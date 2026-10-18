import { describe, expect, it } from 'vitest';
import { composeListPlace } from '../../src/publisher/report-list-place';
import { PlacementBasis } from '../../src/types/placement-basis';
import { RepositoryEditKind } from '../../src/types/repository-edit-kind';

const FILE = 'easylist/easylist_specific_hide.txt';

describe('composeListPlace', () => {
    it('names the file alone when the run planned no place inside it', () => {
        expect(composeListPlace(FILE)).toBe(FILE);
        expect(composeListPlace(undefined)).toBe('');
    });

    it('names the neighbouring rule of a planned position, never a line number', () => {
        // The maintainer reads the comment later than the run wrote it: the rule it precedes is
        // still there, a line number has drifted.
        const place = composeListPlace(FILE, {
            kind: 'insert',
            basis: 'sorted_position',
            anchorRule: 'usmagazine.com##.inline-firework-shopping',
        });
        expect(place.startsWith(`${FILE}\n\n`)).toBe(true);
        expect(place).toContain('`usmagazine.com##.inline-firework-shopping`');
        expect(place).not.toMatch(/line \d/u);
    });

    it('says which existing rule a domain extension rewrites', () => {
        const place = composeListPlace('BaseFilter/sections/specific.txt', {
            kind: 'extend_domains',
            originalRule: 'devonlive.com,themirror.com##div[data-tmdatatrack-type="commercial"]',
        });
        expect(place).toContain(
            '`devonlive.com,themirror.com##div[data-tmdatatrack-type="commercial"]`',
        );
    });

    it('keeps a declared comment line visible for an append behind it', () => {
        const place = composeListPlace('filters/filters-2026.txt', {
            kind: 'insert',
            basis: 'append_eof',
            precedingComment: '! https://github.com/uBlockOrigin/uAssets/issues/1',
        });
        expect(place).toContain('`! https://github.com/uBlockOrigin/uAssets/issues/1`');
    });

    it('names a long neighbouring rule whole', () => {
        // A cut rule is a different rule, and a maintainer looks for the one the comment names.
        const domains = Array.from({ length: 80 }, (_, index) => `site-${index}.example`);
        const anchorRule = `${domains.join(',')}##.ad`;

        const place = composeListPlace(FILE, {
            kind: RepositoryEditKind.Insert,
            basis: PlacementBasis.DomainBlock,
            anchorRule,
        });

        expect(place).toContain(`\`${anchorRule}\``);
    });
});
