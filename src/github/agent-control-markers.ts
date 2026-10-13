/**
 * Reserved automation markers that untrusted upstream Markdown may not reproduce.
 */
const AGENT_CONTROL_MARKER_PATTERN =
    /<!--\s*(?:adguard-agent-benchmark\s*:|adguard-filters-agent:[a-z0-9_-]+)[\s\S]*?-->/giu;

/**
 * Upper bound on {@link stripAgentControlMarkers} passes over one untrusted body.
 */
const AGENT_CONTROL_MARKER_MAX_STRIP_PASSES = 16;

/**
 * Clone a global marker expression so callers never share `lastIndex` state.
 *
 * @param pattern - Marker expression to clone.
 * @returns An independent regular expression.
 */
function clonePattern(pattern: RegExp): RegExp {
    return new RegExp(pattern.source, pattern.flags);
}

/**
 * Remove every reserved automation marker from untrusted upstream Markdown.
 *
 * `String.replace` never re-scans its own output, so a single pass leaves a nested marker behind:
 * removing the inner comment splices the surrounding fragments into a fresh, well-formed marker.
 * Stripping to a fixpoint closes that. Each iteration removes at least one match and therefore
 * strictly shortens the text, so the loop terminates; the bound only guards against a future
 * pattern that could rewrite rather than shorten.
 *
 * @param body - Reporter-controlled issue or comment Markdown.
 * @returns Markdown without strings that could impersonate trusted workflow state.
 */
export function stripAgentControlMarkers(body: string | null): string | null {
    if (body === null) {
        return null;
    }
    let stripped = body;
    for (let pass = 0; pass < AGENT_CONTROL_MARKER_MAX_STRIP_PASSES; pass += 1) {
        const next = stripped.replace(clonePattern(AGENT_CONTROL_MARKER_PATTERN), '');
        if (next === stripped) {
            break;
        }
        stripped = next;
    }
    return stripped.trimEnd();
}
