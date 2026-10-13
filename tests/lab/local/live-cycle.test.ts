import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runTargetedLiveIssueCycle } from '../../../lab/local/live-cycle';

const github = { owner: 'AdguardTeam', repo: 'AdguardFilters', token: 'github-secret' };

function runtimeOptions() {
    return {
        browserMode: 'auto' as const,
        keepTemporaryFiles: false,
        verbose: false,
    };
}

describe('targeted live local cycle', () => {
    it('sanitizes GitHub intake failures before writing a targeted result', async () => {
        const root = mkdtempSync(join(tmpdir(), 'live-cycle-secret-'));
        const outputDir = join(root, 'targeted');
        const result = await runTargetedLiveIssueCycle(
            { github, issueNumber: 4, outputDir, ...runtimeOptions() },
            {
                captureIssueRevision: async () => {
                    throw new Error(`GitHub rejected ${github.token}`);
                },
                createCycleId: () => '44444444-4444-4444-8444-444444444444',
                now: () => '2026-07-23T12:00:00.000Z',
            },
        );

        expect(result.status).toBe('live_intake_failed');
        expect(readFileSync(join(outputDir, 'cycle-result.json'), 'utf8')).not.toContain(
            github.token,
        );
    });

    it('keeps invalid capture failures typed and sanitized', async () => {
        const root = mkdtempSync(join(tmpdir(), 'live-cycle-invalid-capture-'));
        const outputDir = join(root, 'targeted');
        const result = await runTargetedLiveIssueCycle(
            { github, issueNumber: 4, outputDir, ...runtimeOptions() },
            {
                captureIssueRevision: async () => ({
                    kind: 'invalid',
                    code: 'invalid_revision',
                    message: `invalid snapshot ${github.token}`,
                }),
                createCycleId: () => '99999999-9999-4999-8999-999999999999',
                now: () => '2026-07-23T12:00:00.000Z',
            },
        );

        expect(result).toMatchObject({
            status: 'invalid_live_revision',
            failure: { code: 'invalid_live_revision' },
        });
        expect(readFileSync(join(outputDir, 'cycle-result.json'), 'utf8')).not.toContain(
            github.token,
        );
    });
});
