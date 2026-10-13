import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import {
    applyQueueDefaults,
    DEFAULT_TRUSTED_ROLES,
    QueueInputsSchema,
    QUEUE_DEFAULTS,
    REVISION_ROLLING_WINDOW_MS,
    TrustedRole,
} from '../../src/queue/queue-inputs';
import { formatIssues } from '../../src/pi/valibot-issues';

const CAPTURED_AT = '2026-09-09T12:00:00.000Z';

const REPORT_AUTHOR_LOGIN = 'adguard-filters-agent';

const ONE_DAY_MS = 24 * 60 * 60 * 1_000;

const QUEUE_INPUT_FAILURES: ReadonlyArray<{
    name: string;
    override: Record<string, unknown>;
    field: string;
}> = [
    { name: 'zero maxIssuesPerRun', override: { maxIssuesPerRun: 0 }, field: 'maxIssuesPerRun' },
    {
        name: 'negative maxIssuesPerRun',
        override: { maxIssuesPerRun: -1 },
        field: 'maxIssuesPerRun',
    },
    {
        name: 'zero maxRevisionsPerWindow',
        override: { maxRevisionsPerWindow: 0 },
        field: 'maxRevisionsPerWindow',
    },
    {
        name: 'negative maxRevisionsPerWindow',
        override: { maxRevisionsPerWindow: -1 },
        field: 'maxRevisionsPerWindow',
    },
    { name: 'zero revisionWindowMs', override: { revisionWindowMs: 0 }, field: 'revisionWindowMs' },
    {
        name: 'negative revisionWindowMs',
        override: { revisionWindowMs: -1 },
        field: 'revisionWindowMs',
    },
    { name: 'non-ISO capturedAt', override: { capturedAt: 'yesterday' }, field: 'capturedAt' },
    {
        name: 'missing capturedAt',
        override: { capturedAt: undefined },
        field: 'capturedAt',
    },
    {
        name: 'missing reportAuthorLogin',
        override: { reportAuthorLogin: undefined },
        field: 'reportAuthorLogin',
    },
    {
        name: 'empty reportAuthorLogin',
        override: { reportAuthorLogin: '' },
        field: 'reportAuthorLogin',
    },
    {
        name: 'unknown trusted role',
        override: { trustedRoles: ['CONTRIBUTOR'] },
        field: 'trustedRoles',
    },
    {
        name: 'negative trusted-role entry',
        override: { trustedRoles: [-1] },
        field: 'trustedRoles',
    },
];

describe('QUEUE_DEFAULTS', () => {
    it('carries exactly the lab defaults for the limit, the revision budget, and the trusted roles', () => {
        expect(QUEUE_DEFAULTS.maxIssuesPerRun).toBe(50);
        expect(QUEUE_DEFAULTS.maxRevisionsPerWindow).toBe(3);
        expect(QUEUE_DEFAULTS.revisionWindowMs).toBe(REVISION_ROLLING_WINDOW_MS);
        expect(QUEUE_DEFAULTS.revisionWindowMs).toBe(ONE_DAY_MS);
        expect(QUEUE_DEFAULTS.trustedRoles).toEqual([
            TrustedRole.Owner,
            TrustedRole.Member,
            TrustedRole.Collaborator,
        ]);
        expect(QUEUE_DEFAULTS.trustedRoles).toEqual(['OWNER', 'MEMBER', 'COLLABORATOR']);
    });
});

describe('applyQueueDefaults', () => {
    it('falls back per missing field to the lab defaults, and the defaulted record validates', () => {
        const inputs = v.parse(
            QueueInputsSchema,
            applyQueueDefaults({ capturedAt: CAPTURED_AT, reportAuthorLogin: REPORT_AUTHOR_LOGIN }),
        );

        expect(inputs.capturedAt).toBe(CAPTURED_AT);
        expect(inputs.reportAuthorLogin).toBe(REPORT_AUTHOR_LOGIN);
        expect(inputs.maxIssuesPerRun).toBe(50);
        expect(inputs.maxRevisionsPerWindow).toBe(3);
        expect(inputs.revisionWindowMs).toBe(ONE_DAY_MS);
        expect(inputs.trustedRoles).toEqual(DEFAULT_TRUSTED_ROLES);
    });

    it('keeps each value the caller provided and fills only the unset fields', () => {
        const defaulted = applyQueueDefaults({
            capturedAt: CAPTURED_AT,
            reportAuthorLogin: REPORT_AUTHOR_LOGIN,
            maxIssuesPerRun: 2,
            maxRevisionsPerWindow: 5,
            revisionWindowMs: 60_000,
            trustedRoles: [TrustedRole.Member],
            excludedLabels: ['NSFW'],
        });

        expect(defaulted).toEqual({
            capturedAt: CAPTURED_AT,
            reportAuthorLogin: REPORT_AUTHOR_LOGIN,
            maxIssuesPerRun: 2,
            maxRevisionsPerWindow: 5,
            revisionWindowMs: 60_000,
            trustedRoles: [TrustedRole.Member],
            excludedLabels: ['NSFW'],
        });
    });

    it('never invents a run clock or identity: an empty record leaves both unset for the schema to name', () => {
        const defaulted = applyQueueDefaults({});

        expect(defaulted.capturedAt).toBeUndefined();
        expect(defaulted.reportAuthorLogin).toBeUndefined();
        expect(defaulted.maxIssuesPerRun).toBe(50);
        expect(defaulted.trustedRoles).toEqual(DEFAULT_TRUSTED_ROLES);
    });
});

describe('applyQueueDefaults narrowing', () => {
    it('keeps narrowing provided by the caller and leaves it unset otherwise', () => {
        const narrowing = { labels: ['T: Ads'], maxAgeDays: 30 };
        const provided = applyQueueDefaults({
            capturedAt: CAPTURED_AT,
            reportAuthorLogin: REPORT_AUTHOR_LOGIN,
            narrowing,
        });
        const plain = applyQueueDefaults({
            capturedAt: CAPTURED_AT,
            reportAuthorLogin: REPORT_AUTHOR_LOGIN,
        });

        expect(provided.narrowing).toEqual(narrowing);
        expect(plain.narrowing).toBeUndefined();
    });

    it('validates provided narrowing for the queue schema and fails named when wrong', () => {
        const inputs = v.parse(
            QueueInputsSchema,
            applyQueueDefaults({
                capturedAt: CAPTURED_AT,
                reportAuthorLogin: REPORT_AUTHOR_LOGIN,
                narrowing: { labels: ['T: Ads'] },
            }),
        );
        expect(inputs.narrowing).toEqual({ labels: ['T: Ads'] });

        const raw = applyQueueDefaults({
            capturedAt: CAPTURED_AT,
            reportAuthorLogin: REPORT_AUTHOR_LOGIN,
            narrowing: { maxAgeDays: 0 },
        });
        const result = v.safeParse(QueueInputsSchema, raw);
        if (result.success) {
            throw new Error('Expected a zero maxAgeDays to fail queue inputs validation.');
        }
        expect(formatIssues(result.issues)).toContain('maxAgeDays');
    });
});

describe('QueueInputsSchema', () => {
    it('validates a fully set record verbatim', () => {
        const inputs = v.parse(QueueInputsSchema, {
            capturedAt: CAPTURED_AT,
            reportAuthorLogin: REPORT_AUTHOR_LOGIN,
            maxIssuesPerRun: 10,
            maxRevisionsPerWindow: 2,
            revisionWindowMs: 3_600_000,
            trustedRoles: [TrustedRole.Collaborator],
            excludedLabels: ['NSFW'],
        });

        expect(inputs).toEqual({
            capturedAt: CAPTURED_AT,
            reportAuthorLogin: REPORT_AUTHOR_LOGIN,
            maxIssuesPerRun: 10,
            maxRevisionsPerWindow: 2,
            revisionWindowMs: 3_600_000,
            trustedRoles: [TrustedRole.Collaborator],
            excludedLabels: ['NSFW'],
        });
    });

    it.each(QUEUE_INPUT_FAILURES)(
        '$name fails validation naming the offending field',
        ({ override, field }) => {
            const raw = {
                ...applyQueueDefaults({
                    capturedAt: CAPTURED_AT,
                    reportAuthorLogin: REPORT_AUTHOR_LOGIN,
                }),
                ...override,
            };

            const result = v.safeParse(QueueInputsSchema, raw);
            if (result.success) {
                throw new Error(
                    `Expected override ${JSON.stringify(override)} to fail validation.`,
                );
            }

            expect(formatIssues(result.issues)).toContain(field);
        },
    );
});
