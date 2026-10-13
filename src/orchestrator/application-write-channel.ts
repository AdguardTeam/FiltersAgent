import type { Page } from 'playwright-core';
import * as v from 'valibot';
import { TOOL_GUIDANCE, TOOL_PARAMETER_SCHEMAS } from '../agent/tool-catalog';
import { ToolName } from '../agent/tool-names';
import {
    CUSTOM_FILTERS_GROUP_ID,
    type ExtensionCustomFilterEntry,
} from '../browser/adguard-custom-filters';
import { AdGuardExtensionMessageType } from '../browser/adguard-extension-message-types';
import { DISABLE_STEALTH_SETTING } from '../browser/adguard-extension-settings';
import { waitForAppInitialized } from '../browser/adguard-extension-state-read';
import {
    DEFAULT_READINESS_BUDGET_MS,
    probeUntilReady,
    sendExtensionMessage,
    type ExtensionReadinessOptions,
} from '../browser/adguard-extension-state-transport';
import type { IBrowserSession } from '../browser/browser-interfaces';
import type { AdaptedToolInput } from '../pi/session-tools';

/**
 * The application session's declared write channel: the one runtime message tool and the settings
 * payload the host prepares for it.
 *
 * `evaluate_js` stays read-only on the blocker's privileged surface, so this module owns the one
 * way an application session may change the blocker: a runtime message sent from the prepared
 * surface page itself, admitted by the same protocol-and-host identity the scoped `open_page`
 * enforces. The settings payload is built here too: the host loads the extension's own current
 * settings export over the same message transport, changes only the filters, groups and stealth
 * fields the prepared expectation names, and hands the model the complete resulting document — the
 * pinned build's `applySettingsJson` refuses anything less than a complete document, and this is
 * the only place a complete one is ever available to build from.
 */

/**
 * The two identifying parts of a URL the admission guard compares.
 */
export interface ProtocolHost {
    /**
     * The URL's scheme, including its trailing colon (e.g. `chrome-extension:`).
     */
    protocol: string;

    /**
     * The URL's host: the extension id for a management surface, the DNS name (port included) for a
     * public site.
     */
    host: string;
}

/**
 * Reduce one URL to the protocol-and-host pair the admission guard compares, or null when it cannot
 * parse.
 *
 * `URL.origin` cannot carry this comparison for a `chrome-extension://` surface: an opaque origin
 * serializes as the string `null`, so every non-special scheme — extension, `file:`, `data:` —
 * would compare equal. The pair keeps the one surface identity the application session prepared.
 *
 * @param url - Absolute URL to reduce, as a string or an already-parsed `URL`.
 * @returns The URL's protocol and host, or null when the URL is not parseable.
 */
export function protocolHostOf(url: string | URL): ProtocolHost | null {
    try {
        const parsed = url instanceof URL ? url : new URL(url);
        return { protocol: parsed.protocol, host: parsed.host };
    } catch {
        return null;
    }
}

/**
 * Whether two protocol-and-host pairs name the same admission target.
 *
 * @param left - One parsed pair.
 * @param right - The other parsed pair.
 * @returns True when both the protocol and the host are equal.
 */
export function sameProtocolHost(left: ProtocolHost, right: ProtocolHost): boolean {
    return left.protocol === right.protocol && left.host === right.host;
}

/**
 * Section key of the extension's own configuration schema the filters live under.
 */
const FILTERS_SECTION_KEY = 'filters';

/**
 * Key of the enabled-filter ID array inside the filters section.
 */
const ENABLED_FILTERS_KEY = 'enabled-filters';

/**
 * Key of the enabled-group ID array inside the filters section: a filter's rules run only when its
 * own group is also enabled, so naming a filter without its group leaves it inert.
 */
const ENABLED_GROUPS_KEY = 'enabled-groups';

/**
 * Key of the custom-filter array inside the filters section: the filters the import downloads from
 * their own URLs and allocates ids to, as `adguard-custom-filters.ts` describes.
 */
const CUSTOM_FILTERS_KEY = 'custom-filters';

/**
 * Section key of the extension's own configuration schema the Tracking-protection state lives
 * under.
 */
const STEALTH_SECTION_KEY = 'stealth';

/**
 * Section key of the extension's own configuration schema the Acceptable Ads switch lives under.
 */
const GENERAL_SETTINGS_SECTION_KEY = 'general-settings';

/**
 * Key of the Acceptable Ads switch inside the general-settings section.
 *
 * It is not a preference the payload may leave alone: the extension treats it as authority over
 * {@link SEARCH_ADS_AND_SELF_PROMOTION_FILTER_ID} and re-enables that filter whenever the flag is
 * on, whatever `enabled-filters` says: an import of the prepared `[2, 3]` answers `true`, and the
 * read-back observes `[2, 3, 10]`.
 */
const ALLOW_ACCEPTABLE_ADS_KEY = 'allow-acceptable-ads';

/**
 * Official ID of the "Filter unblocking search ads and self-promotion" filter — the one filter the
 * Acceptable Ads switch governs, so the switch is exactly "is this filter expected".
 */
const SEARCH_ADS_AND_SELF_PROMOTION_FILTER_ID = 10;

/**
 * Shape of the `loadSettingsJson` response: the complete settings export as a JSON string.
 */
const SettingsExportResponseSchema = v.object({
    content: v.string(),
});

/**
 * The prepared expectation the host renders into one settings payload.
 */
export interface ExtensionSettingsPayloadExpectation {
    /**
     * Exact official filter IDs the payload must enable.
     */
    enabledFilterIds: readonly number[];

    /**
     * Filter groups the enabled filters need switched on, merged into the export's own
     * `enabled-groups` rather than replacing it.
     */
    requiredGroupIds: readonly number[];

    /**
     * Custom filters the import installs, replacing whatever the export's own custom-filters
     * section carried. Omitted leaves that section untouched. A non-empty list also switches the
     * custom filters group on, without which the build lists every custom filter and runs none.
     */
    customFilters?: readonly ExtensionCustomFilterEntry[];

    /**
     * Expected Tracking-protection state. Omitted leaves the stealth section untouched, so the
     * instruction applies only what the host can state exactly.
     */
    stealthEnabled?: boolean;
}

/**
 * Set the Acceptable Ads switch from the expected filter set.
 *
 * The switch is a second, higher authority over one filter, so leaving the export's own value in
 * place silently contradicts `enabled-filters`. Expressed as an equality rather than a one-way
 * disable: a run that expects the filter must not have the switch turn it back off either.
 *
 * @param root - The parsed settings export being mutated in place.
 * @param enabledFilterIds - Exact official filter IDs the payload enables.
 * @returns Nothing.
 */
function setAcceptableAds(
    root: Record<string, unknown>,
    enabledFilterIds: readonly number[],
): void {
    const section = root[GENERAL_SETTINGS_SECTION_KEY];
    if (typeof section !== 'object' || section === null) {
        throw new Error(
            "The extension's own settings export carries no general-settings section to set " +
                'the Acceptable Ads switch in.',
        );
    }
    (section as Record<string, unknown>)[ALLOW_ACCEPTABLE_ADS_KEY] = enabledFilterIds.includes(
        SEARCH_ADS_AND_SELF_PROMOTION_FILTER_ID,
    );
}

/**
 * Load the extension's own settings export and mutate it into the complete import document its
 * `applySettingsJson` message accepts.
 *
 * The pinned build refuses a partial document — `applySettingsJson` reports failure before applying
 * anything unless the JSON carries `protocol-version`, `general-settings`,
 * `extension-specific-settings` and a full `filters` section — so a payload built from the
 * expectation alone can never establish a baseline. The build's own most recent export already
 * carries all of that; this loads it fresh over the prepared surface, changes only the fields the
 * expectation names — the filters, their groups, the Acceptable Ads switch that governs one of them
 * and the stealth state — and hands back the complete document unchanged everywhere else.
 *
 * The page has only just loaded when this runs, and the extension's background message handlers
 * register asynchronously after it: a message sent too early meets "Could not establish connection.
 * Receiving end does not exist." from a listener that is not up yet, and the whole prepared launch
 * is thrown away for it. The export read therefore waits for the extension's readiness first and
 * probes the export the way every host read-back of the blocker state does.
 *
 * @param page - Prepared blocker management surface page the export is read from.
 * @param expectation - The prepared expectation the payload must express.
 * @param readiness - Optional readiness budget; the shared default otherwise.
 * @returns The complete settings-import JSON document, ready for `applySettingsJson`.
 * @throws When the extension does not become ready within the budget, or the export does not parse
 *   as a JSON object, or carries no `filters` or `general-settings` section, or carries no
 *   `stealth` section to enable Tracking protection in when one is expected enabled.
 */
export async function buildExtensionSettingsPayload(
    page: Page,
    expectation: ExtensionSettingsPayloadExpectation,
    readiness?: ExtensionReadinessOptions,
): Promise<string> {
    const readinessDeadlineAt = Date.now() + (readiness?.budgetMs ?? DEFAULT_READINESS_BUDGET_MS);
    await waitForAppInitialized(page, readinessDeadlineAt);
    const exported = await probeUntilReady({
        page,
        sharedDeadlineAt: readinessDeadlineAt,
        label: "the extension's own settings export did not answer",
        probe: async () =>
            v.parse(
                SettingsExportResponseSchema,
                await sendExtensionMessage(page, {
                    type: AdGuardExtensionMessageType.LoadSettingsJson,
                }),
            ),
    });
    let root: Record<string, unknown>;
    try {
        root = v.parse(v.record(v.string(), v.unknown()), JSON.parse(exported.content));
    } catch (error) {
        throw new Error(
            "The extension's own settings export is not a JSON object: " +
                (error instanceof Error ? error.message : String(error)),
            { cause: error },
        );
    }
    const filtersSection = root[FILTERS_SECTION_KEY];
    if (typeof filtersSection !== 'object' || filtersSection === null) {
        throw new Error("The extension's own settings export carries no filters section.");
    }
    const filters = filtersSection as Record<string, unknown>;
    filters[ENABLED_FILTERS_KEY] = [...expectation.enabledFilterIds];
    setAcceptableAds(root, expectation.enabledFilterIds);
    const customFilters = expectation.customFilters;
    if (customFilters !== undefined) {
        filters[CUSTOM_FILTERS_KEY] = customFilters.map((entry) => ({ ...entry }));
    }
    const existingGroups = Array.isArray(filters[ENABLED_GROUPS_KEY])
        ? (filters[ENABLED_GROUPS_KEY] as unknown[]).filter(
              (group): group is number => typeof group === 'number',
          )
        : [];
    filters[ENABLED_GROUPS_KEY] = [
        ...new Set([
            ...existingGroups,
            ...expectation.requiredGroupIds,
            ...(customFilters !== undefined && customFilters.length > 0
                ? [CUSTOM_FILTERS_GROUP_ID]
                : []),
        ]),
    ];
    if (expectation.stealthEnabled !== undefined) {
        const stealthSection = root[STEALTH_SECTION_KEY];
        if (typeof stealthSection === 'object' && stealthSection !== null) {
            (stealthSection as Record<string, unknown>)[DISABLE_STEALTH_SETTING] =
                !expectation.stealthEnabled;
        } else if (expectation.stealthEnabled) {
            // Without a stealth section there is nothing safe to synthesize against the build's
            // own schema; disabling needs no write, since a section-less extension carries no
            // Tracking protection to turn off.
            throw new Error(
                "The extension's own settings export carries no stealth section to enable " +
                    'Tracking protection in.',
            );
        }
    }
    return JSON.stringify(root);
}

/**
 * Send one application runtime message from the prepared blocker surface page.
 *
 * The prepared surface's protocol and host are the whole admission rule: a call made anywhere else
 * is refused before any message leaves, so the declared write channel can never fire from a page
 * the session was not prepared against. The background response is returned as-is (wrapped so a
 * void answer still reaches the model); a transport or background rejection propagates as its typed
 * error, which the tool adapter logs with its cause before answering the model.
 *
 * @param page - The session's current page.
 * @param surface - Protocol and host of the prepared blocker management surface.
 * @param args - The model's message arguments: the message `type` and optional `data`.
 * @returns The message response, or the typed refusal of a call made off the surface.
 */
export async function deliverExtensionMessage(
    page: Page,
    surface: ProtocolHost,
    args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
    const messageType = typeof args.type === 'string' ? args.type : '';
    if (messageType.length === 0) {
        return { error: 'message type is required' };
    }
    const current = protocolHostOf(page.url());
    if (current === null || !sameProtocolHost(current, surface)) {
        return {
            error:
                'message blocked: send_extension_message is admitted only on the prepared ' +
                `blocker management surface ${surface.protocol}//${surface.host}`,
        };
    }
    const data = args.data;
    const response = await sendExtensionMessage(page, {
        type: messageType,
        ...(typeof data === 'object' && data !== null
            ? { data: data as Record<string, unknown> }
            : {}),
    });
    return { response: response ?? null };
}

/**
 * Build the declared `send_extension_message` tool over one application session.
 *
 * The caller wraps the returned input's execute with the application tool set's action-log
 * recorder, so every message — accepted or refused — lands in the host-assembled trace.
 *
 * @param session - The phase lease session whose current page sends the message.
 * @param surface - Protocol and host of the prepared blocker management surface.
 * @returns The adapted tool input for the application tool set.
 */
export function buildSendExtensionMessageTool(
    session: IBrowserSession,
    surface: ProtocolHost,
): AdaptedToolInput {
    return {
        name: ToolName.SendExtensionMessage,
        parameters: TOOL_PARAMETER_SCHEMAS[ToolName.SendExtensionMessage],
        description: TOOL_GUIDANCE[ToolName.SendExtensionMessage]!,
        execute: async (args) => await deliverExtensionMessage(session.getPage(), surface, args),
    };
}
