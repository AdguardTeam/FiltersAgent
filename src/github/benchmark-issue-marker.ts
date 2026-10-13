/**
 * HTML comment carrying trusted benchmark-only metadata in an issue body.
 */
const BENCHMARK_MARKER_PATTERN = /<!--\s*adguard-agent-benchmark\s*:\s*([\s\S]*?)-->/gi;

/**
 * A standalone marker line, including its following newline when present.
 */
const BENCHMARK_MARKER_LINE_PATTERN =
    /^[ \t]*<!--\s*adguard-agent-benchmark\s*:\s*[\s\S]*?-->[ \t]*(?:\r?\n|$)/gim;

/**
 * Return fresh regular expression state for one marker operation.
 *
 * @param pattern - Shared marker expression whose source and flags should be cloned.
 * @returns A regular expression with an independent `lastIndex`.
 */
function clonePattern(pattern: RegExp): RegExp {
    return new RegExp(pattern.source, pattern.flags);
}

/**
 * Remove every benchmark metadata marker from an issue body before it enters an agent prompt.
 *
 * Stripping deliberately does not depend on successful trusted parsing: malformed hidden metadata
 * is still withheld from the model while the workflow gate can reject it independently.
 *
 * @param body - Raw issue body retained for audit.
 * @returns Prompt-safe issue body with benchmark comments removed.
 */
export function stripBenchmarkIssueMarker(body: string | null): string | null {
    if (body === null) {
        return null;
    }
    return body
        .replace(clonePattern(BENCHMARK_MARKER_LINE_PATTERN), '')
        .replace(clonePattern(BENCHMARK_MARKER_PATTERN), '')
        .trimEnd();
}
