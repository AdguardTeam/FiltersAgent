import {
    mkdtempSync as createLocalCycleTemporaryDirectory,
    existsSync,
    readFileSync,
    realpathSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import {
    afterEach as cleanupLocalCycleFixturesAfterEachTestCase,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { CoreConfig } from '../../../src/config/config';
import { recordPreflightDiagnostic } from '../../../src/local/preflight-diagnostic-log';
import { buildLocalIssueSnapshot } from '../../../src/local/issue-snapshot';
import { buildExportedIssueRevision } from '../../../src/local/issue-revision';
import { LocalCycleResultSchema, runExportedSnapshotCycle } from '../../../lab/local/local-cycle';
import { testCoreConfig } from '../../config/test-core-config';

const roots: string[] = [];

const coreConfig: CoreConfig = testCoreConfig({
    llm: {
        baseUrl: 'https://llm.example.com/api/v1',
        apiKey: 'host-only-secret',
        visionModel: 'gemini-3.5-flash',
    },
});

/**
 * Create a valid portable revision bundle and separate cycle output root.
 *
 * @returns Paths needed by one coordinator test.
 */
function createFixture(): { issuePath: string; outputDir: string } {
    const root = createLocalCycleTemporaryDirectory(join(tmpdir(), 'agent-local-cycle-'));
    roots.push(root);
    const snapshot = buildLocalIssueSnapshot(
        {
            number: 4,
            reporterAuthor: 'reporter',
            url: 'https://github.com/AdguardTeam/AdguardFilters/issues/4',
            title: 'Ad remains visible',
            body: 'https://example.test',
            state: 'open',
            labels: ['T: Ads'],
            assignee: null,
            comments: [],
        },
        [],
    );
    const envelope = buildExportedIssueRevision({
        repository: 'AdguardTeam/AdguardFilters',
        issueNumber: 4,
        sourceUpdatedAt: '2026-07-23T10:02:00.000Z',
        capturedAt: '2026-07-23T10:03:00.000Z',
        snapshot,
    });
    const issuePath = join(root, 'issue.json');
    writeFileSync(issuePath, JSON.stringify(envelope));
    return { issuePath, outputDir: join(root, 'cycle') };
}

/**
 * Return the common cycle options for one fixture.
 *
 * @param fixture - Bundle and output paths.
 * @returns Coordinator options.
 */
function cycleOptions(fixture: ReturnType<typeof createFixture>) {
    return {
        issueNumber: 4,
        issueFile: fixture.issuePath,
        outputDir: fixture.outputDir,
        environment: 'current' as const,
        keepTemporaryFiles: false,
        browserMode: 'auto' as const,
        verbose: false,
    };
}

cleanupLocalCycleFixturesAfterEachTestCase(() => {
    for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

describe('runExportedSnapshotCycle', () => {
    it('writes a completed result with a fresh cycle identity', async () => {
        const fixture = createFixture();
        const resultPath = join(fixture.outputDir, 'investigation/run-result.json');
        const runLocalFixFromRevision = vi.fn(async () => {
            writeFileSync(resultPath, JSON.stringify({ result: { runStatus: 'analysis_only' } }));
            return {
                agentReportPath: join(fixture.outputDir, 'investigation/agent-report.md'),
                agentDecisionPath: null,
                agentObservationsPath: join(
                    fixture.outputDir,
                    'investigation/agent-observations.json',
                ),
                runResultPath: resultPath,
                manifestPath: '',
                candidatePatchPath: null,
            };
        });

        const first = await runExportedSnapshotCycle(cycleOptions(fixture), {
            loadLocalCoreConfig: () => coreConfig,
            runLocalFixFromRevision,
            createCycleId: () => '11111111-1111-4111-8111-111111111111',
            now: () => '2026-07-23T10:04:00.000Z',
        });
        const second = await runExportedSnapshotCycle(cycleOptions(fixture), {
            loadLocalCoreConfig: () => coreConfig,
            runLocalFixFromRevision,
            createCycleId: () => '22222222-2222-4222-8222-222222222222',
            now: () => '2026-07-23T10:05:00.000Z',
        });

        expect(first.status).toBe('completed');
        expect(first.outcome).toEqual({ kind: 'product', category: 'inconclusive' });
        expect(first.cycleId).not.toBe(second.cycleId);
        expect(first.revision).toMatchObject({
            issueNumber: 4,
            repository: 'adguardteam/adguardfilters',
            inputOrigin: 'exported',
        });
        expect(v.parse(LocalCycleResultSchema, first)).toEqual(first);
        expect(
            JSON.parse(readFileSync(join(fixture.outputDir, 'cycle-result.json'), 'utf8')),
        ).toEqual(second);
        expect(runLocalFixFromRevision).toHaveBeenCalledTimes(2);
    });

    it('keeps every diagnostic the investigation records in a per-cycle log file', async () => {
        const fixture = createFixture();
        const resultPath = join(fixture.outputDir, 'investigation/run-result.json');
        const runLocalFixFromRevision = vi.fn(async () => {
            // What the layers below actually do on failure: record the collapsed native detail.
            recordPreflightDiagnostic('cli_phase', {
                note: 'phase_observation_failed',
                phase: 'A',
                error: { message: 'net::ERR_TIMED_OUT' },
            });
            writeFileSync(resultPath, JSON.stringify({ result: { runStatus: 'analysis_only' } }));
            return {
                agentReportPath: join(fixture.outputDir, 'investigation/agent-report.md'),
                agentDecisionPath: null,
                agentObservationsPath: join(
                    fixture.outputDir,
                    'investigation/agent-observations.json',
                ),
                runResultPath: resultPath,
                manifestPath: '',
                candidatePatchPath: null,
            };
        });

        await runExportedSnapshotCycle(cycleOptions(fixture), {
            loadLocalCoreConfig: () => coreConfig,
            runLocalFixFromRevision,
            createCycleId: () => '11111111-1111-4111-8111-111111111111',
            now: () => '2026-07-23T10:04:00.000Z',
        });

        const logName = readdirSync(fixture.outputDir).find(
            (name) => name.startsWith('adguard-cli-preflight-') && name.endsWith('.log'),
        );
        expect(logName).toBeDefined();
        const records = readFileSync(join(fixture.outputDir, logName!), 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
        expect(records).toContainEqual(
            expect.objectContaining({
                channel: 'cli_phase',
                detail: expect.objectContaining({ note: 'phase_observation_failed' }),
            }),
        );
        // The sink closes with the cycle, so records after the run change nothing.
        expect(records.at(-1)).toMatchObject({ channel: 'run' });
        recordPreflightDiagnostic('cli_phase', { note: 'after_cycle' });
        const after = readFileSync(join(fixture.outputDir, logName!), 'utf8')
            .trim()
            .split('\n').length;
        expect(after).toBe(records.length);
    });

    it('rejects invalid input before config or handler work and writes a local result', async () => {
        const fixture = createFixture();
        const changed = JSON.parse(readFileSync(fixture.issuePath, 'utf8'));
        changed.snapshot.rawIssue.title = 'Tampered';
        writeFileSync(fixture.issuePath, JSON.stringify(changed));
        const loadLocalCoreConfig = vi.fn(() => coreConfig);
        const runLocalFixFromRevision = vi.fn();

        const result = await runExportedSnapshotCycle(cycleOptions(fixture), {
            loadLocalCoreConfig,
            runLocalFixFromRevision,
            createCycleId: () => '11111111-1111-4111-8111-111111111111',
            now: () => '2026-07-23T10:04:00.000Z',
        });

        expect(result.status).toBe('invalid_snapshot');
        expect(result.revision).toBeNull();
        expect(result.investigationResultPath).toBeNull();
        expect(loadLocalCoreConfig).not.toHaveBeenCalled();
        expect(runLocalFixFromRevision).not.toHaveBeenCalled();
        expect(readFileSync(join(fixture.outputDir, 'cycle-result.json'), 'utf8')).toContain(
            'invalid_snapshot',
        );
    });

    it('sanitizes configured credentials from failed cycle output', async () => {
        const fixture = createFixture();
        const result = await runExportedSnapshotCycle(cycleOptions(fixture), {
            loadLocalCoreConfig: () => coreConfig,
            runLocalFixFromRevision: async () => {
                throw new Error(`Provider rejected ${coreConfig.llm.apiKey}`);
            },
            createCycleId: () => '11111111-1111-4111-8111-111111111111',
            now: () => '2026-07-23T10:04:00.000Z',
        });
        const serialized = readFileSync(join(fixture.outputDir, 'cycle-result.json'), 'utf8');

        expect(result.status).toBe('failed');
        expect(result.outcome).toEqual({ kind: 'infrastructure', category: 'runtime' });
        expect(serialized).not.toContain(coreConfig.llm.apiKey);
        expect(serialized).toContain('[redacted]');
        expect(readdirSync(fixture.outputDir)).not.toContain('.cycle-result.json.tmp');
    });

    it('fails a schema-invalid locked investigation closed to investigation output', async () => {
        const fixture = createFixture();
        const resultPath = join(fixture.outputDir, 'investigation/run-result.json');
        const result = await runExportedSnapshotCycle(cycleOptions(fixture), {
            loadLocalCoreConfig: () => coreConfig,
            runLocalFixFromRevision: async () => {
                writeFileSync(resultPath, JSON.stringify({ result: { runStatus: 'unexpected' } }));
                return {
                    agentReportPath: '',
                    agentDecisionPath: null,
                    agentObservationsPath: '',
                    runResultPath: resultPath,
                    manifestPath: '',
                    candidatePatchPath: null,
                };
            },
            createCycleId: () => '11111111-1111-4111-8111-111111111111',
            now: () => '2026-07-23T10:04:00.000Z',
        });

        expect(result.status).toBe('failed');
        expect(result.outcome).toEqual({
            kind: 'infrastructure',
            category: 'investigation_output',
        });
        expect(result.investigationResultPath).toBeNull();
    });

    it('gives the CLI module one private OS-temp workspace and removes it after the cycle', async () => {
        const fixture = createFixture();
        const resultPath = join(fixture.outputDir, 'investigation/run-result.json');
        let privateCycleRoot = '';
        const runLocalFixFromRevision = vi.fn(async (_config, _revision, options) => {
            privateCycleRoot = options.adguardCliModule.workspaceDir;
            expect(existsSync(privateCycleRoot)).toBe(true);
            writeFileSync(resultPath, JSON.stringify({ result: { runStatus: 'analysis_only' } }));
            return {
                agentReportPath: '',
                agentDecisionPath: null,
                agentObservationsPath: '',
                runResultPath: resultPath,
                manifestPath: '',
                candidatePatchPath: null,
            };
        });

        await runExportedSnapshotCycle(cycleOptions(fixture), {
            loadLocalCoreConfig: () => coreConfig,
            runLocalFixFromRevision,
            createCycleId: () => '11111111-1111-4111-8111-111111111111',
            now: () => '2026-07-23T10:04:00.000Z',
        });

        expect(privateCycleRoot.startsWith(`${realpathSync(tmpdir())}/`)).toBe(true);
        expect(privateCycleRoot.startsWith(`${realpathSync(process.cwd())}/`)).toBe(false);
        expect(privateCycleRoot.startsWith(`${realpathSync(fixture.outputDir)}/`)).toBe(false);
        expect(existsSync(privateCycleRoot)).toBe(false);
    });
});
