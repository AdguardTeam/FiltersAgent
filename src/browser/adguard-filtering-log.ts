/**
 * The AdGuard Browser Extension's own filtering log, read as an applied-rules report.
 *
 * The extension records, per tab, every rule its engine applied — requests it blocked, redirected
 * or allowed, elements it hid, scriptlets it injected — and, in an unpacked MV3 build, the
 * declarative rules Chrome reports as having fired. It records only while its filtering-log page is
 * connected, and the pinned build's open message is broken (see
 * `adguard-extension-message-types.ts`), so opening the log means opening that page and keeping it
 * for the session: the page connects the log's port itself and reconnects after a service-worker
 * restart. Reads go over the same page with the extension's own messages.
 *
 * The extension is third-party code, so its answers are validated here, once, where they enter.
 */
import * as v from 'valibot';
import type { BrowserContext, Page } from 'playwright-core';
import {
    AppliedRuleFamily,
    AppliedRuleReporter,
    AppliedRulesReadKind,
    type AppliedRuleEvent,
    type AppliedRulesLog,
    type AppliedRulesRead,
    type FilterListName,
    type ProtectionActionCount,
} from '../environment/applied-rules';
import type { ExtensionManifestVersion } from '../environment/extension-preparation';
import { normalizeRule } from '../repo/rule-normalizer';
import { AdGuardExtensionMessageType } from './adguard-extension-message-types';
import {
    DEFAULT_READINESS_BUDGET_MS,
    probeUntilReady,
    sendExtensionMessage,
} from './adguard-extension-state-transport';
import { findExtensionRuntime } from './extension-runtime-location';

/**
 * The extension page whose connection keeps the filtering log recording.
 */
const FILTERING_LOG_PAGE_PATH = 'pages/filtering-log.html';

/**
 * How the report names the engine; the build's version follows.
 */
const ENGINE_NAME = 'AdGuard Browser Extension';

/**
 * The period one read covers.
 */
const COVERS =
    "The page's current load: the extension keeps one log per tab and restarts it on every " +
    'main-frame load of the tab.';

/**
 * Names of the extension's own list ids, which its filter metadata does not carry
 * (`AntiBannerFiltersId` in the extension source).
 */
const SPECIAL_LIST_NAMES: readonly FilterListName[] = [
    { id: 0, name: 'User rules' },
    { id: -1, name: 'Tracking protection (Stealth Mode)' },
    { id: 100, name: 'Allowlist' },
];

/**
 * One Tracking protection action and the bit the extension marks it with.
 */
interface TrackingProtectionAction {
    /**
     * The action's bit in a log entry's `stealthActions` mask.
     */
    bit: number;

    /**
     * The extension's own name of the action.
     */
    action: string;
}

/**
 * The extension's Tracking protection action bits (`StealthActions` in the extension source), in
 * the order the report lists them.
 */
const TRACKING_PROTECTION_ACTIONS: readonly TrackingProtectionAction[] = [
    { bit: 1, action: 'HideReferrer' },
    { bit: 2, action: 'HideSearchQueries' },
    { bit: 4, action: 'BlockChromeClientData' },
    { bit: 8, action: 'SendDoNotTrack' },
    { bit: 16, action: 'FirstPartyCookies' },
    { bit: 32, action: 'ThirdPartyCookies' },
];

/**
 * Separator of the family and the rule text in a merge key; no rule text contains it.
 */
const MERGE_KEY_SEPARATOR = '\u0000';

/**
 * One rule reference in a log entry, in the extension's own shape.
 */
const RequestRuleSchema = v.object({
    filterId: v.number(),
    ruleIndex: v.optional(v.number()),
    appliedRuleText: v.nullish(v.string()),
    originalRuleText: v.nullish(v.string()),
    allowlistRule: v.optional(v.boolean()),
    cssRule: v.optional(v.boolean()),
    scriptRule: v.optional(v.boolean()),
    contentRule: v.optional(v.boolean()),
});

/**
 * One filtering-log entry; fields this report does not read pass unvalidated.
 */
const FilteringEventSchema = v.object({
    requestUrl: v.nullish(v.string()),
    frameUrl: v.nullish(v.string()),
    element: v.nullish(v.string()),
    requestRule: v.optional(RequestRuleSchema),
    declarativeRuleInfo: v.optional(
        v.object({
            sourceRules: v.array(v.object({ sourceRule: v.string(), filterId: v.number() })),
        }),
    ),
    stealthActions: v.optional(v.number()),
    stealthAllowlistRules: v.optional(v.array(RequestRuleSchema)),
});

/**
 * One tab's filtering log.
 */
const FilteringTabInfoSchema = v.object({
    filteringEvents: v.array(FilteringEventSchema),
});

/**
 * The filtering log's metadata; only the list names are read.
 */
const FilteringLogDataSchema = v.object({
    filtersMetadata: v.array(v.object({ filterId: v.number(), name: v.string() })),
});

/**
 * Chrome's answer to a tab query; only the identity and the URL are read.
 */
const TabsSchema = v.array(v.object({ id: v.optional(v.number()), url: v.optional(v.string()) }));

/**
 * One validated log entry.
 */
type FilteringEvent = v.InferOutput<typeof FilteringEventSchema>;

/**
 * One validated rule reference.
 */
type RequestRule = v.InferOutput<typeof RequestRuleSchema>;

/**
 * The manifest fields the report reads.
 */
interface ExtensionManifestFacts {
    /**
     * The loaded build's version.
     */
    version: string;
}

/**
 * Extension-page globals the in-page reads call.
 */
interface ExtensionPageGlobal {
    /**
     * The extension API of the page.
     */
    chrome: {
        /**
         * Runtime API.
         */
        runtime: {
            /**
             * The loaded build's manifest.
             *
             * @returns The manifest fields read here.
             */
            getManifest(): ExtensionManifestFacts;
        };

        /**
         * Tabs API.
         */
        tabs: {
            /**
             * List tabs.
             *
             * @param query - Tab filter; empty for every tab.
             * @returns The matching tabs.
             */
            query(query: object): Promise<unknown>;
        };
    };
}

/**
 * Where to open the log.
 */
export interface OpenAdGuardFilteringLogInput {
    /**
     * The session's persistent context carrying the prepared extension.
     */
    context: BrowserContext;

    /**
     * Manifest generation of the prepared build, to locate its runtime.
     */
    manifestVersion: ExtensionManifestVersion;

    /**
     * Wall-clock budget for the log to answer after its page loads; the shared transport default
     * when unset.
     */
    readinessBudgetMs?: number;
}

/**
 * The family a rule reference of the extension engine belongs to.
 *
 * @param rule - The rule reference.
 * @returns Its family, from the engine's own flags.
 */
function engineRuleFamily(rule: RequestRule): AppliedRuleFamily {
    if (rule.cssRule) {
        return AppliedRuleFamily.ElementHiding;
    }
    if (rule.scriptRule) {
        return AppliedRuleFamily.Script;
    }
    if (rule.contentRule) {
        return AppliedRuleFamily.HtmlFiltering;
    }
    return rule.allowlistRule ? AppliedRuleFamily.NetworkException : AppliedRuleFamily.Network;
}

/**
 * What a rule of one family acted on in one log entry.
 *
 * @param family - The rule's family.
 * @param entry - The log entry.
 * @returns The element for element hiding and HTML filtering, the frame for a script, the request
 *   otherwise; empty when the entry names none.
 */
function targetOf(family: AppliedRuleFamily, entry: FilteringEvent): string {
    switch (family) {
        case AppliedRuleFamily.ElementHiding:
            return entry.element ?? entry.frameUrl ?? '';
        case AppliedRuleFamily.Script:
            return entry.frameUrl ?? entry.requestUrl ?? '';
        case AppliedRuleFamily.HtmlFiltering:
            return entry.element ?? entry.requestUrl ?? entry.frameUrl ?? '';
        default:
            return entry.requestUrl ?? entry.frameUrl ?? '';
    }
}

/**
 * One application while its log entry is mapped: its list ids still grow.
 */
interface MergingApplication extends AppliedRuleEvent {
    /**
     * Lists attributed so far, in order of first report.
     */
    filterIds: number[];
}

/**
 * Map one log entry to its rule applications.
 *
 * The same rule reported for one entry by the engine and by Chrome's declarative matching is one
 * application with both reporters.
 *
 * @param entry - The log entry.
 * @returns The entry's applications, engine first.
 */
function applicationsOf(entry: FilteringEvent): AppliedRuleEvent[] {
    const merged = new Map<string, MergingApplication>();
    const add = (
        rule: string,
        convertedFrom: string | undefined,
        family: AppliedRuleFamily,
        filterId: number,
        reporter: AppliedRuleReporter,
    ): void => {
        const key = `${family}${MERGE_KEY_SEPARATOR}${rule}`;
        const existing = merged.get(key);
        if (existing === undefined) {
            merged.set(key, {
                rule,
                ...(convertedFrom === undefined ? {} : { convertedFrom }),
                family,
                filterIds: [filterId],
                target: targetOf(family, entry),
                reportedBy: [reporter],
            });
            return;
        }
        if (!existing.filterIds.includes(filterId)) {
            existing.filterIds.push(filterId);
        }
        if (!existing.reportedBy.includes(reporter)) {
            existing.reportedBy = [...existing.reportedBy, reporter];
        }
    };
    const addEngineRule = (rule: RequestRule): void => {
        // The extension's own filtering log prints exactly this when an engine rule has no text.
        const text =
            rule.appliedRuleText ??
            `<rule text is not specified> (${rule.filterId}:${rule.ruleIndex})`;
        const original = rule.originalRuleText ?? undefined;
        add(
            text,
            original !== undefined && original !== text ? original : undefined,
            engineRuleFamily(rule),
            rule.filterId,
            AppliedRuleReporter.Engine,
        );
    };
    if (entry.requestRule !== undefined) {
        addEngineRule(entry.requestRule);
    }
    for (const source of entry.declarativeRuleInfo?.sourceRules ?? []) {
        add(
            source.sourceRule,
            undefined,
            normalizeRule(source.sourceRule).isException
                ? AppliedRuleFamily.NetworkException
                : AppliedRuleFamily.Network,
            source.filterId,
            AppliedRuleReporter.BrowserDeclarative,
        );
    }
    for (const rule of entry.stealthAllowlistRules ?? []) {
        addEngineRule(rule);
    }
    return [...merged.values()];
}

/**
 * Count the Tracking protection actions of a tab's log.
 *
 * @param entries - The tab's log entries.
 * @returns Each action that acted, with how many requests it acted on.
 */
function trackingProtectionOf(entries: readonly FilteringEvent[]): ProtectionActionCount[] {
    return TRACKING_PROTECTION_ACTIONS.map(({ bit, action }) => ({
        action,
        requests: entries.filter((entry) => ((entry.stealthActions ?? 0) & bit) !== 0).length,
    })).filter((count) => count.requests > 0);
}

/**
 * Read every list name the log can refer to right now.
 *
 * Read afresh on every report, not once at open: the settings import runs after the log opened and
 * creates the custom filters (id 1000 and up), so a name captured at open time would miss them.
 *
 * @param page - The kept filtering-log page.
 * @returns The extension's own list ids, then the lists its filter metadata names now.
 * @throws When the log does not answer, or answers in an unexpected shape.
 */
async function readKnownLists(page: Page): Promise<FilterListName[]> {
    const logData = v.parse(
        FilteringLogDataSchema,
        await sendExtensionMessage(page, { type: AdGuardExtensionMessageType.GetFilteringLogData }),
    );
    return [
        ...SPECIAL_LIST_NAMES,
        ...logData.filtersMetadata.map((filter) => ({ id: filter.filterId, name: filter.name })),
    ];
}

/**
 * Read the log of the tab showing one page.
 *
 * @param page - The kept filtering-log page.
 * @param pageUrl - URL of the page the session shows.
 * @param engine - Engine name with the build's version.
 * @returns The report, or why there is none.
 */
async function readTab(page: Page, pageUrl: string, engine: string): Promise<AppliedRulesRead> {
    const tabs = v.parse(
        TabsSchema,
        await page.evaluate(async () =>
            (globalThis as unknown as ExtensionPageGlobal).chrome.tabs.query({}),
        ),
    );
    const showing = tabs.filter((tab) => tab.url === pageUrl && tab.id !== undefined);
    if (showing.length !== 1) {
        return {
            kind: AppliedRulesReadKind.Unavailable,
            reason:
                `${showing.length} browser tabs show ${pageUrl}, so the log cannot tell which ` +
                `one is this session's page. Tabs seen: ${tabs.map((tab) => tab.url).join(', ')}. ` +
                'Load the page again with open_page and read once it settles.',
        };
    }
    const answer = await sendExtensionMessage(page, {
        type: AdGuardExtensionMessageType.GetFilteringInfoByTabId,
        data: { tabId: showing[0]!.id },
    });
    if (answer === undefined || answer === null) {
        return {
            kind: AppliedRulesReadKind.Unavailable,
            reason:
                `The extension's filtering log holds no entry for the tab showing ${pageUrl}. ` +
                'Load the page again with open_page and read once it settles.',
        };
    }
    const entries = v.parse(FilteringTabInfoSchema, answer).filteringEvents;
    const events = entries.flatMap(applicationsOf);
    const referenced = new Set(events.flatMap((event) => event.filterIds));
    const knownLists = await readKnownLists(page);
    return {
        kind: AppliedRulesReadKind.Report,
        report: {
            engine,
            covers: COVERS,
            events,
            lists: knownLists.filter((list) => referenced.has(list.id)),
            trackingProtection: trackingProtectionOf(entries),
            notReported: [],
            // The extension reads every page it is given.
            unfilteredHosts: [],
        },
    };
}

/**
 * Open the prepared extension's filtering log for one session.
 *
 * Call it as soon as the session launches, before the settings import configures the engine: the
 * build keeps Chrome's declarative-match log only when its filtering log is open while the engine
 * is configured, and records nothing before it opens. The log page belongs to the session and
 * closes with it.
 *
 * @param input - The session's context and the build's manifest generation.
 * @returns The session's applied-rules log.
 * @throws When the extension, its log page, or the log's first answer cannot be reached.
 */
export async function openAdGuardFilteringLog(
    input: OpenAdGuardFilteringLogInput,
): Promise<AppliedRulesLog> {
    const runtime = await findExtensionRuntime(input.context, input.manifestVersion);
    const page = await input.context.newPage();
    await page.goto(`chrome-extension://${runtime.extensionId}/${FILTERING_LOG_PAGE_PATH}`, {
        waitUntil: 'load',
    });
    // The probe proves the log answers; the names it returns are read again on every report.
    await probeUntilReady({
        page,
        sharedDeadlineAt: Date.now() + (input.readinessBudgetMs ?? DEFAULT_READINESS_BUDGET_MS),
        label: 'The extension filtering log did not answer',
        probe: () => readKnownLists(page),
    });
    await sendExtensionMessage(page, { type: AdGuardExtensionMessageType.SynchronizeOpenTabs });
    const version = await page.evaluate(
        () => (globalThis as unknown as ExtensionPageGlobal).chrome.runtime.getManifest().version,
    );
    return {
        read: async (pageUrl) => await readTab(page, pageUrl, `${ENGINE_NAME} ${version}`),
    };
}
