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
        const comment = '! https://github.com/uBlockOrigin/uAssets/issues/1';
        const place = composeListPlace('filters/filters-2026.txt', SOURCE, {
            kind: RepositoryEditKind.Insert,
            basis: PlacementBasis.AppendEof,
            precedingComment: comment,
        });
        expect(place).toContain(comment);
    });

    it('links a file path with a space in it', () => {
        const place = composeListPlace('Filters/Mobile beta/rules.txt', SOURCE);

        expect(linkTargets(place)).toEqual([
            `https://github.com/example-owner/example-repo/blob/${COMMIT}/Filters/Mobile%20beta/rules.txt`,
        ]);
    });

    it('names the heading and links the line a chosen-line insert precedes', () => {
        const heading = '! NOTE: Specific rules';
        const place = composeListPlace(FILE, SOURCE, {
            kind: RepositoryEditKind.Insert,
            insertionPoint: 41,
            anchorRule: 'example.org##.existing',
            basis: PlacementBasis.ChosenLine,
            heading,
        });

        expect(linkTargets(place)).toEqual([FILE_URL, `${FILE_URL}#L42`]);
        expect(place).toContain(heading);
        expect(place).not.toContain('In section');
    });

    it('names the platform condition the chosen line sits inside', () => {
        const heading = '! NOTE: Specific rules';
        const condition = '!#if (adguard_ext_android_cb)';
        const place = composeListPlace(FILE, SOURCE, {
            kind: RepositoryEditKind.Insert,
            insertionPoint: 41,
            anchorRule: 'example.org##.existing',
            basis: PlacementBasis.ChosenLine,
            heading,
            condition,
        });

        expect(linkTargets(place)).toEqual([FILE_URL, `${FILE_URL}#L42`]);
        expect(place).toContain(heading);
        expect(place).toContain(condition);
    });

    it('prints a banner heading by its clean label, not its framing line', () => {
        const place = composeListPlace(FILE, SOURCE, {
            kind: RepositoryEditKind.Insert,
            insertionPoint: 41,
            anchorRule: 'example.org##.existing',
            basis: PlacementBasis.ChosenLine,
            heading: 'JS rules',
        });

        expect(place).toContain('`JS rules`');
        expect(place).not.toContain('!-------');
    });

    it('renders the legacy section field of an earlier run', () => {
        // Results written before the field was renamed carry `section`; the report must read it
        // exactly like the heading new runs write.
        const section = '! NOTE: Specific rules';
        const place = composeListPlace(FILE, SOURCE, {
            kind: RepositoryEditKind.Insert,
            insertionPoint: 41,
            anchorRule: 'example.org##.existing',
            basis: PlacementBasis.ChosenLine,
            section,
        });

        expect(linkTargets(place)).toEqual([FILE_URL, `${FILE_URL}#L42`]);
        expect(place).toContain(section);
    });

    it('links the line alone when no heading is above it', () => {
        const place = composeListPlace(FILE, SOURCE, {
            kind: RepositoryEditKind.Insert,
            insertionPoint: 41,
            anchorRule: 'example.org##.existing',
            basis: PlacementBasis.ChosenLine,
        });

        expect(linkTargets(place)).toEqual([FILE_URL, `${FILE_URL}#L42`]);
        expect(place).toContain('[line 42](');
    });

    it("gives the agent's reason for an end-of-file insert", () => {
        const reason = 'The list keeps one rule per site and this site has none';
        const place = composeListPlace(FILE, SOURCE, {
            kind: RepositoryEditKind.Insert,
            basis: PlacementBasis.AppendEof,
            reason,
        });

        expect(linkTargets(place)).toEqual([FILE_URL]);
        expect(place).toContain(reason);
    });

    it('closes the end-of-file sentence without doubling terminal punctuation', () => {
        const reason = 'The list keeps one rule per site and this site has none';
        const sentence = (text: string): string =>
            composeListPlace(FILE, SOURCE, {
                kind: RepositoryEditKind.Insert,
                basis: PlacementBasis.AppendEof,
                reason: text,
            });

        expect(sentence(reason).endsWith('none.')).toBe(true);
        expect(sentence(`${reason}.`).endsWith('none.')).toBe(true);
        expect(sentence(`${reason}.`).endsWith('none..')).toBe(false);
        expect(sentence('Nothing fits here!').endsWith('here!')).toBe(true);
        expect(sentence('Nothing fits here!').endsWith('here!.')).toBe(false);
    });

    it('keeps rendering the domain-block and terminal-section bases of earlier runs', () => {
        const domainBlock = composeListPlace(FILE, SOURCE, {
            kind: RepositoryEditKind.Insert,
            insertionPoint: 4,
            anchorRule: 'example.org##.existing',
            basis: PlacementBasis.DomainBlock,
        });
        const terminalSection = composeListPlace(FILE, SOURCE, {
            kind: RepositoryEditKind.Insert,
            insertionPoint: 4,
            anchorRule: 'example.org##.existing',
            basis: PlacementBasis.TerminalSection,
        });

        expect(linkTargets(domainBlock)).toEqual([FILE_URL, `${FILE_URL}#L5`]);
        expect(domainBlock).toContain("site's existing rules");
        expect(linkTargets(terminalSection)).toEqual([FILE_URL, `${FILE_URL}#L5`]);
        expect(terminalSection).toContain("end of the file's regular rules");
    });

    it('renders heading, condition and reason that carry Markdown as inert text', () => {
        const heading = '! NOTE: [docs](https://example.org/x) and *emphasis*';
        const condition = '!#if (example_host="a<b>")';
        const place = composeListPlace(FILE, SOURCE, {
            kind: RepositoryEditKind.Insert,
            insertionPoint: 0,
            anchorRule: '||ads.example^',
            basis: PlacementBasis.ChosenLine,
            heading,
            condition,
        });
        const endOfFile = composeListPlace(FILE, SOURCE, {
            kind: RepositoryEditKind.Insert,
            basis: PlacementBasis.AppendEof,
            reason: 'Nothing fits here: see @maintainer, #123 and <b>html</b>.',
        });

        expect(place).toContain(`\`${heading}\``);
        expect(place).toContain(`\`${condition}\``);
        expect(endOfFile).not.toContain('@maintainer');
        expect(endOfFile).toContain('@\u2060maintainer');
        expect(endOfFile).not.toContain('<b>');
    });
});
