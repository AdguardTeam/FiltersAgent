/**
 * How a run records that its executor reproduced the reporter's filter selection only
 * approximately. Without these records the run report would silently imply the reporter's exact
 * configuration was executed when the extension build's catalog, or the CLI's, could not offer
 * every filter the reporter had enabled.
 */
import { EnvironmentSelectionReservedCase } from '../environment/environment-vocabulary';
import { FidelityLimitationCode } from '../environment/environment-selection-contract';
import { type EnvironmentSelectionHost } from '../environment/environment-selection';
import { BrowserExtensionExecutorName } from '../environment/executor-name';
import type { MissingCatalogFilterClassification } from '../environment/third-party-filter-catalog';
import type { EvidenceRouteSnapshot } from '../local/evidence-route-contract';
import type { UnfilteredHost } from '../environment/applied-rules';
import type { Logger } from '../logger/logger';

/**
 * The official Base filter (ID 2) every CLI evidence route enables, listed first among the
 * reproduced filters because the route's snapshot names it by a flag rather than by id.
 */
const BASE_FILTER_ID = 2;

/**
 * Publish how closely the extension route reproduced the reporter's filter selection.
 *
 * @param environmentHost - The run's environment-selection host the record lands in.
 * @param conflicts - Requested filters dropped from the expected set during the degraded import.
 */
export function recordExtensionFilterFidelity(
    environmentHost: EnvironmentSelectionHost,
    conflicts: readonly MissingCatalogFilterClassification[],
): void {
    const detail = conflicts
        .map((conflict) =>
            conflict.name === undefined
                ? String(conflict.filterId)
                : `${conflict.filterId} (${conflict.name})`,
        )
        .join(', ');
    try {
        environmentHost.recordFilterSelectionApproximation(
            BrowserExtensionExecutorName,
            'The installed extension build catalog does not list every filter the reporter ' +
                `had enabled. Skipped during import: ${detail}.`,
        );
    } catch {
        // A lock that moved on is not worth failing a live session over.
    }
}

/**
 * Publish that the reporter's filter set exceeded the executing browser's MV3 limits, so the run
 * executed it only in part and its terminal evidence comes from a smaller selection.
 *
 * @param environmentHost - The run's environment-selection host the record lands in.
 * @param detail - The Baseline credit's own diagnosis, naming the requested count, the filters kept
 *   and the limit counters.
 * @param logger - The run's logger, so a refused record is visible instead of silent.
 */
export function recordMv3LimitsFidelity(
    environmentHost: EnvironmentSelectionHost,
    detail: string,
    logger: Logger,
): void {
    try {
        environmentHost.recordFilterSelectionApproximation(
            BrowserExtensionExecutorName,
            "The reporter's filter set does not fit Chrome's MV3 limits, so the run executed a " +
                `smaller selection. ${detail}`,
            FidelityLimitationCode.Mv3LimitsApproximation,
        );
    } catch (error) {
        // A lock that moved on is not worth failing a live session over, but a swallowed refusal
        // is a fidelity record the report will not carry, so it says so in the run log.
        logger.warn(
            { err: error, detail },
            'the MV3-limits fidelity record was refused by the environment-selection host',
        );
    }
}

/**
 * Publish how closely the activated evidence route reproduced the reporter's filter selection.
 *
 * @param environmentHost - The run's environment-selection host the record lands in.
 * @param snapshot - The evidence route's own snapshot, when a route is active.
 */
export function recordEvidenceRouteFilterFidelity(
    environmentHost: EnvironmentSelectionHost,
    snapshot: EvidenceRouteSnapshot | undefined,
): void {
    const kind = environmentHost.snapshot()?.selectedKind;
    if (
        !snapshot ||
        snapshot.unavailableFilterIds.length === 0 ||
        !kind ||
        kind === EnvironmentSelectionReservedCase.UnsupportedProductCase
    ) {
        return;
    }
    try {
        environmentHost.recordFilterSelectionApproximation(
            kind,
            `The executor's catalog did not offer every filter the reporter had enabled. ` +
                `Reproduced official filters: ${[BASE_FILTER_ID, ...snapshot.reproducedFilterIds].join(', ')}. ` +
                `Unavailable: ${snapshot.unavailableFilterIds.join(', ')}.`,
        );
    } catch {
        // A lock that moved on is not worth failing a live session over.
    }
}

/**
 * Publish that the executor passed hosts through without reading their content.
 *
 * Without the record a report shows a cosmetic candidate as applied and not working, as for a
 * learning.ua report, where the AdGuard CLI had stopped decrypting the site.
 *
 * @param environmentHost - The run's environment-selection host the record lands in.
 * @param hosts - The unfiltered hosts and the engine's reasons.
 * @param logger - The run's logger, so a refused record is visible instead of silent.
 */
export function recordUnfilteredHostsFidelity(
    environmentHost: EnvironmentSelectionHost,
    hosts: readonly UnfilteredHost[],
    logger: Logger,
): void {
    const kind = environmentHost.snapshot()?.selectedKind;
    if (
        hosts.length === 0 ||
        !kind ||
        kind === EnvironmentSelectionReservedCase.UnsupportedProductCase
    ) {
        return;
    }
    try {
        environmentHost.recordFilterSelectionApproximation(
            kind,
            'The filtering engine passed these hosts through without reading their content, so ' +
                'no element-hiding, script or HTML rule could act on their pages: ' +
                `${hosts.map((entry) => `${entry.host} (${entry.reason})`).join(', ')}.`,
            FidelityLimitationCode.ContentNotFiltered,
        );
    } catch (error) {
        logger.warn(
            { err: error, hosts },
            'the unfiltered-hosts fidelity record was refused by the environment-selection host',
        );
    }
}
