/**
 * JSON Schemas for Anthropic structured outputs (`output_config.format`).
 *
 * These mirror the contract types in ./contracts.ts: GtmStrategy and CampaignCopy.
 * If a contract type changes, change the schema here in the same commit.
 *
 * Hard constraints from the Anthropic structured-output docs. Breaking any of
 * them returns a 400 from the API:
 *   - `additionalProperties: false` on EVERY object
 *   - no `minimum` / `maximum` / `multipleOf`
 *   - no `minLength` / `maxLength`
 *   - `minItems` only ever 0 or 1 (we never use it; counts are enforced in the
 *     prompt and by the compliance checker, not by the grammar)
 *   - no recursive schemas
 * Nullable fields use `anyOf: [{type}, {type: 'null'}]`, which is supported.
 *
 * Every property is listed in `required`. Optional contract fields (`note`) are
 * still required here: the grammar is cheaper to reason about when the model
 * always emits the full shape, and an empty string is a valid "no note".
 */

export type JsonSchema = Record<string, unknown>;

const STRING: JsonSchema = { type: 'string' };
const STRING_ARRAY: JsonSchema = { type: 'array', items: STRING };
const NULLABLE_INTEGER: JsonSchema = { anyOf: [{ type: 'integer' }, { type: 'null' }] };
const NULLABLE_STRING: JsonSchema = { anyOf: [{ type: 'string' }, { type: 'null' }] };

function object(properties: Record<string, JsonSchema>, description?: string): JsonSchema {
  const schema: JsonSchema = {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
  if (description) schema.description = description;
  return schema;
}

function array(items: JsonSchema, description?: string): JsonSchema {
  const schema: JsonSchema = { type: 'array', items };
  if (description) schema.description = description;
  return schema;
}

function withDescription(schema: JsonSchema, description: string): JsonSchema {
  return { ...schema, description };
}

// ---------------------------------------------------------------- GtmStrategy

const STRATEGY_SEGMENT_SCHEMA = object({
  name: withDescription(STRING, 'Short segment name, e.g. "Seed-stage SaaS hiring first SDR".'),
  description: withDescription(STRING, 'Who is in this segment and why they feel the pain now.'),
  signals: withDescription(STRING_ARRAY, 'Observable buying signals to filter a list on, e.g. "hiring SDRs", "raised seed <12mo".'),
  angle: withDescription(STRING, 'The one-sentence message angle for this segment.'),
  estimated_size: withDescription(NULLABLE_INTEGER, 'Rough number of companies, or null when unknown. Never a guess dressed as a fact.'),
}, 'A target segment within the ICP.');

const SEQUENCE_STEP_PLAN_SCHEMA = object({
  step: withDescription({ type: 'integer' }, '1-based step number.'),
  delay_days: withDescription({ type: 'integer' }, 'Days after the previous step. Step 1 is always 0.'),
  purpose: withDescription(STRING, 'What this step is for, e.g. "pain / poke the bear", "benefits as outcomes", "soft breakup".'),
  channel: withDescription({ type: 'string', enum: ['email'] }, 'Always "email".'),
}, 'One step of the outbound sequence.');

export const GTM_STRATEGY_SCHEMA: JsonSchema = object({
  positioning: withDescription(STRING, 'One or two sentences: who the product is for, what it does, and why that matters now.'),
  icp: object({
    summary: withDescription(STRING, 'A concrete, specific description of the ideal customer. Names the role, the company shape and the situation that makes them buy.'),
    titles: withDescription(STRING_ARRAY, 'Job titles to target.'),
    industries: withDescription(STRING_ARRAY, 'Industries to target.'),
    geos: withDescription(STRING_ARRAY, 'Countries or regions to target.'),
    headcount_min: withDescription(NULLABLE_INTEGER, 'Minimum company headcount, or null.'),
    headcount_max: withDescription(NULLABLE_INTEGER, 'Maximum company headcount, or null.'),
    exclusions: withDescription(STRING_ARRAY, 'Companies, industries or situations to exclude.'),
  }, 'The ideal customer profile.'),
  segments: array(STRATEGY_SEGMENT_SCHEMA, 'Two to four segments, each with a distinct angle.'),
  offer: object({
    headline: withDescription(STRING, 'The offer in one line, in plain words.'),
    body: withDescription(STRING, 'The offer explained in two to four sentences.'),
    proof_points: withDescription(STRING_ARRAY, "Only proof points the customer supplied in onboarding, verbatim or lightly tidied. Never invented. Empty when they supplied none."),
    risk_reversal: withDescription(NULLABLE_STRING, 'A guarantee or low-risk first step the customer actually offers, or null.'),
  }, 'The offer to lead with.'),
  sequence_plan: array(SEQUENCE_STEP_PLAN_SCHEMA, 'The three-step plan: day 0, day 3-4, day 7-9.'),
  rationale: withDescription(STRING, "Why this strategy, in the customer's own context. Shown on the strategy page."),
  assumptions: withDescription(STRING_ARRAY, 'Everything the model could not determine from the inputs and had to assume. Shown as "we assumed".'),
}, 'A go-to-market strategy derived from onboarding answers and the site scrape.');

// ---------------------------------------------------------------- CampaignCopy

const COPY_STEP_SCHEMA = object({
  step: withDescription({ type: 'integer' }, '1-based step number.'),
  delay_days: withDescription({ type: 'integer' }, 'Days after the previous step. Step 1 is always 0.'),
  subject: withDescription(STRING, 'Two-word lowercase spintax subject, e.g. "{quick question|small idea|one thought}". Identical across all steps so they thread.'),
  body: withDescription(STRING, 'The email body with hard line breaks. Merge tags only from the allowed set. Must contain {{unsubscribe_link}} and a P.S. opt-out line.'),
  note: withDescription(STRING, 'Per-step rationale for the human reviewer. Not sent. May be empty.'),
}, 'One email in the sequence.');

export const CAMPAIGN_COPY_SCHEMA: JsonSchema = object({
  steps: array(COPY_STEP_SCHEMA, 'Exactly three steps: day 0, day 3-4, day 7-9.'),
}, 'A three-step cold email sequence.');
