/**
 * A blocker's reports for one browser session, read as an applied-rules report.
 *
 * The blocker reports the network rules that decided requests and the elements it removed from
 * served HTML through the contract's log; inside the page it reports the rest (`page-evidence.ts`):
 * the script rules it injects, and the rule that hides each hidden element. None of it names a
 * list, so a rule's list is found here by an exact line match among the lists the run itself
 * executes.
 *
 * The blocker's log has no page boundary, so one applied-rules log is bound to one browser session:
 * it reads only what the blocker reported after the session launched, and only while the proxy the
 * session rides is still the one running.
 */
import {
    AppliedRuleFamily,
    AppliedRuleReporter,
    AppliedRulesReadKind,
    type AppliedRuleEvent,
    type AppliedRulesLog,
    type UnfilteredHost,
} from '../environment/applied-rules';
import { OFFICIAL_ADGUARD_FILTERS } from '../environment/official-filter-catalog';
import { normalizeRule } from '../repo/rule-normalizer';
import {
    BlockerEventKind,
    type BlockerContract,
    type BlockerDescription,
    type BlockerEvent,
    type BlockerFilterList,
    type BlockerUnfilteredHostEvent,
} from './blocker-contract';
import type { PageReports } from './page-evidence';

/**
 * Line break of a filter list.
 */
const LINE_BREAK = /\r?\n/u;

/**
 * Construction input for one session's applied-rules log.
 */
export interface BlockerAppliedRulesLogInput {
    /**
     * The blocker the session rides.
     */
    blocker: BlockerContract;

    /**
     * The blocker's description, naming the engine and what its reports cover.
     */
    description: BlockerDescription;

    /**
     * Log cursor taken when the session launched.
     */
    cursor: string;

    /**
     * Blocker revision the session launched at.
     */
    revision: number;

    /**
     * The lists the blocker executes for the session, for list attribution.
     */
    lists: readonly BlockerFilterList[];

    /**
     * The session's in-page reports, or null when the blocker leaves none.
     */
    page: PageReports | null;
}

/**
 * Map each rule to the executed lists holding it as an exact line.
 *
 * @param rules - Rule texts to look up.
 * @param lists - The executed lists.
 * @returns Rule text to list identifiers, only for rules some list holds.
 */
function listsHolding(
    rules: ReadonlySet<string>,
    lists: readonly BlockerFilterList[],
): Map<string, number[]> {
    const holders = new Map<string, number[]>();
    for (const list of lists) {
        for (const line of list.content.split(LINE_BREAK)) {
            if (!rules.has(line)) {
                continue;
            }
            const ids = holders.get(line) ?? [];
            if (!ids.includes(list.id)) {
                ids.push(list.id);
            }
            holders.set(line, ids);
        }
    }
    return holders;
}

/**
 * Read one contract event as an applied-rule event.
 *
 * @param event - The blocker's event.
 * @returns The applied-rule event, its lists not yet attributed.
 */
function appliedRule(
    event: Exclude<BlockerEvent, BlockerUnfilteredHostEvent>,
): Omit<AppliedRuleEvent, 'filterIds'> {
    if (event.kind === BlockerEventKind.HtmlElementRemoved) {
        return {
            rule: event.rule,
            family: AppliedRuleFamily.HtmlFiltering,
            target: `${event.element} ${event.url}`,
            reportedBy: [AppliedRuleReporter.Engine],
        };
    }
    return {
        rule: event.rule,
        family: normalizeRule(event.rule).isException
            ? AppliedRuleFamily.NetworkException
            : AppliedRuleFamily.Network,
        target: event.url,
        reportedBy: [AppliedRuleReporter.Engine],
    };
}

/**
 * Collect the hosts the blocker passed through unfiltered, one entry per host.
 *
 * @param events - The blocker's events since the session launched.
 * @returns Each host with the first reason the blocker gave for it.
 */
function unfilteredHostsOf(events: readonly BlockerEvent[]): UnfilteredHost[] {
    const byHost = new Map<string, UnfilteredHost>();
    for (const event of events) {
        if (event.kind === BlockerEventKind.UnfilteredHost && !byHost.has(event.host)) {
            byHost.set(event.host, { host: event.host, reason: event.reason });
        }
    }
    return [...byHost.values()];
}

/**
 * Create one session's applied-rules log.
 *
 * @param input - Blocker, description, session cursor and revision, executed lists, page reports.
 * @returns The session's applied-rules log.
 */
export function createBlockerAppliedRulesLog(input: BlockerAppliedRulesLogInput): AppliedRulesLog {
    return {
        read: async () => {
            const logged = await input.blocker.log(input.cursor);
            if (logged.revision !== input.revision) {
                return {
                    kind: AppliedRulesReadKind.Unavailable,
                    reason:
                        'The proxy restarted after this browser session started (a candidate ' +
                        'experiment or a new enabled list set moves it to a new port), so this ' +
                        'session no longer reaches it and its log ended there. Launch a new ' +
                        'browser session and read again.',
                };
            }
            const unfilteredHosts = unfilteredHostsOf(logged.events);
            const found = logged.events
                .filter(
                    (event): event is Exclude<BlockerEvent, BlockerUnfilteredHostEvent> =>
                        event.kind !== BlockerEventKind.UnfilteredHost,
                )
                .map(appliedRule);
            for (const injected of (await input.page?.injectedScripts()) ?? []) {
                found.push({
                    rule: injected.rule,
                    family: AppliedRuleFamily.Script,
                    target: injected.frameUrl,
                    reportedBy: [AppliedRuleReporter.Engine],
                });
            }
            const marked = ((await input.page?.hiddenElements()) ?? []).map((hidden) => ({
                rule: hidden.rule,
                family: AppliedRuleFamily.ElementHiding,
                target: hidden.element,
                reportedBy: [AppliedRuleReporter.Engine],
            }));
            const holders = listsHolding(
                new Set([...found, ...marked].map((event) => event.rule)),
                input.lists,
            );
            // A marker no executed list holds was written by the page, not by the blocker.
            const events = [...found, ...marked.filter((event) => holders.has(event.rule))].map(
                (event) => ({ ...event, filterIds: holders.get(event.rule) ?? [] }),
            );
            const referenced = new Set(events.flatMap((event) => event.filterIds));
            return {
                kind: AppliedRulesReadKind.Report,
                report: {
                    engine: input.description.product,
                    covers: input.description.covers,
                    events,
                    lists: OFFICIAL_ADGUARD_FILTERS.filter((filter) =>
                        referenced.has(filter.filterId),
                    ).map((filter) => ({ id: filter.filterId, name: filter.name })),
                    trackingProtection: [],
                    notReported: input.description.notReported,
                    unfilteredHosts,
                },
            };
        },
    };
}
