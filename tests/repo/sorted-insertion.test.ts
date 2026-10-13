import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyRepositoryEdit, planRepositoryEdit } from '../../src/repo/repository-edit';
import { PlacementBasis } from '../../src/types/placement-basis';

/**
 * A run of numbered rules is long enough to prove a file's order, and 24 clears the 20-rule minimum
 * without making the fixtures unreadable.
 */
const SORTED_RULE_COUNT = 24;

/**
 * Domains written in an order that is deliberately not ascending, so a file can only qualify as
 * sorted under the key that ignores them.
 */
const SCRAMBLED_DOMAINS = ['zulu', 'mike', 'alpha', 'tango', 'bravo', 'yankee'];

const checkouts: string[] = [];

/**
 * Write one list file into a fresh checkout.
 *
 * @param relativePath - Checkout-relative path of the list file.
 * @param lines - Exact lines of the file; a trailing newline is added.
 * @returns The checkout root holding it.
 */
function checkoutWith(relativePath: string, lines: readonly string[]): string {
    const root = mkdtempSync(join(tmpdir(), 'sorted-insertion-'));
    checkouts.push(root);
    mkdirSync(join(root, relativePath, '..'), { recursive: true });
    writeFileSync(join(root, relativePath), `${lines.join('\n')}\n`, 'utf8');
    return root;
}

/**
 * Two-digit index used in the generated rule names, so their text order is their numeric order.
 *
 * @param index - Zero-based rule index.
 * @returns The index as a zero-padded two-digit string.
 */
function ordinal(index: number): string {
    return String(index + 1).padStart(2, '0');
}

afterEach(() => {
    for (const root of checkouts.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

describe('a list file that keeps its rules sorted', () => {
    it('places a cosmetic rule at its sorted position by selector, anchored on the next rule', () => {
        // FOP sorts element-hiding rules by the rule text with the domain part removed, so this
        // file is in order by selector while its domains are not in order at all.
        const rules = Array.from(
            { length: SORTED_RULE_COUNT },
            (_unused, index) =>
                `${SCRAMBLED_DOMAINS[index % SCRAMBLED_DOMAINS.length]}.example###ad-${ordinal(index)}`,
        );
        const relativePath = 'easylist/easylist_specific_hide.txt';
        const root = checkoutWith(relativePath, ['! Title: Specific hide', ...rules]);
        const candidateRule = 'sitepoint.example###ad-12b';

        const plan = planRepositoryEdit(root, relativePath, candidateRule);

        expect(plan.edit).toEqual({
            kind: 'insert',
            basis: PlacementBasis.SortedPosition,
            // The title comment takes line 1, so rule N sits at index N.
            insertionPoint: 13,
            anchorRule: `${SCRAMBLED_DOMAINS[12 % SCRAMBLED_DOMAINS.length]}.example###ad-13`,
        });
        // The anchored plan is what the applier writes, and it refuses a stale anchor: the rule
        // landing between `###ad-12` and `###ad-13` is the whole contract.
        const content = readFileSync(join(root, relativePath), 'utf8');
        const written = applyRepositoryEdit(content, candidateRule, plan.edit).split('\n');
        expect(written.slice(12, 15)).toEqual([
            `${SCRAMBLED_DOMAINS[11 % SCRAMBLED_DOMAINS.length]}.example###ad-12`,
            candidateRule,
            `${SCRAMBLED_DOMAINS[12 % SCRAMBLED_DOMAINS.length]}.example###ad-13`,
        ]);
    });

    it('places a network rule at its sorted position by rule text', () => {
        const rules = Array.from(
            { length: SORTED_RULE_COUNT },
            (_unused, index) => `||ads-${ordinal(index)}.example^`,
        );
        const relativePath = 'easylist/easylist_adservers.txt';
        const root = checkoutWith(relativePath, ['! Title: Ad servers', ...rules]);
        const candidateRule = '||ads-12b.example^';

        const plan = planRepositoryEdit(root, relativePath, candidateRule);

        expect(plan.edit).toEqual({
            kind: 'insert',
            basis: PlacementBasis.SortedPosition,
            insertionPoint: 13,
            anchorRule: '||ads-13.example^',
        });
    });

    it('keeps the domain block in a file whose rules are a chronological log', () => {
        // Each pair goes down then up, so barely half the adjacent pairs ascend under any key —
        // the shape of AdguardFilters' own `specific.txt` and uAssets' year files.
        const rules: string[] = [];
        for (let index = 0; index < SORTED_RULE_COUNT; index += 2) {
            rules.push(`zulu-${ordinal(index)}.example##.late-${ordinal(index)}`);
            rules.push(`alpha-${ordinal(index)}.example##.early-${ordinal(index)}`);
        }
        rules.push('site.example##.existing-ad');
        const relativePath = 'filters/filters-2026.txt';
        const root = checkoutWith(relativePath, ['! Title: Log', ...rules]);

        const plan = planRepositoryEdit(root, relativePath, 'site.example##.new-ad');

        expect(plan.edit).toEqual({
            kind: 'insert',
            basis: PlacementBasis.DomainBlock,
            insertionPoint: rules.length,
            anchorRule: 'site.example##.existing-ad',
        });
    });

    it('does not read an order into a file too short for one to mean anything', () => {
        // Ten rules in ascending order is a coincidence that happens; it is also the case where an
        // appended rule is least likely to be in the wrong place.
        const rules = Array.from(
            { length: 10 },
            (_unused, index) =>
                `${SCRAMBLED_DOMAINS[index % SCRAMBLED_DOMAINS.length]}.example###ad-${ordinal(index)}`,
        );
        const relativePath = 'easylist/easylist_tiny.txt';
        const root = checkoutWith(relativePath, ['! Title: Tiny', ...rules]);

        const plan = planRepositoryEdit(root, relativePath, 'sitepoint.example###ad-05b');

        expect(plan.edit).toEqual({ kind: 'insert', basis: PlacementBasis.AppendEof });
    });
});

describe('a declared placement chooses its position from the file it names', () => {
    it('takes the sorted position when the declaration carries no comment', () => {
        // The live EasyList run declared `placement: easylist/easylist_specific_hide.txt` and the
        // verified rule was planned at the end of a file EasyList keeps sorted with FOP.
        const rules = Array.from(
            { length: SORTED_RULE_COUNT },
            (_unused, index) =>
                `${SCRAMBLED_DOMAINS[index % SCRAMBLED_DOMAINS.length]}.example###ad-${ordinal(index)}`,
        );
        const relativePath = 'easylist/easylist_specific_hide.txt';
        const root = checkoutWith(relativePath, ['! Title: Specific hide', ...rules]);

        const plan = planRepositoryEdit(root, relativePath, 'sitepoint.example###ad-12b', {
            byRuleType: {},
            unqualified: { filePath: relativePath },
        });

        expect(plan.edit).toMatchObject({
            basis: PlacementBasis.SortedPosition,
            insertionPoint: 13,
        });
    });

    it('appends behind the declared comment, which makes the file a chronological log', () => {
        const rules = Array.from(
            { length: SORTED_RULE_COUNT },
            (_unused, index) =>
                `${SCRAMBLED_DOMAINS[index % SCRAMBLED_DOMAINS.length]}.example###ad-${ordinal(index)}`,
        );
        const relativePath = 'filters/filters-2026.txt';
        const root = checkoutWith(relativePath, ['! Title: Year file', ...rules]);
        const commentLine = '! https://github.com/uBlockOrigin/uAssets/issues/29471';

        const plan = planRepositoryEdit(root, relativePath, 'sitepoint.example###ad-12b', {
            byRuleType: {},
            unqualified: { filePath: relativePath, commentLine },
        });

        expect(plan.edit).toEqual({
            kind: 'insert',
            basis: PlacementBasis.AppendEof,
            precedingComment: commentLine,
        });
    });

    it('lets the line for a rule kind decide over the unqualified one', () => {
        const cosmeticPath = 'easylist/easylist_specific_hide.txt';
        const networkPath = 'easylist/easylist_adservers.txt';
        const root = checkoutWith(networkPath, ['! Title: Ad servers', '||ads.example^']);
        mkdirSync(join(root, cosmeticPath, '..'), { recursive: true });
        writeFileSync(join(root, cosmeticPath), '! Title: Specific hide\n', 'utf8');
        const declared = {
            byRuleType: { network: { filePath: networkPath } },
            unqualified: { filePath: cosmeticPath },
        } as const;

        // The network line governs a network candidate even though the unqualified line names
        // another file, and the unqualified line still governs everything else.
        expect(planRepositoryEdit(root, networkPath, '||tracker.example^', declared).filePath).toBe(
            networkPath,
        );
        expect(planRepositoryEdit(root, cosmeticPath, 'site.example##.ad', declared).filePath).toBe(
            cosmeticPath,
        );
        // Any other file for a declared kind is refused, naming the file the kind is declared for.
        expect(() =>
            planRepositoryEdit(root, 'easylist/absent.txt', '||tracker.example^', declared),
        ).toThrow(/easylist\/absent\.txt/);
    });
});
