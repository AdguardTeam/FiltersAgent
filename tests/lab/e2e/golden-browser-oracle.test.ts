import { describe, expect, it, vi } from 'vitest';
import type { CoreConfig } from '../../../src/config/config';
import type { GoldenOracleContext } from '../../../lab/e2e/golden-runner';
import {
    boundedGoldenOracleProfiles,
    buildOracleFiltersConfig,
    validateHumanCandidateInHistoricalBuild,
    createGoldenBrowserOracleProbe,
    formatGoldenTargetSiteUnavailable,
    GOLDEN_ORACLE_RETRY_POLICY,
    GoldenTargetSiteUnavailableError,
    resolveGoldenOracleReplacedRule,
} from '../../../lab/e2e/golden-browser-oracle';
import { testCoreConfig } from '../../config/test-core-config';

const coreConfig: CoreConfig = testCoreConfig({
    llm: { apiKey: 'secret', visionModel: 'example-vision-model' },
});

const context = {
    candidate: {
        rule: 'nettg.pl##.banner',
        syntaxKind: 'element_hiding',
        filePath: 'BaseFilter/sections/foreign.txt',
        repositoryEdit: 'extend_domains',
    },
} as GoldenOracleContext;

describe('createGoldenBrowserOracleProbe', () => {
    it('maps a real verified visual review to a verified oracle result', async () => {
        const validateHumanCandidate = vi.fn().mockResolvedValue({
            verdict: 'verified',
            coverageComplete: true,
            beforeInstanceCount: 13,
            remainingInstanceCount: 0,
            rationale: 'All repeated leftovers disappeared and the page stayed intact.',
        });
        const probe = createGoldenBrowserOracleProbe(coreConfig, { validateHumanCandidate });

        const result = await probe(context);

        expect(result.status).toBe('verified');
        expect(validateHumanCandidate).toHaveBeenCalledWith(coreConfig, context);
    });

    it('reports environment drift when a complete review rejects the human candidate', async () => {
        const probe = createGoldenBrowserOracleProbe(coreConfig, {
            validateHumanCandidate: async () => ({
                verdict: 'rejected',
                coverageComplete: true,
                beforeInstanceCount: 13,
                remainingInstanceCount: 2,
                rationale: 'Two target leftovers remain.',
            }),
        });

        await expect(probe(context)).resolves.toMatchObject({ status: 'not_verified' });
    });

    it('treats complete absence of the historical symptom as environment drift', async () => {
        const probe = createGoldenBrowserOracleProbe(coreConfig, {
            validateHumanCandidate: async () => ({
                verdict: 'inconclusive',
                coverageComplete: true,
                beforeInstanceCount: 0,
                remainingInstanceCount: 0,
                rationale: 'The target family no longer exists on the live page.',
            }),
        });

        await expect(probe(context)).resolves.toMatchObject({ status: 'not_verified' });
    });

    it('keeps incomplete vision and runtime errors as infrastructure failures', async () => {
        const inconclusive = createGoldenBrowserOracleProbe(coreConfig, {
            validateHumanCandidate: async () => ({
                verdict: 'inconclusive',
                coverageComplete: false,
                beforeInstanceCount: 1,
                remainingInstanceCount: 0,
                rationale: 'Full-page coverage was incomplete.',
            }),
        });
        const failed = createGoldenBrowserOracleProbe(coreConfig, {
            validateHumanCandidate: async () => {
                throw new Error('browser failed');
            },
        });

        await expect(inconclusive(context)).resolves.toMatchObject({
            status: 'infrastructure_failure',
        });
        await expect(failed(context)).resolves.toMatchObject({
            status: 'infrastructure_failure',
            detail: 'browser failed',
        });
    });

    it('classifies target navigation exhaustion as an infrastructure failure', async () => {
        const probe = createGoldenBrowserOracleProbe(coreConfig, {
            validateHumanCandidate: async () => {
                throw new GoldenTargetSiteUnavailableError(
                    'Golden oracle target site remained unreachable after three sessions.',
                );
            },
        });

        await expect(probe(context)).resolves.toEqual({
            status: 'infrastructure_failure',
            detail: 'Golden oracle target site remained unreachable after three sessions.',
        });
    });
});

describe('golden oracle retry policy', () => {
    it('summarizes a refused target without exposing the Playwright call log or URL query', () => {
        const detail = formatGoldenTargetSiteUnavailable(
            'https://sochi.camera/watch?session=secret#player',
            'page.goto: net::ERR_CONNECTION_REFUSED at https://sochi.camera/watch\n' +
                'Call log:\n  - navigating to target',
            3,
            3,
        );

        expect(detail).toBe(
            'Golden oracle could not reach https://sochi.camera/watch from this runner ' +
                '(ERR_CONNECTION_REFUSED in 3/3 browser profiles).',
        );
        expect(detail).not.toContain('Call log');
        expect(detail).not.toContain('secret');
    });

    it('caps the nested browser work at three total navigation attempts', () => {
        const profiles = boundedGoldenOracleProfiles({
            issueNumber: 234715,
            issueUrl: 'https://github.com/AdguardTeam/AdguardFilters/issues/234715',
            reportedSiteUrls: ['https://sochi.camera/'],
            labels: ['T: Anti Adblock Script'],
            problemType: 'anti-adblock',
            product: 'AdGuard Browser Extension v5.4.3.83 MV3',
            os: 'Windows 10',
            browser: 'Chrome',
            enabledFilters: [
                { name: 'AdGuard Russian filter', officialFilterId: 1 },
                { name: 'AdGuard Base filter', officialFilterId: 2 },
            ],
            screenshots: [],
        });

        expect(GOLDEN_ORACLE_RETRY_POLICY).toEqual({
            profileAttempts: 3,
            openPageRetriesPerProfile: 1,
        });
        expect(profiles).toHaveLength(3);
        expect(profiles.length * GOLDEN_ORACLE_RETRY_POLICY.openPageRetriesPerProfile).toBe(3);
    });
});

describe('resolveGoldenOracleReplacedRule', () => {
    it('returns the first-parent rule only for an exact replacement edit', () => {
        const replacedRule = '||ads.example^$domain=example.com';
        const candidate = {
            ...context.candidate,
            rule: '||ads.example^$domain=example.com|~sub.example.com',
            syntaxKind: 'network',
            repositoryEdit: 'replace',
            replacedRule,
        } as GoldenOracleContext['candidate'];

        expect(resolveGoldenOracleReplacedRule(candidate)).toBe(replacedRule);
        expect(resolveGoldenOracleReplacedRule(context.candidate)).toBeUndefined();
    });

    it('rejects malformed replacement metadata before opening a browser', () => {
        expect(() =>
            resolveGoldenOracleReplacedRule({
                ...context.candidate,
                repositoryEdit: 'replace',
                replacedRule: undefined,
            }),
        ).toThrow(/missing.*first-parent rule/i);
        expect(() =>
            resolveGoldenOracleReplacedRule({
                ...context.candidate,
                replacedRule: 'nettg.pl##.old-banner',
            }),
        ).toThrow(/additive candidate/i);
    });
});

const historicalBuild = {
    version: '5.4.3.99',
    releaseTag: 'v5.4.3.1',
    releaseSha256: 'a'.repeat(64),
    autobuildTag: 'autobuild-v5.4.3.99',
    autobuildCommit: 'b'.repeat(40),
};

const lockedContext: GoldenOracleContext = {
    ...context,
    run: {
        schemaVersion: 3,
        issueNumber: 235988,
        issueFile: 'issue/issue.json',
        filtersBaseSha: '0e06526e359cfb83f2883f7005aeee3feb56b653',
        extensionBuild: {
            version: historicalBuild.version,
            releaseTag: historicalBuild.releaseTag,
            autobuildCommit: historicalBuild.autobuildCommit,
        },
    },
    extensionBuild: {
        version: historicalBuild.version,
        releaseTag: historicalBuild.releaseTag,
        autobuildCommit: historicalBuild.autobuildCommit,
    },
    expectedReleaseSha256: historicalBuild.releaseSha256,
};

vi.mock('../../../lab/local/historical-extension-build', () => ({
    prepareHistoricalExtensionBuild: vi.fn(),
    labExtensionCacheRoot: (root: string) => `${root}/tmp/cache`,
}));
vi.mock('../../../src/local/filters-preparer', () => ({
    withPreparedFiltersCheckout: vi.fn(async (_config, callback) =>
        callback({ filtersPath: '/tmp/filters' }),
    ),
}));

describe('validateHumanCandidateInHistoricalBuild', () => {
    it('uses the locked historical filters checkout for independent validation', () => {
        expect(buildOracleFiltersConfig(lockedContext).environment).toEqual({
            kind: 'historical',
            baseSha: lockedContext.run.filtersBaseSha,
        });
    });

    it('accepts an unknown locked digest before checking browser compatibility', async () => {
        const { prepareHistoricalExtensionBuild } =
            await import('../../../lab/local/historical-extension-build');
        vi.mocked(prepareHistoricalExtensionBuild).mockResolvedValue({
            extensionDir: '/tmp/historical-extension',
            manifestVersion: 2,
            provenance: { ...historicalBuild, releaseSha256: 'c'.repeat(64) },
        });

        await expect(
            validateHumanCandidateInHistoricalBuild(coreConfig, {
                ...lockedContext,
                expectedReleaseSha256: null,
            }),
        ).rejects.toThrow(/manifest_version=2/u);
    });

    it('rebuilds the locked identity and refuses a changed release digest before validation', async () => {
        const { prepareHistoricalExtensionBuild } =
            await import('../../../lab/local/historical-extension-build');
        const changedDigest = 'c'.repeat(64);
        vi.mocked(prepareHistoricalExtensionBuild).mockResolvedValue({
            extensionDir: '/tmp/historical-extension',
            manifestVersion: 3,
            provenance: { ...historicalBuild, releaseSha256: changedDigest },
        });

        const differingPublicCase = {
            ...lockedContext,
            run: {
                ...lockedContext.run,
                extensionBuild: {
                    ...lockedContext.run.extensionBuild,
                    version: '5.4.3.98',
                    autobuildCommit: 'd'.repeat(40),
                },
            },
        };
        await expect(
            validateHumanCandidateInHistoricalBuild(coreConfig, differingPublicCase),
        ).rejects.toThrow(new RegExp(`${historicalBuild.releaseSha256}.*${changedDigest}`));
        expect(prepareHistoricalExtensionBuild).toHaveBeenCalledWith(
            expect.objectContaining({
                build: {
                    version: historicalBuild.version,
                    releaseTag: historicalBuild.releaseTag,
                    autobuildCommit: historicalBuild.autobuildCommit,
                },
                cacheRoot: `${process.cwd()}/tmp/cache`,
            }),
        );
    });
});
