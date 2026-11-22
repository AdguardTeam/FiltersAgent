/**
 * Attachment upload of the report's before and after screenshots.
 *
 * GitHub accepts an image at `POST https://uploads.github.com/user-attachments/assets` and answers
 * with a `https://github.com/user-attachments/assets/<uuid>` address: the same store the web editor
 * uses when an image is dropped into a comment, so the address opens inline in the posted comment.
 * The endpoint needs a user account's token with write access to the repository and answers 404 for
 * anything else, the workflow token included, whatever permissions the workflow grants.
 *
 * One upload cannot be undone: the endpoint has no delete call, so an image that uploaded while its
 * partner failed stays on GitHub unreferenced. Every failure therefore reaches the caller, named by
 * the request that failed, and the caller contains it to the screenshots alone.
 */

import type { Octokit } from '@octokit/rest';
import * as v from 'valibot';
import { GITHUB_USER_TOKEN_VAR } from '../config/run-token';
import type { HostedReportScreenshots, ReportScreenshotsPair } from './report-screenshots';

/**
 * Route of the attachment store: the query names the file, its image type and the repository the
 * token must be allowed to write.
 */
const ATTACHMENT_UPLOAD_ROUTE =
    'POST https://uploads.github.com/user-attachments/assets{?name,content_type,repository_id}';

/**
 * Image type of an uploaded screenshot; the report's pair is always PNG.
 */
const ATTACHMENT_CONTENT_TYPE = 'image/png';

/**
 * Content type of the upload request itself: the body carries the raw image bytes.
 */
const ATTACHMENT_REQUEST_CONTENT_TYPE = 'application/octet-stream';

/**
 * The two screenshots of an issue, in upload order.
 */
const ScreenshotPhase = {
    /**
     * The page without the rule.
     */
    Before: 'before',

    /**
     * The page with the rule.
     */
    After: 'after',
} as const;

/**
 * ScreenshotPhase value.
 */
type ScreenshotPhase = (typeof ScreenshotPhase)[keyof typeof ScreenshotPhase];

/**
 * The JSON answer of one upload: the image's address.
 */
const AttachmentUploadAnswerSchema = v.object({
    url: v.pipe(v.string(), v.url()),
});

/**
 * The three requests of one upload, in order; a failure names the one that failed.
 */
export const AttachmentUploadStep = {
    /**
     * The read of the repository's numeric id.
     */
    RepositoryRead: 'repository_read',

    /**
     * The upload of the page without the rule.
     */
    BeforeUpload: 'before_upload',

    /**
     * The upload of the page with the rule.
     */
    AfterUpload: 'after_upload',
} as const;

/**
 * AttachmentUploadStep value.
 */
export type AttachmentUploadStep = (typeof AttachmentUploadStep)[keyof typeof AttachmentUploadStep];

/**
 * The upload step of each screenshot.
 */
const UPLOAD_STEP: Record<ScreenshotPhase, AttachmentUploadStep> = {
    [ScreenshotPhase.Before]: AttachmentUploadStep.BeforeUpload,
    [ScreenshotPhase.After]: AttachmentUploadStep.AfterUpload,
};

/**
 * One failed upload: the request that failed and what it threw.
 */
export class AttachmentUploadError extends Error {
    /**
     * The request that failed.
     */
    readonly step: AttachmentUploadStep;

    /**
     * What the request threw, unchanged: a refused status, a transport error, an answer without an
     * address.
     */
    readonly failure: unknown;

    constructor(step: AttachmentUploadStep, failure: unknown) {
        super(
            `attachment upload failed at ${step}: ` +
                (failure instanceof Error ? failure.message : String(failure)),
        );
        this.name = 'AttachmentUploadError';
        this.step = step;
        this.failure = failure;
    }
}

/**
 * Run one request of the upload and name it on failure.
 *
 * @param step - The request being run.
 * @param request - The request itself.
 * @returns What the request resolved to.
 * @throws AttachmentUploadError carrying the step and the thrown value.
 */
async function atStep<T>(step: AttachmentUploadStep, request: () => Promise<T>): Promise<T> {
    try {
        return await request();
    } catch (failure) {
        throw new AttachmentUploadError(step, failure);
    }
}

/**
 * One upload's own inputs.
 */
interface AttachmentUpload {
    /**
     * Numeric repository id the token must write.
     */
    repositoryId: number;

    /**
     * Issue the screenshot belongs to.
     */
    issueNumber: number;

    /**
     * Which of the two screenshots this upload carries.
     */
    phase: ScreenshotPhase;

    /**
     * The image bytes.
     */
    bytes: Buffer;
}

/**
 * Name one uploaded file after its issue role.
 *
 * @param issueNumber - Issue the screenshot belongs to.
 * @param phase - Which of the two screenshots it is.
 * @returns The upload's file name.
 */
function attachmentFileName(issueNumber: number, phase: ScreenshotPhase): string {
    return `issue-${String(issueNumber)}-${phase}.png`;
}

/**
 * Upload one screenshot and read its address.
 *
 * The request goes through the run's own client, so no token travels into this module; a failure —
 * a refused status, a transport error, an answer without an address — throws.
 *
 * @param octokit - Authenticated GitHub API client.
 * @param upload - The repository, the issue role and the bytes.
 * @returns The address the answer names.
 */
async function uploadAttachment(octokit: Octokit, upload: AttachmentUpload): Promise<string> {
    const { data } = await octokit.request(ATTACHMENT_UPLOAD_ROUTE, {
        name: attachmentFileName(upload.issueNumber, upload.phase),
        content_type: ATTACHMENT_CONTENT_TYPE,
        repository_id: upload.repositoryId,
        data: upload.bytes,
        headers: { 'content-type': ATTACHMENT_REQUEST_CONTENT_TYPE },
    });
    const answer = v.parse(AttachmentUploadAnswerSchema, data);
    return answer.url;
}

/**
 * Upload the before and after screenshots of one report as attachments and return their addresses.
 *
 * The repository id is read first because the endpoint scopes the upload to it; `before` uploads
 * before `after`. Every failure propagates: a caller that cannot host both images must post the
 * report without screenshots rather than link an image that did not upload.
 *
 * @param octokit - Authenticated GitHub API client.
 * @param pair - Target repository and issue and the two PNGs.
 * @returns Addresses of both uploaded images.
 * @throws AttachmentUploadError naming the request that failed.
 */
export async function uploadReportScreenshotAttachments(
    octokit: Octokit,
    pair: ReportScreenshotsPair,
): Promise<HostedReportScreenshots> {
    const { data } = await atStep(AttachmentUploadStep.RepositoryRead, () =>
        octokit.rest.repos.get({ owner: pair.owner, repo: pair.repo }),
    );
    const upload = (phase: ScreenshotPhase, bytes: Buffer): Promise<string> =>
        atStep(UPLOAD_STEP[phase], () =>
            uploadAttachment(octokit, {
                repositoryId: data.id,
                issueNumber: pair.issueNumber,
                phase,
                bytes,
            }),
        );
    const beforeUrl = await upload(ScreenshotPhase.Before, pair.before);
    const afterUrl = await upload(ScreenshotPhase.After, pair.after);
    return { beforeUrl, afterUrl };
}

/**
 * Statuses GitHub answers with when it does not accept the token for the upload: bad credentials, a
 * forbidden write, and the 404 it gives a token that may not write the repository — the workflow
 * token included.
 */
const TOKEN_REFUSAL_STATUSES: readonly number[] = [401, 403, 404];

/**
 * What every upload-failure warning says.
 */
const UPLOAD_FAILURE_MESSAGE = 'the report posts without screenshots: the attachment upload failed';

/**
 * What the warning adds when the status says the token was not accepted.
 */
const TOKEN_REFUSAL_HINT =
    `. ${GITHUB_USER_TOKEN_VAR} (the action's \`githubUserToken\` input) must hold the token of a ` +
    'user account with write access to the repository';

/**
 * The part of a request failure the warning reads.
 */
interface HttpFailure {
    /**
     * HTTP status of the failed request; absent when the failure never reached a response.
     */
    status?: number;
}

/**
 * The fields the upload-failure warning logs.
 */
interface AttachmentFailureFields {
    /**
     * The request that failed; absent when the thrown value did not name one.
     */
    step?: AttachmentUploadStep;

    /**
     * HTTP status of the failed request; absent when the failure carries none.
     */
    status?: number;

    /**
     * The failure's message, or the string form of anything that is not an `Error`.
     */
    failure: string;

    /**
     * The failure's stack; absent when the failure is not an `Error`.
     */
    stack?: string;
}

/**
 * One upload failure as the run logs it.
 */
export interface AttachmentFailureWarning {
    /**
     * The warn fields.
     */
    fields: AttachmentFailureFields;

    /**
     * The warn message.
     */
    message: string;
}

/**
 * Describe one upload failure for the run log.
 *
 * The error object itself never reaches the log: Octokit's request error keeps the request on it,
 * and for an upload that request's body is the PNG buffer, which pino's error serializer would
 * write into the log as an array of numbers. The token hint is added only for a status that says
 * the token was not accepted: a transport error or a malformed answer is not the token's doing.
 *
 * @param error - The value the upload threw; anything at all, `null` and `undefined` included.
 * @returns The fields and the message of the warning.
 */
export function describeAttachmentUploadFailure(error: unknown): AttachmentFailureWarning {
    const failure = error instanceof AttachmentUploadError ? error.failure : error;
    const status = (failure as HttpFailure | null | undefined)?.status;
    const refused = typeof status === 'number' && TOKEN_REFUSAL_STATUSES.includes(status);
    return {
        fields: {
            ...(error instanceof AttachmentUploadError ? { step: error.step } : {}),
            ...(typeof status === 'number' ? { status } : {}),
            failure: failure instanceof Error ? failure.message : String(failure),
            ...(failure instanceof Error && failure.stack !== undefined
                ? { stack: failure.stack }
                : {}),
        },
        message: refused
            ? `${UPLOAD_FAILURE_MESSAGE}${TOKEN_REFUSAL_HINT}`
            : UPLOAD_FAILURE_MESSAGE,
    };
}
