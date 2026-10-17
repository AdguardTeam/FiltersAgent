import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateHumanCandidateInHistoricalBuild } from '../../../lab/e2e/golden-browser-oracle';
import type { GoldenOracleContext } from '../../../lab/e2e/golden-runner';
import { createBrowserToolHandlers } from '../../../src/browser/browser-tools';
import { RedirectOriginPolicy } from '../../../src/browser/redirect-origin-policy';
import { testCoreConfig } from '../../config/test-core-config';

const { boundaryReached, historicalBuild } = vi.hoisted(() => ({
    boundaryReached: new Error('Browser handler boundary reached'),
    historicalBuild: {
        version: '5.4.3.99',
        releaseTag: 'v5.4.3.1',
        releaseSha256: 'a'.repeat(64),
        autobuildTag: 'autobuild-v5.4.3.99',
        autobuildCommit: 'b'.repeat(40),
    },
}));

vi.mock('../../../lab/local/historical-extension-build', () => ({
    prepareHistoricalExtensionBuild: vi.fn(async () => ({
        extensionDir: '/tmp/historical-extension',
        manifestVersion: 3,
        provenance: historicalBuild,
    })),
    labExtensionCacheRoot: () => '/tmp/cache',
}));
vi.mock('../../../src/local/filters-preparer', () => ({
    withPreparedFiltersCheckout: vi.fn(async (_config, callback) =>
        callback({ filtersPath: '/tmp/filters' }),
    ),
}));
vi.mock('../../../src/local/issue-snapshot', () => ({
    loadLocalIssueSnapshot: vi.fn(() => ({})),
    toAgentIssueInput: vi.fn(() => ({ number: 1, url: 'https://example.com/issue', labels: [] })),
}));
vi.mock('../../../src/intake/extract-issue-facts', () => ({
    extractIntakeReport: vi.fn(async () => ({ kind: 'extracted', report: {} })),
}));
vi.mock('../../../src/intake/report-facts', () => ({
    reportToIssueFacts: vi.fn(() => ({ reportedSiteUrls: ['https://example.com/'] })),
}));
vi.mock('../../../src/pi/llm-wiring', () => ({
    createPiRuntimeFromConfig: vi.fn(async () => ({})),
    createVisionClient: vi.fn(() => ({})),
}));
vi.mock('../../../lab/e2e/repro-profile', () => ({
    profileFallbacks: vi.fn(() => [{}]),
}));
vi.mock('../../../src/validator/trusted-validation-context', () => ({
    createTrustedValidationContext: vi.fn(() => ({ existingRules: [] })),
}));
vi.mock('../../../lab/e2e/golden-reporter-defect', () => ({
    analyzeGoldenReporterScreenshots: vi.fn(async () => []),
    buildGoldenReporterDefect: vi.fn(() => ({})),
}));
vi.mock('../../../src/browser/browser-session', () => ({
    BrowserSession: {
        create: vi.fn(async () => ({ close: vi.fn(async () => undefined) })),
    },
}));
vi.mock('../../../src/browser/cloakbrowser-engine', () => ({
    CloakBrowserEngine: vi.fn(),
}));
vi.mock('../../../src/browser/browser-tools', () => ({
    createBrowserToolHandlers: vi.fn(() => {
        throw boundaryReached;
    }),
}));

const temporaryDirectories: string[] = [];
afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

describe('historical human-candidate browser configuration', () => {
    it('keeps only related redirect origins for the independent human validation', async () => {
        const outputDirectory = mkdtempSync(join(tmpdir(), 'oracle-redirect-policy-'));
        temporaryDirectories.push(outputDirectory);
        const context = {
            issueFile: 'issue.json',
            outputDirectory,
            run: { issueNumber: 1, filtersBaseSha: 'c'.repeat(40) },
            candidate: {
                filePath: 'BaseFilter/sections/specific.txt',
                rule: 'example.com##.ad',
                repositoryEdit: 'insert',
            },
            extension: {
                source: 'historical_build',
                historicalBuild,
            },
        } as GoldenOracleContext;

        await expect(
            validateHumanCandidateInHistoricalBuild(testCoreConfig(), context),
        ).rejects.toBe(boundaryReached);

        expect(createBrowserToolHandlers).toHaveBeenCalledWith(
            expect.objectContaining({
                allowedOrigin: 'https://example.com/',
                redirectOriginPolicy: RedirectOriginPolicy.KeepRelatedHosts,
            }),
        );
    });
});
