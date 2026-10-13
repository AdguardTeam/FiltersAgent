/**
 * The enabled-filter reconciliation of the host-performed AdGuard application.
 *
 * Step 4 of `src/prompts/documents/instructions/adguard-extension.md`: a successful settings import
 * is not proof of the expected filter set — the extension re-enables some filters from settings of
 * its own after an import, so a read-back can show `[2, 3, 10]` against the prepared `[2, 3]` — so
 * the host reads the enabled set back, turns off what the expectation does not name, and re-reads,
 * a bounded number of times. Nothing is ever enabled here: the import is the only step that turns
 * filters on, and the protocol has no enable counterpart at all.
 *
 * A custom filter the import installed is the one case an expectation cannot name by ID: the build
 * allocates the ID at import (`adguard-custom-filters.ts`). The expectation names it by the title
 * it gave the import entry instead, and an enabled custom filter with no expected title is a stray
 * turned off like any other.
 */
import type { Page } from 'playwright-core';
import { isCustomFilterId, type EnabledCustomFilter } from '../browser/adguard-custom-filters';
import { AdGuardExtensionMessageType } from '../browser/adguard-extension-message-types';
import {
    normalizeReadFilterIds,
    waitForOptionsData,
} from '../browser/adguard-extension-state-read';
import { sendExtensionMessage } from '../browser/adguard-extension-state-transport';
import type { Logger } from '../logger/logger';

/**
 * How many times the host may turn unexpected filters off and re-read the enabled set.
 *
 * Why this value: a successful `applySettingsJson` is not proof of the expected set — the extension
 * re-enables some filters from settings of its own after an import: a read-back of the prepared
 * `[2, 3]` can show `[2, 3, 10]`. One more read-and-disable pass settles that; three bounds a build
 * that keeps re-enabling from looping forever, and is the count the built-in instruction document
 * specifies.
 */
const FILTER_RECONCILIATION_ROUNDS = 3;

/**
 * What the enabled-filter reconciliation observed.
 */
export interface FilterReconciliation {
    /**
     * How many read-and-disable rounds ran; zero when the import already landed on exactly the
     * expected set.
     */
    rounds: number;

    /**
     * Filter IDs the host turned off, ascending and distinct.
     */
    disabledFilterIds: number[];

    /**
     * Filter IDs still enabled outside the expected set when the rounds ran out; empty when the
     * enabled set converged.
     */
    unexpectedFilterIds: number[];

    /**
     * The enabled custom filters the expectation named by title, as the last read listed them.
     */
    keptCustomFilters: EnabledCustomFilter[];
}

/**
 * One read of the extension's enabled filter set during reconciliation.
 */
interface ObservedEnabledFilters {
    /**
     * Every filter the extension reports enabled, ascending and distinct.
     */
    enabled: number[];

    /**
     * The subset of those the prepared expectation names neither by ID nor by custom title.
     */
    unexpected: number[];

    /**
     * The enabled custom filters the expectation names by title.
     */
    keptCustom: EnabledCustomFilter[];
}

/**
 * Read the enabled filter set and turn off everything outside the prepared expectation.
 *
 * @param page - The dedicated surface page the messages are sent from.
 * @param expectedFilterIds - Exact official filter IDs the prepared expectation names.
 * @param expectedCustomFilterTitles - Titles of the custom filters the expectation keeps.
 * @param readinessDeadlineAt - Absolute deadline shared with every other read of this application.
 * @param logger - Run logger receiving each round.
 * @param signal - Caller cancellation, checked between rounds.
 * @returns What the reconciliation observed: rounds run, filters disabled, filters still
 *   unexpected, custom filters kept.
 * @throws When an options read or a disable message fails, or the deadline aborts between rounds.
 */
export async function reconcileEnabledFilters(
    page: Page,
    expectedFilterIds: readonly number[],
    expectedCustomFilterTitles: readonly string[],
    readinessDeadlineAt: number,
    logger: Logger,
    signal: AbortSignal | undefined,
): Promise<FilterReconciliation> {
    const expected = new Set(expectedFilterIds);
    const expectedTitles = new Set(expectedCustomFilterTitles);
    const disabled = new Set<number>();

    /**
     * Read the options metadata and name the enabled filters the expectation does not.
     *
     * @returns The enabled set, the unexpected subset of it and the custom filters kept by title.
     */
    const readUnexpected = async (): Promise<ObservedEnabledFilters> => {
        const optionsData = await waitForOptionsData(page, readinessDeadlineAt);
        const enabledFilters = optionsData.filtersMetadata.filters.filter(
            (filter) => filter.enabled,
        );
        const keptCustom = enabledFilters.flatMap((filter) =>
            isCustomFilterId(filter.filterId) &&
            filter.name !== undefined &&
            expectedTitles.has(filter.name)
                ? [{ filterId: filter.filterId, name: filter.name }]
                : [],
        );
        const kept = new Set(keptCustom.map((filter) => filter.filterId));
        const enabled = normalizeReadFilterIds(enabledFilters.map((filter) => filter.filterId));
        return {
            enabled,
            unexpected: enabled.filter(
                (filterId) => !expected.has(filterId) && !kept.has(filterId),
            ),
            keptCustom,
        };
    };

    let observed = await readUnexpected();
    let rounds = 0;
    while (observed.unexpected.length > 0 && rounds < FILTER_RECONCILIATION_ROUNDS) {
        if (signal?.aborted ?? false) {
            throw new Error('the phase deadline aborted between two reconciliation rounds');
        }
        rounds += 1;
        logger.warn(
            {
                round: rounds,
                expectedFilterIds: [...expected],
                expectedCustomFilterTitles: [...expectedTitles],
                enabledFilterIds: observed.enabled,
                unexpectedFilterIds: observed.unexpected,
                keptCustomFilters: observed.keptCustom,
            },
            'the import left filters enabled the prepared expectation does not name; turning them off',
        );
        for (const filterId of observed.unexpected) {
            await sendExtensionMessage(page, {
                type: AdGuardExtensionMessageType.DisableFilter,
                data: { filterId },
            });
            disabled.add(filterId);
        }
        observed = await readUnexpected();
    }
    const disabledFilterIds = normalizeReadFilterIds([...disabled]);
    if (observed.unexpected.length === 0) {
        logger.info(
            {
                rounds,
                disabledFilterIds,
                enabledFilterIds: observed.enabled,
                keptCustomFilters: observed.keptCustom,
            },
            'the enabled filter set matches the prepared expectation',
        );
    } else {
        logger.error(
            {
                rounds,
                disabledFilterIds,
                expectedFilterIds: [...expected],
                expectedCustomFilterTitles: [...expectedTitles],
                enabledFilterIds: observed.enabled,
                unexpectedFilterIds: observed.unexpected,
                keptCustomFilters: observed.keptCustom,
            },
            'the enabled filter set did not converge within the reconciliation rounds',
        );
    }
    return {
        rounds,
        disabledFilterIds,
        unexpectedFilterIds: observed.unexpected,
        keptCustomFilters: observed.keptCustom,
    };
}
