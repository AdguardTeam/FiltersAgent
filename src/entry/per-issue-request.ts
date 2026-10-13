/**
 * The per-issue request the entry dispatch hands the per-issue engine: the validated run inputs
 * narrowed to one issue, in the single-issue mode and for each taken backlog issue alike.
 */

import { AgentRunMode, type AgentRunInputs } from './entry-inputs';
import type { DefaultSingleIssueRequest } from './single-issue-run-types';
import type { TrustedRole } from '../queue/queue-inputs';

/**
 * Build one per-issue request from the validated inputs, spreading only set optional fields so the
 * request carries exactly what the caller configured.
 *
 * @param inputs - Validated run inputs.
 * @param issueNumber - Issue the request processes.
 * @param artifactsDir - Directory the per-issue run writes into.
 * @returns The per-issue request.
 */
export function perIssueRequest(
    inputs: AgentRunInputs,
    issueNumber: number,
    artifactsDir: string,
): DefaultSingleIssueRequest {
    return {
        config: inputs.config,
        slug: inputs.slug,
        ...(inputs.checkoutPath !== undefined ? { checkoutPath: inputs.checkoutPath } : {}),
        issueNumber,
        ...(inputs.issueSnapshotPath !== undefined
            ? { issueSnapshotPath: inputs.issueSnapshotPath }
            : {}),
        token: inputs.comments.token,
        commentsEnabled: inputs.comments.enabled,
        screenshotsBranch: inputs.comments.screenshotsBranch,
        ...(inputs.model !== undefined ? { model: inputs.model } : {}),
        ...(inputs.executors !== undefined ? { executors: inputs.executors } : {}),
        ...(inputs.instructionPath !== undefined
            ? { instructionPath: inputs.instructionPath }
            : {}),
        ...(inputs.actionsRunUrl !== undefined ? { actionsRunUrl: inputs.actionsRunUrl } : {}),
        ...(inputs.lintCommand !== undefined ? { lintCommand: inputs.lintCommand } : {}),
        ...(inputs.excludedLabels !== undefined ? { excludedLabels: inputs.excludedLabels } : {}),
        ...(inputs.inProgressLabels !== undefined
            ? { inProgressLabels: inputs.inProgressLabels }
            : {}),
        ...(inputs.reportBots !== undefined ? { reportBots: inputs.reportBots } : {}),
        // Only a single-issue run is forced: the backlog mode has no maintainer behind each issue.
        ...(inputs.mode.kind === AgentRunMode.SingleIssue && inputs.mode.force === true
            ? { force: true }
            : {}),
        // Threaded so the fetch, the extraction, and the revision digest computed over the fetch's
        // own comments all apply the one policy backlog selection resolved (see entry-run.ts's cast
        // rationale next to the identical trustedRoles threading for selection).
        ...(inputs.queue?.trustedRoles !== undefined
            ? { trustedRoles: inputs.queue.trustedRoles as TrustedRole[] }
            : {}),
        artifactsDir,
    };
}
