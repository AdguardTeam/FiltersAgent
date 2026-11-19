/**
 * The report's "place in the list" reading: the file an accepted rule goes into and, when the run
 * planned one, the place inside it.
 *
 * The run records the exact edit — the domain list it extends, the line the agent chose under its
 * heading, the sorted position, the end of the file with the agent's reason — so the comment names
 * that place, not the file alone: a bare "easylist/easylist_specific_hide.txt" for a rule the run
 * placed between two specific lines of an 8,800-rule sorted list leaves exactly that part for a
 * maintainer to redo by hand. The place is a permalink to the line at the commit the run analyzed,
 * not a quote of the rule on it: that line does not drift however the list moves on, and a
 * neighbouring rule quoted whole can be a wall of hundreds of domains with its selector at the far
 * end.
 */
import { GitHubFileView, gitHubFileUrl } from '../github/github-file-url';
import type { InsertRepositoryEdit } from '../types/repository-edit';
import type { CandidatePatch } from '../types/fix-run-result';
import { PlacementBasis } from '../types/placement-basis';
import { RepositoryEditKind } from '../types/repository-edit-kind';
import type { RepositorySlug } from '../types/repository-slug';
import { renderUntrustedRuleCodeSpan, renderUntrustedText } from './untrusted-text';

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
 * End one sentence without doubling terminal punctuation the text already carries.
 *
 * The end-of-file sentence ends however the agent's reason ends, so the renderer supplies the
 * period itself and leaves a reason that already ends a sentence as written.
 *
 * @param text - The sentence without its closing punctuation.
 * @returns The sentence with one terminal mark.
 */
function fullStop(text: string): string {
    const end = text.trimEnd();
    return /[.!?]$/u.test(end) ? end : `${end}.`;
}

/**
 * The clause naming the line the rule lands before, when the edit records one.
 *
 * A sorted insert after the last rule and an append have no line to precede, so the clause stays
 * out of the sentence rather than pointing at a line the file does not hold.
 *
 * @param edit - The insert edit recorded on the candidate patch.
 * @param lineLink - Renders the link to one line of the file.
 * @returns The clause, or undefined when the edit precedes no line.
 */
function beforeClause(
    edit: InsertRepositoryEdit,
    lineLink: (line: number) => string,
): string | undefined {
    if (edit.insertionPoint === undefined || edit.anchorRule === undefined) {
        return undefined;
    }
    return `before ${lineLink(edit.insertionPoint + 1)}`;
}

/**
 * The clauses naming where an insert lands, in reading order.
 *
 * One builder serves a place with and without a heading, so the heading, the platform condition and
 * the line the rule lands before are read the same way whatever basis the edit records.
 *
 * @param place - The basis's own place wording, or undefined when the line alone names it.
 * @param edit - The insert edit recorded on the candidate patch.
 * @param lineLink - Renders the link to one line of the file.
 * @returns The clauses of the sentence, empty when the edit names no place.
 */
function insertClauses(
    place: string | undefined,
    edit: InsertRepositoryEdit,
    lineLink: (line: number) => string,
): string[] {
    // `section` is the legacy name earlier builds wrote; a locked result still parses with it and
    // renders exactly like a heading new runs write.
    const heading = edit.heading ?? edit.section;
    const clauses: string[] = [];
    if (heading !== undefined) {
        clauses.push(`under the heading ${renderUntrustedRuleCodeSpan(heading)}`);
    }
    if (edit.condition !== undefined) {
        clauses.push(`inside the condition ${renderUntrustedRuleCodeSpan(edit.condition)}`);
    }
    if (place !== undefined) {
        clauses.push(place);
    }
    const before = beforeClause(edit, lineLink);
    if (before !== undefined) {
        clauses.push(before);
    }
    return clauses;
}

/**
 * Join the clauses into one sentence, or nothing when they name no place.
 *
 * @param clauses - The clauses of the sentence, in reading order.
 * @returns The sentence, capitalized and ending with a period, or the empty string.
 */
function sentence(clauses: readonly string[]): string {
    const first = clauses[0];
    if (first === undefined) {
        return '';
    }
    const rest = clauses.slice(1);
    const text = [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(', ');
    return `${text}.`;
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
    switch (edit.basis) {
        case PlacementBasis.ChosenLine:
            if (edit.insertionPoint === undefined) {
                return '';
            }
            return sentence(insertClauses(undefined, edit, lineLink));
        case PlacementBasis.SortedPosition:
            return sentence(
                insertClauses('at its sorted position among the existing rules', edit, lineLink),
            );
        case PlacementBasis.DomainBlock:
            return sentence(insertClauses("next to the site's existing rules", edit, lineLink));
        case PlacementBasis.TerminalSection:
            return sentence(
                insertClauses("at the end of the file's regular rules", edit, lineLink),
            );
        case PlacementBasis.AppendEof:
            if (edit.reason !== undefined) {
                return fullStop(`At the end of the file: ${renderUntrustedText(edit.reason)}`);
            }
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
