/**
 * The host's own dealings with the prepared extension's management surface, for one application.
 *
 * Three host-side operations bracket every AdGuard-route application: locating the prepared build's
 * options page, reading the settings export over it to build the import payload, and reading the
 * complete extension state back afterwards. None of them may touch the phase session's own page —
 * the lease observes the reported target there — so each opens a throwaway page on the surface
 * instead and closes it whether the work succeeded or threw.
 *
 * `phase-application-flow.ts` composes these around the application runner; the host-performed
 * runner (`host-extension-application.ts`) drives the protocol over the same dedicated-page
 * helper.
 */
import type { BrowserContext, Page } from 'playwright-core';
import type {
    AdGuardExtensionOptionsData,
    AdGuardExtensionStateRead,
    AdGuardMv3RulesLimitsEvidence,
} from '../browser/adguard-extension-state-shapes';
import { DISABLE_STEALTH_SETTING } from '../browser/adguard-extension-settings';
import { readAdGuardExtensionState as readAdGuardExtensionStateDefault } from '../browser/adguard-extension-state-read';
import { findExtensionRuntime as findExtensionRuntimeDefault } from '../browser/extension-runtime-location';
import { adguardListKey } from '../environment/filter-list-ref';
import { ExtensionLaunchFamily } from '../environment/extension-launch';
import { requireChromiumPreparedExtension } from '../local/prepared-extension';
import { createLogger, type Logger } from '../logger/logger';
import {
    buildExtensionSettingsPayload,
    type ExtensionSettingsPayloadExpectation,
} from './application-write-channel';
import type { Mv3RulesLimits } from '../validator/blocker-state-readers';
import type { AgentRuntimeSessionState } from './agent-runtime-session-evidence';
import { filterLimitsExceededFor } from './phase-application-wiring';
import type {
    EnvironmentBlockerStateCapture,
    PhaseApplicationFlowHost,
} from './phase-application-flow-host';

/**
 * Run one host-to-extension exchange over a page dedicated to it.
 *
 * No model turn and no phase observation may share this page: a fresh phase session opens with no
 * navigation of its own, and the lease's page belongs to the reported target. This opens and
 * navigates a throwaway page instead, exactly like every other host read-back of the blocker state
 * (`readAdGuardExtensionState`'s own `openOptionsPage`), and closes it whether the exchange
 * succeeds or throws — a close that itself fails is logged and never masks the exchange's own
 * outcome.
 *
 * @param context - The lease session's persistent context the throwaway page belongs to.
 * @param blockerSurfaceUrl - The prepared blocker's own management surface URL.
 * @param logger - Logger receiving the unclean-close diagnostic.
 * @param exchange - The work to perform over the loaded surface page.
 * @returns Whatever the exchange returned.
 */
export async function overDedicatedSurfacePage<T>(
    context: BrowserContext,
    blockerSurfaceUrl: string,
    logger: Logger,
    exchange: (page: Page) => Promise<T>,
): Promise<T> {
    const page = await context.newPage();
    try {
        await page.goto(blockerSurfaceUrl, { waitUntil: 'load' });
        return await exchange(page);
    } finally {
        await page.close().catch((error: unknown) => {
            logger.warn(
                { err: error, blockerSurfaceUrl },
                'the dedicated blocker-surface page did not close cleanly',
            );
        });
    }
}

/**
 * Locate the prepared blocker's own management surface for the application.
 *
 * @param host - The runtime seam the application flow acts through.
 * @param state - Prepared session naming the verified extension build.
 * @param context - The lease session's persistent context to search.
 * @returns The options-page URL, or undefined when the runtime could not be located (the refusal
 *   detail is logged; the application proceeds with the read tools only).
 */
export async function preparedBlockerSurfaceUrl(
    host: PhaseApplicationFlowHost,
    state: AgentRuntimeSessionState,
    context: BrowserContext,
): Promise<string | undefined> {
    const extension = state.extension;
    if (!extension) {
        return undefined;
    }
    const find = host.findExtensionRuntime ?? findExtensionRuntimeDefault;
    try {
        const runtime = await find(
            context,
            requireChromiumPreparedExtension(
                extension,
                'Locating the prepared blocker management surface',
            ).manifestVersion,
        );
        return `chrome-extension://${runtime.extensionId}/pages/options.html`;
    } catch (error) {
        createLogger({ verbose: host.verbose }).warn(
            {
                error: error instanceof Error ? error.message : String(error),
                launchFamily: extension.launchFamily ?? ExtensionLaunchFamily.Chromium,
            },
            'the prepared blocker management surface could not be located',
        );
        return undefined;
    }
}

/**
 * Build the settings payload over a page dedicated to this one host-to-extension exchange.
 *
 * @param host - The runtime seam the application flow acts through.
 * @param context - The lease session's persistent context the throwaway page belongs to.
 * @param blockerSurfaceUrl - The prepared blocker's own management surface URL.
 * @param expectation - The prepared expectation the payload must express.
 * @returns The complete settings-import JSON document, ready for `applySettingsJson`.
 */
export async function buildExtensionSettingsPayloadOverDedicatedPage(
    host: PhaseApplicationFlowHost,
    context: BrowserContext,
    blockerSurfaceUrl: string,
    expectation: ExtensionSettingsPayloadExpectation,
): Promise<string> {
    const logger = createLogger({ verbose: host.verbose });
    return overDedicatedSurfacePage(
        context,
        blockerSurfaceUrl,
        logger,
        async (page) => await buildExtensionSettingsPayload(page, expectation),
    );
}

/**
 * The static-ruleset counters of one rules-limits read, for the credit's MV3 diagnosis.
 *
 * @param rulesLimits - The complete counters the extension's rules-limits service reported.
 * @returns The four static counters the credit names in an MV3-limits outcome.
 */
function mv3RulesLimitsOf(rulesLimits: AdGuardMv3RulesLimitsEvidence): Mv3RulesLimits {
    return {
        staticFiltersEnabledCount: rulesLimits.staticFiltersEnabledCount,
        staticFiltersMaximumCount: rulesLimits.staticFiltersMaximumCount,
        staticRulesEnabledCount: rulesLimits.staticRulesEnabledCount,
        staticRulesMaximumCount: rulesLimits.staticRulesMaximumCount,
    };
}

/**
 * Read the prepared extension's complete observable state back over one session context.
 *
 * @param host - The runtime seam the application flow acts through.
 * @param state - Prepared session naming the verified extension build and the readiness budget.
 * @param context - The session's persistent context.
 * @returns The complete state read plus the enriched read the phase credit compares against.
 */
export async function readExtensionBlockerState(
    host: PhaseApplicationFlowHost,
    state: AgentRuntimeSessionState,
    context: BrowserContext,
): Promise<EnvironmentBlockerStateCapture> {
    const extension = state.extension!;
    const readState = host.readAdGuardExtensionState ?? readAdGuardExtensionStateDefault;
    const stateRead: AdGuardExtensionStateRead = await readState(
        context,
        requireChromiumPreparedExtension(extension, 'Reading the live AdGuard extension state')
            .manifestVersion,
        host.phaseReadinessBudgetMs === undefined
            ? undefined
            : { budgetMs: host.phaseReadinessBudgetMs },
    );
    return {
        stateRead,
        enriched: {
            rulesContent: stateRead.userRules.content,
            rulesContentSha256: stateRead.userRules.contentSha256,
            // The options metadata is the enabled-set source of truth the read-back credits
            // against; the MV3 counters name the DNR rulesets that actually compiled. Both native
            // numeric sets convert to list keys here, at the reader boundary.
            enabledFilterIds: stateRead.optionsEnabledFilterIds.map(adguardListKey),
            ...(stateRead.rulesLimits
                ? {
                      activeRulesetFilterIds:
                          stateRead.rulesLimits.actuallyEnabledFilters.map(adguardListKey),
                      rulesLimits: mv3RulesLimitsOf(stateRead.rulesLimits),
                  }
                : {}),
            // The requested/options credit alone proves a filter is switched on, never that its
            // MV3 ruleset actually compiled and activated within the browser's limits — the phase
            // credit in phase-application-procedure.ts requires both before it applies.
            limitsExceeded: filterLimitsExceededFor(stateRead),
            stealthEnabled:
                stateRead.optionsData.settings.values[DISABLE_STEALTH_SETTING] === false,
        },
    };
}

/**
 * The filter catalog one application's settings payload computes its required groups from.
 *
 * The very first Baseline application runs before `state.extensionBaselineReadBack` exists — it is
 * what populates it — so the launch's own pre-read supplies the catalog then; every later phase
 * falls back to the baseline read-back `buildBrowserExtensionEnvironmentOptions` already required
 * to exist.
 *
 * @param state - Prepared active session carrying the baseline read-back, once one exists.
 * @param override - The launch pre-read's own catalog, for the very first Baseline application.
 * @returns The filter catalog with its groups.
 * @throws When neither a launch pre-read nor a baseline read-back has run yet.
 */
export function applicationFiltersMetadata(
    state: AgentRuntimeSessionState,
    override: AdGuardExtensionOptionsData['filtersMetadata'] | undefined,
): AdGuardExtensionOptionsData['filtersMetadata'] {
    const filtersMetadata =
        override ?? state.extensionBaselineReadBack?.optionsData.filtersMetadata;
    if (filtersMetadata === undefined) {
        throw new Error(
            "No filter catalog is available to compute the settings payload's required " +
                'groups: neither a launch pre-read nor a baseline read-back has run yet.',
        );
    }
    return filtersMetadata;
}
