/**
 * The report's "place in the list" reading: the file an accepted rule goes into and, when the host
 * planned one, the place inside it.
 *
 * The run plans the exact edit — the domain list it extends, the sorted position, the site's own
 * block, the end of a section — so the comment names that place, not the file alone: a bare
 * "easylist/easylist_specific_hide.txt" for a rule the run placed between two specific lines of an
 * 8,800-rule sorted list leaves exactly that part for a maintainer to redo by hand. The place is a
 * permalink to the line at the commit the run analyzed, not a quote of the rule on it: that line
 * does not drift however the list moves on, and a neighbouring rule quoted whole can be a wall of
 * hundreds of domains with its selector at the far end.
 */
import { GitHubFileView, gitHubFileUrl } from '../github/github-file-url';
import type { CandidatePatch } from '../types/fix-run-result';
import { PlacementBasis } from '../types/placement-basis';
import { RepositoryEditKind } from '../types/repository-edit-kind';
import type { RepositorySlug } from '../types/repository-slug';
import { renderUntrustedRuleCodeSpan } from './untrusted-text';

/**
 * The analyzed revision of the repository the lists come from: what a list permalink points at.
 */
export interface ReportListSource {
    /**
     * The repository the run read the lists from.
     */
    repository: RepositorySlug;

    /**
     * The full commit the run analyzed the lists at.
     */
    commit: string;
}

/**
 * The host-planned edit recorded on a candidate patch, which names the place inside the file.
 */
export type ReportRepositoryEdit = NonNullable<CandidatePatch['repositoryEdit']>;

/**
 * Build the permalink to a file, or to one of its lines, at the analyzed commit.
 *
 * @param source - The analyzed repository revision.
 * @param filePath - Checkout-relative file.
 * @param line - One-based line to point at, or undefined for the file itself.
 * @returns The GitHub blob URL.
 */
function listFileUrl(source: ReportListSource, filePath: string, line?: number): string {
    const { owner, repo } = source.repository;
    return gitHubFileUrl(
        GitHubFileView.Blob,
        { repository: `${owner}/${repo}`, commit: source.commit, filePath },
        line === undefined ? undefined : `L${line}`,
    );
}

/**
 * Say where inside the file the planned edit lands, or nothing when the plan names no place.
 *
 * @param edit - The host-planned edit recorded on the candidate patch.
 * @param lineLink - Renders the link to one line of the file.
 * @returns One sentence, or the empty string.
 */
function placeInsideFile(edit: ReportRepositoryEdit, lineLink: (line: number) => string): string {
    if (edit.kind === RepositoryEditKind.ExtendDomains) {
        return `By adding the domain to the existing rule on ${lineLink(edit.line)}.`;
    }
    if (edit.kind !== RepositoryEditKind.Insert) {
        return '';
    }
    // The planner records the anchor only when the insertion point is an existing line; past the
    // end of the file there is no line to precede.
    const before =
        edit.anchorRule === undefined || edit.insertionPoint === undefined
            ? ''
            : `, before ${lineLink(edit.insertionPoint + 1)}`;
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
 * Compose the "place in the list" fill: the file, and the place inside it when one was planned,
 * each linked at the analyzed commit.
 *
 * @param filePath - Checkout-relative file the rule lands in, or undefined without a patch.
 * @param source - The repository revision the run analyzed the lists at.
 * @param edit - The host-planned edit recorded on the candidate patch, when there is one.
 * @returns The fill text; empty without a patch.
 */
export function composeListPlace(
    filePath: string | undefined,
    source: ReportListSource,
    edit?: ReportRepositoryEdit,
): string {
    if (filePath === undefined || filePath === '') {
        return '';
    }
    const file = `[${filePath}](${listFileUrl(source, filePath)})`;
    const place =
        edit === undefined
            ? ''
            : placeInsideFile(
                  edit,
                  (line) => `[line ${line}](${listFileUrl(source, filePath, line)})`,
              );
    return place === '' ? file : `${file}\n\n${place}`;
}
