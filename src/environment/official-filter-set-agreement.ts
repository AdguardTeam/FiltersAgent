import { officialAdguardListRef } from './filter-list-ref';

/**
 * Registry ids named one by one in a public disagreement detail before the rest becomes a count.
 *
 * The detail travels in an adapter limitation, which `PublicDetailSchema` caps at 500 characters.
 * Eight ids on each side fit that bound with the surrounding sentences, and a disagreement wider
 * than that is a wholly different filter selection, where the count says as much as the ids would.
 */
const MAX_NAMED_DISAGREEING_IDS = 8;

/**
 * Order registry ids numerically, the order every settings proof carries them in.
 *
 * @param left - First registry id.
 * @param right - Second registry id.
 * @returns A negative number when `left` sorts first.
 */
function ascending(left: number, right: number): number {
    return left - right;
}

/**
 * How the pinned official part of an observed enabled set departs from a requested set.
 */
export interface OfficialFilterSetDisagreement {
    /**
     * Requested official filter ids the blocker did not report enabled.
     */
    missing: readonly number[];

    /**
     * Pinned official filter ids the blocker reported enabled although the request never named
     * them.
     */
    unrequested: readonly number[];
}

/**
 * Compare a requested official filter set with the pinned official part of an observed one.
 *
 * A preparation request speaks list references, and a reference exists only for a pinned official
 * list, so the request can never name a third-party ruleset the installed build ships and a
 * reporter import activates (216, 238, 252). Comparing it with the whole observed set therefore
 * refused every run whose blocker had one of those enabled: two scheduled passes lost eight live
 * investigations at `apply_rule` to exactly that. The comparison is made like with like — the
 * observed set is projected through `officialAdguardListRef`, the same function the request was
 * built with — while the baseline lock and the phase sessions keep covering every list the blocker
 * activated.
 *
 * @param requestedFilterIds - The pinned official filter ids the preparation request named.
 * @param enabledFilterIds - Every filter id the blocker reported enabled.
 * @returns The disagreement, or null when the pinned official sets agree exactly.
 */
export function officialFilterSetDisagreement(
    requestedFilterIds: readonly number[],
    enabledFilterIds: readonly number[],
): OfficialFilterSetDisagreement | null {
    const requested = new Set(requestedFilterIds);
    const enabled = new Set(enabledFilterIds);
    const missing = [...requested].filter((filterId) => !enabled.has(filterId)).sort(ascending);
    const unrequested = [...enabled]
        .filter((filterId) => !requested.has(filterId) && officialAdguardListRef(filterId) !== null)
        .sort(ascending);
    return missing.length === 0 && unrequested.length === 0 ? null : { missing, unrequested };
}

/**
 * Render one side of a disagreement as a bounded comma-separated id list.
 *
 * @param filterIds - The disagreeing registry ids, ascending.
 * @returns The ids, with everything past `MAX_NAMED_DISAGREEING_IDS` summarized as a count.
 */
function describeFilterIds(filterIds: readonly number[]): string {
    const named = filterIds.slice(0, MAX_NAMED_DISAGREEING_IDS).join(', ');
    const remaining = filterIds.length - MAX_NAMED_DISAGREEING_IDS;
    return remaining > 0 ? `${named} and ${remaining} more` : named;
}

/**
 * Render a disagreement as the public detail of a settings-mismatch limitation.
 *
 * The ids are tokens of the pinned public catalog, so naming them is safe, and a refusal that names
 * them is diagnosable from the report alone instead of from the run's evidence archive.
 *
 * @param disagreement - The disagreement between the requested and the observed official sets.
 * @returns The bounded public detail.
 */
export function describeOfficialFilterSetDisagreement(
    disagreement: OfficialFilterSetDisagreement,
): string {
    const sentences = ['The Extension did not activate exactly the requested official filters.'];
    if (disagreement.missing.length > 0) {
        sentences.push(`Requested but not enabled: ${describeFilterIds(disagreement.missing)}.`);
    }
    if (disagreement.unrequested.length > 0) {
        sentences.push(
            `Enabled but not requested: ${describeFilterIds(disagreement.unrequested)}.`,
        );
    }
    return sentences.join(' ');
}
