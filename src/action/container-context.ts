/**
 * The workspace vocabulary of the action face. The face has exactly one runtime — the container
 * image built from `action.Dockerfile` — so it carries exactly one workspace contract: GitHub binds
 * the runner's workspace variable for every action it runs and mounts the checkout there, the
 * binding treats that variable as mandatory, the artifacts default lives under it, and the
 * `artifacts-dir` output is expressed workspace-relative for the host-side
 * `actions/upload-artifact` step. Everything here is a pure read or string mapping — no file
 * system, no clock, no network.
 */

import { isAbsolute, join, relative, sep } from 'node:path';

/**
 * Environment variable the runner always binds for the checkout directory (`github.workspace`),
 * mounted into the container; the one workspace anchor the face has — there is deliberately no
 * fixed container path fallback, because GitHub binds this variable for every action it runs.
 */
export const GITHUB_WORKSPACE_VAR = 'GITHUB_WORKSPACE';

/**
 * Directory under the workspace that holds the run's artifacts; the subdirectory itself carries the
 * default artifacts directory. An explicit `artifactsDir` passes through unchanged, and a relative
 * value resolves against the workspace (the process working directory inside the container), not
 * relative to this directory. Deliberately not a hidden dot-directory: `actions/upload-artifact`
 * skips hidden files by default, so a `.`-prefixed artifacts root would upload nothing.
 */
export const WORKSPACE_ARTIFACTS_SUBDIR = 'filters-agent-artifacts';

/**
 * Directory name under {@link WORKSPACE_ARTIFACTS_SUBDIR} receiving the run's artifacts.
 */
export const WORKSPACE_ARTIFACTS_DIR_NAME = 'artifacts';

/**
 * Resolve the workspace artifacts default: the directory under the checkout a run writes its
 * artifacts to when no `artifactsDir` input names one. There is no other default — the workspace is
 * the one anchor the face's one runtime has.
 *
 * @param workspaceDir - The runner-bound checkout directory.
 * @returns The artifacts directory under the workspace.
 */
export function workspaceArtifactsDefault(workspaceDir: string): string {
    return join(workspaceDir, WORKSPACE_ARTIFACTS_SUBDIR, WORKSPACE_ARTIFACTS_DIR_NAME);
}

/**
 * Relativize the artifacts directory against the workspace for the `artifacts-dir` output, which
 * the host-side `actions/upload-artifact` step resolves relative to the checkout.
 *
 * @param artifactsDir - The resolved artifacts directory of the finished run.
 * @param workspaceDir - The runner-bound checkout directory the run executed in.
 * @returns The workspace-relative path, or the input unchanged when the directory escapes the
 *   workspace (a `..` prefix) — an escaping directory is never rewritten into a sibling traversal.
 */
export function workspaceRelativeArtifactsDir(artifactsDir: string, workspaceDir: string): string {
    const relativeDir = relative(workspaceDir, artifactsDir);
    return relativeDir.startsWith('..') ? artifactsDir : relativeDir;
}

/**
 * List the directories strictly between the workspace and the artifacts directory, outermost first.
 * The entry creates any missing one as root with mode 0700 (`mkdirSync` recursive), and the
 * host-side upload step running as the runner user has to get through each of them before it
 * reaches the tree, so the handover changes their owner too.
 *
 * @param artifactsDir - The resolved artifacts directory, absolute inside the container.
 * @param workspaceDir - The runner-bound checkout directory.
 * @returns The absolute directories between the two; empty when the tree sits directly in the
 *   workspace or outside it, where there is nothing of the workspace to hand over.
 */
export function workspaceArtifactsAncestors(artifactsDir: string, workspaceDir: string): string[] {
    const relativeDir = relative(workspaceDir, artifactsDir);
    if (relativeDir === '' || relativeDir.startsWith('..') || isAbsolute(relativeDir)) {
        return [];
    }
    const segments = relativeDir.split(sep).slice(0, -1);
    return segments.map((_, index) => join(workspaceDir, ...segments.slice(0, index + 1)));
}
