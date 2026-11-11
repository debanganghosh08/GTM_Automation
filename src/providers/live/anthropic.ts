/**
 * Anthropic LLM provider: strict-JSON generation through the Messages API.
 *
 * Verified against @anthropic-ai/sdk 1.1.0 on 2026-10-23. The SDK sends API
 * version 2026-10-21, and on that version:
 *   - `temperature`, `top_p` and `top_k` are rejected with a 400. Never pass them.
 *   - Strict JSON comes from `output_config.format = { type: 'json_schema', schema }`
 *     (GA). Forced `tool_choice` (`any` / `tool`) returns a 400 on Sonnet 5.5, and
 *     `response_format` is not a Messages API parameter. Neither is used here.
 *   - Thinking is adaptive by default on Sonnet 5.5 / Haiku 5.5; we leave the
 *     `thinking` parameter out entirely.
 *
 * Reading the result: check `stop_reason` BEFORE parsing. `refusal` is billed and
 * may not match the schema; `max_tokens` means the JSON was cut off. Each throws
 * its own error class so a caller can tell "raise max_tokens" from "do not retry".
 *
 * Retries: `maxRetries: 4` on the client (429 / 5xx / connection errors, with the
 * SDK's own backoff). A 429 whose body carries
 * `error.details.error_code === 'enforced_spend_limit_reached'` is the account
 * spend cap: retrying cannot help, so a client middleware converts it into
 * `AnthropicSpendLimitError` before the SDK's retry loop sees it. Middleware errors
 * are not retried by the SDK (only connection-level errors are).
 *
 * Prompt caching: with `cache_system` the system prompt goes in a text block with
 * `cache_control: { type: 'ephemeral' }`. Prompts under 512 tokens (Sonnet 5.5 /
 * Haiku 5.5 minimum) are simply not cached; that is not an error. Cache usage is
 * logged and returned alongside the token counts.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Middleware } from '@anthropic-ai/sdk';
import type { LlmProvider } from '../../lib/contracts';
import { env, requireCredential } from '../../lib/env';

/** Non-streaming default from the SDK guidance: enough room, still under HTTP timeouts. */
const DEFAULT_MAX_TOKENS = 16_000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export type ModelKey = 'strategy' | 'copy' | 'cheap';

/** The slice of the SDK client this provider uses. Tests pass a fake. */
export interface AnthropicMessagesClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

export interface LlmJsonResult<T> {
  value: T;
  model: string;
  /** Uncached + cache-read + cache-creation input tokens, i.e. everything billed as input. */
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  request_id: string | null;
}

// ---------------------------------------------------------------- errors

export class AnthropicProviderError extends Error {
  readonly request_id: string | null;
  constructor(message: string, request_id: string | null = null) {
    super(request_id ? `${message} (request_id=${request_id})` : message);
    this.name = 'AnthropicProviderError';
    this.request_id = request_id;
  }
}

/** The model declined (stop_reason `refusal`). Billed; the output is not usable. Do not retry blindly. */
export class AnthropicRefusalError extends AnthropicProviderError {
  readonly category: string | null;
  constructor(input: { model: string; schema_name: string; category: string | null; explanation: string | null; request_id: string | null }) {
    super(
      `Anthropic refused the "${input.schema_name}" request on ${input.model}` +
        (input.category ? ` [${input.category}]` : '') +
        (input.explanation ? `: ${input.explanation}` : ''),
      input.request_id,
    );
    this.name = 'AnthropicRefusalError';
    this.category = input.category;
  }
}

/** Output hit `max_tokens` (stop_reason `max_tokens`): the JSON is truncated. Raise max_tokens and retry. */
export class AnthropicTruncatedError extends AnthropicProviderError {
  readonly max_tokens: number;
  constructor(input: { model: string; schema_name: string; max_tokens: number; request_id: string | null }) {
    super(
      `Anthropic output for "${input.schema_name}" on ${input.model} was truncated at max_tokens=${input.max_tokens}; ` +
        'the JSON is incomplete. Raise max_tokens or shorten the prompt.',
      input.request_id,
    );
    this.name = 'AnthropicTruncatedError';
    this.max_tokens = input.max_tokens;
  }
}

/** The organisation's spend cap was hit. Retrying cannot help; a human must raise the limit. */
export class AnthropicSpendLimitError extends AnthropicProviderError {
  constructor(request_id: string | null) {
    super(
      'Anthropic account spend limit reached (error_code=enforced_spend_limit_reached). ' +
        'This 429 is not retried: raise the spend cap in the Anthropic console, then re-run the job.',
      request_id,
    );
    this.name = 'AnthropicSpendLimitError';
  }
}

/** The response was well-formed HTTP but not usable: unexpected stop reason, no text block, or non-JSON text. */
export class AnthropicOutputError extends AnthropicProviderError {
  constructor(message: string, request_id: string | null) {
    super(message, request_id);
    this.name = 'AnthropicOutputError';
  }
}

// ---------------------------------------------------------------- spend-cap guard

function isSpendLimitBody(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return false;
  const details = (error as { details?: unknown }).details;
  if (typeof details !== 'object' || details === null) return false;
  return (details as { error_code?: unknown }).error_code === 'enforced_spend_limit_reached';
}

/**
 * Client middleware: turn a spend-cap 429 into a non-retryable error. Runs per HTTP
 * attempt inside the SDK; an error thrown here propagates to the caller as-is and is
 * NOT retried. Any other 429 is returned untouched so the SDK's backoff handles it.
 */
export const spendLimitMiddleware: Middleware = async (request, next, ctx) => {
  const response = await next(request);
  if (response.status !== 429) return response;
  // ctx.parse reads a clone, so the body stays readable for the SDK.
  const body: unknown = await ctx.parse<unknown>(response).catch(() => undefined);
  if (isSpendLimitBody(body)) {
    throw new AnthropicSpendLimitError(response.headers.get('request-id'));
  }
  return response;
};

/** Builds the real SDK client with our retry policy and the spend-cap guard. */
export function createAnthropicClient(options: { apiKey: string; fetch?: typeof fetch; timeoutMs?: number }): Anthropic {
  return new Anthropic({
    apiKey: options.apiKey,
    maxRetries: 4,
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    middleware: [spendLimitMiddleware],
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}

// ---------------------------------------------------------------- provider

function requestIdOf(message: unknown): string | null {
  if (typeof message !== 'object' || message === null) return null;
  const id = (message as { _request_id?: unknown })._request_id;
  return typeof id === 'string' ? id : null;
}

function errorRequestId(err: unknown): string | null {
  if (err instanceof Anthropic.APIError) return err.requestID ?? null;
  if (err instanceof AnthropicProviderError) return err.request_id;
  return null;
}

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  private readonly client: AnthropicMessagesClient;
  private readonly models: Record<ModelKey, string>;

  /**
   * @param client  Optional: anything with `messages.create`. Tests pass a fake; production
   *                omits it and gets a real SDK client built by `createAnthropicClient`.
   */
  constructor(client?: AnthropicMessagesClient, options: { models?: Record<ModelKey, string> } = {}) {
    this.models = options.models ?? env.models;
    if (client) {
      this.client = client;
    } else {
      const apiKey = requireCredential('Anthropic', 'ANTHROPIC_API_KEY', env.anthropicApiKey);
      this.client = createAnthropicClient({ apiKey });
    }
  }

  async json<T>(input: {
    system: string;
    user: string;
    schema_name: string;
    schema: Record<string, unknown>;
    model?: ModelKey;
    max_tokens?: number;
    cache_system?: boolean;
  }): Promise<LlmJsonResult<T>> {
    const model = this.models[input.model ?? 'cheap'];
    const max_tokens = input.max_tokens ?? DEFAULT_MAX_TOKENS;

    const system: string | Anthropic.TextBlockParam[] = input.cache_system
      ? [{ type: 'text', text: input.system, cache_control: { type: 'ephemeral' } }]
      : input.system;

    // Deliberately no temperature / top_p / top_k / tool_choice / thinking / response_format.
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      max_tokens,
      system,
      messages: [{ role: 'user', content: input.user }],
      output_config: { format: { type: 'json_schema', schema: input.schema } },
    };

    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create(params);
    } catch (err) {
      console.error('[anthropic] request failed', {
        schema_name: input.schema_name,
        model,
        request_id: errorRequestId(err),
        status: err instanceof Anthropic.APIError ? err.status : undefined,
        error: err instanceof Error ? err.name : typeof err,
      });
      throw err;
    }

    const request_id = requestIdOf(message);

    if (message.stop_reason === 'refusal') {
      const details = message.stop_details;
      const refusal = new AnthropicRefusalError({
        model,
        schema_name: input.schema_name,
        category: details?.category ?? null,
        explanation: details?.explanation ?? null,
        request_id,
      });
      console.error('[anthropic] refusal', { schema_name: input.schema_name, model, request_id, category: refusal.category });
      throw refusal;
    }
    if (message.stop_reason === 'max_tokens') {
      console.error('[anthropic] truncated', { schema_name: input.schema_name, model, request_id, max_tokens });
      throw new AnthropicTruncatedError({ model, schema_name: input.schema_name, max_tokens, request_id });
    }
    if (message.stop_reason !== 'end_turn' && message.stop_reason !== 'stop_sequence') {
      throw new AnthropicOutputError(
        `Anthropic stopped with unexpected stop_reason "${String(message.stop_reason)}" for "${input.schema_name}" on ${model}`,
        request_id,
      );
    }

    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');
    if (!text.trim()) {
      throw new AnthropicOutputError(
        `Anthropic returned no text content for "${input.schema_name}" on ${model}`,
        request_id,
      );
    }

    let value: T;
    try {
      value = JSON.parse(text) as T;
    } catch (err) {
      throw new AnthropicOutputError(
        `Anthropic returned non-JSON text for "${input.schema_name}" on ${model}: ` +
          (err instanceof Error ? err.message : String(err)),
        request_id,
      );
    }

    const usage = message.usage;
    const cache_read_input_tokens = usage.cache_read_input_tokens ?? 0;
    const cache_creation_input_tokens = usage.cache_creation_input_tokens ?? 0;

    return {
      value,
      model: message.model,
      input_tokens: usage.input_tokens + cache_read_input_tokens + cache_creation_input_tokens,
      output_tokens: usage.output_tokens,
      cache_read_input_tokens,
      cache_creation_input_tokens,
      request_id,
    };
  }
}
