/**
 * The `get_applied_rules` tool: the model's view of what the session's filtering engine reported
 * applying to the page — every rule with its list, grouped, bounded, and persisted whole.
 *
 * The answer is a projection, never a judgement: rules are grouped by family and kept in the
 * engine's log order, and which of them causes the reported problem is the agent's decision.
 */
import type { IBrowserSession } from '../browser/browser-interfaces';
import {
    APPLIED_RULE_FAMILY_VALUES,
    AppliedRulesReadKind,
    type AppliedRuleEvent,
    type AppliedRuleFamily,
    type AppliedRuleReporter,
    type AppliedRulesLog,
    type AppliedRulesReport,
    type ProtectionActionCount,
} from '../environment/applied-rules';
import type { IArtifactStore } from '../tracer/artifact-store';
import { registeredParameters } from './registered-parameters';
import { TOOL_GUIDANCE } from './tool-catalog';
import { ToolName } from './tool-names';
import type { ToolRegistry } from './tool-registry';

/**
 * Error kind of every answer that carries no report.
 */
export const APPLIED_RULES_UNAVAILABLE_ERROR_KIND = 'applied_rules_unavailable';

/**
 * Byte ceiling of one model answer.
 *
 * Half the 64 KiB tool-result limit: the answer must never reach the truncation envelope, which
 * would cut rules from the end of the answer the agent reads, and a page's filtering log (the
 * extension keeps up to 1000 events per tab) can outgrow any fixed rule count.
 */
const MODEL_ANSWER_BYTE_BUDGET = 32 * 1024;

/**
 * Longest rule text returned whole; a longer one keeps its head and tail.
 */
const MAX_RULE_CHARS = 600;

/**
 * Characters kept from the start of an elided rule: its pattern or its first domains.
 */
const RULE_ELISION_HEAD_CHARS = 200;

/**
 * Characters kept from the end of an elided rule. The modifiers of a network rule and the body of a
 * scriptlet sit at the end, behind a domain list that can run to hundreds of characters, and the
 * body is what the agent must read to name the rule.
 */
const RULE_ELISION_TAIL_CHARS = 350;

/**
 * Marker joining the kept head and tail of an elided rule.
 */
const RULE_ELISION_MARKER = ' … ';

/**
 * Distinct targets shown per rule; the artifact keeps every one.
 */
const MAX_TARGETS_PER_RULE = 3;

/**
 * Longest target shown, the same bound the network-log inventory puts on a request path.
 */
const MAX_TARGET_CHARS = 160;

/**
 * Marker ending a truncated target.
 */
const TARGET_TRUNCATION_MARKER = '…';

/**
 * Protocols of a page whose rules an engine can report.
 */
const WEB_PAGE_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

/**
 * Trace artifact type of the persisted report.
 */
const APPLIED_RULES_ARTIFACT_TYPE = 'applied-rules';

/**
 * Separator of the family and the rule text in a group key; no rule text contains it.
 */
const GROUP_KEY_SEPARATOR = '\u0000';

/**
 * One list a reported rule belongs to.
 */
interface AppliedRuleListRef {
    /**
     * Filter list identifier.
     */
    id: number;

    /**
     * List name, when the engine or the run knows it.
     */
    name?: string;
}

/**
 * One reported rule as the model sees it.
 */
interface AppliedRuleSummary {
    /**
     * The rule text; beyond {@link MAX_RULE_CHARS} its middle is elided.
     */
    rule: string;

    /**
     * Present when the middle of the rule was elided.
     */
    ruleElided?: true;

    /**
     * The text the engine converted the rule from, when it did.
     */
    convertedFrom?: string;

    /**
     * What kind of rule acted.
     */
    family: AppliedRuleFamily;

    /**
     * The lists the rule belongs to.
     */
    lists: AppliedRuleListRef[];

    /**
     * How many log entries report the rule.
     */
    hits: number;

    /**
     * A bounded sample of what the rule acted on.
     */
    targets: string[];

    /**
     * Who reported the rule.
     */
    reportedBy: AppliedRuleReporter[];
}

/**
 * The accumulating group of every event reporting one rule of one family.
 */
interface RuleGroup {
    /**
     * The group's family.
     */
    family: AppliedRuleFamily;

    /**
     * The rule text.
     */
    rule: string;

    /**
     * The first text the engine reported converting the rule from.
     */
    convertedFrom?: string;

    /**
     * Lists in order of first appearance.
     */
    filterIds: number[];

    /**
     * Number of events.
     */
    hits: number;

    /**
     * Distinct shown targets, in order of first appearance.
     */
    targets: string[];

    /**
     * Reporters in order of first appearance.
     */
    reporters: AppliedRuleReporter[];
}

/**
 * Everything the tool needs for one session.
 */
export interface AppliedRulesToolOptions {
    /**
     * The session whose current page the answer describes.
     */
    session: IBrowserSession;

    /**
     * The session's applied-rules log.
     */
    log: AppliedRulesLog;

    /**
     * Store the complete report is persisted to, for `get_detail`.
     */
    artifactStore: IArtifactStore;
}

/**
 * The answer given instead of a report.
 *
 * Every such answer is retryable: a session whose engine can never report does not offer the tool
 * at all, so what is left is a moment the agent can change — no page loaded yet, a page to load
 * again, a session to relaunch — and the reason says which.
 *
 * @param reason - Why no report exists, and what to do about it.
 * @returns The typed refusal.
 */
function unavailableAnswer(reason: string): Record<string, unknown> {
    return { error: reason, errorKind: APPLIED_RULES_UNAVAILABLE_ERROR_KIND, retryable: true };
}

/**
 * Whether a URL is a web page an engine can have filtered.
 *
 * @param pageUrl - URL the session's page shows.
 * @returns True for an http(s) page.
 */
function isWebPage(pageUrl: string): boolean {
    return URL.canParse(pageUrl) && WEB_PAGE_PROTOCOLS.has(new URL(pageUrl).protocol);
}

/**
 * Bound one target for the model.
 *
 * @param target - Target as the engine reported it.
 * @returns The target, cut to {@link MAX_TARGET_CHARS}.
 */
function shownTarget(target: string): string {
    return target.length <= MAX_TARGET_CHARS
        ? target
        : `${target.slice(0, MAX_TARGET_CHARS - TARGET_TRUNCATION_MARKER.length)}${TARGET_TRUNCATION_MARKER}`;
}

/**
 * Group the engine's events by family and rule, in log order.
 *
 * @param events - Rule applications in the engine's log order.
 * @returns One group per distinct family and rule, in order of first appearance.
 */
function groupEvents(events: readonly AppliedRuleEvent[]): RuleGroup[] {
    const groups = new Map<string, RuleGroup>();
    for (const event of events) {
        const key = `${event.family}${GROUP_KEY_SEPARATOR}${event.rule}`;
        let group = groups.get(key);
        if (group === undefined) {
            group = {
                family: event.family,
                rule: event.rule,
                filterIds: [],
                hits: 0,
                targets: [],
                reporters: [],
            };
            groups.set(key, group);
        }
        group.hits += 1;
        group.convertedFrom ??= event.convertedFrom;
        for (const filterId of event.filterIds) {
            if (!group.filterIds.includes(filterId)) {
                group.filterIds.push(filterId);
            }
        }
        for (const reporter of event.reportedBy) {
            if (!group.reporters.includes(reporter)) {
                group.reporters.push(reporter);
            }
        }
        const target = shownTarget(event.target);
        if (
            target.length > 0 &&
            group.targets.length < MAX_TARGETS_PER_RULE &&
            !group.targets.includes(target)
        ) {
            group.targets.push(target);
        }
    }
    return [...groups.values()];
}

/**
 * Project one group onto the model-facing summary.
 *
 * @param group - The rule's group.
 * @param listNames - List names by id.
 * @returns The bounded summary.
 */
function summarize(group: RuleGroup, listNames: ReadonlyMap<number, string>): AppliedRuleSummary {
    const elided = group.rule.length > MAX_RULE_CHARS;
    return {
        rule: elided
            ? `${group.rule.slice(0, RULE_ELISION_HEAD_CHARS)}${RULE_ELISION_MARKER}` +
              group.rule.slice(-RULE_ELISION_TAIL_CHARS)
            : group.rule,
        ...(elided ? { ruleElided: true as const } : {}),
        ...(group.convertedFrom === undefined ? {} : { convertedFrom: group.convertedFrom }),
        family: group.family,
        lists: group.filterIds.map((id) => {
            const name = listNames.get(id);
            return name === undefined ? { id } : { id, name };
        }),
        hits: group.hits,
        targets: group.targets,
        reportedBy: group.reporters,
    };
}

/**
 * Admit summaries into the answer until the byte budget is spent.
 *
 * Families take turns, each in its log order, so a page with hundreds of network rules still shows
 * its scriptlets; the admitted rules come back grouped by family.
 *
 * @param groups - Every group in log order.
 * @param listNames - List names by id.
 * @param baseBytes - Bytes the answer takes without any rule.
 * @returns The admitted summaries, in family order and then log order.
 */
function admitWithinBudget(
    groups: readonly RuleGroup[],
    listNames: ReadonlyMap<number, string>,
    baseBytes: number,
): AppliedRuleSummary[] {
    const queues = APPLIED_RULE_FAMILY_VALUES.map((family) =>
        groups.filter((group) => group.family === family),
    );
    const admitted: AppliedRuleSummary[][] = queues.map(() => []);
    let bytes = baseBytes;
    for (let round = 0; queues.some((queue) => round < queue.length); round += 1) {
        for (const [index, queue] of queues.entries()) {
            const group = queue[round];
            if (group === undefined) {
                continue;
            }
            const summary = summarize(group, listNames);
            // One comma per admitted entry besides its own bytes.
            const summaryBytes = Buffer.byteLength(JSON.stringify(summary)) + 1;
            if (bytes + summaryBytes > MODEL_ANSWER_BYTE_BUDGET) {
                return admitted.flat();
            }
            bytes += summaryBytes;
            admitted[index]!.push(summary);
        }
    }
    return admitted.flat();
}

/**
 * Build the model answer for one report and persist the whole report.
 *
 * @param report - What the engine reported.
 * @param pageUrl - The page the report describes.
 * @param artifactStore - Store the complete report is persisted to.
 * @returns The bounded answer.
 */
function answerFor(
    report: AppliedRulesReport,
    pageUrl: string,
    artifactStore: IArtifactStore,
): Record<string, unknown> {
    const artifact = artifactStore.write(
        JSON.stringify({ pageUrl, ...report }, null, 2),
        APPLIED_RULES_ARTIFACT_TYPE,
    );
    const groups = groupEvents(report.events);
    const listNames = new Map(report.lists.map((list) => [list.id, list.name]));
    const trackingProtection: ProtectionActionCount[] = [...report.trackingProtection];
    const base = {
        engine: report.engine,
        pageUrl,
        covers: report.covers,
        ruleCount: groups.length,
        rules: [] as AppliedRuleSummary[],
        omittedRuleCount: groups.length,
        trackingProtection,
        notReported: [...report.notReported],
        unfilteredHosts: [...report.unfilteredHosts],
        artifactId: artifact.id,
        metaHint:
            `The complete log is persisted. Use get_detail("${artifact.id}") with the key ` +
            '"events" and a limit to read every rule text and target.',
    };
    const rules = admitWithinBudget(groups, listNames, Buffer.byteLength(JSON.stringify(base)));
    return { ...base, rules, omittedRuleCount: groups.length - rules.length };
}

/**
 * Register `get_applied_rules` for one browser session.
 *
 * @param registry - The session's registry.
 * @param options - The session, its applied-rules log, and the artifact store.
 */
export function registerAppliedRulesTool(
    registry: ToolRegistry,
    options: AppliedRulesToolOptions,
): void {
    const { session, log, artifactStore } = options;
    registry.register({
        definition: {
            type: 'function',
            function: {
                name: ToolName.GetAppliedRules,
                description: TOOL_GUIDANCE[ToolName.GetAppliedRules]!,
                parameters: registeredParameters(ToolName.GetAppliedRules),
            },
        },
        handler: async () => {
            const pageUrl = session.getPage().url();
            if (!isWebPage(pageUrl)) {
                return unavailableAnswer(
                    `No web page is loaded in this session yet (the page shows ${pageUrl}); ` +
                        'open the page with open_page, then call again.',
                );
            }
            const read = await log.read(pageUrl);
            if (read.kind === AppliedRulesReadKind.Unavailable) {
                return unavailableAnswer(read.reason);
            }
            return answerFor(read.report, pageUrl, artifactStore);
        },
    });
}
