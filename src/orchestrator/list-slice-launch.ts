/**
 * The runtime-facing half of a list slice (`settings.slice`): what a launch checks before it starts
 * a browser for one, what the launch answer then reports about the lists a session runs, and why a
 * slice session refuses to validate a candidate. The slice's own Baseline application lives in
 * `list-slice-baseline.ts`; the list text comes from `extension-list-text.ts`.
 */
import { isCustomFilterId } from '../browser/adguard-custom-filters';
import type { AdGuardExtensionSettingsProfile } from '../browser/adguard-extension-settings';
import type {
    AdGuardExtensionOptionsData,
    AdGuardExtensionStateRead,
} from '../browser/adguard-extension-state-shapes';
import { readBundledListLines } from '../browser/extension-list-text';
import type { EnabledListFacts, ListSlice, ListSliceFacts } from '../environment/list-slice';
import type { Logger } from '../logger/logger';
import { SettingsProfileKind } from '../types/settings-profile-kind';
import type { AgentRuntimeSessionState } from './agent-runtime-session-evidence';

/**
 * The `errorKind` of a launch refused for its slice: the range or the list cannot be run as asked.
 * Every refusal is retryable — the agent corrects the slice and launches again.
 */
export const LIST_SLICE_REFUSAL_ERROR_KIND = 'invalid_list_slice';

/**
 * The `errorKind` of an `apply_rule` call made in a session that runs a slice: a candidate is
 * judged against whole lists only, so the agent launches a session without a slice for it.
 */
export const SLICE_SESSION_ERROR_KIND = 'slice_session';

/**
 * How a list with no name in the options metadata is named in answers and titles: by its id, so the
 * agent and the filtering log still agree on which list it is.
 */
const UNNAMED_LIST_PREFIX = 'filter ';

/**
 * Line count of one built-in list from the build's own text, or null when the build carries no
 * readable text for it: such a list cannot be sliced.
 */
export type ListLineCounter = (filterId: number) => number | null;

/**
 * A per-run line counter over one unpacked build: each list's ruleset is read and counted once —
 * the largest is tens of megabytes — and answered from memory after that. A list the build has no
 * text for is remembered the same way, so it is read and logged once per run rather than on every
 * launch answer that lists it.
 *
 * @param extensionPath - Unpacked root of the prepared Chromium build.
 * @param logger - Run logger receiving each read and each list the build has no text for.
 * @returns The counter.
 */
export function createListLineCounter(extensionPath: string, logger: Logger): ListLineCounter {
    const counts = new Map<number, number | null>();
    return (filterId) => {
        const cached = counts.get(filterId);
        if (cached !== undefined) {
            return cached;
        }
        const startedAt = Date.now();
        try {
            const lines = readBundledListLines(extensionPath, filterId).length;
            counts.set(filterId, lines);
            logger.info(
                { filterId, lines, readMs: Date.now() - startedAt },
                'counted the lines of a built-in list from the build text',
            );
            return lines;
        } catch (error) {
            logger.warn(
                { err: error, filterId, extensionPath },
                'the build carries no readable text for a built-in list, so it cannot be sliced',
            );
            counts.set(filterId, null);
            return null;
        }
    };
}

/**
 * The name the options metadata gives one list, or its id when it gives none.
 *
 * @param filtersMetadata - The extension's filter catalog as a state read reported it.
 * @param filterId - The list.
 * @returns The list's name.
 */
export function listNameFor(
    filtersMetadata: AdGuardExtensionOptionsData['filtersMetadata'],
    filterId: number,
): string {
    const entry = filtersMetadata.filters.find((filter) => filter.filterId === filterId);
    return entry?.name ?? `${UNNAMED_LIST_PREFIX}${filterId}`;
}

/**
 * What the pre-launch slice check judges a request by.
 */
export interface ListSliceRefusalInput {
    /**
     * The launch request's settings, when it carries any.
     */
    settings: AdGuardExtensionSettingsProfile | undefined;

    /**
     * Whether this run applies through the built-in AdGuard route; a slice is imported through that
     * route's settings document and exists nowhere else.
     */
    hostPerformed: boolean;

    /**
     * The run's line counter over the prepared Chromium build, or undefined when the run prepared
     * no such build.
     */
    lineCountOf: ListLineCounter | undefined;
}

/**
 * One refusal of a launch for its slice, with the slice named.
 *
 * @param error - Why the slice cannot run as asked.
 * @param slice - The slice the request named.
 * @param totalLines - The list's line count, when the check got as far as reading it.
 * @returns The typed, retryable refusal the launch answers with.
 */
function sliceRefusal(
    error: string,
    slice: ListSlice,
    totalLines?: number,
): Record<string, unknown> {
    return {
        error,
        errorKind: LIST_SLICE_REFUSAL_ERROR_KIND,
        retryable: true,
        listSlice: { ...slice },
        ...(totalLines === undefined ? {} : { totalLines }),
    };
}

/**
 * Refuse a launch whose slice cannot run, before any browser starts for it.
 *
 * The request schema already holds the shape (three positive integers); this holds the meaning: the
 * sliced list must be one of the selected lists, the build must carry its text, and the range must
 * lie within that text. Judged here, on the build alone, so a wrong range costs no browser launch.
 *
 * @param input - The request's settings, the run's route and the build's line counter.
 * @returns The typed refusal, or undefined when the request carries no slice or a valid one.
 */
export function listSliceRefusal(
    input: ListSliceRefusalInput,
): Record<string, unknown> | undefined {
    const { settings } = input;
    if (settings?.kind !== SettingsProfileKind.AgentSelected || settings.slice === undefined) {
        return undefined;
    }
    const { slice } = settings;
    if (!input.hostPerformed) {
        return sliceRefusal(
            'settings.slice runs a list slice through the built-in AdGuard settings import, and ' +
                'this run applies its blocker through its own instruction. Launch without ' +
                'settings.slice.',
            slice,
        );
    }
    if (input.lineCountOf === undefined) {
        return sliceRefusal(
            'settings.slice needs the text of the list, which only a prepared Chromium build ' +
                'carries; this run prepared none. Launch without settings.slice.',
            slice,
        );
    }
    if (!settings.filterIds.includes(slice.filterId)) {
        return sliceRefusal(
            `settings.slice.filterId ${slice.filterId} is not one of settings.filterIds ` +
                `[${settings.filterIds.join(', ')}]; a slice replaces one of the selected lists.`,
            slice,
        );
    }
    const totalLines = input.lineCountOf(slice.filterId);
    if (totalLines === null) {
        return sliceRefusal(
            `The prepared build carries no text for list ${slice.filterId}, so it cannot be ` +
                'sliced; pick a list the launch answer reports a line count for.',
            slice,
        );
    }
    if (slice.firstLine > slice.lastLine) {
        return sliceRefusal(
            `settings.slice.firstLine ${slice.firstLine} is after lastLine ${slice.lastLine}; ` +
                `list ${slice.filterId} has ${totalLines} lines, numbered 1 to ${totalLines}.`,
            slice,
            totalLines,
        );
    }
    if (slice.lastLine > totalLines) {
        return sliceRefusal(
            `settings.slice.lastLine ${slice.lastLine} is past the end of list ` +
                `${slice.filterId}, which has ${totalLines} lines (totalLines ${totalLines}); ` +
                `lines are numbered 1 to ${totalLines}.`,
            slice,
            totalLines,
        );
    }
    return undefined;
}

/**
 * The lists one verified session runs, with their line counts.
 *
 * The enabled built-in lists come from the read-back; a sliced list is disabled there (its custom
 * filter replaced it) and is listed all the same, because the agent is halving exactly that list.
 * Names come from the options metadata, which lists every list the build knows, enabled or not.
 *
 * @param readBack - The verified Baseline read-back of the session.
 * @param slice - The slice the session runs, when it runs one.
 * @param lineCountOf - The run's line counter over the build.
 * @returns The lists, ascending by id.
 */
function enabledListsFor(
    readBack: AdGuardExtensionStateRead,
    slice: ListSlice | undefined,
    lineCountOf: ListLineCounter,
): EnabledListFacts[] {
    const ids = new Set(
        readBack.optionsEnabledFilterIds.filter((filterId) => !isCustomFilterId(filterId)),
    );
    if (slice !== undefined) {
        ids.add(slice.filterId);
    }
    return [...ids]
        .sort((left, right) => left - right)
        .map((id) => ({
            id,
            name: listNameFor(readBack.optionsData.filtersMetadata, id),
            lines: lineCountOf(id),
        }));
}

/**
 * The list facts a launch answer carries for one prepared Chromium session whose Baseline verified:
 * every list it runs with its line count, and the slice facts when it runs a slice.
 *
 * @param state - The launched session's state, once the Baseline outcome was stored on it.
 * @param lineCountOf - The run's line counter over the build, or undefined when the run prepared no
 *   Chromium build.
 * @returns The fields to spread into the launch answer; empty for a session with no read-back.
 */
export function launchListFields(
    state: AgentRuntimeSessionState,
    lineCountOf: ListLineCounter | undefined,
): Record<string, unknown> {
    const readBack = state.extensionBaselineReadBack;
    if (readBack === undefined || lineCountOf === undefined) {
        return {};
    }
    return {
        enabledLists: enabledListsFor(readBack, state.listSlice, lineCountOf),
        ...(state.listSlice === undefined ? {} : { listSlice: state.listSlice }),
    };
}

/**
 * Refuse a candidate validation in a session that runs a slice.
 *
 * A candidate is judged against whole lists: the exception it proposes must hold beside every rule
 * of the list, not beside a half of it. The refusal costs no candidate attempt.
 *
 * @param listSlice - The slice the active session runs, when it runs one.
 * @returns The typed, retryable refusal, or undefined when the session runs no slice.
 */
export function sliceSessionApplyRuleRefusal(
    listSlice: ListSliceFacts | undefined,
): Record<string, unknown> | undefined {
    if (listSlice === undefined) {
        return undefined;
    }
    return {
        error:
            `This session runs lines ${listSlice.firstLine}-${listSlice.lastLine} of list ` +
            `${listSlice.filterId} as a custom filter; candidates are validated only against ` +
            'whole lists. Launch a session without settings.slice, then apply_rule.',
        errorKind: SLICE_SESSION_ERROR_KIND,
        retryable: true,
        listSlice: {
            filterId: listSlice.filterId,
            firstLine: listSlice.firstLine,
            lastLine: listSlice.lastLine,
        },
    };
}
