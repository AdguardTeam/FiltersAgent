/**
 * The stop-reason vocabulary of every provider completion this codebase observes, plus the single
 * mapper onto it. Both pi surfaces hand out a raw harness stop reason — the agent loop's `turn_end`
 * assistant message and the single-shot completion — and both map through here, so a reason pi
 * adds, renames or drops degrades to `Unknown` at one seam instead of leaking a harness string into
 * the trace and widening every consumer's type.
 *
 * A leaf module of its own rather than a section of the seal or observation vocabularies:
 * `single-shot-types.ts` shares this set (it is the single-shot vocabulary too) and must not import
 * the loop vocabulary. This file imports nothing — in particular nothing from
 * `@earendil-works/pi-ai`, so no consumer of a mapped stop reason ever touches a harness type.
 */

/**
 * How one provider completion ended, in this codebase's own vocabulary.
 *
 * The members pi also produces keep pi's spelling, so existing comparisons and already-persisted
 * trace strings stay valid; the SET is owned here, and `toTurnStopReason` is the only way in.
 */
export const TurnStopReason = {
    /**
     * The model finished its reply.
     */
    Stop: 'stop',

    /**
     * The reply hit the output-token cap before it finished.
     */
    Length: 'length',

    /**
     * The reply ended by calling tools.
     */
    ToolUse: 'toolUse',

    /**
     * The provider or the daemon failed the request; the accompanying error message carries the
     * cause.
     */
    Error: 'error',

    /**
     * The caller's abort signal cancelled the request.
     */
    Aborted: 'aborted',

    /**
     * The completion never started streaming.
     */
    Pending: 'pending',

    /**
     * The provider deferred the completion to a batch handle this codebase never polls.
     */
    Deferred: 'deferred',

    /**
     * The harness reported an ending outside this vocabulary; the accompanying message carries the
     * detail.
     */
    Unknown: 'unknown',
} as const;

/**
 * TurnStopReason value.
 */
export type TurnStopReason = (typeof TurnStopReason)[keyof typeof TurnStopReason];

/**
 * Every TurnStopReason value, for the boundary mapping and exhaustive listings.
 */
export const TURN_STOP_REASON_VALUES = Object.values(TurnStopReason);

/**
 * The named set the mapper looks up; built once because both boundaries call the mapper per turn.
 */
const KNOWN_STOP_REASONS: ReadonlySet<string> = new Set<string>(TURN_STOP_REASON_VALUES);

/**
 * Map a harness stop reason onto the app-owned vocabulary.
 *
 * @param stopReason - The stop reason pi reported for the completion.
 * @returns The matching app-owned stop reason, or `Unknown` for an ending pi grew that this
 *   codebase does not name; the completion's error message carries the detail either way.
 */
export function toTurnStopReason(stopReason: string): TurnStopReason {
    return KNOWN_STOP_REASONS.has(stopReason)
        ? (stopReason as TurnStopReason)
        : TurnStopReason.Unknown;
}
