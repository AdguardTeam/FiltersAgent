import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runExportedSnapshotCycle } from '../../../lab/local/local-cycle';
import { LocalInfrastructureFailureCategory } from '../../../lab/local/cycle-outcome';
import { buildExportedIssueRevision } from '../../../src/local/issue-revision';
import {
    runLocalFix,
    runLocalFixFromRevision,
    type LocalFixRunnerDependencies,
} from '../../../lab/local/local-fix-runner';
import {
    HistoricalBuildError,
    HistoricalBuildFailureCode,
} from '../../../lab/local/historical-build-error';
import { RedirectOriginPolicy } from '../../../src/browser/redirect-origin-policy';
import {
    PreparedExtensionSource,
    ExtensionManifestVersion,
} from '../../../src/environment/extension-preparation';
import { ExtensionEnvironmentKind } from '../../../src/types/extension-environment-kind';
import { InfrastructureFailureReason } from '../../../src/types/infrastructure-failure-reason';
import { IntakeExtractionKind } from '../../../src/intake/extract-report';
import { buildLocalIssueSnapshot } from '../../../src/local/issue-snapshot';
import { testCoreConfig } from '../../config/test-core-config';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const pin = { version: '5.4.3.99', releaseTag: 'v5.4.3.1', autobuildCommit: 'a'.repeat(40) };
const provenance = {
    ...pin,
    releaseSha256: 'b'.repeat(64),
    autobuildTag: `autobuild-v${pin.version}`,
};

function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'historical-local-run-'));
    roots.push(root);
    mkdirSync(join(root, '.github', 'filters-agent'), { recursive: true });
    writeFileSync(
        join(root, '.github', 'filters-agent', 'AGENTS.md'),
        '# Instructions\nInvestigate the reported advertisement.\n',
    );
    const issueFile = join(root, 'issue.json');
    writeFileSync(
        issueFile,
        JSON.stringify(
            buildLocalIssueSnapshot(
                {
                    number: 1,
                    title: 'An advertisement remains visible',
                    body: 'https://example.com/',
                    url: 'https://github.com/example-owner/example-repo/issues/1',
                    labels: [],
                    comments: [],
                    state: 'open',
                    assignee: null,
                },
                [],
            ),
        ),
    );
    const extensionDir = join(root, 'extension');
    mkdirSync(extensionDir);
    writeFileSync(
        join(extensionDir, 'manifest.json'),
        JSON.stringify({ version: '5.4.3.1', manifest_version: 3 }),
    );
    const runConfig = join(root, 'run.json');
    writeFileSync(
        runConfig,
        JSON.stringify({ filtersBaseSha: 'c'.repeat(40), extensionBuild: pin }),
    );
    const prepareBuild = vi.fn().mockResolvedValue({
        extensionDir,
        manifestVersion: ExtensionManifestVersion.Mv3,
        provenance,
    });
    const extractReport = vi
        .fn<NonNullable<LocalFixRunnerDependencies['extractReport']>>()
        .mockResolvedValue({
            kind: IntakeExtractionKind.Report,
            report: {
                siteUrls: ['https://example.com/'],
                problemType: 'ads',
                screenshots: [],
                environment: {},
                enabledLists: [],
                userRules: [],
                reproductionSteps: [],
            },
        });
    // Stop at the injected core boundary; the wrapper still persists a complete failure record.
    const runFixCore = vi
        .fn<NonNullable<LocalFixRunnerDependencies['runFixCore']>>()
        .mockRejectedValue(new Error('Fixture reached the core boundary.'));
    const prepareFilters = vi.fn();
    const withPreparedFiltersCheckout: NonNullable<
        LocalFixRunnerDependencies['withPreparedFiltersCheckout']
    > = async (config, callback) => {
        prepareFilters(config);
        return callback({
            filtersPath: root,
            checkoutPath: root,
            provenance: {
                environment: ExtensionEnvironmentKind.Historical,
                source: 'local-shared-clone',
                sourceLocation: root,
                requestedRevision: 'c'.repeat(40),
                commit: 'c'.repeat(40),
            },
        });
    };
    const dependencies: LocalFixRunnerDependencies = {
        prepareHistoricalExtensionBuild: prepareBuild,
        extractReport,
        runFixCore,
        withPreparedFiltersCheckout,
    };
    const options = {
        issueNumber: 1,
        issueFile,
        environment: ExtensionEnvironmentKind.Historical,
        outputDir: join(root, 'output'),
        runConfig,
        keepTemporaryFiles: false,
        browserMode: 'auto' as const,
        verbose: false,
        knowledgeBaseSha: 'd'.repeat(40),
    };
    return {
        options,
        dependencies,
        prepareBuild,
        extractReport,
        runFixCore,
        prepareFilters,
        extensionDir,
    };
}

describe('local reporter build selection', () => {
    it('hands the reporter build and the related-hosts redirect policy to the fix core in a historical run', async () => {
        const f = fixture();
        await runLocalFix(testCoreConfig(), f.options, f.dependencies);
        expect(f.prepareBuild).toHaveBeenCalledWith(
            expect.objectContaining({
                build: pin,
                cacheRoot: expect.any(String),
                logger: expect.any(Object),
            }),
        );
        expect(f.runFixCore).toHaveBeenCalledOnce();
        expect(f.runFixCore.mock.calls[0]![2]).toMatchObject({
            preparedExtension: {
                source: PreparedExtensionSource.HistoricalBuild,
                extensionPath: f.extensionDir,
                historicalBuild: provenance,
            },
            redirectOriginPolicy: RedirectOriginPolicy.KeepRelatedHosts,
        });
    });
    it('fails a historical run as an unavailable environment when the build is refused', async () => {
        const f = fixture();
        f.prepareBuild.mockRejectedValue(
            new HistoricalBuildError(
                HistoricalBuildFailureCode.ReleaseUnknown,
                'Unsupported reporter build.',
            ),
        );
        const paths = await runLocalFix(testCoreConfig(), f.options, f.dependencies);
        expect(f.runFixCore).not.toHaveBeenCalled();
        expect(f.prepareFilters).not.toHaveBeenCalled();
        expect(f.extractReport).not.toHaveBeenCalled();
        expect(JSON.parse(readFileSync(paths.runResultPath, 'utf8')).result).toMatchObject({
            infrastructureFailureReason: InfrastructureFailureReason.EnvironmentUnavailable,
        });
    });
    it('classifies a refused reporter build as unavailable through the verified local cycle', async () => {
        const f = fixture();
        const snapshot = JSON.parse(readFileSync(f.options.issueFile, 'utf8'));
        writeFileSync(
            f.options.issueFile,
            JSON.stringify(
                buildExportedIssueRevision({
                    repository: 'example-owner/example-repo',
                    issueNumber: 1,
                    sourceUpdatedAt: '2026-07-23T10:02:00.000Z',
                    capturedAt: '2026-07-23T10:03:00.000Z',
                    snapshot,
                }),
            ),
        );
        f.prepareBuild.mockRejectedValue(
            new HistoricalBuildError(
                HistoricalBuildFailureCode.ReleaseUnknown,
                'Unsupported reporter build.',
            ),
        );
        const cycle = await runExportedSnapshotCycle(f.options, {
            loadLocalCoreConfig: () => testCoreConfig(),
            runLocalFixFromRevision: (config, revision, options) =>
                runLocalFixFromRevision(config, revision, options, f.dependencies),
        });
        expect(cycle.status).toBe('failed');
        expect(cycle.outcome).toEqual({
            kind: 'infrastructure',
            category: LocalInfrastructureFailureCategory.Environment,
        });
        expect(f.extractReport).not.toHaveBeenCalled();
        expect(f.runFixCore).not.toHaveBeenCalled();
        const saved = JSON.parse(
            readFileSync(join(f.options.outputDir, 'cycle-result.json'), 'utf8'),
        );
        expect(saved.outcome).toEqual(cycle.outcome);
    });
    it('refuses a historical config without extensionBuild before the intake extraction', async () => {
        const f = fixture();
        writeFileSync(f.options.runConfig, JSON.stringify({ filtersBaseSha: 'c'.repeat(40) }));
        const paths = await runLocalFix(testCoreConfig(), f.options, f.dependencies);
        expect(f.extractReport).not.toHaveBeenCalled();
        expect(f.prepareBuild).not.toHaveBeenCalled();
        expect(f.runFixCore).not.toHaveBeenCalled();
        expect(JSON.parse(readFileSync(paths.runResultPath, 'utf8')).result).toMatchObject({
            infrastructureFailureReason: InfrastructureFailureReason.InputUnavailable,
        });
    });
    it('leaves a current run on the pinned release and the live redirect policy', async () => {
        const f = fixture();
        await runLocalFix(
            testCoreConfig(),
            { ...f.options, environment: ExtensionEnvironmentKind.Current },
            f.dependencies,
        );
        expect(f.prepareBuild).not.toHaveBeenCalled();
        expect(f.runFixCore).toHaveBeenCalledOnce();
        expect(f.runFixCore.mock.calls[0]![2]).not.toHaveProperty('preparedExtension');
        expect(f.runFixCore.mock.calls[0]![2]).not.toHaveProperty('redirectOriginPolicy');
    });
});
