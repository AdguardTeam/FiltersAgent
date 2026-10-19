import { pino } from 'pino';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createToolRegistry } from '../../src/agent/tool-factory';
import { ToolName } from '../../src/agent/tool-names';
import type { SiteAnalyzer } from '../../src/analyzer/site-analyzer';
import type { IBrowserSession } from '../../src/browser/browser-interfaces';
import {
    AppliedRuleFamily,
    AppliedRuleReporter,
    AppliedRulesReadKind,
    type AppliedRuleEvent,
    type AppliedRulesLog,
    type AppliedRulesReport,
} from '../../src/environment/applied-rules';
import { TraceArtifactStore } from '../../src/tracer/artifact-store';
import { TraceRecorder } from '../../src/tracer/trace-recorder';

const PAGE_URL = 'https://www.walla.co.il/';

const temporaryRoots: string[] = [];

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

/**
 * A report shaped like the extension's walla.co.il log: one list-108 scriptlet, one network rule
 * reported twice on one request (engine and declarative) and once more on another, and one
 * element-hiding rule on two elements.
 */
function wallaLikeReport(events?: AppliedRuleEvent[]): AppliedRulesReport {
    return {
        engine: 'AdGuard Browser Extension 5.5.2.3',
        covers: 'the page current load',
        events: events ?? [
            {
                rule: "walla.co.il#%#//scriptlet('ubo-aopr', 'btoa')",
                convertedFrom: 'walla.co.il##+js(aopr, btoa)',
                family: AppliedRuleFamily.Script,
                filterIds: [108],
                target: PAGE_URL,
                reportedBy: [AppliedRuleReporter.Engine],
            },
            {
                rule: '||tags.dxmdp.com^',
                family: AppliedRuleFamily.Network,
                filterIds: [3],
                target: 'https://tags.dxmdp.com/a.js',
                reportedBy: [AppliedRuleReporter.Engine, AppliedRuleReporter.BrowserDeclarative],
            },
            {
                rule: '||tags.dxmdp.com^',
                family: AppliedRuleFamily.Network,
                filterIds: [3],
                target: 'https://tags.dxmdp.com/b.js',
                reportedBy: [AppliedRuleReporter.BrowserDeclarative],
            },
            {
                rule: '##.OUTBRAIN',
                family: AppliedRuleFamily.ElementHiding,
                filterIds: [2],
                target: '<div class="OUTBRAIN" data-widget-id="CRHP_6">',
                reportedBy: [AppliedRuleReporter.Engine],
            },
            {
                rule: '##.OUTBRAIN',
                family: AppliedRuleFamily.ElementHiding,
                filterIds: [2],
                target: '<div class="OUTBRAIN" data-widget-id="HPP">',
                reportedBy: [AppliedRuleReporter.Engine],
            },
        ],
        lists: [
            { id: 2, name: 'AdGuard Base filter' },
            { id: 3, name: 'AdGuard Tracking Protection filter' },
            { id: 108, name: 'EasyList Hebrew' },
        ],
        trackingProtection: [{ action: 'SendDoNotTrack', requests: 2 }],
        notReported: [],
        unfilteredHosts: [],
    };
}

/**
 * A log answering every read with one fixed report.
 */
function reportingLog(
    report: AppliedRulesReport,
): AppliedRulesLog & { read: ReturnType<typeof vi.fn> } {
    return {
        read: vi.fn(async () => ({ kind: AppliedRulesReadKind.Report, report })),
    };
}

/**
 * Build the per-session registry exactly as a fix run does, with a page at the given URL.
 */
async function sessionRegistry(log: AppliedRulesLog, pageUrl = PAGE_URL) {
    const root = mkdtempSync(join(tmpdir(), 'applied-rules-tool-'));
    temporaryRoots.push(root);
    const recorder = new TraceRecorder({ runId: 'applied-rules', issueNumber: 1, mode: 'fix' });
    const session = {
        getPage: () => ({ url: () => pageUrl }),
    } as unknown as IBrowserSession;
    const registry = await createToolRegistry({
        allowedIssueNumber: 1,
        browserTools: {
            session,
            analyzer: {} as SiteAnalyzer,
            artifactsDir: root,
            logger: pino({ level: 'silent' }),
            recorder,
            allowedOrigin: PAGE_URL,
            appliedRules: log,
        },
    });
    return { registry, store: new TraceArtifactStore(root, recorder) };
}

describe('get_applied_rules', () => {
    it('groups the engine report by rule, names every list, and keeps family then log order', async () => {
        const { registry } = await sessionRegistry(reportingLog(wallaLikeReport()));

        const answer = await registry.dispatch(ToolName.GetAppliedRules, {});

        expect(answer).toMatchObject({
            engine: 'AdGuard Browser Extension 5.5.2.3',
            pageUrl: PAGE_URL,
            covers: 'the page current load',
            ruleCount: 3,
            omittedRuleCount: 0,
            trackingProtection: [{ action: 'SendDoNotTrack', requests: 2 }],
            notReported: [],
        });
        expect(answer.rules).toEqual([
            {
                rule: '||tags.dxmdp.com^',
                family: 'network',
                lists: [{ id: 3, name: 'AdGuard Tracking Protection filter' }],
                hits: 2,
                targets: ['https://tags.dxmdp.com/a.js', 'https://tags.dxmdp.com/b.js'],
                reportedBy: ['engine', 'browser_declarative'],
            },
            {
                rule: '##.OUTBRAIN',
                family: 'element_hiding',
                lists: [{ id: 2, name: 'AdGuard Base filter' }],
                hits: 2,
                targets: [
                    '<div class="OUTBRAIN" data-widget-id="CRHP_6">',
                    '<div class="OUTBRAIN" data-widget-id="HPP">',
                ],
                reportedBy: ['engine'],
            },
            {
                rule: "walla.co.il#%#//scriptlet('ubo-aopr', 'btoa')",
                convertedFrom: 'walla.co.il##+js(aopr, btoa)',
                family: 'script',
                lists: [{ id: 108, name: 'EasyList Hebrew' }],
                hits: 1,
                targets: [PAGE_URL],
                reportedBy: ['engine'],
            },
        ]);
    });

    it('bounds the answer, never starves a family, and persists the whole log', async () => {
        const longScriptlet = `${'a.example,'.repeat(90)}walla.co.il#%#//scriptlet('ubo-aopr', 'googletag.cmd')`;
        const events: AppliedRuleEvent[] = [
            ...Array.from({ length: 200 }, (_, index) => ({
                rule: `||tracker-${index}.example^$third-party,domain=${'x'.repeat(200)}`,
                family: AppliedRuleFamily.Network,
                filterIds: [3],
                target: `https://tracker-${index}.example/${'p'.repeat(300)}`,
                reportedBy: [AppliedRuleReporter.Engine],
            })),
            {
                rule: longScriptlet,
                family: AppliedRuleFamily.Script,
                filterIds: [108],
                target: PAGE_URL,
                reportedBy: [AppliedRuleReporter.Engine],
            },
        ];
        const { registry, store } = await sessionRegistry(reportingLog(wallaLikeReport(events)));

        const answer = await registry.dispatch(ToolName.GetAppliedRules, {});

        expect(Buffer.byteLength(JSON.stringify(answer))).toBeLessThanOrEqual(32 * 1024);
        const rules = answer.rules as Array<Record<string, unknown>>;
        expect(answer.ruleCount).toBe(201);
        expect(answer.omittedRuleCount).toBe(201 - rules.length);
        expect(rules.length).toBeLessThan(201);
        const scriptlet = rules.find((rule) => rule.family === 'script');
        expect(scriptlet).toMatchObject({ ruleElided: true, lists: [{ id: 108 }] });
        expect(scriptlet!.rule as string).toMatch(
            /#%#\/\/scriptlet\('ubo-aopr', 'googletag\.cmd'\)$/u,
        );
        for (const rule of rules) {
            for (const target of rule.targets as string[]) {
                expect(target.length).toBeLessThanOrEqual(160);
            }
        }

        const persisted = JSON.parse(store.read(answer.artifactId as string)!) as {
            pageUrl: string;
            events: AppliedRuleEvent[];
        };
        expect(persisted.pageUrl).toBe(PAGE_URL);
        expect(persisted.events).toHaveLength(201);
        expect(persisted.events.at(-1)!.rule).toBe(longScriptlet);
    });

    it('answers a retryable refusal instead of an empty list when no report exists yet', async () => {
        const reason =
            'The proxy restarted after this browser session started. Launch a new browser ' +
            'session and read again.';
        const { registry } = await sessionRegistry({
            read: async () => ({ kind: AppliedRulesReadKind.Unavailable, reason }),
        });

        const answer = await registry.dispatch(ToolName.GetAppliedRules, {});

        expect(answer).toEqual({
            error: reason,
            errorKind: 'applied_rules_unavailable',
            retryable: true,
        });
    });

    it('refuses before any web page loaded without asking the engine', async () => {
        const log = reportingLog(wallaLikeReport());
        const { registry } = await sessionRegistry(log, 'about:blank');

        const answer = await registry.dispatch(ToolName.GetAppliedRules, {});

        expect(answer).toMatchObject({ errorKind: 'applied_rules_unavailable' });
        expect(answer.error).toMatch(/no web page/iu);
        expect(log.read).not.toHaveBeenCalled();
    });
});
