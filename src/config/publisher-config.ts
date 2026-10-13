/**
 * Build the canonical GitHub Actions run URL for a run's own artifacts.
 *
 * @param env - Environment values, injectable for deterministic tests.
 * @returns The run URL when `GITHUB_SERVER_URL`, `GITHUB_REPOSITORY` and `GITHUB_RUN_ID` are all
 *   present and non-blank — one trailing slash of the server URL removed — or `undefined` when any
 *   of them is absent, so a caller without runner variables carries no artifacts link at all.
 */
export function buildActionsRunUrl(env: Record<string, string | undefined>): string | undefined {
    const serverUrl = env.GITHUB_SERVER_URL?.trim().replace(/\/$/, '');
    const repository = env.GITHUB_REPOSITORY?.trim();
    const runId = env.GITHUB_RUN_ID?.trim();
    if (!serverUrl || !repository || !runId) {
        return undefined;
    }
    return `${serverUrl}/${repository}/actions/runs/${runId}`;
}
