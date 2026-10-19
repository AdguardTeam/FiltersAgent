/**
 * Hard deadline for one vision tool call (`analyze_screenshot`, `inspect_full_page_capture`).
 *
 * These tools spend their whole duration awaiting out-of-loop single-shot completions, and pi's own
 * abort reaches only the request the loop itself has in flight — so a vision call that never
 * returns keeps the run alive past its wall-clock budget with nothing to end it: one stalled
 * `inspect_full_page_capture` can hold a 60-minute run for 90 minutes.
 *
 * Why ten minutes: `inspect_full_page_capture` is a BATCH — one overview call plus one per three
 * original-resolution tiles, so a tall page legitimately spends several completions in one call.
 * Verified batches finish within a few minutes, so ten leaves a healthy call ample room.
 *
 * This deadline does not wait for a failing completion to give up on its own. A completion that
 * stalls is attempted up to `llm.requestMaxAttempts` times, and each attempt is bounded only by the
 * single-shot ceiling, silence included, so its own failure can take far longer than any share of a
 * 60-minute run one tool call should hold. When it does, the deadline ends the whole call, the
 * batches that already finished are lost with it, and the agent gets a retryable error. A single
 * stall costs only its retry, which usually succeeds.
 */
export const VISION_TOOL_DEADLINE_MS = 10 * 60_000;
