import { describe, expect, it } from 'vitest';
import { composeListPlace, type ReportListSource } from '../../src/publisher/report-list-place';
import { PlacementBasis } from '../../src/types/placement-basis';
import { RepositoryEditKind } from '../../src/types/repository-edit-kind';

const FILE = 'easylist/easylist_specific_hide.txt';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';

const SOURCE: ReportListSource = {
    repository: { owner: 'example-owner', repo: 'example-repo' },
    commit: COMMIT,
};

const FILE_URL = `https://github.com/example-owner/example-repo/blob/${COMMIT}/${FILE}`;

/**
 * The Markdown link targets in the fill, in order.
 *
 * @param markdown - Rendered fill.
 * @returns Every `](target)` of a Markdown link.
 */
function linkTargets(markdown: string): string[] {
    return [...markdown.matchAll(/\]\(([^)\s]+)\)/gu)].map((match) => match[1]);
}

describe('composeListPlace', () => {
    it('links the file at the analyzed commit when the run planned no place inside it', () => {
        expect(linkTargets(composeListPlace(FILE, SOURCE))).toEqual([FILE_URL]);
        expect(composeListPlace(undefined, SOURCE)).toBe('');
    });

    it('links the line an insert precedes at the analyzed commit instead of quoting it', () => {
        // A long neighbouring rule quoted whole is a wall of domains with its selector at the far
        // end; the line at the analyzed commit is where the maintainer puts the rule, and it does
        // not move.
        const domains = Array.from({ length: 80 }, (_, index) => `site-${index}.example`);
        const anchorRule = `${domains.join(',')}##.ad`;

        const place = composeListPlace(FILE, SOURCE, {
            kind: RepositoryEditKind.Insert,
            insertionPoint: 83,
            anchorRule,
            basis: PlacementBasis.DomainBlock,
        });

        expect(linkTargets(place)).toEqual([FILE_URL, `${FILE_URL}#L84`]);
        expect(place).not.toContain(domains[0]);
    });

    it('links the existing rule a domain extension rewrites by its line', () => {
        const originalRule = 'devonlive.com,themirror.com##div[data-tmdatatrack-type="commercial"]';

        const place = composeListPlace(FILE, SOURCE, {
            kind: RepositoryEditKind.ExtendDomains,
            line: 12,
            originalRule,
            replacementRule: `example.com,${originalRule}`,
        });

        expect(linkTargets(place)).toEqual([FILE_URL, `${FILE_URL}#L12`]);
        expect(place).not.toContain(originalRule);
    });

    it('links no line past the end of the file', () => {
        // A sorted insert after the last rule and an append have no line to precede.
        for (const edit of [
            {
                kind: RepositoryEditKind.Insert,
                insertionPoint: 500,
                basis: PlacementBasis.SortedPosition,
            },
            { kind: RepositoryEditKind.Insert, basis: PlacementBasis.AppendEof },
        ]) {
            expect(linkTargets(composeListPlace(FILE, SOURCE, edit))).toEqual([FILE_URL]);
        }
    });

    it('keeps a declared comment line visible for an append behind it', () => {
        // The comment is a line the edit itself writes, not a neighbour the file already holds.
        const place = composeListPlace('filters/filters-2026.txt', SOURCE, {
            kind: RepositoryEditKind.Insert,
            basis: PlacementBasis.AppendEof,
            precedingComment: '! https://github.com/uBlockOrigin/uAssets/issues/1',
        });
        expect(place).toContain('`! https://github.com/uBlockOrigin/uAssets/issues/1`');
    });

    it('links a file path with a space in it', () => {
        const place = composeListPlace('Filters/Mobile beta/rules.txt', SOURCE);

        expect(linkTargets(place)).toEqual([
            `https://github.com/example-owner/example-repo/blob/${COMMIT}/Filters/Mobile%20beta/rules.txt`,
        ]);
    });
});
