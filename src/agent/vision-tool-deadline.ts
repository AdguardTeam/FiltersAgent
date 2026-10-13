/**
 * Hard deadline for one vision tool call (`analyze_screenshot`, `inspect_full_page_capture`).
 *
 * These tools spend their whole duration awaiting out-of-loop single-shot completions, and pi's own
 * abort reaches only the request the loop itself has in flight — so a vision call that never
 * returns keeps the run alive past its wall-clock budget with nothing to end it: one stalled
 * `inspect_full_page_capture` can hold a 60-minute run for 90 minutes.
 *
 * Why ten minutes: `inspect_full_page_capture` is a BATCH — one overview call plus one per three
 * original-resolution tiles, so a tall page legitimately spends several completions in one call —
 * and each of those completions is itself bounded by the configured per-request inactivity
 * deadline, at most 300 s (`llm.requestTimeoutMs`). Ten minutes therefore leaves a healthy batch
 * ample room while capping the call at roughly two stalled completions, and the batch stops at the
 * first aborted one rather than paying for the rest.
 */
export const VISION_TOOL_DEADLINE_MS = 10 * 60_000;
