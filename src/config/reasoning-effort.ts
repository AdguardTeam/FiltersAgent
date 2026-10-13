/**
 * The reasoning-effort vocabulary: the one declaration of the thinking levels this deployment may
 * ask the gateway for.
 *
 * It is a leaf module on purpose — it imports nothing. `config.ts` needs the value set to build its
 * `picklist`, and a `src/config` module must not reach into the harness, so the vocabulary cannot
 * live next to the pi wiring that consumes it. The literals are chosen to match pi's own spellings
 * exactly, in both places the value lands: `createAgentSession({ thinkingLevel })` for a loop
 * session and the provider request's `reasoningEffort` field for a single-shot call. That is why no
 * mapping table exists here — there is nothing for a pi upgrade to silently desynchronize, and a
 * renamed pi level would surface as a type error at the boundary instead of as a wrong request.
 */

/**
 * Reasoning effort one request may carry.
 *
 * The set stops at `high` deliberately. Pi derives a model's supported levels from its catalog
 * entry, and for the reasoning model this runtime registers — `reasoning: true`, no
 * `thinkingLevelMap` — `getSupportedThinkingLevels` answers exactly `off | minimal | low | medium |
 * high`. `xhigh` and `max` do exist in pi's own `ThinkingLevel` union, but they are unsupported for
 * this model: `clampThinkingLevel` folds them straight back down to `high`, so offering them would
 * only let a deployment configure a value that silently means something else. `off` is kept because
 * it is the only way to send no reasoning parameter at all — the like-for-like setting when
 * benchmarking against requests that carried none.
 */
export const ReasoningEffort = {
    /**
     * Send no reasoning parameter at all.
     */
    Off: 'off',

    /**
     * The smallest reasoning budget the model offers.
     */
    Minimal: 'minimal',

    /**
     * A short reasoning budget.
     */
    Low: 'low',

    /**
     * Pi's own default level, stated here so it is a choice rather than an inheritance.
     */
    Medium: 'medium',

    /**
     * The largest reasoning budget this model can carry.
     */
    High: 'high',
} as const;

/**
 * ReasoningEffort value.
 */
export type ReasoningEffort = (typeof ReasoningEffort)[keyof typeof ReasoningEffort];

/**
 * Every ReasoningEffort value, for schemas and exhaustive listings.
 */
export const REASONING_EFFORT_VALUES = Object.values(ReasoningEffort);

/**
 * A reasoning effort that actually puts a level on the wire — every member but `Off`.
 *
 * Named because the provider request field is typed exactly this way: pi's per-API
 * `reasoningEffort` option has no `off` member, since "off" is expressed by omitting the field
 * rather than by naming a level.
 */
export type ActiveReasoningEffort = Exclude<ReasoningEffort, typeof ReasoningEffort.Off>;
