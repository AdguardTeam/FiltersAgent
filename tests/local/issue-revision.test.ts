import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildLocalIssueSnapshot } from '../../src/local/issue-snapshot';
import {
    EXPORTED_REVISION_MAX_AGGREGATE_BYTES,
    EXPORTED_REVISION_MAX_ATTACHMENT_COUNT,
    buildExportedIssueRevision,
    copyVerifiedAttachmentBytes,
    copyVerifiedAttachments,
    copyVerifiedIssueInput,
    loadVerifiedExportedIssueRevision,
    verifyCapturedIssueRevision,
} from '../../src/local/issue-revision';

const roots: string[] = [];

/**
 * Create one disposable exported-revision bundle.
 *
 * @param bytes - Attachment payloads to materialize.
 * @param repository - Repository identity recorded in the envelope.
 * @returns Bundle paths and its immutable envelope.
 */
function createBundle(
    bytes: readonly Uint8Array[] = [new TextEncoder().encode('image-bytes')],
    repository = 'AdguardTeam/AdguardFilters',
) {
    const root = mkdtempSync(join(tmpdir(), 'agent-revision-'));
    roots.push(root);
    const attachmentsDir = join(root, 'attachments');
    mkdirSync(attachmentsDir);
    const attachments = bytes.map((value, index) => {
        const localPath = `attachments/${index + 1}.bin`;
        writeFileSync(join(root, localPath), value);
        return {
            kind: 'attachment' as const,
            sourceUrl: `https://github.com/user-attachments/assets/${index + 1}`,
            localPath,
            sha256: attachmentHash(value),
            promptVisible: true,
            source: 'body' as const,
        };
    });
    const snapshot = buildLocalIssueSnapshot(
        {
            number: 42,
            reporterAuthor: 'reporter',
            url: 'https://github.com/AdguardTeam/AdguardFilters/issues/42',
            title: 'Ad remains visible',
            body: 'See the attached screenshot.',
            state: 'open',
            labels: ['T: Ads'],
            assignee: null,
            comments: [
                {
                    author: 'reporter',
                    body: 'Still reproducible.',
                    createdAt: '2026-07-23T10:01:00.000Z',
                },
            ],
        },
        attachments,
        { reporterAuthorOnly: 'reporter' },
    );
    const envelope = buildExportedIssueRevision({
        repository,
        issueNumber: 42,
        sourceUpdatedAt: '2026-07-23T10:02:00.000Z',
        capturedAt: '2026-07-23T10:03:00.000Z',
        snapshot,
    });
    const issuePath = join(root, 'issue.json');
    writeFileSync(issuePath, `${JSON.stringify(envelope, null, 2)}\n`);
    return { root, issuePath, envelope };
}

/**
 * Compute the SHA-256 used by local attachment fixtures.
 *
 * @param bytes - Fixture bytes.
 * @returns Lowercase SHA-256 digest.
 */
function attachmentHash(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

afterEach(() => {
    for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

describe('exported issue revisions', () => {
    it('normalizes exported and live bytes into the same bounded work identity', () => {
        const bytes = new TextEncoder().encode('image-bytes');
        const bundle = createBundle([bytes]);
        const exported = loadVerifiedExportedIssueRevision(bundle.issuePath);
        const live = verifyCapturedIssueRevision({
            repository: bundle.envelope.repository,
            issueNumber: bundle.envelope.issueNumber,
            sourceUpdatedAt: bundle.envelope.sourceUpdatedAt,
            capturedAt: bundle.envelope.capturedAt,
            snapshot: bundle.envelope.snapshot,
            attachmentBytes: [bytes],
            inputOrigin: 'live',
        });

        expect(live).toMatchObject({
            inputOrigin: 'live',
            sourceIntegrityDigest: exported.sourceIntegrityDigest,
            sourcePromptIntegrityDigest: exported.sourcePromptIntegrityDigest,
            promptDigest: exported.promptDigest,
            revisionDigest: exported.revisionDigest,
        });
        expect(copyVerifiedIssueInput(live)).toEqual(copyVerifiedIssueInput(exported));
        expect(copyVerifiedAttachmentBytes(live)).toEqual(copyVerifiedAttachmentBytes(exported));
    });

    it('keeps source integrity distinct from the bounded trusted work identity', () => {
        const bundle = createBundle([]);
        const first = verifyCapturedIssueRevision({
            repository: bundle.envelope.repository,
            issueNumber: 42,
            sourceUpdatedAt: '2026-07-23T10:02:00.000Z',
            capturedAt: bundle.envelope.capturedAt,
            snapshot: bundle.envelope.snapshot,
            attachmentBytes: [],
            inputOrigin: 'live',
        });
        const changedSnapshot = buildLocalIssueSnapshot(
            {
                ...bundle.envelope.snapshot.rawIssue,
                comments: [
                    ...bundle.envelope.snapshot.rawIssue.comments,
                    {
                        author: 'maintainer',
                        body: 'Untrusted discussion.',
                        createdAt: '2026-07-23T10:03:00.000Z',
                    },
                ],
            },
            [],
            { reporterAuthorOnly: 'reporter' },
        );
        const second = verifyCapturedIssueRevision({
            repository: bundle.envelope.repository,
            issueNumber: 42,
            sourceUpdatedAt: '2026-07-24T10:02:00.000Z',
            capturedAt: bundle.envelope.capturedAt,
            snapshot: changedSnapshot,
            attachmentBytes: [],
            inputOrigin: 'live',
        });

        expect(second.sourceIntegrityDigest).not.toBe(first.sourceIntegrityDigest);
        expect(second.revisionDigest).toBe(first.revisionDigest);
        expect(second.promptDigest).toBe(first.promptDigest);
    });

    it('rejects complete raw history above the hard limit even when the comment is excluded', () => {
        const bundle = createBundle([]);
        const snapshot = buildLocalIssueSnapshot(
            {
                ...bundle.envelope.snapshot.rawIssue,
                body: null,
                comments: [
                    {
                        author: 'adguard-bot[bot]',
                        body: 'x'.repeat(256_001),
                        createdAt: '2026-07-23T10:03:00.000Z',
                    },
                ],
            },
            [],
            { reporterAuthorOnly: 'reporter' },
        );
        const envelope = buildExportedIssueRevision({
            repository: bundle.envelope.repository,
            issueNumber: bundle.envelope.issueNumber,
            sourceUpdatedAt: bundle.envelope.sourceUpdatedAt,
            capturedAt: bundle.envelope.capturedAt,
            snapshot,
        });
        writeFileSync(bundle.issuePath, JSON.stringify(envelope));

        expect(() => loadVerifiedExportedIssueRevision(bundle.issuePath)).toThrow(/256000|raw/iu);
    });

    it('derives portable deterministic revision and prompt identities', () => {
        const first = createBundle();
        const second = createBundle([], 'adguardteam/adguardfilters');
        const secondSnapshot = {
            ...first.envelope.snapshot,
            attachments: first.envelope.snapshot.attachments.map((attachment) => ({
                ...attachment,
                localPath: '/a/completely/different/bundle/image.bin',
            })),
        };
        const rebuilt = buildExportedIssueRevision({
            repository: ' adguardteam/ADGUARDFILTERS ',
            issueNumber: 42,
            sourceUpdatedAt: first.envelope.sourceUpdatedAt,
            capturedAt: '2027-01-01T00:00:00.000Z',
            snapshot: secondSnapshot,
        });

        expect(rebuilt.repository).toBe('adguardteam/adguardfilters');
        expect(rebuilt.revisionDigest).toBe(first.envelope.revisionDigest);
        expect(rebuilt.promptDigest).toBe(first.envelope.promptDigest);
        expect(second.envelope.revisionDigest).not.toBe(first.envelope.revisionDigest);
    });

    it.each([
        ['title', (value: any) => (value.snapshot.rawIssue.title = 'Changed')],
        [
            'reporter comment',
            (value: any) => {
                value.snapshot.reporterComments[0].body = 'Changed';
                value.snapshot.rawIssue.comments[0].body = 'Changed';
            },
        ],
        [
            'source update time',
            (value: any) => (value.sourceUpdatedAt = '2026-07-24T00:00:00.000Z'),
        ],
        [
            'attachment identity',
            (value: any) => (value.snapshot.attachments[0].sha256 = '0'.repeat(64)),
        ],
    ])('rejects a stale digest after a %s change', (_label, mutate) => {
        const bundle = createBundle();
        const changed = structuredClone(bundle.envelope);
        mutate(changed);
        writeFileSync(bundle.issuePath, JSON.stringify(changed));

        expect(() => loadVerifiedExportedIssueRevision(bundle.issuePath)).toThrow(/digest/i);
    });

    it.each(['repository', 'issueNumber', 'sourceUpdatedAt', 'revisionDigest', 'promptDigest'])(
        'rejects a missing %s field',
        (field) => {
            const bundle = createBundle();
            const changed = structuredClone(bundle.envelope) as Record<string, unknown>;
            delete changed[field];
            writeFileSync(bundle.issuePath, JSON.stringify(changed));

            expect(() => loadVerifiedExportedIssueRevision(bundle.issuePath)).toThrow();
        },
    );

    it('captures prompt data and attachment bytes before the source bundle changes', () => {
        const original = new TextEncoder().encode('original');
        const bundle = createBundle([original]);
        const verified = loadVerifiedExportedIssueRevision(bundle.issuePath);
        writeFileSync(bundle.issuePath, JSON.stringify({ broken: true }));
        writeFileSync(join(bundle.root, 'attachments/1.bin'), 'replacement');

        expect(verified.sourceIntegrityDigest).toBe(bundle.envelope.revisionDigest);
        expect(copyVerifiedIssueInput(verified).title).toBe('Ad remains visible');
        expect(copyVerifiedAttachmentBytes(verified)).toEqual([original]);
    });

    it('derives a safe screenshot extension from verified file magic', () => {
        const png = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
            'base64',
        );
        const bundle = createBundle([png]);
        const snapshot = {
            ...bundle.envelope.snapshot,
            attachments: bundle.envelope.snapshot.attachments.map((attachment) => ({
                ...attachment,
                kind: 'issue_screenshot' as const,
                localPath: 'attachments/1.bin',
            })),
        };
        const envelope = buildExportedIssueRevision({
            repository: bundle.envelope.repository,
            issueNumber: bundle.envelope.issueNumber,
            sourceUpdatedAt: bundle.envelope.sourceUpdatedAt,
            capturedAt: bundle.envelope.capturedAt,
            snapshot,
        });
        writeFileSync(bundle.issuePath, JSON.stringify(envelope));

        const [captured] = copyVerifiedAttachments(
            loadVerifiedExportedIssueRevision(bundle.issuePath),
        );

        expect(captured?.attachment.localPath).toMatch(/\.png$/u);
        expect(Buffer.from(captured?.bytes ?? [])).toEqual(png);
    });

    it('accepts zero and exactly twelve attachments but rejects thirteen before file access', () => {
        const empty = createBundle([]);
        expect(
            copyVerifiedAttachmentBytes(loadVerifiedExportedIssueRevision(empty.issuePath)),
        ).toEqual([]);

        const twelve = createBundle(
            Array.from(
                { length: EXPORTED_REVISION_MAX_ATTACHMENT_COUNT },
                (_, index) => new Uint8Array([index]),
            ),
        );
        expect(
            copyVerifiedAttachmentBytes(loadVerifiedExportedIssueRevision(twelve.issuePath)),
        ).toHaveLength(EXPORTED_REVISION_MAX_ATTACHMENT_COUNT);

        const thirteen = createBundle(
            Array.from(
                { length: EXPORTED_REVISION_MAX_ATTACHMENT_COUNT },
                () => new Uint8Array([1]),
            ),
        );
        const changed = structuredClone(thirteen.envelope);
        changed.snapshot.attachments.push({
            ...changed.snapshot.attachments[0],
            localPath: 'attachments/does-not-exist.bin',
        });
        writeFileSync(thirteen.issuePath, JSON.stringify(changed));
        expect(() => loadVerifiedExportedIssueRevision(thirteen.issuePath)).toThrow(
            /12 attachments/i,
        );
    });

    it('accepts the aggregate byte limit and rejects the first byte beyond it', () => {
        const exactBytes = new Uint8Array(EXPORTED_REVISION_MAX_AGGREGATE_BYTES);
        const exact = createBundle([exactBytes]);
        expect(
            copyVerifiedAttachmentBytes(loadVerifiedExportedIssueRevision(exact.issuePath))[0],
        ).toHaveLength(EXPORTED_REVISION_MAX_AGGREGATE_BYTES);

        const tooLarge = createBundle([
            new Uint8Array(EXPORTED_REVISION_MAX_AGGREGATE_BYTES),
            new Uint8Array([1]),
        ]);
        expect(() => loadVerifiedExportedIssueRevision(tooLarge.issuePath)).toThrow(/48 MiB/i);
    });

    it('rejects changed attachment bytes', () => {
        const bundle = createBundle();
        writeFileSync(join(bundle.root, 'attachments/1.bin'), 'tampered');
        expect(() => loadVerifiedExportedIssueRevision(bundle.issuePath)).toThrow(/SHA-256/i);
    });
});
