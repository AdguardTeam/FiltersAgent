import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportLocalIssueSnapshot, toAgentIssueInput } from '../../../src/local/issue-snapshot';
import { loadGoldenHumanOracle, loadGoldenRunCase } from '../../../lab/e2e/golden-case';
import { prepareGoldenCase } from '../../../lab/e2e/golden-case-preparer';
import { createLogger } from '../../../src/logger/logger';
import { ExtensionManifestVersion } from '../../../src/environment/extension-preparation';
import type { withPreparedFiltersCheckout } from '../../../src/local/filters-preparer';
import { CheckoutSource } from '../../../src/types/checkout-source';
import { ExtensionEnvironmentKind } from '../../../src/types/extension-environment-kind';
import type { PrepareHistoricalExtensionBuildOptions } from '../../../lab/local/historical-extension-build';

afterEach(() => vi.restoreAllMocks());

const HUMAN_COMMIT = 'f'.repeat(40);
const FILTERS_BASE_SHA = '203b5312920118056616596bc62a19318f57d6d3';
const HUMAN_CANONICAL_RULE = 'money.pl##.money-ecommerce-container';
const HUMAN_SOURCE_RULE = 'bankier.pl,money.pl##.money-ecommerce-container';
const HUMAN_QUOTED_CANONICAL_RULE = 'money.pl##div[data-slot="ad"]';
const HUMAN_QUOTED_SOURCE_RULE = 'bankier.pl,money.pl##div[data-slot="ad"]';

const HUMAN_RULE_CANDIDATES = [
    {
        canonicalRule: HUMAN_CANONICAL_RULE,
        sourceRule: HUMAN_SOURCE_RULE,
    },
    {
        canonicalRule: HUMAN_QUOTED_CANONICAL_RULE,
        sourceRule: HUMAN_QUOTED_SOURCE_RULE,
    },
];

/**
 * Build a scriptable intake extraction returning one model-filled report.
 *
 * @param report - The filled report the scripted extraction returns.
 * @returns A single-argument extraction function suitable for the preparer seam.
 */
function scriptedExtraction(report: Record<string, unknown>): (raw: unknown) => Promise<unknown> {
    return vi.fn(async () => report);
}

/**
 * Supply a readable bundled list while keeping every preparation test offline.
 */
function fixtureBuild(lines = '! Clean pre-fix list') {
    return vi.fn(async ({ build }: PrepareHistoricalExtensionBuildOptions) => {
        const extensionDir = mkdtempSync(join(tmpdir(), 'case-build-'));
        const ruleset = join(extensionDir, 'filters', 'declarative', 'ruleset_2');
        mkdirSync(ruleset, { recursive: true });
        writeFileSync(
            join(ruleset, 'ruleset_2.json'),
            JSON.stringify([{ metadata: { rawFilterList: lines } }]),
        );
        writeFileSync(
            join(extensionDir, 'manifest.json'),
            JSON.stringify({
                declarative_net_request: {
                    rule_resources: [
                        {
                            id: 'ruleset_2',
                            enabled: true,
                            path: 'filters/declarative/ruleset_2/ruleset_2.json',
                        },
                    ],
                },
            }),
        );
        return {
            extensionDir,
            manifestVersion: ExtensionManifestVersion.Mv3,
            provenance: {
                ...build,
                releaseSha256: '0'.repeat(64),
                autobuildTag: `autobuild-v${build.version}`,
            },
        };
    });
}

function fixtureCheckout(baseRule = ''): typeof withPreparedFiltersCheckout {
    return async (config, callback) => {
        const checkoutPath = mkdtempSync(join(tmpdir(), 'case-base-'));
        mkdirSync(join(checkoutPath, 'unmapped', 'nested'), { recursive: true });
        writeFileSync(join(checkoutPath, 'unmapped', 'nested', 'rules.txt'), baseRule);
        try {
            return await callback({
                checkoutPath,
                filtersPath: checkoutPath,
                provenance: {
                    environment: ExtensionEnvironmentKind.Historical,
                    source: CheckoutSource.LocalSharedClone,
                    sourceLocation: checkoutPath,
                    requestedRevision:
                        config.environment.kind === ExtensionEnvironmentKind.Historical
                            ? config.environment.baseSha
                            : '',
                    commit: FILTERS_BASE_SHA,
                },
            });
        } finally {
            rmSync(checkoutPath, { recursive: true, force: true });
        }
    };
}

describe('prepareGoldenCase', () => {
    it.each([
        [
            'writes the reporter extension build into a v3 run.json after the guard passes',
            '5.4.3.96',
            '! Clean list',
            null,
            '',
            [],
        ],
        [
            'ignores duplicate additions from the base and prints absent removals before saving',
            '5.4.3.96',
            HUMAN_SOURCE_RULE,
            null,
            ` ${HUMAN_SOURCE_RULE} \n`,
            ['||example.org/old-ad^'],
        ],
        [
            'refuses a case whose build already carries the human fix, naming the rule and list',
            '5.4.3.96',
            HUMAN_SOURCE_RULE,
            /bankier\.pl,money\.pl##\.money-ecommerce-container.*list 2/u,
            '',
            [],
        ],
        [
            'refuses a reporter version whose code line has no listed release',
            '9.8.7.6',
            '! Clean list',
            /9\.8\.7.*9\.8\.7\.6/u,
            '',
            [],
        ],
    ])('%s', async (_name, reportVersion, listLines, expectedError, baseRule, removedRules) => {
        const workspaceRoot = mkdtempSync(join(tmpdir(), 'case-preparer-workspace-'));
        const casesRoot = join(workspaceRoot, 'benchmark', 'e2e', 'cases');
        const reportScreenshot = 'https://cdn.adguardcdn.com/sitereports/money-reporter.png?nc=1';
        // The tracked body is free-form reporter prose: the compatibility facts come from the
        // scripted extraction, never from a deterministic re-parse of the body.
        const freeFormBody = [
            'Ads stay on https://www.money.pl/ on Chrome (desktop).',
            `Below is the screenshot of the banner: ![Screenshot 1](${reportScreenshot})`,
            'My settings are on the import link in the issue configuration below.',
        ].join('\n');
        const exportIssue = vi.fn(async (_config, _issueNumber, options) => {
            expect(options.reporterOnlyPrompt).toBe(true);
            return await exportLocalIssueSnapshot(
                {
                    number: 235679,
                    reporterAuthor: 'adguard-bot',
                    url: 'https://github.com/AdguardTeam/AdguardFilters/issues/235679',
                    title: 'www.money.pl',
                    body: freeFormBody,
                    state: 'closed',
                    labels: ['T: Ads', 'N: AdGuard Browser Extension'],
                    assignee: null,
                    comments: [
                        {
                            author: 'maintainer',
                            body:
                                `Fixed by ${HUMAN_COMMIT.slice(0, 12)} in ` +
                                'https://github.com/AdguardTeam/AdguardFilters/pull/123456\n' +
                                HUMAN_SOURCE_RULE,
                            createdAt: '2026-07-15T00:00:00.000Z',
                        },
                    ],
                },
                {
                    outputDir: options.outputDir,
                    reporterAuthorOnly: 'adguard-bot',
                    includeStructuredIssueReports: true,
                    downloadAttachment: async () =>
                        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
                },
            );
        });
        const extractReport = scriptedExtraction({
            siteUrls: ['https://www.money.pl/'],
            problemType: 'ads',
            comment: 'Ads stay on the money.pl homepage.',
            screenshots: [{ url: reportScreenshot }],
            environment: {
                product: `AdGuard Browser Extension v${reportVersion} MV3`,
                browser: 'Chrome',
            },
            enabledLists: [{ name: 'AdGuard Base filter', officialFilterId: 2 }],
            settingsImportUrl:
                'https://reports.adguard.com/settings/import.html?' +
                `product_type=ext&product_version=${reportVersion}&ext.manifest_version=3&` +
                'browser=chrome&regular_filters=2&stealth.enabled=0',
            userRules: [],
            reproductionSteps: [],
        });
        const inspectHistoricalMetadata = vi.fn().mockResolvedValue({
            filtersBaseSha: FILTERS_BASE_SHA,
            extensionTagCommit: 'a0dba5b957bf1a93cf3c05216f75b29223dac7e4',
            humanChangedFiles: ['BaseFilter/sections/foreign.txt'],
            humanRuleCandidates: HUMAN_RULE_CANDIDATES,
            humanRuleLines: { added: [HUMAN_SOURCE_RULE], removed: removedRules ?? [] },
        });

        const prepareHistoricalExtensionBuild = fixtureBuild(listLines as string);
        const warnings = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        const preparation = prepareGoldenCase(
            { owner: 'AdguardTeam', repo: 'AdguardFilters', token: 'read-token' },
            {
                issueNumber: 235679,
                humanFixCommit: HUMAN_COMMIT,
                workspaceRoot,
                cacheRoot: join(workspaceRoot, 'cache'),
                logger: createLogger(),
                casesRoot,
                onWarning: (warning) => process.stderr.write(`${warning}\n`),
            },
            {
                exportIssue,
                extractReport: extractReport as never,
                inspectHistoricalMetadata,
                prepareHistoricalExtensionBuild,
                withPreparedFiltersCheckout: fixtureCheckout(baseRule as string | undefined),
            },
        );

        if (expectedError) {
            await expect(preparation).rejects.toThrow(expectedError);
            expect(existsSync(join(casesRoot, 'money-pl-235679'))).toBe(false);
            return;
        }
        const prepared = await preparation;
        expect(warnings.mock.calls.map(([text]) => text)).toEqual(
            (removedRules ?? []).map((rule) => `${rule}\n`),
        );
        expect(prepared.caseName).toBe('money-pl-235679');
        expect(prepared.extensionBuild).toEqual({
            version: '5.4.3.96',
            releaseTag: 'v5.4.3.1',
            autobuildCommit: 'a0dba5b957bf1a93cf3c05216f75b29223dac7e4',
        });
        expect(prepared.filtersBaseSha).toBe(FILTERS_BASE_SHA);
        expect(existsSync(join(prepared.caseDirectory, 'issue', 'attachments'))).toBe(true);
        expect(loadGoldenRunCase(prepared.caseDirectory).config).toEqual({
            schemaVersion: 3,
            issueNumber: 235679,
            issueFile: 'issue/issue.json',
            filtersBaseSha: FILTERS_BASE_SHA,
            extensionBuild: prepared.extensionBuild,
        });
        expect(loadGoldenHumanOracle(prepared.caseDirectory)).toEqual({
            humanFixCommit: HUMAN_COMMIT,
        });
        const issueSource = readFileSync(
            join(prepared.caseDirectory, 'issue', 'issue.json'),
            'utf8',
        );
        expect(issueSource).toContain(HUMAN_COMMIT.slice(0, 12));
        expect(issueSource).toContain(HUMAN_SOURCE_RULE);
        expect(readFileSync(join(prepared.caseDirectory, 'run.json'), 'utf8')).not.toContain(
            HUMAN_COMMIT,
        );
        const oracleSource = readFileSync(join(prepared.caseDirectory, 'oracle.json'), 'utf8');
        const snapshot = JSON.parse(issueSource);
        const agentInputSource = JSON.stringify(toAgentIssueInput(snapshot));
        for (const answer of [HUMAN_CANONICAL_RULE, HUMAN_SOURCE_RULE]) {
            expect(agentInputSource).not.toContain(answer);
            expect(readFileSync(join(prepared.caseDirectory, 'run.json'), 'utf8')).not.toContain(
                answer,
            );
            expect(oracleSource).not.toContain(answer);
        }
        expect(agentInputSource).not.toContain(HUMAN_COMMIT.slice(0, 12));
        expect(agentInputSource).not.toContain('/pull/123456');
        expect(toAgentIssueInput(snapshot).comments).toEqual([]);
        expect(toAgentIssueInput(snapshot).attachments).toHaveLength(1);
        expect(inspectHistoricalMetadata).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                issueNumber: 235679,
                humanFixCommit: HUMAN_COMMIT,
                extensionTag: 'autobuild-v5.4.3.96',
            }),
        );
    });

    it('selects a structured follow-up report from the trusted bot comment', async () => {
        const workspaceRoot = mkdtempSync(join(tmpdir(), 'case-preparer-follow-up-'));
        const casesRoot = join(workspaceRoot, 'cases');
        // The follow-up stays a structured bot relay comment: that is what the exporter surfaces
        // to the run. The facts still come from the scripted extraction, not the body.
        const followUpBody = [
            '### Issue URL (Anti Adblock Script)',
            '[https://e-words.jp/test](https://e-words.jp/test)',
            '### Screenshots',
            '![Screenshot](https://cdn.adguardcdn.com/sitereports/extension.png)',
            '### System configuration',
            'AdGuard product: | AdGuard Browser Extension v5.4.3.84 MV3',
            'Browser: | Chrome',
            '### Issue configuration',
            '[Import](https://reports.adguard.com/settings/import.html?' +
                'product_type=ext&product_version=5.4.3.84&ext.manifest_version=3&browser=chrome)',
        ].join('\n');
        const exportIssue = vi.fn(async (_config, _issueNumber, options) => {
            return await exportLocalIssueSnapshot(
                {
                    number: 235510,
                    reporterAuthor: 'adguard-bot',
                    url: 'https://github.com/AdguardTeam/AdguardFilters/issues/235510',
                    title: 'e-words.jp',
                    body: 'Reporter describes a Windows product report.',
                    state: 'closed',
                    labels: ['T: Anti Adblock Script', 'N: AdGuard Browser Extension'],
                    assignee: null,
                    comments: [
                        {
                            author: 'adguard-bot',
                            body: followUpBody,
                            createdAt: '2026-07-12T05:42:13.000Z',
                        },
                    ],
                },
                {
                    outputDir: options.outputDir,
                    reporterAuthorOnly: 'adguard-bot',
                    includeStructuredIssueReports: true,
                    downloadAttachment: async (sourceUrl: string) => {
                        expect(sourceUrl).toBe(
                            'https://cdn.adguardcdn.com/sitereports/extension.png',
                        );
                        return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
                    },
                },
            );
        });
        // The root body extracts to a non-compatible report; the trusted bot comment is the only
        // Chrome MV3 report with exact import settings.
        const extractReport = vi.fn(async (raw: { body?: string | null }) => {
            if (raw.body === followUpBody) {
                return {
                    siteUrls: ['https://e-words.jp/test'],
                    problemType: 'anti-adblock',
                    screenshots: [{ url: 'https://cdn.adguardcdn.com/sitereports/extension.png' }],
                    environment: {
                        product: 'AdGuard Browser Extension v5.4.3.84 MV3',
                        browser: 'Chrome',
                    },
                    enabledLists: [],
                    settingsImportUrl:
                        'https://reports.adguard.com/settings/import.html?' +
                        'product_type=ext&product_version=5.4.3.84&ext.manifest_version=3&browser=chrome',
                    userRules: [],
                    reproductionSteps: [],
                };
            }
            return {
                siteUrls: ['https://e-words.jp/test'],
                problemType: 'other',
                screenshots: [],
                environment: { product: 'AdGuard for Windows' },
                enabledLists: [],
                userRules: [],
                reproductionSteps: [],
            };
        });

        const prepared = await prepareGoldenCase(
            { owner: 'AdguardTeam', repo: 'AdguardFilters', token: 'read-token' },
            {
                issueNumber: 235510,
                humanFixCommit: 'e'.repeat(40),
                workspaceRoot,
                cacheRoot: join(workspaceRoot, 'cache'),
                logger: createLogger(),
                casesRoot,
            },
            {
                exportIssue,
                prepareHistoricalExtensionBuild: fixtureBuild(),
                withPreparedFiltersCheckout: fixtureCheckout(),
                extractReport: extractReport as never,
                inspectHistoricalMetadata: vi.fn().mockResolvedValue({
                    filtersBaseSha: 'cd93c10da43f3dd3197d854adbe1b8218fdf8353',
                    extensionTagCommit: '65d6adcd0a7cdae237ff3344b190568bdb944514',
                    humanChangedFiles: ['JapaneseFilter/sections/antiadblock.txt'],
                    humanRuleLines: {
                        added: ["e-words.jp#%#//scriptlet('abort-on-property-read', 'x')"],
                        removed: [],
                    },
                    humanRuleCandidates: [
                        {
                            canonicalRule:
                                "e-words.jp#%#//scriptlet('abort-on-property-read', 'x')",
                            sourceRule: "e-words.jp#%#//scriptlet('abort-on-property-read', 'x')",
                        },
                    ],
                }),
            },
        );

        expect(prepared.caseName).toBe('e-words-jp-235510');
        expect(prepared.extensionBuild.version).toBe('5.4.3.84');
        const loaded = loadGoldenRunCase(prepared.caseDirectory);
        expect(
            toAgentIssueInput(JSON.parse(readFileSync(loaded.issueFile, 'utf8'))).comments,
        ).toEqual([expect.objectContaining({ body: expect.stringContaining('v5.4.3.84 MV3') })]);
        expect(
            toAgentIssueInput(JSON.parse(readFileSync(loaded.issueFile, 'utf8'))).attachments,
        ).toHaveLength(1);
    });

    it('fails closed before materializing unsupported or oracle-contaminated cases', async () => {
        const workspaceRoot = mkdtempSync(join(tmpdir(), 'case-preparer-reject-'));
        const casesRoot = join(workspaceRoot, 'cases');
        const exportIssue = vi.fn(async (_config, _issueNumber, options) => {
            mkdirSync(options.outputDir, { recursive: true });
            writeFileSync(
                join(options.outputDir, 'issue.json'),
                JSON.stringify({
                    schemaVersion: 1,
                    rawIssue: {
                        number: 4,
                        reporterAuthor: 'reporter',
                        url: 'https://github.com/AdguardTeam/AdguardFilters/issues/4',
                        title: 'example.com',
                        body: `Human commit leaked: ${HUMAN_COMMIT}`,
                        state: 'closed',
                        labels: ['T: Ads', 'N: AdGuard Browser Extension'],
                        assignee: null,
                        comments: [],
                    },
                    reporterComments: [],
                    attachments: [],
                }),
                'utf8',
            );
            return {
                snapshotPath: join(options.outputDir, 'issue.json'),
                snapshot: JSON.parse(readFileSync(join(options.outputDir, 'issue.json'), 'utf8')),
            };
        });

        await expect(
            prepareGoldenCase(
                { owner: 'AdguardTeam', repo: 'AdguardFilters', token: 'read-token' },
                {
                    issueNumber: 4,
                    humanFixCommit: HUMAN_COMMIT,
                    workspaceRoot,
                    cacheRoot: join(workspaceRoot, 'cache'),
                    logger: createLogger(),
                    casesRoot,
                },
                {
                    exportIssue,
                    inspectHistoricalMetadata: vi.fn(),
                },
            ),
        ).rejects.toThrow();
        expect(existsSync(join(casesRoot, 'example-com-4'))).toBe(false);
    });

    it.each([
        ['short human commit', HUMAN_COMMIT.slice(0, 12)],
        ['human pull request', 'https://github.com/AdguardTeam/AdguardFilters/pull/123456'],
        ['canonical human rule', HUMAN_CANONICAL_RULE],
        ['human source rule', HUMAN_SOURCE_RULE],
        ['quoted canonical human rule', HUMAN_QUOTED_CANONICAL_RULE],
        ['quoted human source rule', HUMAN_QUOTED_SOURCE_RULE],
    ])('rejects an agent-visible %s before materializing the case', async (_label, leak) => {
        const workspaceRoot = mkdtempSync(join(tmpdir(), 'case-preparer-answer-leak-'));
        const casesRoot = join(workspaceRoot, 'cases');
        const reportScreenshot = 'https://cdn.adguardcdn.com/sitereports/leak-test.png';
        // Free-form reporter prose: the oracle-isolation rejection must fire before any extraction
        // or case materialization happens.
        const body = [
            'Ads stay on https://www.money.pl/ on Chrome.',
            `Below is the screenshot of the banner: ![Screenshot](${reportScreenshot})`,
            `Reported: ${leak}`,
            'Import link in the issue configuration.',
        ].join('\n');
        const exportIssue = vi.fn(async (_config, _issueNumber, options) => {
            return await exportLocalIssueSnapshot(
                {
                    number: 235679,
                    reporterAuthor: 'reporter',
                    url: 'https://github.com/AdguardTeam/AdguardFilters/issues/235679',
                    title: 'www.money.pl',
                    body,
                    state: 'closed',
                    labels: ['T: Ads', 'N: AdGuard Browser Extension'],
                    assignee: null,
                    comments: [],
                },
                {
                    outputDir: options.outputDir,
                    reporterAuthorOnly: 'reporter',
                    includeStructuredIssueReports: true,
                    downloadAttachment: async () =>
                        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
                },
            );
        });
        const extractReport = scriptedExtraction({
            siteUrls: ['https://www.money.pl/'],
            problemType: 'ads',
            screenshots: [{ url: reportScreenshot }],
            environment: { product: 'AdGuard Browser Extension v5.4.3.96 MV3', browser: 'Chrome' },
            enabledLists: [],
            settingsImportUrl:
                'https://reports.adguard.com/settings/import.html?' +
                'product_type=ext&product_version=5.4.3.96&ext.manifest_version=3&browser=chrome',
            userRules: [],
            reproductionSteps: [],
        });

        await expect(
            prepareGoldenCase(
                { owner: 'AdguardTeam', repo: 'AdguardFilters', token: 'read-token' },
                {
                    issueNumber: 235679,
                    humanFixCommit: HUMAN_COMMIT,
                    workspaceRoot,
                    cacheRoot: join(workspaceRoot, 'cache'),
                    logger: createLogger(),
                    casesRoot,
                },
                {
                    exportIssue,
                    extractReport: extractReport as never,
                    inspectHistoricalMetadata: vi.fn().mockResolvedValue({
                        filtersBaseSha: FILTERS_BASE_SHA,
                        extensionTagCommit: 'a'.repeat(40),
                        humanChangedFiles: ['BaseFilter/sections/foreign.txt'],
                        humanRuleCandidates: HUMAN_RULE_CANDIDATES,
                        humanRuleLines: { added: [HUMAN_SOURCE_RULE], removed: [] },
                    }),
                },
            ),
        ).rejects.toThrow(/human|oracle|pull request/iu);
        expect(existsSync(join(casesRoot, 'money-pl-235679'))).toBe(false);
    });
});
