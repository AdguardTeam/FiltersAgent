/**
 * What a slice session's read-back must show, and what a verified one reports: the judgement of
 * `list-slice-baseline.ts`, kept apart from its procedure. The credit rule of
 * `blocker-state-credit.ts` is not reused here because it would count the slice's custom filter as
 * a stray beside the built-in lists.
 */
import { isCustomFilterId } from '../browser/adguard-custom-filters';
import { DISABLE_STEALTH_SETTING } from '../browser/adguard-extension-settings';
import type {
    AdGuardExtensionStateRead,
    AdGuardMv3RulesLimitsEvidence,
} from '../browser/adguard-extension-state-shapes';
import {
    MAX_REPORTED_SLICE_LINES,
    sliceLineCount,
    type ListSlice,
    type ListSliceFacts,
} from '../environment/list-slice';
import { normalizeRulesContent } from '../environment/rules-content';
import { filterLimitsExceededFor } from './phase-application-wiring';

/**
 * What the read-back verification of a slice session found.
 */
export interface SliceReadBackVerification {
    /**
     * The checks the read-back failed, each named; empty when it verifies.
     */
    mismatches: string[];

    /**
     * The id of the one enabled custom filter carrying the slice's title, when exactly one does.
     */
    customFilterId: number | undefined;
}

/**
 * The read-back checks a slice session must pass, as a list of the ones it failed.
 *
 * @param readBack - The state read after the application.
 * @param commonFilterIds - The lists that must be on.
 * @param title - The custom filter title the slice was imported under.
 * @param expectedStealthEnabled - The Stealth state the request expects, when it states one.
 * @returns The mismatches, empty when the read-back verifies, plus the slice's custom filter id
 *   when exactly one carries the title.
 */
export function verifySliceReadBack(
    readBack: AdGuardExtensionStateRead,
    commonFilterIds: readonly number[],
    title: string,
    expectedStealthEnabled: boolean | undefined,
): SliceReadBackVerification {
    const mismatches: string[] = [];
    const enabledBuiltIn = readBack.optionsEnabledFilterIds.filter(
        (filterId) => !isCustomFilterId(filterId),
    );
    const expected = [...new Set(commonFilterIds)].sort((left, right) => left - right);
    if (
        enabledBuiltIn.length !== expected.length ||
        enabledBuiltIn.some((filterId, index) => filterId !== expected[index])
    ) {
        mismatches.push(
            `enabled built-in lists [${enabledBuiltIn.join(', ')}] differ from the expected ` +
                `[${expected.join(', ')}]`,
        );
    }
    const enabledCustom = readBack.optionsData.filtersMetadata.filters.filter(
        (filter) => filter.enabled && isCustomFilterId(filter.filterId),
    );
    const sliceFilters = enabledCustom.filter((filter) => filter.name === title);
    if (enabledCustom.length !== 1 || sliceFilters.length !== 1) {
        mismatches.push(
            `expected exactly one enabled custom filter titled "${title}", found ` +
                `[${enabledCustom.map((filter) => `${filter.filterId} "${filter.name ?? ''}"`).join(', ')}]`,
        );
    }
    if (normalizeRulesContent(readBack.userRules.content).length !== 0) {
        mismatches.push('the baseline state carries user rules');
    }
    const stealthEnabled = readBack.optionsData.settings.values[DISABLE_STEALTH_SETTING] === false;
    if (expectedStealthEnabled !== undefined && stealthEnabled !== expectedStealthEnabled) {
        mismatches.push(
            `Tracking protection is ${stealthEnabled ? 'on' : 'off'}, expected ` +
                (expectedStealthEnabled ? 'on' : 'off'),
        );
    }
    if (readBack.rulesLimits === null) {
        mismatches.push('the read-back reports no MV3 rule-limit counters');
    } else if (filterLimitsExceededFor(readBack)) {
        mismatches.push('the extension reports its filter limits exceeded');
    }
    return { mismatches, customFilterId: sliceFilters[0]?.filterId };
}

/**
 * The facts a verified slice session reports.
 *
 * @param slice - The slice.
 * @param lines - The whole list's lines.
 * @param customFilterId - The id the import allocated to the slice's custom filter.
 * @param rulesLimits - The MV3 counters read back after the import.
 * @returns The facts.
 */
export function sliceFacts(
    slice: ListSlice,
    lines: readonly string[],
    customFilterId: number,
    rulesLimits: AdGuardMv3RulesLimitsEvidence,
): ListSliceFacts {
    const enabled = rulesLimits.dynamicRulesEnabledCount;
    const maximum = rulesLimits.dynamicRulesMaximumCount;
    return {
        ...slice,
        totalLines: lines.length,
        customFilterId,
        dynamicRules: {
            enabled,
            maximum,
            unsafeEnabled: rulesLimits.dynamicRulesUnsafeEnabledCount,
            unsafeMaximum: rulesLimits.dynamicRulesUnsafeMaximumCount,
            regexEnabled: rulesLimits.dynamicRulesRegexpsEnabledCount,
            regexMaximum: rulesLimits.dynamicRulesRegexpsMaximumCount,
        },
        atLimit: enabled >= maximum,
        ...(sliceLineCount(slice) <= MAX_REPORTED_SLICE_LINES
            ? { lines: lines.slice(slice.firstLine - 1, slice.lastLine) }
            : {}),
    };
}
