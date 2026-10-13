import * as v from 'valibot';
import type { BrowserContext, Page } from 'playwright-core';
import { ExtensionManifestVersion } from '../environment/extension-preparation';
import { normalizeRulesContent, sha256OfContent } from '../environment/rules-content';
import { FilterEngine } from '../types/filter-engine';
import { AdGuardExtensionMessageType } from './adguard-extension-message-types';
import type { ExtensionRuntimeHints } from './extension-runtime-location';
import {
    DEFAULT_READINESS_BUDGET_MS,
    type ExtensionReadinessOptions,
    openOptionsPage,
    probeUntilReady,
    sendExtensionMessage,
} from './adguard-extension-state-transport';
import {
    AdGuardExtensionStateRead,
    AdGuardUserRulesStateRead,
    OptionsDataSchema,
    RulesLimitsSchema,
    UserRulesResponseSchema,
} from './adguard-extension-state-shapes';

/**
 * The host read-backs of the prepared extension's state: the options settings, the user rules, and
 * the MV3 limit counters, read over the extension's own app-message transport.
 *
 * After the model performs the instruction's application steps, the host reads the blocker state
 * itself and credits a phase only when that state contains exactly what the phase expected. This
 * module only reads; it never writes extension settings.
 *
 * The message transport and the bounded readiness posture underneath every read live in
 * `adguard-extension-state-transport.ts`.
 */

/**
 * Normalize a filter-ID list into ascending order without duplicates.
 *
 * @param filterIds - Filter IDs as the extension reports them.
 * @returns Sorted distinct IDs.
 */
export function normalizeReadFilterIds(filterIds: readonly number[]): number[] {
    return [...new Set(filterIds)].sort((left, right) => left - right);
}

/**
 * The validated options-data output type.
 */
type OptionsDataOutput = v.InferOutput<typeof OptionsDataSchema>;

/**
 * The validated MV3 rules-limit counters output type.
 */
type RulesLimitsOutput = v.InferOutput<typeof RulesLimitsSchema>;

/**
 * Wait until the options application and its background message handlers are ready.
 *
 * @param page - Loaded AdGuard options page.
 * @param sharedDeadlineAt - Absolute deadline of the whole state read.
 * @returns Parsed options data proving readiness.
 */
export async function waitForOptionsData(
    page: Page,
    sharedDeadlineAt: number,
): Promise<OptionsDataOutput> {
    return probeUntilReady({
        page,
        sharedDeadlineAt,
        label: 'AdGuard options app did not become ready',
        probe: async () => {
            const response = await sendExtensionMessage(page, {
                type: AdGuardExtensionMessageType.GetOptionsData,
            });
            if (response === undefined) {
                throw new Error(
                    `${AdGuardExtensionMessageType.GetOptionsData} returned no response.`,
                );
            }
            return v.parse(OptionsDataSchema, response);
        },
    });
}

/**
 * Wait until AdGuard finishes its asynchronous fresh-install bootstrap.
 *
 * The options message handlers can become available before default filters finish initializing.
 * Reading state in that window lets late bootstrap work land after the read.
 *
 * @param page - Loaded AdGuard options page.
 * @param sharedDeadlineAt - Absolute deadline of the whole state read.
 * @returns Promise resolved after the extension reports complete initialization.
 */
export async function waitForAppInitialized(page: Page, sharedDeadlineAt: number): Promise<void> {
    return probeUntilReady({
        page,
        sharedDeadlineAt,
        label: 'AdGuard app did not finish initialization',
        probe: async () => {
            const response = await sendExtensionMessage(page, {
                type: AdGuardExtensionMessageType.GetIsAppInitialized,
            });
            if (response !== true) {
                throw new Error('AdGuard fresh-install bootstrap is still running.');
            }
            return undefined;
        },
    });
}

/**
 * Read the validated MV3 rules-limit counters once, retrying only transport-level failures.
 *
 * @param page - Loaded AdGuard options page.
 * @param sharedDeadlineAt - Absolute deadline of the whole state read.
 * @returns The observed counters.
 */
async function readRulesLimits(page: Page, sharedDeadlineAt: number): Promise<RulesLimitsOutput> {
    return probeUntilReady({
        page,
        sharedDeadlineAt,
        label: 'AdGuard MV3 rules-limit counters could not be read',
        probe: async () => {
            const response = await sendExtensionMessage(page, {
                type: 'getRulesLimitsCountersMv3',
            });
            if (response === undefined) {
                throw new Error('getRulesLimitsCountersMv3 returned no response.');
            }
            return v.parse(RulesLimitsSchema, response);
        },
    });
}

/**
 * Read one snapshot of the exact user-rule bundle the extension persists.
 *
 * A failed probe retries within the shared budget like every readiness wait; the first successful
 * read wins — a user-rules state that is empty reports `content: ''` and `ruleCount: 0`, because an
 * empty bundle is the true observed state a baseline phase must be proved against.
 *
 * @param page - Loaded AdGuard options page.
 * @param sharedDeadlineAt - Absolute deadline of the whole state read.
 * @returns The exact content with its digest and non-empty rule count.
 */
async function readUserRulesContent(
    page: Page,
    sharedDeadlineAt: number,
): Promise<AdGuardUserRulesStateRead> {
    return probeUntilReady({
        page,
        sharedDeadlineAt,
        label: 'AdGuard user rules could not be read',
        probe: async () => {
            const response = v.parse(
                UserRulesResponseSchema,
                await sendExtensionMessage(page, { type: 'getUserRules' }),
            );
            // The historical read-back compared bundles after the same trim, so the observed
            // content keeps that exact semantics: the outer whitespace the runtime round-trips
            // through its storage is not part of the rule content. `rules-content.ts` is the one
            // place that normalizes and digests it, so this read-back agrees with every other
            // comparison site by construction.
            const content = normalizeRulesContent(response.content);
            return {
                manifestVersion: ExtensionManifestVersion.Mv3,
                ruleCount: content.split('\n').filter((line) => line.trim().length > 0).length,
                contentSha256: sha256OfContent(content),
                rulesLimits: null,
                content,
            };
        },
    });
}

/**
 * Read the complete observable state of the prepared extension for the host read-back.
 *
 * This is the `extension-state` verification surface: the options settings, the exact user-rule
 * bundle, and the MV3 counters, all read by the host itself after the model's application steps.
 *
 * @param context - Persistent Chromium context containing the prepared AdGuard extension.
 * @param expectedManifestVersion - Manifest generation verified from the extension build.
 * @param readiness - Optional wall-clock budget override for the bounded readiness waits.
 * @param hints - Profile and extension paths used for Preferences-based MV2 discovery.
 * @returns The observed extension state.
 */
export async function readAdGuardExtensionState(
    context: BrowserContext,
    expectedManifestVersion: ExtensionManifestVersion = ExtensionManifestVersion.Mv3,
    readiness?: ExtensionReadinessOptions,
    hints?: ExtensionRuntimeHints,
): Promise<AdGuardExtensionStateRead> {
    const readinessDeadlineAt = Date.now() + (readiness?.budgetMs ?? DEFAULT_READINESS_BUDGET_MS);
    const { runtime, page, optionsPageUrl } = await openOptionsPage(
        context,
        expectedManifestVersion,
        hints,
    );

    try {
        await waitForAppInitialized(page, readinessDeadlineAt);
        const optionsData = await waitForOptionsData(page, readinessDeadlineAt);
        const userRules = await readUserRulesContent(page, readinessDeadlineAt);
        const rulesLimits =
            runtime.manifestVersion === ExtensionManifestVersion.Mv3
                ? await readRulesLimits(page, readinessDeadlineAt)
                : null;
        return {
            extensionId: runtime.extensionId,
            optionsPageUrl,
            manifestVersion: runtime.manifestVersion,
            filterEngine:
                runtime.manifestVersion === ExtensionManifestVersion.Mv3
                    ? FilterEngine.DeclarativeNetRequest
                    : FilterEngine.WebRequest,
            appVersion: optionsData.appVersion,
            optionsEnabledFilterIds: normalizeReadFilterIds(
                optionsData.filtersMetadata.filters
                    .filter((filter) => filter.enabled)
                    .map((filter) => filter.filterId),
            ),
            optionsData,
            userRules: {
                ...userRules,
                manifestVersion: runtime.manifestVersion,
                rulesLimits,
            },
            rulesLimits,
        };
    } finally {
        await page.close();
    }
}
