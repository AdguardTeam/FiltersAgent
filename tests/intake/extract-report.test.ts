import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import * as v from 'valibot';
import type { Logger } from '../../src/logger/logger';
import { RawIssueSchema, type RawIssue } from '../../src/github/fetch-issue';
import { GeneratedCommentMarker } from '../../src/github/generated-comment-markers';
import { createPromptDocumentLoader, PromptDocumentName } from '../../src/prompts/prompt-documents';
import { PromptRenderErrorKind } from '../../src/prompts/template';
import { IntakeVerdict, ReportProblemType } from '../../src/intake/report';
import { extractReport, IntakeExtractionKind } from '../../src/intake/extract-report';
import {
    HermeticScenario,
    type HermeticProvider,
    ScriptedReplyKind,
    startHermeticProvider,
} from '../pi/hermetic-provider';
import { createTestSingleShotClients } from '../pi/test-runtime';

/**
 * A minimal raw issue whose body carries one site URL, for assembly and wire assertions.
 */
function rawIssue(overrides: Partial<RawIssue> = {}): RawIssue {
    return {
        number: 42,
        reporterAuthor: 'reporter',
        url: 'https://github.com/owner/repo/issues/42',
        title: 'Ads on example.com',
        body: '### Issue URL\nhttps://example.com',
        state: 'open',
        labels: ['T: Ads'],
        assignee: null,
        comments: [],
        ...overrides,
    };
}

/**
 * The report a correct extraction of {@link rawIssue} produces.
 */
function expectedReport(): Record<string, unknown> {
    return {
        siteUrls: ['https://example.com'],
        problemType: ReportProblemType.Ads,
        declaredType: 'Ads',
        comment: 'An ad banner covers the article.',
        screenshots: [],
        environment: { product: 'AdGuard Browser Extension v5.0.0', browser: 'Chrome' },
        enabledLists: [{ name: 'EasyList' }],
        userRules: [],
        reproductionSteps: [],
    };
}

let provider: HermeticProvider | undefined;

afterEach(async () => {
    if (!provider) {
        return;
    }
    await provider.close();
    provider = undefined;
});

describe('extract-report prompt document', () => {
    it('renders the extract-report task with the full fill set', () => {
        const loader = createPromptDocumentLoader();
        const rendered = loader.render(PromptDocumentName.ExtractReportTask, {
            issueNumber: '42',
            issueUrl: 'https://github.com/owner/repo/issues/42',
            issueTitle: 'Ads on example.com',
            issueBody: '### Issue URL\nhttps://example.com',
            trustedComments: '- reporter: no comments',
            officialFilterCatalog: '- 2: AdGuard Base filter',
        });
        expect(rendered).toContain('#42');
        expect(rendered).toContain('https://github.com/owner/repo/issues/42');
        expect(rendered).toContain('Ads on example.com');
        expect(rendered).toContain('https://example.com');
    });

    it('refuses to render with an incomplete fill set', () => {
        const loader = createPromptDocumentLoader();
        expect(() =>
            loader.render(PromptDocumentName.ExtractReportTask, {
                issueNumber: '42',
                issueUrl: 'https://github.com/owner/repo/issues/42',
                issueTitle: 'Ads on example.com',
                issueBody: '### Issue URL\nhttps://example.com',
            }),
        ).toThrow(expect.objectContaining({ kind: PromptRenderErrorKind.MissingPlaceholder }));
    });
});

describe('extractReport', () => {
    it('maps a schema-valid extraction reply to a report outcome', async () => {
        provider = await startHermeticProvider({
            scenario: HermeticScenario.Scripted,
            script: [
                {
                    kind: ScriptedReplyKind.Text,
                    text: JSON.stringify({
                        verdict: IntakeVerdict.FilterReport,
                        report: expectedReport(),
                    }),
                },
            ],
        });
        const clients = await createTestSingleShotClients(provider.baseUrl);

        const outcome = await extractReport(rawIssue(), { client: clients.reasoning });

        expect(outcome).toEqual({ kind: IntakeExtractionKind.Report, report: expectedReport() });
    });

    it('maps a not-a-filter-report reply to a skipped outcome with the reason', async () => {
        provider = await startHermeticProvider({
            scenario: HermeticScenario.Scripted,
            script: [
                {
                    kind: ScriptedReplyKind.Text,
                    text: JSON.stringify({
                        verdict: IntakeVerdict.NotAFilterReport,
                        reason: 'no site URL in the issue',
                    }),
                },
            ],
        });
        const clients = await createTestSingleShotClients(provider.baseUrl);

        const outcome = await extractReport(rawIssue(), { client: clients.reasoning });

        expect(outcome).toEqual({
            kind: IntakeExtractionKind.Skipped,
            reason: 'no site URL in the issue',
        });
    });

    it('throws with the field name when every reply fails schema validation', async () => {
        provider = await startHermeticProvider({
            scenario: HermeticScenario.Scripted,
            script: [
                {
                    kind: ScriptedReplyKind.Text,
                    text: JSON.stringify({
                        verdict: IntakeVerdict.FilterReport,
                        report: { siteUrls: [] },
                    }),
                },
                {
                    kind: ScriptedReplyKind.Text,
                    text: JSON.stringify({
                        verdict: IntakeVerdict.FilterReport,
                        report: { siteUrls: [] },
                    }),
                },
            ],
        });
        const clients = await createTestSingleShotClients(provider.baseUrl);

        await expect(extractReport(rawIssue(), { client: clients.reasoning })).rejects.toThrow(
            /siteUrls/,
        );
        await expect(extractReport(rawIssue(), { client: clients.reasoning })).rejects.toThrow(
            /Report extraction failed schema validation/,
        );
    });

    it('repairs a site URL the model did not copy from the issue, then accepts the faithful copy', async () => {
        // A 1.3 KB base64 query string the model could not reproduce (AdguardFilters #242138): the
        // garbled copy became the run's whole navigation allow-list, and every launch was refused.
        const token = Buffer.from('x'.repeat(900)).toString('base64');
        const reported = `https://app.example.com/?nd=t&aiintent=${token}`;
        const garbled = `https://app.example.com/?nd=t&aiintent=${token.slice(0, 300)}Q${token.slice(340)}`;
        provider = await startHermeticProvider({
            scenario: HermeticScenario.Scripted,
            script: [
                {
                    kind: ScriptedReplyKind.Text,
                    text: JSON.stringify({
                        verdict: IntakeVerdict.FilterReport,
                        report: { ...expectedReport(), siteUrls: [garbled] },
                    }),
                },
                {
                    kind: ScriptedReplyKind.Text,
                    text: JSON.stringify({
                        verdict: IntakeVerdict.FilterReport,
                        report: { ...expectedReport(), siteUrls: [reported] },
                    }),
                },
            ],
        });
        const clients = await createTestSingleShotClients(provider.baseUrl);
        const issue = rawIssue({
            title: 'app.example.com',
            body: `### Issue URL (Incorrect Blocking)\n[${reported}](https://redirect.example/?url=${encodeURIComponent(reported)})`,
        });

        const outcome = await extractReport(issue, { client: clients.reasoning });

        expect(outcome).toEqual({
            kind: IntakeExtractionKind.Report,
            report: { ...expectedReport(), siteUrls: [reported] },
        });
        expect(provider.requests).toHaveLength(2);
        const repair = String(provider.requests[1]!.messages.at(-1)!.content);
        expect(repair).toContain('siteUrls');
        expect(repair).toContain('copied from the issue');
    });

    it('accepts a site URL the issue states without a scheme', async () => {
        provider = await startHermeticProvider({
            scenario: HermeticScenario.Scripted,
            script: [
                {
                    kind: ScriptedReplyKind.Text,
                    text: JSON.stringify({
                        verdict: IntakeVerdict.FilterReport,
                        report: { ...expectedReport(), siteUrls: ['https://sitepoint.com/'] },
                    }),
                },
            ],
        });
        const clients = await createTestSingleShotClients(provider.baseUrl);
        const issue = rawIssue({
            title: 'sitepoint.com: ads throughout',
            body: 'Visible ads in the header and the sidebar.',
        });

        const outcome = await extractReport(issue, { client: clients.reasoning });

        expect(outcome).toMatchObject({
            kind: IntakeExtractionKind.Report,
            report: { siteUrls: ['https://sitepoint.com/'] },
        });
        expect(provider.requests).toHaveLength(1);
    });

    it('throws naming siteUrls when no reply copies the site URL from the issue', async () => {
        const invented = JSON.stringify({
            verdict: IntakeVerdict.FilterReport,
            report: { ...expectedReport(), siteUrls: ['https://elsewhere.example/'] },
        });
        provider = await startHermeticProvider({
            scenario: HermeticScenario.Scripted,
            script: [
                { kind: ScriptedReplyKind.Text, text: invented },
                { kind: ScriptedReplyKind.Text, text: invented },
            ],
        });
        const clients = await createTestSingleShotClients(provider.baseUrl);

        await expect(extractReport(rawIssue(), { client: clients.reasoning })).rejects.toThrow(
            /siteUrls.*copied from the issue/,
        );
    });

    it('shows the model the official catalog and repairs an id the catalog does not have', async () => {
        const reply = (officialFilterId: number) =>
            JSON.stringify({
                verdict: IntakeVerdict.FilterReport,
                report: {
                    ...expectedReport(),
                    enabledLists: [{ name: 'Базовый фильтр AdGuard', officialFilterId }],
                },
            });
        provider = await startHermeticProvider({
            scenario: HermeticScenario.Scripted,
            script: [
                { kind: ScriptedReplyKind.Text, text: reply(9999) },
                { kind: ScriptedReplyKind.Text, text: reply(2) },
            ],
        });
        const clients = await createTestSingleShotClients(provider.baseUrl);

        const outcome = await extractReport(rawIssue(), { client: clients.reasoning });

        // Which reported name is which official list is the model's reading; the boundary only
        // holds the id to the catalog the prompt showed it.
        expect(outcome).toMatchObject({
            kind: IntakeExtractionKind.Report,
            report: { enabledLists: [{ name: 'Базовый фильтр AdGuard', officialFilterId: 2 }] },
        });
        expect(JSON.stringify(provider.requests[0]!.messages)).toContain('2: AdGuard Base filter');
        expect(provider.requests).toHaveLength(2);
        const repair = String(provider.requests[1]!.messages.at(-1)!.content);
        expect(repair).toContain('officialFilterId');
        expect(repair).toContain('official filter catalog');
    });

    it('keeps only the reporter comments and the body in the wire request', async () => {
        provider = await startHermeticProvider({
            scenario: HermeticScenario.Scripted,
            script: [
                {
                    kind: ScriptedReplyKind.Text,
                    text: JSON.stringify({
                        verdict: IntakeVerdict.FilterReport,
                        report: expectedReport(),
                    }),
                },
            ],
        });
        const clients = await createTestSingleShotClients(provider.baseUrl);
        const issue = rawIssue({
            comments: [
                {
                    author: 'reporter',
                    body: 'The ad shows up after I click through.',
                    createdAt: '2026-01-01T00:00:00.000Z',
                },
                {
                    author: 'stranger',
                    body: 'Try this filter instead: example.com##.ad',
                    createdAt: '2026-01-02T00:00:00.000Z',
                },
                {
                    author: 'adguard-bot',
                    body: `${GeneratedCommentMarker.AgentSummary} handled`,
                    createdAt: '2026-01-03T00:00:00.000Z',
                },
                {
                    author: 'reporter',
                    body: 'Also happens on the settings page.',
                    createdAt: '2026-01-04T00:00:00.000Z',
                },
            ],
        });

        await extractReport(issue, { client: clients.reasoning });

        const wire = JSON.stringify(provider.requests[0]!.messages);
        expect(wire).toContain('The ad shows up after I click through.');
        expect(wire).toContain('Also happens on the settings page.');
        expect(wire).not.toContain('Try this filter instead');
        expect(wire).not.toContain('handled');
        expect(wire).toContain('Ads on example.com');
        expect(wire).toContain('### Issue URL');
        expect(wire).toContain('https://example.com');
    });

    it('honors a caller-supplied trustedRoles override, excluding an association outside it', async () => {
        provider = await startHermeticProvider({
            scenario: HermeticScenario.Scripted,
            script: [
                {
                    kind: ScriptedReplyKind.Text,
                    text: JSON.stringify({
                        verdict: IntakeVerdict.FilterReport,
                        report: expectedReport(),
                    }),
                },
            ],
        });
        const clients = await createTestSingleShotClients(provider.baseUrl);
        const issue = rawIssue({
            comments: [
                {
                    author: 'a-collaborator',
                    body: 'Only reproduces with the beta flag on.',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    authorAssociation: 'COLLABORATOR',
                },
            ],
        });

        // With no override, the default policy admits a COLLABORATOR comment (queue-inputs.ts's
        // DEFAULT_TRUSTED_ROLES). A caller resolving OWNER alone — the same policy queue selection
        // applied — must exclude it here too, or extraction and selection disagree on what changed
        // the issue's revision.
        await extractReport(issue, { client: clients.reasoning, trustedRoles: ['OWNER'] });

        const wire = JSON.stringify(provider.requests[0]!.messages);
        expect(wire).not.toContain('Only reproduces with the beta flag on.');
    });

    it('logs one structured info line for a skip', async () => {
        provider = await startHermeticProvider({
            scenario: HermeticScenario.Scripted,
            script: [
                {
                    kind: ScriptedReplyKind.Text,
                    text: JSON.stringify({
                        verdict: IntakeVerdict.NotAFilterReport,
                        reason: 'no site URL in the issue',
                    }),
                },
            ],
        });
        const clients = await createTestSingleShotClients(provider.baseUrl);
        const logs: unknown[][] = [];
        const logger = {
            info: (...args: unknown[]) => {
                logs.push(args);
            },
            warn: () => undefined,
            debug: () => undefined,
            error: () => undefined,
        } as unknown as Logger;

        await extractReport(rawIssue(), { client: clients.reasoning, logger });

        // The skip is one line of its own; the single-shot client logs its completed call
        // through the same sink, so the skip line is picked by its message, not by count.
        const skipLines = logs.filter(([, message]) => String(message).includes('skipped'));
        expect(skipLines).toHaveLength(1);
        const [payload] = skipLines[0]! as [Record<string, unknown>, string];
        expect(payload).toMatchObject({ issueNumber: 42 });
    });
});

/**
 * Load one real-issue fixture as a raw issue.
 *
 * @param name - Fixture file name under `tests/intake/fixtures/`.
 * @returns The validated raw issue.
 */
function fixture(name: string): RawIssue {
    const doc = JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
    return v.parse(RawIssueSchema, doc);
}

/**
 * The report a correct extraction of the adguard-bot fixture produces.
 */
function botExpectedReport(): Record<string, unknown> {
    return {
        siteUrls: [
            'https://www.rmcbfmplay.com/video/episode/mickey-dans-tous-les-foyers-la-folie-du-merchandising-1020905975577',
        ],
        problemType: ReportProblemType.AntiAdblock,
        declaredType: 'Anti Adblock Script',
        screenshots: [
            {
                url: 'https://cdn.adguardcdn.com/sitereports/fh08kpn91pssw4s4sso8gg8og8gsgk4fkvsh9k1tvc.png?nc=1',
            },
        ],
        environment: {
            product: 'AdGuard Browser Extension v5.4.3.79 MV3',
            browser: 'Chrome',
            os: 'Mac OS 26.2.0',
        },
        enabledLists: [
            { name: 'AdGuard Base filter', officialFilterId: 2 },
            { name: 'Filter unblocking search ads and self-promotion', officialFilterId: 10 },
            { name: 'AdGuard Russian filter', officialFilterId: 1 },
            { name: 'AdGuard German filter', officialFilterId: 6 },
            { name: 'AdGuard Dutch filter', officialFilterId: 8 },
            { name: 'AdGuard Spanish/Portuguese filter', officialFilterId: 9 },
            { name: 'AdGuard Turkish filter', officialFilterId: 13 },
            { name: 'AdGuard French filter', officialFilterId: 16 },
            { name: 'EasyList Italy' },
            { name: 'Liste AR' },
            { name: 'Official Polish filters for AdBlock, uBlock Origin & AdGuard' },
        ],
        settingsImportUrl:
            'https://reports.adguard.com/settings/import.html?scheme_version=4&product_type=ext&product_version=5.4.3.79&system_version=Mac+OS+26.2.0&ext.manifest_version=3&browser=chrome&regular_filters=1%2C2%2C6%2C8%2C9%2C10%2C13%2C16%2C109%2C112%2C216&filters_last_update=2026-06-26T09%3A00%3A59Z&stealth.enabled=0',
        userRules: [],
        reproductionSteps: [],
    };
}

/**
 * The report a correct extraction of the uBO-widget fixture produces.
 */
function uboExpectedReport(): Record<string, unknown> {
    return {
        siteUrls: ['https://ptoszek.pl/'],
        problemType: ReportProblemType.Other,
        comment: 'badware redirect from the compromised knowyourmeme.com',
        screenshots: [
            {
                url: 'https://github.com/user-attachments/assets/40b80d8c-4a1c-4fca-9b59-bc5a81404261',
            },
        ],
        environment: { browser: 'Brave 1.94.121 (Official Build) (64-bit)' },
        enabledLists: [
            { name: 'ublock-experimental' },
            { name: 'adguard-generic' },
            { name: 'adguard-mobile-app-banners' },
            { name: 'easylist-newsletters' },
            { name: 'ublock-annoyances' },
            { name: 'dpollock-0' },
            { name: 'ublock-filters' },
            { name: 'ublock-badware' },
            { name: 'ublock-privacy' },
            { name: 'ublock-unbreak' },
            { name: 'ublock-quick-fixes' },
            { name: 'easylist' },
            { name: 'easyprivacy' },
            { name: 'urlhaus-1' },
            { name: 'plowe-0' },
        ],
        userRules: ['##+js(prevent-clipboard-write, /^mshta |^msiexec |^(bash <<<|cur\u2026'],
        blockedCounts: { 'ublock-filters': 53298, 'ublock-badware': 10395, easylist: 88767 },
        reproductionSteps: [],
    };
}

/**
 * The report a correct extraction of the free-form EasyList fixture produces (sparse fill).
 */
function freeformExpectedReport(): Record<string, unknown> {
    return {
        siteUrls: ['https://www.sibnet.ru/', 'https://video.sibnet.ru/'],
        problemType: ReportProblemType.Annoyance,
        comment: 'social',
        screenshots: [{ url: 'https://i.ibb.co/PZd1ZkJ4/i.png' }],
        environment: {},
        enabledLists: [],
        userRules: ['sibnet.ru##.push', 'sibnet.ru###widget-messenger'],
        reproductionSteps: [],
    };
}

describe('extractReport over the three real-issue fixtures', () => {
    it('holds every fixture to the raw-issue contract', () => {
        expect(fixture('adguard-bot-issue.json').number).toBeGreaterThan(0);
        expect(fixture('ubo-widget-issue.json').number).toBeGreaterThan(0);
        expect(fixture('easylist-freeform-issue.json').number).toBeGreaterThan(0);
    });

    it('assembles the adguard-bot issue and returns the AC key fields', async () => {
        const raw = fixture('adguard-bot-issue.json');
        provider = await startHermeticProvider({
            scenario: HermeticScenario.Scripted,
            script: [
                {
                    kind: ScriptedReplyKind.Text,
                    text: JSON.stringify({
                        verdict: IntakeVerdict.FilterReport,
                        report: botExpectedReport(),
                    }),
                },
            ],
        });
        const clients = await createTestSingleShotClients(provider.baseUrl);

        const outcome = await extractReport(raw, { client: clients.reasoning });

        expect(outcome.kind).toBe(IntakeExtractionKind.Report);
        if (outcome.kind !== IntakeExtractionKind.Report) {
            return;
        }
        expect(outcome.report.siteUrls).toEqual(botExpectedReport().siteUrls);
        expect(outcome.report.problemType).toBe(ReportProblemType.AntiAdblock);
        expect(outcome.report.environment).toMatchObject({
            product: 'AdGuard Browser Extension v5.4.3.79 MV3',
            browser: 'Chrome',
            os: 'Mac OS 26.2.0',
        });
        expect(outcome.report.enabledLists).toContainEqual({
            name: 'AdGuard Russian filter',
            officialFilterId: 1,
        });
        expect(outcome.report.settingsImportUrl).toContain('reports.adguard.com');
        const wire = JSON.stringify(provider.requests[0]!.messages);
        expect(wire).toContain('www.rmcbfmplay.com');
        expect(wire).toContain('AdGuard Russian filter');
    });

    it('embeds the uBO YAML block in the wire request and returns lists, counts and rules', async () => {
        const raw = fixture('ubo-widget-issue.json');
        provider = await startHermeticProvider({
            scenario: HermeticScenario.Scripted,
            script: [
                {
                    kind: ScriptedReplyKind.Text,
                    text: JSON.stringify({
                        verdict: IntakeVerdict.FilterReport,
                        report: uboExpectedReport(),
                    }),
                },
            ],
        });
        const clients = await createTestSingleShotClients(provider.baseUrl);

        const outcome = await extractReport(raw, { client: clients.reasoning });

        expect(outcome.kind).toBe(IntakeExtractionKind.Report);
        if (outcome.kind !== IntakeExtractionKind.Report) {
            return;
        }
        expect(outcome.report.siteUrls).toEqual(['https://ptoszek.pl/']);
        expect(outcome.report.enabledLists).toContainEqual({ name: 'ublock-badware' });
        expect(outcome.report.blockedCounts).toMatchObject({ 'ublock-filters': 53298 });
        expect(outcome.report.userRules).toContain(
            '##+js(prevent-clipboard-write, /^mshta |^msiexec |^(bash <<<|cur\u2026',
        );
        const wire = JSON.stringify(provider.requests[0]!.messages);
        expect(wire).toContain('ptoszek.pl');
        expect(wire).toContain('listset (total-discarded');
        expect(wire).toContain('supportStats');
        expect(wire).toContain('adguard-mobile-app-banners');
    });

    it('sparse-fills the free-form EasyList issue and continues', async () => {
        const raw = fixture('easylist-freeform-issue.json');
        provider = await startHermeticProvider({
            scenario: HermeticScenario.Scripted,
            script: [
                {
                    kind: ScriptedReplyKind.Text,
                    text: JSON.stringify({
                        verdict: IntakeVerdict.FilterReport,
                        report: freeformExpectedReport(),
                    }),
                },
            ],
        });
        const clients = await createTestSingleShotClients(provider.baseUrl);

        const outcome = await extractReport(raw, { client: clients.reasoning });

        expect(outcome.kind).toBe(IntakeExtractionKind.Report);
        if (outcome.kind !== IntakeExtractionKind.Report) {
            return;
        }
        expect(outcome.report.siteUrls).toContain('https://www.sibnet.ru/');
        expect(outcome.report.environment).toEqual({});
        expect(outcome.report.enabledLists).toEqual([]);
        expect(outcome.report.userRules).toEqual([
            'sibnet.ru##.push',
            'sibnet.ru###widget-messenger',
        ]);
        const wire = JSON.stringify(provider.requests[0]!.messages);
        expect(wire).toContain('sibnet.ru');
        expect(wire).toContain('widget-messenger');
    });
});
