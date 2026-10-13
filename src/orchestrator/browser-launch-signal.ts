/**
 * Maximum cause-chain depth the signal extraction walks.
 *
 * Launch wrappers nest two or three levels deep (route error → launch error → engine error);
 * anything deeper is pathological, and a cyclic chain must not spin the classifier forever.
 */
const MAX_CAUSE_DEPTH = 8;

/**
 * Extract the fatal process signal from a browser launch failure.
 *
 * A Chromium startup crash reaches the runtime as a Playwright launch error whose message records
 * how the browser process died (`<process did exit: exitCode=null, signal=SIGTRAP>`). The message
 * sits somewhere down the cause chain — route wrappers deliberately carry path-free messages — so
 * the whole chain is searched. The signal is the deterministic-crash signature the technical budget
 * uses to stop burning attempts: an identical signal on the next launch means the crash repeats
 * exactly, and retrying the unchanged environment cannot succeed.
 *
 * @param error - Caught launch failure, possibly wrapping the engine error as its cause.
 * @returns The uppercase signal name (for example `SIGTRAP`), or null when none is recorded.
 */
export function extractBrowserLaunchSignal(error: unknown): string | null {
    let current: unknown = error;
    for (let depth = 0; current && depth < MAX_CAUSE_DEPTH; depth += 1) {
        const message = current instanceof Error ? current.message : String(current);
        const match = /signal=([A-Z][A-Z0-9]*)/u.exec(message);
        if (match) {
            return match[1];
        }
        current = current instanceof Error ? current.cause : null;
    }
    return null;
}
