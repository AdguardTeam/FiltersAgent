import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Frame, Page, Response } from 'playwright-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAdguardCliBlocker } from '../../src/adguard-cli/adguard-cli-blocker';
import { readAdguardCliLog } from '../../src/adguard-cli/adguard-cli-log';
import { createBlockerAppliedRulesLog } from '../../src/blocker-contract/blocker-applied-rules';
import {
    PageEvidenceFormat,
    type BlockerContract,
    type BlockerFilterList,
} from '../../src/blocker-contract/blocker-contract';
import { watchPageEvidence, type PageReports } from '../../src/blocker-contract/page-evidence';
import {
    AppliedRuleFamily,
    AppliedRuleReporter,
    AppliedRulesReadKind,
    type AppliedRulesReport,
} from '../../src/environment/applied-rules';
import type { Logger } from '../../src/logger/logger';

const temporaryRoots: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
});

/*
 * The requests of a live nnmclub.to run, in the AdGuard CLI access-log format, and the proxy
 * output lines of that run. The access log carries the rule text of a blocked request and no list
 * id; the proxy output carries the rule that removed an element from the served HTML.
 */
const BEFORE_SESSION_ACCESS =
    '24.09.2026 07:56:27.255000 "manual_proxy" HTTP2 GET ' +
    'https://nnmstatic.win/forum/ads/tumbler/branding.js?3 - 0 script BLOCKED 1 ID=1 - 0b 1ms ' +
    '-- ||nnmstatic.win/forum/ads/\n';
const SESSION_ACCESS = [
    '24.09.2026 07:57:36.174000 "manual_proxy" HTTP2 GET https://nnmclub.to/ - 200 any ' +
        'MODIFIED_CONTENT 5 - 203.0.113.7:443 1005571b 209ms -- ',
    '24.09.2026 07:57:36.537000 "manual_proxy" HTTP2 GET https://www.google-analytics.com/ga.js ' +
        '- 0 script BLOCKED 1 ID=1 - 0b 1ms -- ' +
        '||google-analytics.com/ga.js$script,redirect=google-analytics-ga,domain=~daj.jp',
    '24.09.2026 07:57:36.856000 "manual_proxy" HTTP GET ' +
        'https://counter.yadro.ru/hit?t52.10;r;s1920*1080*24;uhttps%3A//nnmclub.to/;' +
        '0.6174267215701524 - 0 img BLOCKED 1 ID=1 - 0b 0ms -- ||yadro.ru^',
    '24.09.2026 07:57:36.399000 "manual_proxy" TCP - - - - any NONE 0 - - 58b 3ms -- ',
].join('\n');
const BEFORE_SESSION_OUTPUT =
    '--- 2026-09-24T07:56:19.567Z starting on port 39483 with filters 1,2,3 and 0 user rules\n';
const SESSION_OUTPUT = [
    '24.09.2026 07:57:36.234171 INFO  [243] AGStandaloneProxyServer onHtmlElementRemoved: ' +
        '[sess 1000003 - req 200186] rule:||pagead2.googlesyndication.com^ ' +
        'url:https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-7768347321290299 ' +
        'element name:script resourceType:script',
    'removed element:<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-7768347321290299" crossorigin="anonymous"></script>',
    '24.09.2026 07:57:36.383489 INFO  [243] AGStandaloneProxyServer onRequestProcessed: ' +
        '[sess 1000003 - req 200186] host:nnmclub.to I/O: 1005571/0 protocol:AGPROTO_HTTP2 ' +
        'main_status:MODIFIED_CONTENT  status:MODIFIED_CONTENT MODIFIED_META  rule:',
].join('\n');

/*
 * What the proxy reports inside the page, in the forms the pinned core-libs (fc61577f) writes with
 * every developer-mode flag on, as its standalone proxy_server runs. The content script a page
 * loads from the injections host carries each injected script as `{ruleText:…,filterId:…,func:…}`
 * (jsfilter's add_rule_to_result; test_AGFilterContent.cpp pins the same form), the last one being
 * the proxy's own stealth script. Every element-hiding rule marks what it hides with
 * `content: 'adguard<list>;<rule>'`, URL-encoded (cssfilter's debug form, pinned in the same test).
 */
const SCRIPTLET_RULE = "nnmclub.to#%#//scriptlet('set-constant', 'adblock', 'false')";
const CONTENT_SCRIPT_URL =
    'https://local.adguard.org/?ts=1790236306660&type=content-script&dmn=nnmclub.to&' +
    'url=https%3A%2F%2Fnnmclub.to%2F&app=manual_proxy&css=3&js=1&rel=1&rji=1&sbe=0';
const CONTENT_SCRIPT_BODY =
    '/* content-script - v3.2.1 - 6/29/2026 */\n!function(){var e={commonCss:null,' +
    'specificCss:".banner { display: none!important; content: \'adguard1%3Bnnmclub.to%23%23' +
    '.banner\'!important; }\\n",extendedCssRules:null,script:[{ruleText:' +
    `${JSON.stringify(SCRIPTLET_RULE)},filterId:1,func:(function(api){\n` +
    '(function setConstant(source,args){})({api:api,name:"set-constant",engine:"corelibs",' +
    `version:"1.0.0",verbose:true,ruleText:${JSON.stringify(SCRIPTLET_RULE)}},` +
    '["adblock","false",]);\n\n})},{ruleText:"Additional script",filterId:-1,' +
    'func:(function(api){\n\n})}],nonce:"8a8d88bb83414bf9973f71711a8",verbose:true}}();';

/**
 * One element as the fake frame's page shows it, with the `content` its style computes to.
 */
interface ShownElement {
    tagName: string;
    id: string;
    className: string;
    content: string;
}

/**
 * The elements of the page: one hidden by a listed rule, one carrying a marker the page wrote
 * itself for a rule no executed list holds, and one untouched.
 */
const SHOWN_ELEMENTS: ShownElement[] = [
    {
        tagName: 'DIV',
        id: 'top',
        className: 'banner wide',
        content: '"adguard1%3Bnnmclub.to%23%23.banner"',
    },
    { tagName: 'SPAN', id: '', className: 'forged', content: '"adguard9%3B%23%23.forged"' },
    { tagName: 'P', id: '', className: '', content: 'normal' },
];

/**
 * A frame whose evaluated functions run against a page of the given elements.
 *
 * @param elements - What the frame shows.
 * @returns The frame.
 */
function frameShowing(elements: readonly ShownElement[]): Frame {
    return {
        url: () => 'https://nnmclub.to/',
        evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => {
            const page = globalThis as unknown as Record<string, unknown>;
            page['document'] = { querySelectorAll: () => elements };
            page['getComputedStyle'] = (element: ShownElement) => ({ content: element.content });
            try {
                return fn(arg);
            } finally {
                delete page['document'];
                delete page['getComputedStyle'];
            }
        },
    } as unknown as Frame;
}

/**
 * A session page that serves responses on demand and shows the given frames.
 *
 * @param frames - The page's frames.
 * @returns The page and a way to deliver one response to its listeners.
 */
function watchedPage(frames: Frame[]): {
    page: Page;
    respond: (url: string, body: string) => void;
} {
    const listeners: Array<(response: Response) => void> = [];
    const page = {
        on: (event: string, listener: (response: Response) => void) => {
            expect(event).toBe('response');
            listeners.push(listener);
        },
        frames: () => frames,
    } as unknown as Page;
    return {
        page,
        respond: (url, body) => {
            const response = { url: () => url, text: async () => body } as unknown as Response;
            for (const listener of listeners) {
                listener(response);
            }
        },
    };
}

/**
 * A logger whose calls the test can read.
 *
 * @returns The logger.
 */
function quietLogger(): Logger {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

/**
 * The executed lists: the ga.js rule of the real Tracking Protection list is left out on purpose,
 * so one reported rule sits in no executed list.
 */
const LISTS: BlockerFilterList[] = [
    {
        id: 1,
        content:
            '! Title: AdGuard Russian filter\n||nnmstatic.win/forum/ads/\n' +
            `nnmclub.to##.banner\n${SCRIPTLET_RULE}\n`,
    },
    {
        id: 2,
        content: '! Title: AdGuard Base filter\r\n||pagead2.googlesyndication.com^\r\n',
    },
    { id: 3, content: '! Title: AdGuard Tracking Protection filter\n||yadro.ru^\n' },
];

/**
 * A proxy workspace holding what the proxy logged before the session.
 */
interface Workspace {
    root: string;
    accessLogPath: string;
    outputLogPath: string;
}

async function workspace(): Promise<Workspace> {
    const root = await mkdtemp(join(tmpdir(), 'adguard-cli-applied-rules-'));
    temporaryRoots.push(root);
    const accessLogPath = join(root, 'access.log');
    const outputLogPath = join(root, 'proxy-output.log');
    await writeFile(accessLogPath, BEFORE_SESSION_ACCESS);
    await writeFile(outputLogPath, BEFORE_SESSION_OUTPUT);
    return { root, accessLogPath, outputLogPath };
}

/**
 * The applied-rules log of a session that launched now, at revision 1, over the AdGuard CLI's own
 * description and logs.
 *
 * @param paths - The proxy workspace.
 * @param lists - The executed lists.
 * @param page - The session's page reports.
 * @param revision - The revision the blocker reports at each read.
 * @returns The session's applied-rules log.
 */
async function sessionLog(
    paths: Workspace,
    lists: readonly BlockerFilterList[],
    page: PageReports,
    revision = 1,
): Promise<ReturnType<typeof createBlockerAppliedRulesLog>> {
    const binaryPath = join(paths.root, 'adguard-cli');
    await writeFile(binaryPath, 'fixture binary');
    const description = await createAdguardCliBlocker({
        binaryPath,
        workspaceDir: paths.root,
        createProxy: () => {
            throw new Error('not started in this test');
        },
    }).describe();
    const blocker = {
        log: (cursor: string | null) => readAdguardCliLog(paths.root, cursor, revision),
    } as unknown as BlockerContract;
    return createBlockerAppliedRulesLog({
        blocker,
        description,
        cursor: (await blocker.log(null)).cursor,
        revision: 1,
        lists,
        page,
    });
}

/**
 * Watch a page the way an AdGuard CLI session does.
 *
 * @param page - The session's page.
 * @param logger - Run logger.
 * @returns The page reports.
 */
function adguardPage(page: Page, logger: Logger): PageReports {
    return watchPageEvidence(
        page,
        { format: PageEvidenceFormat.AdguardMarkers, contentScriptHost: 'local.adguard.org' },
        logger,
    );
}

describe('the AdGuard CLI applied-rules log', () => {
    it('reports the session rules the proxy logged, each with the executed lists holding it', async () => {
        const paths = await workspace();
        const { page, respond } = watchedPage([frameShowing(SHOWN_ELEMENTS)]);
        const log = await sessionLog(paths, LISTS, adguardPage(page, quietLogger()));
        await appendFile(paths.accessLogPath, `${SESSION_ACCESS}\n`);
        await appendFile(paths.outputLogPath, `${SESSION_OUTPUT}\n`);
        respond(CONTENT_SCRIPT_URL, CONTENT_SCRIPT_BODY);
        respond('https://nnmclub.to/forum/js/main.js', 'var script = [{ruleText:"x"}];');

        const read = await log.read('https://nnmclub.to/');

        expect(read.kind).toBe(AppliedRulesReadKind.Report);
        const report = (read as { report: AppliedRulesReport }).report;
        expect(report.events).toEqual([
            {
                rule: '||google-analytics.com/ga.js$script,redirect=google-analytics-ga,domain=~daj.jp',
                family: AppliedRuleFamily.Network,
                filterIds: [],
                target: 'https://www.google-analytics.com/ga.js',
                reportedBy: [AppliedRuleReporter.Engine],
            },
            {
                rule: '||yadro.ru^',
                family: AppliedRuleFamily.Network,
                filterIds: [3],
                target:
                    'https://counter.yadro.ru/hit?t52.10;r;s1920*1080*24;uhttps%3A//nnmclub.to/;' +
                    '0.6174267215701524',
                reportedBy: [AppliedRuleReporter.Engine],
            },
            {
                rule: '||pagead2.googlesyndication.com^',
                family: AppliedRuleFamily.HtmlFiltering,
                filterIds: [2],
                target:
                    'script https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js' +
                    '?client=ca-pub-7768347321290299',
                reportedBy: [AppliedRuleReporter.Engine],
            },
            {
                rule: SCRIPTLET_RULE,
                family: AppliedRuleFamily.Script,
                filterIds: [1],
                target: 'https://nnmclub.to/',
                reportedBy: [AppliedRuleReporter.Engine],
            },
            {
                rule: 'nnmclub.to##.banner',
                family: AppliedRuleFamily.ElementHiding,
                filterIds: [1],
                target: 'div#top.banner.wide',
                reportedBy: [AppliedRuleReporter.Engine],
            },
        ]);
        expect(report.lists).toEqual([
            { id: 1, name: 'AdGuard Russian filter' },
            { id: 2, name: 'AdGuard Base filter' },
            { id: 3, name: 'AdGuard Tracking Protection filter' },
        ]);
        // The rules the proxy counts on a request without naming them are stated, not implied.
        expect(report.notReported).toEqual(
            expect.arrayContaining([expect.stringContaining('$csp')]),
        );
        expect(report.trackingProtection).toEqual([]);
        expect(report.engine).toBe('AdGuard CLI');
    });

    it('reads the network rules from an AdGuard CLI access log', async () => {
        // Lines from the AdGuard CLI 1.5.0-rc.1 money.pl run of 2026-10-01: a blocked request, a
        // connection refused at the TLS handshake, and lines that name no rule.
        const cliAccess = [
            '01.10.2026 12:41:54.202003 "manual_proxy" HTTP2 GET https://www.money.pl/ - 200 any ' +
                'MODIFIED_CONTENT 8 - 212.77.113.87:443 994319b 247ms -- ',
            '01.10.2026 12:41:56.214018 "manual_proxy" HTTP2 POST https://i.connectad.io/api/v2 ' +
                'https://www.money.pl/ 0 other|xhr BLOCKED 1 ID=1 8.47.69.6:443 0b 1ms -- ||connectad.io^',
            '01.10.2026 12:50:47.720938 "manual_proxy" TLS - image8.pubmatic.com - - any BLOCKED 1 ' +
                'ID=1 - 58b 131ms -- ||pubmatic.com^',
            '01.10.2026 12:50:44.443157 "manual_proxy" TLS - adx.adform.net - - any BLOCKED 0 - - ' +
                '58b 478ms -- ',
            '01.10.2026 12:41:49.384374 "manual_proxy" TCP - - - - any NONE 0 - - 0b 0ms -- ',
        ].join('\n');
        const paths = await workspace();
        const { page } = watchedPage([frameShowing([])]);
        const log = await sessionLog(
            paths,
            [{ id: 2, content: '||connectad.io^\n||pubmatic.com^\n' }],
            adguardPage(page, quietLogger()),
        );
        await appendFile(paths.accessLogPath, `${cliAccess}\n`);

        const read = await log.read('https://www.money.pl/');

        const report = (read as { report: AppliedRulesReport }).report;
        expect(report.events).toEqual([
            {
                rule: '||connectad.io^',
                family: AppliedRuleFamily.Network,
                filterIds: [2],
                target: 'https://i.connectad.io/api/v2',
                reportedBy: [AppliedRuleReporter.Engine],
            },
            {
                rule: '||pubmatic.com^',
                family: AppliedRuleFamily.Network,
                filterIds: [2],
                target: 'image8.pubmatic.com',
                reportedBy: [AppliedRuleReporter.Engine],
            },
        ]);
    });

    it('names a host the proxy stopped decrypting, once, with its reason', async () => {
        // Lines from an AdGuard CLI run on a learning.ua report: the release judged the site's
        // certificate invalid and tunnelled the site, so no cosmetic rule could act on it, while
        // the run showed the candidate as applied.
        const cliOutput = [
            "11.10.2026 16:56:28.986574 INFO  [103] AGSslDomainFilter checkDomain: [id=1000002] TLS connection may not be filtered because server doesn't have valid certificate, adding 'manual_proxy#178.63.237.44:443#learning.ua' to exceptions",
            "11.10.2026 16:56:55.093699 INFO  [102] AGSslDomainFilter checkDomain: [id=1000005] TLS connection may not be filtered because server doesn't have valid certificate, adding 'manual_proxy#178.63.237.44:443#learning.ua' to exceptions",
            "11.10.2026 16:56:56.319036 INFO  [100] AGSslDomainFilter checkDomain: [id=1000007] TLS connection may not be filtered because CA cert is not recognized by application, adding 'manual_proxy#192.179.18.97:443#www.googletagmanager.com' to exceptions",
        ].join('\n');
        const paths = await workspace();
        const log = await sessionLog(
            paths,
            LISTS,
            adguardPage(watchedPage([]).page, quietLogger()),
        );
        await appendFile(paths.outputLogPath, `${cliOutput}\n`);

        const read = await log.read('https://learning.ua/tutors');

        const report = (read as { report: AppliedRulesReport }).report;
        expect(report.unfilteredHosts).toEqual([
            { host: 'learning.ua', reason: "server doesn't have valid certificate" },
            {
                host: 'www.googletagmanager.com',
                reason: 'CA cert is not recognized by application',
            },
        ]);
        expect(report.events).toEqual([]);
    });

    it('answers that a restarted proxy ended the session log', async () => {
        const paths = await workspace();
        const log = await sessionLog(
            paths,
            LISTS,
            adguardPage(watchedPage([]).page, quietLogger()),
            2,
        );

        const read = await log.read('https://nnmclub.to/');

        expect(read).toMatchObject({ kind: AppliedRulesReadKind.Unavailable });
        expect((read as { reason: string }).reason).toMatch(/restarted/u);
    });

    it('logs a script body and a frame it could not read, and reports the rest', async () => {
        // A page that navigates on leaves the body of its content script unreadable, and a frame
        // that detached cannot be scanned; neither may cost the rules the other sources report.
        const paths = await workspace();
        const detached = {
            url: () => 'https://ads.example/frame',
            evaluate: async () => {
                throw new Error('Frame was detached');
            },
        } as unknown as Frame;
        const listeners: Array<(response: Response) => void> = [];
        const page = {
            on: (_event: string, listener: (response: Response) => void) => {
                listeners.push(listener);
            },
            frames: () => [detached, frameShowing(SHOWN_ELEMENTS)],
        } as unknown as Page;
        const logger = quietLogger();
        const log = await sessionLog(paths, LISTS, adguardPage(page, logger));
        for (const listener of listeners) {
            listener({
                url: () => CONTENT_SCRIPT_URL,
                text: async () => {
                    throw new Error('No resource with given identifier found');
                },
            } as unknown as Response);
        }

        const read = await log.read('https://nnmclub.to/');

        const report = (read as { report: AppliedRulesReport }).report;
        expect(report.events.map((event) => event.rule)).toEqual(['nnmclub.to##.banner']);
        const warnedErrors = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.map(
            ([fields]) => ((fields as { err: Error }).err as Error).message,
        );
        expect(warnedErrors).toEqual(
            expect.arrayContaining([
                'No resource with given identifier found',
                'Frame was detached',
            ]),
        );
    });
});
