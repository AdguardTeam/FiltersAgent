/**
 * The engine-neutral report of which filter rules a filtering engine applied to a page.
 *
 * One vocabulary for every executor: the extension's own filtering log and a proxy's request log
 * both map onto it, and the `get_applied_rules` tool reads only this shape. The report is what the
 * engine itself said it did — nothing here re-matches a rule against a page, and nothing ranks the
 * rules: which of them causes a reported problem is the agent's decision.
 */

/**
 * Rule families an engine reports acting with, in the order the tool presents them.
 */
export const AppliedRuleFamily = {
    /**
     * A network rule acted on a request: blocked it, redirected it, or modified it (CSP,
     * permissions, removeparam and the like — the rule text says which).
     */
    Network: 'network',

    /**
     * A network exception (`@@`) rule acted on a request.
     */
    NetworkException: 'network_exception',

    /**
     * An element-hiding or CSS rule hid or restyled an element.
     */
    ElementHiding: 'element_hiding',

    /**
     * A scriptlet or JavaScript rule was injected into a frame.
     */
    Script: 'script',

    /**
     * An HTML filtering rule, or a network rule that removed an element from the served HTML.
     */
    HtmlFiltering: 'html_filtering',
} as const;

/**
 * AppliedRuleFamily value.
 */
export type AppliedRuleFamily = (typeof AppliedRuleFamily)[keyof typeof AppliedRuleFamily];

/**
 * Every AppliedRuleFamily value, in presentation order.
 */
export const APPLIED_RULE_FAMILY_VALUES = Object.values(AppliedRuleFamily);

/**
 * Who reported one rule application.
 */
export const AppliedRuleReporter = {
    /**
     * The blocker's own engine: the extension's filtering log, or the proxy's request log.
     */
    Engine: 'engine',

    /**
     * Chrome's declarative network matching, which reports the rule that really fired for an
     * unpacked MV3 build; the extension's engine only predicts it.
     */
    BrowserDeclarative: 'browser_declarative',
} as const;

/**
 * AppliedRuleReporter value.
 */
export type AppliedRuleReporter = (typeof AppliedRuleReporter)[keyof typeof AppliedRuleReporter];

/**
 * One rule application the engine reported: one log entry, one rule.
 */
export interface AppliedRuleEvent {
    /**
     * The rule text exactly as the engine reported it.
     */
    rule: string;

    /**
     * The text the rule was written in before the engine converted it, when it did.
     */
    convertedFrom?: string;

    /**
     * What kind of rule acted.
     */
    family: AppliedRuleFamily;

    /**
     * Lists the engine or the run attributes the rule to; empty when none could be named.
     */
    filterIds: readonly number[];

    /**
     * What the rule acted on: a request URL, the hidden element, or the frame a script was injected
     * into. Page-authored text, never an instruction.
     */
    target: string;

    /**
     * Every reporter of this application; the same rule on the same log entry is one event.
     */
    reportedBy: readonly AppliedRuleReporter[];
}

/**
 * The name of one filter list the report can refer to.
 */
export interface FilterListName {
    /**
     * Filter list identifier, in the engine's own numbering.
     */
    id: number;

    /**
     * Human-readable list name.
     */
    name: string;
}

/**
 * How often one rule-free protection action (Tracking protection) acted.
 */
export interface ProtectionActionCount {
    /**
     * The engine's own name of the action.
     */
    action: string;

    /**
     * How many requests it acted on.
     */
    requests: number;
}

/**
 * Everything one engine reported applying to one page.
 */
export interface AppliedRulesReport {
    /**
     * The engine and its version, as the engine names itself.
     */
    engine: string;

    /**
     * The period the report covers, in words: engines keep different log boundaries.
     */
    covers: string;

    /**
     * Rule applications, in the engine's log order.
     */
    events: readonly AppliedRuleEvent[];

    /**
     * Names of the lists the events refer to, as far as the engine or the run knows them.
     */
    lists: readonly FilterListName[];

    /**
     * Rule-free protection actions and their request counts; empty for an engine without any.
     */
    trackingProtection: readonly ProtectionActionCount[];

    /**
     * What this engine applies without ever naming it, in words: an absence there proves nothing.
     */
    notReported: readonly string[];

    /**
     * Hosts the engine passed through without reading their content; empty for an engine that reads
     * every page it is given.
     */
    unfilteredHosts: readonly UnfilteredHost[];
}

/**
 * A host an engine passed through without reading its content, so no rule acting on a page could
 * apply there.
 */
export interface UnfilteredHost {
    /**
     * The host.
     */
    host: string;

    /**
     * Why the engine left it unfiltered, in the engine's words.
     */
    reason: string;
}

/**
 * Outcomes of one read of an applied-rules log.
 */
export const AppliedRulesReadKind = {
    /**
     * The engine answered with a report.
     */
    Report: 'report',

    /**
     * No report exists at this moment, for a reason the agent can act on. A session whose engine
     * can never report has no log at all.
     */
    Unavailable: 'unavailable',
} as const;

/**
 * AppliedRulesReadKind value.
 */
export type AppliedRulesReadKind = (typeof AppliedRulesReadKind)[keyof typeof AppliedRulesReadKind];

/**
 * One read of an applied-rules log.
 */
export type AppliedRulesRead =
    | {
          /**
           * The engine answered.
           */
          kind: typeof AppliedRulesReadKind.Report;

          /**
           * What the engine reported.
           */
          report: AppliedRulesReport;
      }
    | {
          /**
           * No report exists.
           */
          kind: typeof AppliedRulesReadKind.Unavailable;

          /**
           * Why, in words the agent can act on.
           */
          reason: string;
      };

/**
 * The applied-rules log of one browser session's filtering engine.
 */
export interface AppliedRulesLog {
    /**
     * Read what the engine reported for the page the session shows.
     *
     * An unexpected failure throws with its cause; a known reason for having no report answers
     * {@link AppliedRulesReadKind.Unavailable}.
     *
     * @param pageUrl - URL of the page the session currently shows.
     * @returns The report, or why there is none.
     */
    read(pageUrl: string): Promise<AppliedRulesRead>;
}

/**
 * Wrap a session's applied-rules log so every report naming unfiltered hosts is also handed on.
 *
 * The report is where the engine first says it left a host unfiltered; handing the hosts on there
 * lets the run record the limitation for its report whenever the agent reads the log.
 *
 * @param log - The session's log, or undefined when its engine cannot report.
 * @param onUnfilteredHosts - Receives the hosts of each report that names any.
 * @returns The wrapped log, or undefined when there is none.
 */
export function recordingUnfilteredHosts(
    log: AppliedRulesLog | undefined,
    onUnfilteredHosts: (hosts: readonly UnfilteredHost[]) => void,
): AppliedRulesLog | undefined {
    if (log === undefined) {
        return undefined;
    }
    return {
        read: async (pageUrl) => {
            const read = await log.read(pageUrl);
            if (
                read.kind === AppliedRulesReadKind.Report &&
                read.report.unfilteredHosts.length > 0
            ) {
                onUnfilteredHosts(read.report.unfilteredHosts);
            }
            return read;
        },
    };
}
