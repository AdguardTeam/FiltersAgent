/**
 * The wall-clock bounds of the runtime's browser and vision tools.
 *
 * They live apart from the registrations that apply them because they are read from three places —
 * the lifecycle registrations, the runtime's own per-tool wrapping, and the tests that advance
 * timers past them — and because each value is a recorded observation about production, not a
 * detail of how a tool is registered.
 */
import { APPLICATION_SESSION_BUDGET_MS } from '../validator/phase-application-contract';

/**
 * Hard deadline for one browser tool call.
 *
 * The loop's wall-clock budget is checked between turns, so it cannot end a turn that never
 * returns: a call hung inside a browser launch has been seen to sit for over two hours despite a
 * one-hour budget. This bounds the call itself, and the model is told the tool timed out so it can
 * choose a different move.
 */
export const BROWSER_TOOL_DEADLINE_MS = 3 * 60_000;

/**
 * Wall-clock room one launch's readiness waits need beside the application session.
 *
 * A launch runs a readiness pre-read before the session and a state read-back after it; at the
 * default configuration those waits bound themselves to 30 s and 90 s, and an aborted call gets up
 * to 90 s to record its own cleanup before the agent loop continues. Four minutes fits that sum
 * with bootstrap slack.
 */
const BROWSER_LAUNCH_READINESS_ENVELOPE_MS = 4 * 60_000;

/**
 * Hard deadline for one `launch_browser` call.
 *
 * A launch runs the readiness pre-read, the whole bounded application session
 * (`APPLICATION_SESSION_BUDGET_MS`), and the host read-back inside one tool call, so the plain
 * browser-tool deadline would end a valid launch while its session kept spending turns in the
 * background. This deadline covers the session budget plus the readiness envelope, and the handler
 * threads its abort signal into the session so a timed-out launch discards its late read-back.
 */
export const BROWSER_LAUNCH_DEADLINE_MS =
    APPLICATION_SESSION_BUDGET_MS + BROWSER_LAUNCH_READINESS_ENVELOPE_MS;

/**
 * Hard deadline for one apply_rule candidate validation.
 *
 * The three-phase A/B/C validation navigates the reporter page and captures bounded full-page tiles
 * in every phase; very tall pages (tens of thousands of pixels) legitimately exceed the generic
 * browser bound while still making progress, so the candidate path gets its own limit.
 *
 * Thirty minutes: every phase ends in vision calls, and on a reasoning vision model those can run
 * 200-260 s each (4-9k reasoning tokens per verdict), so a 15-minute limit cuts a validation that
 * is progressing normally — sessions launched, phases applied, verdicts arriving — and the run
 * spends its whole wall-clock budget re-trying it. Each vision call is separately bounded by the
 * single-shot inactivity deadline and the vision tool deadline, so this limit only has to cover a
 * validation that is making progress, not one that hangs.
 */
export const APPLY_RULE_TOOL_DEADLINE_MS = 30 * 60_000;
