/**
 * Before and after screenshots of the report comment, hosted in the storage the run's token input
 * names.
 *
 * The branch storage commits the verified candidate's two viewport captures to a dedicated branch
 * of the repository the action runs in and links them by the commit they landed in: each issue
 * keeps one pair of paths on the branch, so a later run overwrites the files while an earlier
 * comment still shows its own images because its links name the earlier commit. Writing that branch
 * needs the `contents: write` permission; a workflow granting only `contents: read` still gets its
 * report, posted without the images, and the run log names the missing permission.
 *
 * The attachments storage uploads the same pair through a user account's token and links the
 * addresses GitHub answers; nothing is written to the repository. Any upload failure yields the
 * report without images and one warning naming the status: the endpoint reports a token it does not
 * accept in more than one way, and a report without images is worth more than a failed run.
 */

import type { Octokit } from '@octokit/rest';
import * as v from 'valibot';
import { GitHubFileView, gitHubFileUrl } from '../github/github-file-url';
import type { Logger } from '../logger/logger';
import type { FixRunResult, VerifiedCandidateScreenshotPaths } from '../types/fix-run-result';
import {
    describeAttachmentUploadFailure,
    uploadReportScreenshotAttachments,
} from './report-screenshot-attachments';

/**
 * Branch of the analyzed repository that receives the screenshots when the workflow names none.
 *
 * A branch of its own keeps the binary uploads out of the filter lists' history, and deleting it
 * prunes the whole set.
 */
export const DEFAULT_REPORT_SCREENSHOTS_BRANCH = 'filters-agent-screenshots';

/**
 * Where a run hosts the report's before and after screenshots: the storage follows the token input
 * the run took its token from, never a guess about what the token can do.
 */
export const ScreenshotsStorage = {
    /**
     * Committed to the screenshots branch and linked by the commit that holds them.
     */
    Branch: 'branch',

    /**
     * Uploaded as attachments of the report comment.
     */
    Attachments: 'attachments',
} as const;

/**
 * ScreenshotsStorage value.
 */
export type ScreenshotsStorage = (typeof ScreenshotsStorage)[keyof typeof ScreenshotsStorage];

/**
 * Where one run's screenshots go, as the comment policy carries it: the branch storage names its
 * branch, the attachments storage needs nothing more, so a branch never travels with attachments.
 */
export const ScreenshotsTargetSchema = v.variant('storage', [
    v.strictObject({ storage: v.literal(ScreenshotsStorage.Branch), branch: v.string() }),
    v.strictObject({ storage: v.literal(ScreenshotsStorage.Attachments) }),
]);

/**
 * Where one run's screenshots go.
 */
export type ScreenshotsTarget = v.InferOutput<typeof ScreenshotsTargetSchema>;

/**
 * The screenshot pair the report shows under "Without and with the rule", when it shows one.
 *
 * The pair illustrates the rule the report publishes. A verified experiment's screenshots survive
 * on a result that publishes no rule — the safety gate downgraded its draft, or the model finished
 * on another outcome — and there they would show a change the report never names.
 *
 * @param result - The run result the report renders.
 * @returns The verified pair behind the published rule, or undefined when there is no such rule.
 */
export function publishedRuleScreenshots(
    result: FixRunResult,
): VerifiedCandidateScreenshotPaths | undefined {
    return result.candidatePatch === null
        ? undefined
        : result.artifactPaths.verifiedCandidateScreenshots;
}

/**
 * Display width of each screenshot in the comment, in pixels.
 *
 * Two images share one table row. 400 px lets both sit side by side in the comment column and still
 * shows the page layout; a click opens the full-size PNG.
 */
const SCREENSHOT_WIDTH_PX = 400;

/**
 * Attempts at moving the branch to the new commit. Parallel runs commit to the same branch, so a
 * move can lose the race; each retry rebuilds the commit on the branch's new head.
 */
const MAX_BRANCH_UPDATE_ATTEMPTS = 5;

/**
 * HTTP status GitHub answers a ref write with when the ref moved or already exists.
 */
const REF_CONFLICT_STATUS = 422;

/**
 * HTTP status GitHub answers a write with when the token lacks `contents: write`.
 */
const PERMISSION_REFUSAL_STATUS = 403;

/**
 * HTTP status GitHub answers a ref read with when the branch does not exist yet.
 */
const NOT_FOUND_STATUS = 404;

/**
 * The part of an Octokit request failure this module reads.
 */
interface HttpFailure {
    /**
     * HTTP status of the failed request; absent when the failure never reached a response.
     */
    status?: number;
}

/**
 * The screenshot pair of one report and the issue it belongs to.
 */
export interface ReportScreenshotsPair {
    /**
     * Owner of the repository the report is posted to.
     */
    owner: string;

    /**
     * Name of the repository the report is posted to.
     */
    repo: string;

    /**
     * Issue the report belongs to; names the directory the pair lands in.
     */
    issueNumber: number;

    /**
     * PNG of the page without the rule.
     */
    before: Buffer;

    /**
     * PNG of the page with the rule.
     */
    after: Buffer;
}

/**
 * Inputs of one screenshot hosting: the pair and where it goes.
 */
export interface HostReportScreenshotsInput extends ReportScreenshotsPair {
    /**
     * Where the pair is hosted; the target alone decides, never the token.
     */
    target: ScreenshotsTarget;
}

/**
 * Addresses of one hosted screenshot pair.
 */
export interface HostedReportScreenshots {
    /**
     * Address of the page without the rule.
     */
    beforeUrl: string;

    /**
     * Address of the page with the rule.
     */
    afterUrl: string;
}

/**
 * Head of the screenshots branch.
 */
interface BranchHead {
    /**
     * Commit the branch points at.
     */
    commitSha: string;

    /**
     * Tree of that commit.
     */
    treeSha: string;
}

/**
 * Read the head of the screenshots branch.
 *
 * @param octokit - Authenticated GitHub API client.
 * @param owner - Repository owner.
 * @param repo - Repository name.
 * @param branch - The screenshots branch.
 * @returns The branch head, or null before the first upload created the branch.
 */
async function readBranchHead(
    octokit: Octokit,
    owner: string,
    repo: string,
    branch: string,
): Promise<BranchHead | null> {
    let commitSha: string;
    try {
        const { data } = await octokit.rest.git.getRef({
            owner,
            repo,
            ref: `heads/${branch}`,
        });
        commitSha = data.object.sha;
    } catch (error) {
        if ((error as HttpFailure).status === NOT_FOUND_STATUS) {
            return null;
        }
        throw error;
    }
    const { data } = await octokit.rest.git.getCommit({ owner, repo, commit_sha: commitSha });
    return { commitSha, treeSha: data.tree.sha };
}

/**
 * Commit the before and after screenshots of one report to the screenshots branch.
 *
 * Both files land in one commit. The branch is created on the first upload as a history of its own,
 * not a copy of the filter lists. Any failure propagates.
 *
 * @param octokit - Authenticated GitHub API client.
 * @param input - Target repository and issue and the two PNGs.
 * @param branch - Branch the pair is committed to.
 * @returns Addresses of both images, pinned to the commit that holds them.
 */
export async function hostReportScreenshots(
    octokit: Octokit,
    input: ReportScreenshotsPair,
    branch: string,
): Promise<HostedReportScreenshots> {
    const { owner, repo } = input;
    const directory = `issues/${String(input.issueNumber)}`;
    const beforePath = `${directory}/before.png`;
    const afterPath = `${directory}/after.png`;
    const blobSha = async (bytes: Buffer): Promise<string> => {
        const { data } = await octokit.rest.git.createBlob({
            owner,
            repo,
            content: bytes.toString('base64'),
            encoding: 'base64',
        });
        return data.sha;
    };
    const beforeBlob = await blobSha(input.before);
    const afterBlob = await blobSha(input.after);

    for (let attempt = 1; ; attempt += 1) {
        const head = await readBranchHead(octokit, owner, repo, branch);
        const { data: tree } = await octokit.rest.git.createTree({
            owner,
            repo,
            ...(head === null ? {} : { base_tree: head.treeSha }),
            tree: [
                { path: beforePath, mode: '100644', type: 'blob', sha: beforeBlob },
                { path: afterPath, mode: '100644', type: 'blob', sha: afterBlob },
            ],
        });
        const { data: commit } = await octokit.rest.git.createCommit({
            owner,
            repo,
            // No `#` before the number: GitHub would add this commit to the issue's timeline.
            message: `Screenshots for issue ${String(input.issueNumber)}`,
            tree: tree.sha,
            parents: head === null ? [] : [head.commitSha],
        });
        try {
            if (head === null) {
                await octokit.rest.git.createRef({
                    owner,
                    repo,
                    ref: `refs/heads/${branch}`,
                    sha: commit.sha,
                });
            } else {
                await octokit.rest.git.updateRef({
                    owner,
                    repo,
                    ref: `heads/${branch}`,
                    sha: commit.sha,
                    force: false,
                });
            }
        } catch (error) {
            if (
                (error as HttpFailure).status === REF_CONFLICT_STATUS &&
                attempt < MAX_BRANCH_UPDATE_ATTEMPTS
            ) {
                continue;
            }
            throw error;
        }
        const address = (path: string): string =>
            gitHubFileUrl(GitHubFileView.Raw, {
                repository: `${owner}/${repo}`,
                commit: commit.sha,
                filePath: path,
            });
        return { beforeUrl: address(beforePath), afterUrl: address(afterPath) };
    }
}

/**
 * Render the collapsed before/after block of the report's screenshots section.
 *
 * @param hosted - Addresses of the two images.
 * @returns The block as Markdown with inline HTML.
 */
export function renderReportScreenshots(hosted: HostedReportScreenshots): string {
    return [
        '<details>',
        '<summary>Without and with the rule</summary>',
        '',
        '| Without the rule | With the rule |',
        '|---|---|',
        `| <img src="${hosted.beforeUrl}" width="${String(SCREENSHOT_WIDTH_PX)}" alt="Page without the rule"> ` +
            `| <img src="${hosted.afterUrl}" width="${String(SCREENSHOT_WIDTH_PX)}" alt="Page with the rule"> |`,
        '',
        '</details>',
    ].join('\n');
}

/**
 * Host the pair on the screenshots branch and render the fill; a refused write keeps the report.
 *
 * @param octokit - Authenticated GitHub API client.
 * @param input - Target repository and issue and the two PNGs.
 * @param branch - Branch the pair is committed to.
 * @param logger - Run logger.
 * @returns The screenshots fill, or the empty string when the token cannot write the branch.
 */
async function hostBranchScreenshots(
    octokit: Octokit,
    input: ReportScreenshotsPair,
    branch: string,
    logger: Logger,
): Promise<string> {
    try {
        return renderReportScreenshots(await hostReportScreenshots(octokit, input, branch));
    } catch (error) {
        if ((error as HttpFailure).status === PERMISSION_REFUSAL_STATUS) {
            logger.warn(
                { issueNumber: input.issueNumber, branch },
                'the report posts without screenshots: grant the workflow `contents: write` to ' +
                    'host them',
            );
            return '';
        }
        throw error;
    }
}

/**
 * Upload the pair as attachments and render the fill; any failure keeps the report.
 *
 * @param octokit - Authenticated GitHub API client.
 * @param input - Target repository and issue and the two PNGs.
 * @param logger - Run logger.
 * @returns The screenshots fill, or the empty string when either upload failed.
 */
async function hostAttachmentScreenshots(
    octokit: Octokit,
    input: ReportScreenshotsPair,
    logger: Logger,
): Promise<string> {
    try {
        return renderReportScreenshots(await uploadReportScreenshotAttachments(octokit, input));
    } catch (error) {
        const warning = describeAttachmentUploadFailure(error);
        logger.warn({ issueNumber: input.issueNumber, ...warning.fields }, warning.message);
        return '';
    }
}

/**
 * Host the screenshots in the request's storage and render the report's screenshots fill.
 *
 * The branch storage tolerates a token without `contents: write` — a workflow choice, not a
 * failure, so the report posts without the images and the warning names the permission to grant —
 * and propagates every other failure. The attachments storage tolerates every upload failure: the
 * report posts without the images and one warning names the request that failed, its status and,
 * when the status says the token was not accepted, what the token needs. In either storage a
 * comment never links an image that did not upload.
 *
 * @param octokit - Authenticated GitHub API client.
 * @param input - Target repository and issue, the target, and the two PNGs.
 * @param logger - Run logger.
 * @returns The screenshots fill, or the empty string when the pair could not be hosted.
 */
export async function renderHostedReportScreenshots(
    octokit: Octokit,
    input: HostReportScreenshotsInput,
    logger: Logger,
): Promise<string> {
    switch (input.target.storage) {
        case ScreenshotsStorage.Branch:
            return await hostBranchScreenshots(octokit, input, input.target.branch, logger);
        case ScreenshotsStorage.Attachments:
            return await hostAttachmentScreenshots(octokit, input, logger);
    }
}
