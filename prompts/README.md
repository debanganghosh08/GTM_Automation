# Prompts

System prompts for every LLM call the pipeline makes. One directory per task, one file per version.

```
prompts/
  strategy/v001.md   # generate_strategy  -> GtmStrategy   (schema: GTM_STRATEGY_SCHEMA)
  copy/v001.md       # generate_copy      -> CampaignCopy  (schema: CAMPAIGN_COPY_SCHEMA)
```

Each prompt is paired with a JSON Schema in `src/lib/schemas.ts` that is passed to the API as `output_config.format`, so the model's output is grammar-constrained to the contract type. The prompt carries the rules the grammar cannot: what is true, what is allowed, what the house style is.

## Versioning rule

**Never edit a shipped version. Add the next one.**

- A version is shipped the moment any row in the database records it in `prompt_version` (`strategies.prompt_version`, `campaign_copy.prompt_version`). From then on `vNNN.md` is frozen: no wording fixes, no typo fixes, no reformatting.
- To change a prompt, copy `vNNN.md` to `vNNN+1.md`, edit the copy, and point the job handler at the new version. The old file stays so that any stored output can be reproduced and compared.
- Every stored LLM output records the prompt version that produced it. A strategy or copy row without a `prompt_version` is a bug.
- Version numbers are zero-padded three digits (`v001`, `v002`, ...), monotonic, never reused. The number is per task directory; `strategy/v003` and `copy/v003` are unrelated.
- Changing a schema in `src/lib/schemas.ts` in a way that changes what the model is asked to produce also bumps the prompt version, because the pair is what produced the output.

Why: when a customer asks "why did it write this", or a regression shows up in reply rates, we need to run the exact prompt that produced the stored output. Editing in place destroys that.

## What belongs in a prompt

- The input format the user message will carry.
- The exact output shape, restated in prose even though the schema enforces it.
- Every rule from `docs/VENDOR_NOTES.md` §2 that applies to the task.
- What the model must never invent. For this product that is proof points, statistics, customer names and numbers. The customer's own onboarding answers are the only source of truth for results.

## What does not belong in a prompt

- Secrets, API keys, internal URLs.
- Customer data. Customer data goes in the user message at call time, never in the system prompt, so the system prompt stays cacheable and the same for every account.
- Anything that contradicts `src/lib/contracts.ts`. The contract wins; update the prompt.

## Checking a change

The compliance checker (`src/lib/compliance.ts`) is the mechanical backstop for the copy prompt. When you bump `copy/vNNN`, run a handful of generations through `checkCompliance` and confirm the new version produces no errors and fewer warnings than the old one before switching the handler over.
