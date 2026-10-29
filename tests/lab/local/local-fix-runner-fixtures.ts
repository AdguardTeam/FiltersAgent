import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LocalFixRunnerDependencies } from '../../../lab/local/local-fix-runner';
import type { PreparedKnowledgeBase } from '../../../lab/local/knowledge-base-preparer';
import type { CoreConfig } from '../../../src/config/config';
import { EnvironmentSelectionHost } from '../../../src/environment/environment-selection';
import { ExtensionManifestVersion } from '../../../src/environment/extension-preparation';
import type { RawIssue } from '../../../src/github/fetch-issue';
import { IntakeExtractionKind, type IntakeExtraction } from '../../../src/intake/extract-report';
import { RuleGuidanceSourceKind } from '../../../src/knowledge/guidance-source';
import type { PreparedFiltersCheckout } from '../../../src/local/filters-preparer';
import type {
    FiltersPreparationConfig,
    KnowledgeBasePreparationConfig,
} from '../../../src/local/run-config-types';
import type { FixRunResult } from '../../../src/types/fix-run-result';
import type { UpstreamSourceDrift } from '../../../src/types/upstream-source-drift';
import { testCoreConfig } from '../../config/test-core-config';
import { extensionExecutorDescriptor } from '../../environment/test-filtering-environment-fixtures';

/**
 * Materialize one loadable unpacked extension directory for the stubbed pinned-release seam: the
 * run's pre-run preparation consumes it instead of reaching the release network.
 *
 * @param parentDir - Directory to place the unpacked build under.
 * @returns Absolute path of the unpacked directory.
 */
export function writeUnpackedExtensionFixture(parentDir: string): string {
    const unpacked = join(parentDir, 'unpacked');
    mkdirSync(unpacked, { recursive: true });
    writeFileSync(
        join(unpacked, 'manifest.json'),
        JSON.stringify({ version: '5.5.2.3', manifest_version: 3 }),
        'utf8',
    );
    return unpacked;
}

/**
 * Minimal local core configuration every runLocalFix suite hands the runner.
 */
export const coreConfig: CoreConfig = testCoreConfig({
    llm: { apiKey: 'local-key', visionModel: 'gemini-3.5-flash' },
});

/**
 * The report a deterministic extraction of the shared fixture issues produces: the site URL comes
 * from the fixture body, so the runner derives the same domain the retired parser did. Every
 * runLocalFix suite injects this seam; no suite reaches the provider network.
 */
export const extractionSeam = {
    prepareHistoricalExtensionBuild: async ({ build }) => ({
        extensionDir: writeUnpackedExtensionFixture(mkdtempSync(join(tmpdir(), 'reporter-build-'))),
        manifestVersion: ExtensionManifestVersion.Mv3,
        provenance: {
            ...build,
            releaseSha256: 'e'.repeat(64),
            autobuildTag: `autobuild-v${build.version}`,
        },
    }),
    extractReport: async (raw: RawIssue): Promise<IntakeExtraction> => {
        const siteUrl = raw.body?.match(/### Issue URL[^\n]*\n(https?:\/\/[^\s)\]]+)/)?.[1];
        return {
            kind: IntakeExtractionKind.Report,
            report: {
                siteUrls: siteUrl ? [siteUrl] : ['https://example.com/article'],
                problemType: 'ads',
                screenshots: [],
                environment: { product: 'AdGuard Browser Extension v5.4.3' },
                enabledLists: [{ name: 'AdGuard Base filter', officialFilterId: 2 }],
                userRules: [],
                reproductionSteps: [],
            },
        };
    },
} satisfies Partial<LocalFixRunnerDependencies>;

/**
 * The closed historical issue the local runner suites run, with a settings import link.
 */
export const rawIssue = {
    number: 4,
    url: 'https://github.com/example/lab/issues/4',
    title: 'Ad remains visible',
    body: [
        '### Issue URL (Ads)',
        'https://example.com/article',
        '',
        '### Issue configuration',
        '[Import settings](https://reports.adguard.com/en/new_issue.html?product_version=5.4.3.95&regular_filters=2.3.17&stealth.enabled=false)',
        '',
        '### System configuration',
        'AdGuard product: | AdGuard Browser Extension v5.4.3',
        'Filters: | AdGuard Base filter',
    ].join('\n'),
    state: 'closed' as const,
    labels: ['T: Ads', 'N: AdGuard Browser Extension'],
    assignee: null,
    comments: [],
};

/**
 * Build a ready Extension selection for a newly produced agentic result.
 *
 * @returns Host-validated selection with adapter-owned actual context.
 */
export function extensionEnvironmentSelection() {
    const host = new EnvironmentSelectionHost(
        {
            issueNumber: 4,
            issueUrl: 'https://github.com/example/lab/issues/4',
            reportedSiteUrls: ['https://example.com/article'],
            labels: ['T: Ads', 'N: AdGuard Browser Extension'],
            declaredIssueType: 'Ads',
            problemType: 'ads',
            product: 'AdGuard Browser Extension v5.4.3',
            enabledFilters: [{ name: 'AdGuard Base filter', officialFilterId: 2 }],
            settingsImportUrl:
                'https://reports.adguard.com/en/new_issue.html?product_version=5.4.3.95&regular_filters=2.3.17&stealth.enabled=false',
            screenshots: [],
        },
        [extensionExecutorDescriptor()],
    );
    host.select({
        kind: 'browser_extension',
        requiredCapabilities: ['browser_navigation'],
        intent: {
            issueType: 'ads',
            rationale: 'The report describes a visible advertisement on a website.',
            confidence: 0.95,
            evidence: [
                {
                    source: 'issue_body',
                    observation: 'The issue body identifies a page-level advertising symptom.',
                },
            ],
            conflicts: [],
        },
        rationale: 'Use the Browser Extension for this ordinary website-filtering report.',
        confidence: 0.95,
    });
    host.bindActualContext('browser_extension', {
        product: 'AdGuard Browser Extension',
        browser: 'CloakBrowser Chromium',
        productVersion: '5.4.3.95',
    });
    return host.snapshot()!;
}

/**
 * Build a stable core result for local-wrapper tests.
 *
 * @param overrides - Result fields that differ in the scenario.
 * @returns Complete local core result.
 */
export function coreResult(overrides: Partial<FixRunResult> = {}): FixRunResult {
    return {
        issueNumber: 4,
        domain: 'example.com',
        runStatus: 'not_reproduced',
        requestedBrowserMode: 'auto',
        effectiveMode: 'browser',
        verificationStatus: 'verified',
        reproductionSettingsStatus: 'applied',
        reproductionSettingsDetail: 'Controlled profile verified.',
        environmentSelection: extensionEnvironmentSelection(),
        fallbackReason: null,
        fallbackDetail: null,
        candidatePatch: null,
        artifactPaths: {
            screenshots: [],
            domSnapshot: null,
            har: null,
            trace: '/tmp/trace.json',
            settingsProof: null,
        },
        reasoning: 'The reported symptom was absent.',
        repository: 'AdguardTeam/AdguardFilters',
        baseSha: 'a'.repeat(40),
        ...overrides,
    };
}

/**
 * What the upstream observation stand-in reads from its request.
 */
interface UpstreamObservationRequest {
    /**
     * The commit the run is pinned to.
     */
    pinnedCommit: string;
}

/**
 * Stand in for the upstream observation so no local test reaches the network to make one.
 *
 * @param request - Observation request carrying the commit the run is pinned to.
 * @returns Drift record reporting that upstream was never seen.
 */
export async function observeNoUpstream(
    request: UpstreamObservationRequest,
): Promise<UpstreamSourceDrift> {
    return {
        status: 'unobserved',
        pinnedCommit: request.pinnedCommit,
        upstreamCommit: null,
        observedAt: '2026-07-29T10:00:00.000Z',
    };
}

/**
 * A KnowledgeBase-preparation lifecycle stand-in that hands the callback one fixture checkout.
 *
 * @param config - The run's KnowledgeBase preparation configuration.
 * @param filters - The prepared filters checkout the KnowledgeBase pairs with.
 * @param callback - Body that runs with the prepared KnowledgeBase.
 * @returns What the callback returns.
 */
export async function prepareKnowledgeBase<T>(
    config: KnowledgeBasePreparationConfig,
    filters: PreparedFiltersCheckout,
    callback: (prepared: PreparedKnowledgeBase) => Promise<T>,
): Promise<T> {
    return await callback({
        checkoutPath: '/tmp/knowledge-base',
        guidanceSource: {
            kind: RuleGuidanceSourceKind.KnowledgeBase,
            knowledgeBaseCommit: 'c'.repeat(40),
            filtersCommit: filters.provenance.commit,
            knowledgeBaseRepository: config.knowledgeBaseRepository,
            filtersRepository: config.filtersRepository,
            syntaxPath: '/tmp/knowledge-base/create-own-filters.md',
            policyPath: '/tmp/knowledge-base/filter-policy.md',
            contributingPath: join(filters.filtersPath, 'CONTRIBUTING.md'),
        },
        provenance: {
            environment: 'current',
            source: 'local-shared-clone',
            sourceLocation: '/tmp/KnowledgeBase',
            requestedRevision: 'master',
            commit: 'c'.repeat(40),
            filtersCommit: filters.provenance.commit,
            documents: [
                'docs/general/ad-filtering/create-own-filters.md',
                'docs/general/ad-filtering/filter-policy.md',
                'CONTRIBUTING.md',
            ],
        },
    });
}

/**
 * A filters-preparation lifecycle stand-in that hands the callback one exact fixture checkout.
 *
 * @param checkoutPath - Absolute fixture filters checkout the runner treats as prepared.
 * @returns The injectable withPreparedFiltersCheckout seam.
 */
export function preparedCheckoutStub(checkoutPath: string) {
    return async <T>(
        _config: FiltersPreparationConfig,
        callback: (prepared: PreparedFiltersCheckout) => Promise<T>,
    ): Promise<T> =>
        await callback({
            filtersPath: checkoutPath,
            checkoutPath,
            provenance: {
                environment: 'current',
                source: 'local-shared-clone',
                sourceLocation: '/tmp/AdguardFilters',
                requestedRevision: 'master',
                commit: 'a'.repeat(40),
            },
        });
}
