/**
 * The report's "place in the list" reading: the file an accepted rule goes into and, when the host
 * planned one, the place inside it.
 *
 * The run plans the exact edit — the domain list it extends, the sorted position, the site's own
 * block, the end of a section — so the comment names that place, not the file alone: a bare
 * "easylist/easylist_specific_hide.txt" for a rule the run placed between two specific lines of an
 * 8,800-rule sorted list leaves exactly that part for a maintainer to redo by hand. The position is
 * named by the rule it precedes, never by a line number: a line number drifts between the run and
 * the moment someone reads the comment, the neighbouring rule does not.
 */
import { PlacementBasis } from '../types/placement-basis';
import { RepositoryEditKind } from '../types/repository-edit-kind';
import { renderUntrustedRuleCodeSpan } from './untrusted-text';

/**
 * The host-planned edit fields the report reads, kept narrow so publisher tests pass plain shapes.
 */
export interface ReportRepositoryEdit {
    /**
     * Edit discriminator (`insert`, `extend_domains`, …).
     */
    kind: string;

    /**
     * Why an insert sits where it does (`sorted_position`, `domain_block`, …).
     */
    basis?: string;

    /**
     * Exact repository line an anchored insert precedes.
     */
    anchorRule?: string;

    /**
     * Comment line a declared placement writes above the rule.
     */
    precedingComment?: string;

    /**
     * The existing rule a domain extension rewrites.
     */
    originalRule?: string;
}

/**
 * Say where inside the file the planned edit lands, or nothing when the plan names no place.
 *
 * @param edit - The host-planned edit recorded on the candidate patch.
 * @returns One sentence, or the empty string.
 */
function placeInsideFile(edit: ReportRepositoryEdit): string {
    const before =
        edit.anchorRule === undefined
            ? ''
            : `, before ${renderUntrustedRuleCodeSpan(edit.anchorRule)}`;
    if (edit.kind === RepositoryEditKind.ExtendDomains) {
        return edit.originalRule === undefined
            ? 'By adding the domain to an existing rule there.'
            : `By adding the domain to the existing rule ${renderUntrustedRuleCodeSpan(edit.originalRule)}.`;
    }
    if (edit.kind !== RepositoryEditKind.Insert) {
        return '';
    }
    switch (edit.basis) {
        case PlacementBasis.SortedPosition:
            return `At its sorted position among the existing rules${before}.`;
        case PlacementBasis.DomainBlock:
            return `Next to the site's existing rules${before}.`;
        case PlacementBasis.TerminalSection:
            return `At the end of the file's regular rules${before}.`;
        case PlacementBasis.AppendEof:
            return edit.precedingComment === undefined
                ? 'At the end of the file.'
                : `At the end of the file, behind the comment line ${renderUntrustedRuleCodeSpan(edit.precedingComment)}.`;
        default:
            return '';
    }
}

/**
 * Compose the "place in the list" fill: the file, and the place inside it when one was planned.
 *
 * @param filePath - Checkout-relative file the rule lands in, or undefined without a patch.
 * @param edit - The host-planned edit recorded on the candidate patch, when there is one.
 * @returns The fill text; empty without a patch.
 */
export function composeListPlace(
    filePath: string | undefined,
    edit?: ReportRepositoryEdit,
): string {
    if (filePath === undefined || filePath === '') {
        return '';
    }
    const place = edit === undefined ? '' : placeInsideFile(edit);
    return place === '' ? filePath : `${filePath}\n\n${place}`;
}
