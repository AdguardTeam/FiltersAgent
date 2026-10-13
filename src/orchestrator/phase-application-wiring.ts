import type {
    AdGuardExtensionOptionsData,
    AdGuardExtensionStateRead,
} from '../browser/adguard-extension-state-shapes';
import {
    DISABLE_STEALTH_SETTING,
    normalizeFilterIds,
    parseImportExpectations,
    type AdGuardExtensionSettingsProfile,
} from '../browser/adguard-extension-settings';
import type { ExtensionBaselineSettings } from '../environment/browser-extension-environment';
import { createLogger } from '../logger/logger';
import { SettingsProfileKind } from '../types/settings-profile-kind';

/**
 * The deterministic helpers of the between-phases application wiring: the origin the application
 * page-tool inventory is pinned to, the baseline-identity projection of a host read-back, and the
 * exact filter set and Tracking-protection state a launch settings request must produce.
 *
 * They carry no session behavior of their own, so the runtime composes them without importing the
 * phase-application bodies this module is deliberately kept free of.
 */

/**
 * Reduce one bound target URL to its origin for the application page-tool inventory.
 *
 * @param targetUrl - Canonical reported target the lease observes.
 * @returns The URL's origin, or the URL itself when it cannot parse.
 */
export function canonicalPhaseApplicationOrigin(targetUrl: string): string {
    try {
        return new URL(targetUrl).origin;
    } catch {
        return targetUrl;
    }
}

/**
 * Project one host read-back of the extension state onto the adapter's baseline-identity shape.
 *
 * The options metadata is the single surviving enabled-set source after the options-page driver's
 * retirement, so all three runtime identity families report the observed set; the MV3 DNR facts
 * ride their own field where the state can observe them.
 *
 * @param stateRead - Complete blocker state the host read back itself.
 * @returns The filter-identity sets the baseline preparation locks.
 */
export function extensionBaselineSettingsFromStateRead(
    stateRead: AdGuardExtensionStateRead,
): ExtensionBaselineSettings {
    const enabledFilterIds = [...stateRead.optionsEnabledFilterIds];
    const versions = new Map<number, string>();
    for (const filter of stateRead.optionsData.filtersMetadata.filters) {
        if (filter.version !== undefined) {
            versions.set(filter.filterId, filter.version);
        }
    }
    return {
        enabledFilterIds,
        optionsEnabledFilterIds: [...enabledFilterIds],
        runtimeEnabledFilterIds: stateRead.rulesLimits
            ? [...stateRead.rulesLimits.actuallyEnabledFilters]
            : [...enabledFilterIds],
        activeRulesetFilterIds: stateRead.rulesLimits
            ? [...stateRead.rulesLimits.actuallyEnabledFilters]
            : [],
        versions,
    };
}

/**
 * The exact enabled filter set one launch settings request must produce.
 *
 * A model-selected request enables exactly its filter IDs; reporter URLs import exactly their
 * parsed IDs. A defaults-plus-required request expects the fresh-install defaults the launch
 * pre-read observed plus its required IDs, so the required filters are applied and compared, never
 * merely recorded.
 *
 * @param settings - Model-selected extension settings profile.
 * @param preReadEnabledFilterIds - Enabled filter IDs the launch pre-read observed; supplies the
 *   defaults half of a defaults-plus-required request.
 * @returns The exact expected filter IDs, or undefined when the request cannot be resolved.
 */
export function launchBaselineFilterIds(
    settings: AdGuardExtensionSettingsProfile,
    preReadEnabledFilterIds: readonly number[] = [],
): number[] | undefined {
    try {
        if (settings.kind === SettingsProfileKind.AgentSelected) {
            return normalizeFilterIds(settings.filterIds);
        }
        if (
            settings.kind === SettingsProfileKind.ReportExact ||
            settings.kind === SettingsProfileKind.ReportedOnCurrent
        ) {
            return parseImportExpectations(settings.importUrl).enabledFilterIds;
        }
        if (settings.kind === SettingsProfileKind.DefaultsPlusRequired) {
            return normalizeFilterIds([...preReadEnabledFilterIds, ...settings.requiredFilterIds]);
        }
    } catch (error) {
        createLogger().warn(
            { error: error instanceof Error ? error.message : String(error) },
            'the launch settings request could not be resolved to exact filter IDs',
        );
    }
    return undefined;
}

/**
 * The exact Tracking-protection state one settings request expects to observe after its
 * application.
 *
 * A model-selected request states it; a reporter URL carries it; a defaults-plus-required request
 * states nothing, so it expects the state the observed fresh-install settings carried — the
 * inversion of the extension's own `stealth-disable-stealth-mode` setting.
 *
 * @param settings - Model-selected extension settings profile, when one was selected.
 * @param observedState - State read before the application; supplies the defaults expectation.
 * @returns The expected Tracking-protection state, or undefined when none can be stated exactly.
 */
export function expectedStealthEnabledFor(
    settings: AdGuardExtensionSettingsProfile | undefined,
    observedState: AdGuardExtensionStateRead | undefined,
): boolean | undefined {
    if (!settings) {
        return undefined;
    }
    try {
        if (settings.kind === SettingsProfileKind.AgentSelected) {
            return settings.stealthEnabled;
        }
        if (
            settings.kind === SettingsProfileKind.ReportExact ||
            settings.kind === SettingsProfileKind.ReportedOnCurrent
        ) {
            return parseImportExpectations(settings.importUrl).stealthEnabled;
        }
        const stealthDisabled = observedState?.optionsData.settings.values[DISABLE_STEALTH_SETTING];
        return typeof stealthDisabled === 'boolean' ? !stealthDisabled : undefined;
    } catch (error) {
        createLogger().warn(
            { error: error instanceof Error ? error.message : String(error) },
            'the launch settings request could not be resolved to an exact stealth state',
        );
        return undefined;
    }
}

/**
 * Whether one host read-back reports MV3 filter or rule limits exceeded.
 *
 * The extension reports the combined verdict from two places — the MV3 rules-limits counters and
 * the options runtime info — because either alone can be stale: `settingsEvidenceFromReadBack`
 * derives the same run-report field from the identical formula, so this is the one place the
 * combination is written.
 *
 * @param stateRead - Complete blocker state the host read back itself.
 * @returns True when either source reports limits exceeded, false when neither does or an MV2
 *   runtime reports no counters at all.
 */
export function filterLimitsExceededFor(stateRead: AdGuardExtensionStateRead): boolean {
    return (
        (stateRead.rulesLimits?.areFilterLimitsExceeded ?? false) ||
        (stateRead.optionsData.runtimeInfo?.areFilterLimitsExceeded ?? false)
    );
}

/**
 * The filter groups a set of enabled filter IDs need switched on.
 *
 * The extension's own configuration schema enables a filter's rules only when its group is also
 * enabled, so a settings import that names the filter without its group leaves it inert.
 *
 * @param enabledFilterIds - Exact filter IDs the import must enable.
 * @param filtersMetadata - The baseline read-back's own filter catalog, groups included.
 * @returns Deduplicated group IDs the enabled filters need, in no particular order.
 */
export function requiredExtensionGroupIds(
    enabledFilterIds: readonly number[],
    filtersMetadata: AdGuardExtensionOptionsData['filtersMetadata'],
): number[] {
    const enabled = new Set(enabledFilterIds);
    return [
        ...new Set(
            filtersMetadata.filters
                .filter((filter) => filter.groupId !== undefined && enabled.has(filter.filterId))
                .map((filter) => filter.groupId!),
        ),
    ];
}
