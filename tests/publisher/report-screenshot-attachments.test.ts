import { describe, expect, it } from 'vitest';
import { Octokit } from '@octokit/rest';
import {
    AttachmentUploadStep,
    uploadReportScreenshotAttachments,
} from '../../src/publisher/report-screenshot-attachments';

const OWNER = 'example-owner';
const REPO = 'example-repo';
const ISSUE_NUMBER = 22;
const TOKEN = 'test-token';
const REPOSITORY_ID = 987_654;
const BEFORE_URL =
    'https://github.com/user-attachments/assets/11111111-1111-4111-8111-111111111111';
const AFTER_URL = 'https://github.com/user-attachments/assets/22222222-2222-4222-8222-222222222222';

// The PNG signature opens both fixtures: its first byte is above 0x7f, so a body sent as text
// instead of raw bytes no longer equals the fixture.
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const BEFORE_PNG = Buffer.from([...PNG_SIGNATURE, 0xff, 0x00, 0x01]);
const AFTER_PNG = Buffer.from([...PNG_SIGNATURE, 0xfe, 0x80, 0x02]);

/**
 * One request the fake transport received.
 */
interface RecordedRequest {
    /**
     * Parsed request URL.
     */
    url: URL;

    /**
     * HTTP method the client sent.
     */
    method: string;

    /**
     * Request headers, lower-cased by `Headers`.
     */
    headers: Headers;

    /**
     * Request body as bytes; absent for a request without one.
     */
    body: Buffer | undefined;
}

/**
 * One scripted transport answer.
 */
type Answer = (request: RecordedRequest) => Response;

/**
 * Build a JSON response.
 *
 * @param body - Parsed JSON body the answer carries.
 * @param status - HTTP status of the answer.
 * @returns The response the fake transport hands the client.
 */
function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

/**
 * Build a real Octokit client whose transport records every request and answers from a queue.
 *
 * @param answers - One answer per request, in the order the client sends them.
 * @returns The client and the recorded requests.
 */
function recordingOctokit(answers: readonly Answer[]): {
    octokit: Octokit;
    requests: RecordedRequest[];
} {
    const queue = [...answers];
    const requests: RecordedRequest[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
        const href =
            typeof input === 'string'
                ? input
                : input instanceof URL
                  ? input.href
                  : (input as Request).url;
        const request: RecordedRequest = {
            url: new URL(href),
            method: init?.method ?? 'GET',
            headers: new Headers(init?.headers),
            body: init?.body === undefined ? undefined : Buffer.from(init.body as Uint8Array),
        };
        requests.push(request);
        const answer = queue.shift();
        if (answer === undefined) {
            throw new Error(`unexpected request: ${href}`);
        }
        return answer(request);
    };
    const octokit = new Octokit({
        auth: TOKEN,
        request: { fetch },
        // The client logs every request through this logger; a silent one keeps it out of the test
        // output.
        log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    });
    return { octokit, requests };
}

/**
 * The answer naming the repository's numeric id.
 *
 * @returns The transport answer.
 */
function repositoryIdAnswer(): Answer {
    return () => jsonResponse({ id: REPOSITORY_ID });
}

/**
 * The answer naming one attachment address.
 *
 * @param url - Address the answer names.
 * @returns The transport answer.
 */
function attachmentAnswer(url: string): Answer {
    return () => jsonResponse({ url }, 201);
}

const INPUT = {
    owner: OWNER,
    repo: REPO,
    issueNumber: ISSUE_NUMBER,
    before: BEFORE_PNG,
    after: AFTER_PNG,
};

describe('uploadReportScreenshotAttachments', () => {
    it('reads the repository id, then uploads before and after', async () => {
        const { octokit, requests } = recordingOctokit([
            repositoryIdAnswer(),
            attachmentAnswer(BEFORE_URL),
            attachmentAnswer(AFTER_URL),
        ]);

        await uploadReportScreenshotAttachments(octokit, INPUT);

        expect(requests).toHaveLength(3);
        expect(requests[0]?.method).toBe('GET');
        expect(requests[0]?.url.href).toBe(`https://api.github.com/repos/${OWNER}/${REPO}`);
        expect(requests[1]?.url.searchParams.get('name')).toBe('issue-22-before.png');
        expect(requests[2]?.url.searchParams.get('name')).toBe('issue-22-after.png');
    });

    it('sends each image to the attachments endpoint as raw bytes', async () => {
        const { octokit, requests } = recordingOctokit([
            repositoryIdAnswer(),
            attachmentAnswer(BEFORE_URL),
            attachmentAnswer(AFTER_URL),
        ]);

        await uploadReportScreenshotAttachments(octokit, INPUT);

        const expected = [
            { name: 'issue-22-before.png', bytes: BEFORE_PNG },
            { name: 'issue-22-after.png', bytes: AFTER_PNG },
        ];
        for (const [index, upload] of expected.entries()) {
            const request = requests[index + 1]!;
            expect(request.method).toBe('POST');
            expect(request.url.origin).toBe('https://uploads.github.com');
            expect(request.url.pathname).toBe('/user-attachments/assets');
            expect(request.url.searchParams.get('name')).toBe(upload.name);
            expect(request.url.searchParams.get('content_type')).toBe('image/png');
            expect(request.url.searchParams.get('repository_id')).toBe(String(REPOSITORY_ID));
            expect(request.headers.get('content-type')).toBe('application/octet-stream');
            expect(request.headers.get('authorization')).toContain(TOKEN);
            expect(request.body).toEqual(upload.bytes);
        }
    });

    it('returns the addresses the answers name', async () => {
        const { octokit } = recordingOctokit([
            repositoryIdAnswer(),
            attachmentAnswer(BEFORE_URL),
            attachmentAnswer(AFTER_URL),
        ]);

        await expect(uploadReportScreenshotAttachments(octokit, INPUT)).resolves.toEqual({
            beforeUrl: BEFORE_URL,
            afterUrl: AFTER_URL,
        });
    });

    it("rejects with the status and GitHub's message when an upload is refused", async () => {
        const { octokit } = recordingOctokit([
            repositoryIdAnswer(),
            () => jsonResponse({ message: 'Not Found' }, 404),
        ]);

        const failure = await uploadReportScreenshotAttachments(octokit, INPUT).then(
            () => {
                throw new Error('expected the upload to fail');
            },
            (error: unknown) => error as Error & { step?: string; failure?: { status?: number } },
        );

        expect(failure.step).toBe(AttachmentUploadStep.BeforeUpload);
        expect(failure.failure?.status).toBe(404);
        expect(failure.message).toContain('Not Found');
    });

    it('rejects when the second upload fails after the first succeeded', async () => {
        const { octokit, requests } = recordingOctokit([
            repositoryIdAnswer(),
            attachmentAnswer(BEFORE_URL),
            () => jsonResponse({ message: 'Unprocessable Entity' }, 422),
        ]);

        await expect(uploadReportScreenshotAttachments(octokit, INPUT)).rejects.toMatchObject({
            step: AttachmentUploadStep.AfterUpload,
            failure: { status: 422 },
        });
        expect(requests).toHaveLength(3);
    });

    it('rejects and uploads nothing when the repository id cannot be read', async () => {
        const { octokit, requests } = recordingOctokit([
            () => jsonResponse({ message: 'Not Found' }, 404),
        ]);

        await expect(uploadReportScreenshotAttachments(octokit, INPUT)).rejects.toMatchObject({
            step: AttachmentUploadStep.RepositoryRead,
            failure: { status: 404 },
        });
        expect(requests).toHaveLength(1);
    });

    it('rejects an answer that names no address', async () => {
        const { octokit } = recordingOctokit([repositoryIdAnswer(), () => jsonResponse({}, 201)]);

        await expect(uploadReportScreenshotAttachments(octokit, INPUT)).rejects.toMatchObject({
            step: AttachmentUploadStep.BeforeUpload,
        });
    });
});
