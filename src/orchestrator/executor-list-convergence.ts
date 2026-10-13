import { EnvironmentSelectionReservedCase } from '../environment/environment-vocabulary';
import { EnvironmentSelectionHost } from '../environment/environment-selection';
import type { FilterListRef } from '../environment/filter-list-ref';
import {
    EnvironmentAdapterLimitationCode,
    EnvironmentLimitationStage,
    type EnvironmentAdapterLimitation,
} from '../environment/filtering-environment';
import { requestedListsForExecutor } from '../environment/list-catalog';
import { adapterLimitation } from '../environment/phase-lease-registry';
import type { MissingCatalogFilterClassification } from '../environment/third-party-filter-catalog';
import { createLogger, type Logger } from '../logger/logger';

/**
 * Conflicts named one by one in a public detail before the rest collapses into a count.
 *
 * Both sinks are bounded: `PublicDetailSchema` caps an adapter limitation detail at 500 characters
 * and `FidelityLimitationSchema` caps a fidelity detail at 1000, and the fidelity record is parsed
 * rather than truncated — an over-long detail throws and the record is lost instead of published. A
 * reporter running a dozen custom subscriptions would reach either bound, while six named ids still
 * fit both with the surrounding sentence and still show the reader what kind of lists were left
 * out.
 */
const MAX_NAMED_CONFLICTS = 6;

/**
 * The executor request the runtime builds from the run's requested filter ids.
 */
export interface ExecutorListConvergence {
    /**
     * The lists the preparation request carries: one official ref per requested id the AdGuard
     * catalog publishes, in evidence order. Empty when the request itself was empty, and empty
     * whenever `limitation` is set.
     */
    lists: readonly FilterListRef[];

    /**
     * The preparation-stage refusal raised when the run asked for filters and none of them
     * converged, or null when preparation proceeds.
     */
    limitation: EnvironmentAdapterLimitation | null;
}

/**
 * Render one classified conflict as `id (name)`, or as the bare id the registry cannot name.
 *
 * @param conflict - The classified requested id.
 * @returns The single-conflict phrase.
 */
function describeConflict(conflict: MissingCatalogFilterClassification): string {
    return conflict.name === undefined
        ? String(conflict.filterId)
        : `${conflict.filterId} (${conflict.name})`;
}

/**
 * Render the classified conflicts as one bounded comma-separated phrase.
 *
 * @param conflicts - The classified requested ids, in evidence order.
 * @returns The phrase, with everything past `MAX_NAMED_CONFLICTS` summarized as a count.
 */
function describeConflicts(conflicts: readonly MissingCatalogFilterClassification[]): string {
    const named = conflicts.slice(0, MAX_NAMED_CONFLICTS).map(describeConflict).join(', ');
    const remaining = conflicts.length - MAX_NAMED_CONFLICTS;
    return remaining > 0 ? `${named} and ${remaining} more` : named;
}

/**
 * Publish how closely the executed baseline reproduces the reporter's own filter selection.
 *
 * This is the run's one filter-fidelity sink — the same `recordFilterSelectionApproximation` the
 * browser-extension launch degradation and the evidence route already report through, so the
 * dropped filters reach the run report's fidelity limitations instead of a second private record.
 * The lock names the executor, so the record is skipped when no executor is locked: an
 * approximation naming a different environment than the locked one is refused by the host.
 *
 * @param environmentHost - The run's environment-selection host holding the lock.
 * @param conflicts - The requested ids left out of the executed baseline.
 * @param logger - The run's logger, so a refused record is visible instead of silent.
 */
function recordConvergenceFidelity(
    environmentHost: EnvironmentSelectionHost,
    conflicts: readonly MissingCatalogFilterClassification[],
    logger: Logger,
): void {
    const kind = environmentHost.snapshot()?.selectedKind;
    if (!kind || kind === EnvironmentSelectionReservedCase.UnsupportedProductCase) {
        return;
    }
    try {
        environmentHost.recordFilterSelectionApproximation(
            kind,
            'The AdGuard filter catalog does not publish every filter the reporter had enabled. ' +
                `Left out of the executed baseline: ${describeConflicts(conflicts)}.`,
        );
    } catch (error) {
        // A lock that moved on is not worth failing a live session over, but a swallowed refusal
        // here is a fidelity record the report will not carry, so it says so in the run log.
        logger.warn(
            { kind, conflicts: [...conflicts], error },
            'the filter-selection approximation was refused by the environment lock',
        );
    }
}

/**
 * Build the executor's preparation request from the filter ids the reporter had enabled.
 *
 * The requested set converges onto the ids the AdGuard catalog publishes rather than failing on the
 * first one it does not, exactly as the browser-extension launch converges onto the installed build
 * catalog: the ids left behind are classified against the third-party registry and recorded as the
 * run's filter-selection approximation, and the narrower baseline is what the executor prepares, so
 * every downstream record — phase proofs, the report's executed baseline — names what really ran.
 * Failing instead would end a run `capability_limited` before `apply_rule` on nothing worse than a
 * reporter-enabled third-party list such as 207 (Adblock Warning Removal List).
 *
 * Asking for filters and converging on none is still a refusal: a baseline with no list to execute
 * measures nothing, so the run says so instead of silently proving a rule against an empty filter
 * set. An empty request is not that case — an instruction-declared launch requests no official list
 * at all, because its own declaration is the baseline — so it passes through untouched.
 *
 * @param input - The requested ids and the run seams the record and the log line reach.
 * @param input.requestedFilterIds - The run's executing official filter ids, in evidence order.
 * @param input.environmentHost - The environment-selection host the approximation is recorded on.
 * @param input.verbose - Whether verbose lifecycle logging is enabled.
 * @returns The lists to prepare, or the refusal when nothing converged.
 */
function convergeReportedFilterIds(input: {
    /**
     * The run's executing official filter ids, in evidence order.
     */
    requestedFilterIds: readonly number[];

    /**
     * The environment-selection host the filter-selection approximation is recorded on.
     */
    environmentHost: EnvironmentSelectionHost;

    /**
     * Whether verbose lifecycle logging is enabled.
     */
    verbose: boolean;
}): ExecutorListConvergence {
    const projection = requestedListsForExecutor(input.requestedFilterIds);
    if (projection.conflicts.length === 0) {
        return { lists: projection.convergentLists, limitation: null };
    }
    const logger = createLogger({ verbose: input.verbose });
    const requestedFilterIds = [...input.requestedFilterIds];
    const conflicts = [...projection.conflicts];
    if (projection.convergentLists.length === 0) {
        logger.error(
            { conflicts, requestedFilterIds },
            'the requested filter set has no convergent subset in the AdGuard filter catalog',
        );
        return {
            lists: [],
            limitation: adapterLimitation(
                EnvironmentAdapterLimitationCode.BaselineManifestInvalid,
                EnvironmentLimitationStage.Preparation,
                `No requested filter converged on the AdGuard filter catalog. Requested: ` +
                    `${requestedFilterIds.join(', ')}. Absent: ${describeConflicts(conflicts)}.`,
            ),
        };
    }
    logger.warn(
        {
            conflicts,
            requestedFilterIds,
            convergentListKeys: projection.convergentLists.map((list) => list.key),
        },
        'the requested filter set degraded onto the AdGuard filter catalog subset',
    );
    recordConvergenceFidelity(input.environmentHost, conflicts, logger);
    return { lists: projection.convergentLists, limitation: null };
}

/**
 * Build the executor's preparation request from the run's filter ids.
 *
 * Two kinds of id reach this seam, and only one of them can be approximated. Ids the reporter had
 * enabled are a wish: an executor that builds its baseline from the AdGuard catalog runs the part
 * of them the catalog publishes, and the rest is recorded as the run's filter-selection
 * approximation. Ids a launched blocker reported back are a fact: every one of them is already
 * running, the launch has already recorded whatever the installed build could not activate, and the
 * adapter locks and replays the whole observed set from its own read-back. The request names the
 * pinned official part of that set because a list reference exists for nothing else — and nothing
 * is recorded, since a report saying a running ruleset was left out of the executed baseline would
 * state the opposite of what ran. Treating an observed set as a wish does exactly that, and the
 * narrowed request then fails the Extension adapter's exact-set check: every run whose reporter
 * import activates a build-shipped third-party ruleset (216, 238, 252) ends `capability_limited` at
 * `apply_rule`.
 *
 * @param input - The run's filter ids and the seams the record and the log line reach.
 * @param input.observedFilterIds - The enabled ids the launched blocker reported back, or undefined
 *   when the run's executor launches no blocker of its own.
 * @param input.reportedFilterIds - The ids the reporter had enabled, used when nothing was
 *   observed.
 * @param input.environmentHost - The environment-selection host an approximation is recorded on.
 * @param input.verbose - Whether verbose lifecycle logging is enabled.
 * @returns The lists to prepare, or the refusal when a reported request converged on nothing.
 */
export function executorRequestedLists(input: {
    /**
     * The enabled ids the launched blocker reported back, or undefined when the run's executor
     * launches no blocker of its own.
     */
    observedFilterIds: readonly number[] | undefined;

    /**
     * The ids the reporter had enabled, used when nothing was observed.
     */
    reportedFilterIds: readonly number[];

    /**
     * The environment-selection host an approximation is recorded on.
     */
    environmentHost: EnvironmentSelectionHost;

    /**
     * Whether verbose lifecycle logging is enabled.
     */
    verbose: boolean;
}): ExecutorListConvergence {
    if (input.observedFilterIds !== undefined) {
        const projection = requestedListsForExecutor(input.observedFilterIds);
        if (projection.conflicts.length > 0) {
            createLogger({ verbose: input.verbose }).info(
                {
                    observedFilterIds: [...input.observedFilterIds],
                    outsidePinnedCatalog: projection.conflicts.map((conflict) => conflict.filterId),
                    requestedListKeys: projection.convergentLists.map((list) => list.key),
                },
                'the observed blocker set runs lists outside the pinned catalog; the request ' +
                    'names the official part and the adapter prepares the whole observed set',
            );
        }
        return { lists: projection.convergentLists, limitation: null };
    }
    return convergeReportedFilterIds({
        requestedFilterIds: input.reportedFilterIds,
        environmentHost: input.environmentHost,
        verbose: input.verbose,
    });
}
