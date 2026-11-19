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

/**
 * One element-hiding rule whose selector orders it independently of its domain.
 *
 * @param index - Zero-based rule index.
 * @returns The rule text.
 */
function cosmeticRule(index: number): string {
    return `${SCRAMBLED_DOMAINS[index % SCRAMBLED_DOMAINS.length]}.example###ad-${ordinal(index)}`;
}

/**
 * A run of element-hiding rules ordered by selector.
 *
 * @param count - Number of rules in the run.
 * @returns The run's rules.
 */
function cosmeticRules(count: number): string[] {
    return Array.from({ length: count }, (_unused, index) => cosmeticRule(index));
}

/**
 * A run of network rules ordered by rule text.
 *
 * @param count - Number of rules in the run.
 * @returns The run's rules.
 */
function networkRules(count: number): string[] {
    return Array.from({ length: count }, (_unused, index) => `||ads-${ordinal(index)}.example^`);
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
        const relativePath = 'easylist/easylist_specific_hide.txt';
        const root = checkoutWith(relativePath, [
            '! Title: Specific hide',
            ...cosmeticRules(SORTED_RULE_COUNT),
        ]);
        const candidateRule = 'sitepoint.example###ad-12b';

        const plan = planRepositoryEdit(root, relativePath, candidateRule, undefined, {
            kind: 'sorted',
        });

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
        const relativePath = 'easylist/easylist_adservers.txt';
        const root = checkoutWith(relativePath, [
            '! Title: Ad servers',
            ...networkRules(SORTED_RULE_COUNT),
        ]);
        const candidateRule = '||ads-12b.example^';

        const plan = planRepositoryEdit(root, relativePath, candidateRule, undefined, {
            kind: 'sorted',
        });

        expect(plan.edit).toEqual({
            kind: 'insert',
            basis: PlacementBasis.SortedPosition,
            insertionPoint: 13,
            anchorRule: '||ads-13.example^',
        });
    });

    it('places the rule in the marker region the agent names', () => {
        const relativePath = 'easylist/easylist_specific_hide.txt';
        const root = checkoutWith(relativePath, [
            '! Title: Mixed list',
            '! SECTION: Sorted rules',
            ...cosmeticRules(SORTED_RULE_COUNT),
        ]);

        const plan = planRepositoryEdit(
            root,
            relativePath,
            'sitepoint.example###ad-12b',
            undefined,
            { kind: 'sorted', line: 2 },
        );

        expect(plan.edit).toEqual({
            kind: 'insert',
            basis: PlacementBasis.SortedPosition,
            insertionPoint: 14,
            anchorRule: `${SCRAMBLED_DOMAINS[12 % SCRAMBLED_DOMAINS.length]}.example###ad-13`,
            heading: '! SECTION: Sorted rules',
        });
    });

    it('records the condition enclosing the sorted region', () => {
        const relativePath = 'BaseFilter/sections/specific.txt';
        const root = checkoutWith(relativePath, [
            '!#if (adguard_ext_android_cb)',
            ...cosmeticRules(SORTED_RULE_COUNT),
            '!#endif',
        ]);

        const plan = planRepositoryEdit(
            root,
            relativePath,
            'sitepoint.example###ad-12b',
            undefined,
            { kind: 'sorted', line: 1 },
        );

        expect(plan.edit).toMatchObject({
            basis: PlacementBasis.SortedPosition,
            condition: '!#if (adguard_ext_android_cb)',
        });
    });

    it('refuses the leading region when the outline does not flag it sorted', () => {
        const relativePath = 'easylist/easylist_tiny.txt';
        const root = checkoutWith(relativePath, [
            '! Title: Log',
            'zulu.example##.late',
            'alpha.example##.early',
            '! SECTION: Sorted rules',
            ...cosmeticRules(SORTED_RULE_COUNT),
        ]);

        expect(() =>
            planRepositoryEdit(root, relativePath, 'sitepoint.example###ad-12b', undefined, {
                kind: 'sorted',
            }),
        ).toThrow(/first outline marker/u);
    });

    it('refuses a marker whose region the outline does not flag sorted', () => {
        const relativePath = 'easylist/easylist_tiny.txt';
        const root = checkoutWith(relativePath, [
            '! SECTION: Log rules',
            'zulu.example##.late',
            'alpha.example##.early',
            '! SECTION: Sorted rules',
            ...cosmeticRules(SORTED_RULE_COUNT),
        ]);

        expect(() =>
            planRepositoryEdit(root, relativePath, 'sitepoint.example###ad-12b', undefined, {
                kind: 'sorted',
                line: 1,
            }),
        ).toThrow(/not kept sorted/u);
    });

    it('refuses a line that is not an outline marker line', () => {
        const relativePath = 'easylist/easylist_specific_hide.txt';
        const root = checkoutWith(relativePath, [
            '! SECTION: Sorted rules',
            ...cosmeticRules(SORTED_RULE_COUNT),
        ]);

        expect(() =>
            planRepositoryEdit(root, relativePath, 'sitepoint.example###ad-12b', undefined, {
                kind: 'sorted',
                line: 5,
            }),
        ).toThrow(/no outline marker/u);
    });

    it('refuses a region holding no sorted run of the candidate rule family', () => {
        // Both regions are kept sorted, but the first holds network rules and the candidate is
        // cosmetic: the plan must not fall back to the cosmetic region the agent did not name.
        const relativePath = 'easylist/easylist_mixed.txt';
        const root = checkoutWith(relativePath, [
            '! SECTION: Network rules',
            ...networkRules(SORTED_RULE_COUNT),
            '! SECTION: Cosmetic rules',
            ...cosmeticRules(SORTED_RULE_COUNT),
        ]);

        expect(() =>
            planRepositoryEdit(root, relativePath, 'sitepoint.example###ad-12b', undefined, {
                kind: 'sorted',
                line: 1,
            }),
        ).toThrow(/rule's kind/u);
    });

    it('refuses a leading region too short for an order to mean anything', () => {
        // Ten rules in ascending order is a coincidence that happens; it is also the case where an
        // appended rule is least likely to be in the wrong place.
        const relativePath = 'easylist/easylist_tiny.txt';
        const root = checkoutWith(relativePath, ['! Title: Tiny', ...cosmeticRules(10)]);

        expect(() =>
            planRepositoryEdit(root, relativePath, 'sitepoint.example###ad-05b', undefined, {
                kind: 'sorted',
            }),
        ).toThrow(/first outline marker/u);
    });

    it('inserts after the last smaller key when an unsorted head sits above the run', () => {
        // The hand-added head rule sorts after the candidate while every rule below it sorts
        // before it. Searching from the end lands the candidate after the run's last rule; looking
        // for the first greater key would land it right under the head.
        const relativePath = 'CyrillicFilters/common-sections/general_elemhide.txt';
        const root = checkoutWith(relativePath, [
            '! Title: General',
            'zzz-head.example###zzz-head',
            ...cosmeticRules(60),
        ]);
        const candidateRule = 'sitepoint.example###zzz';

        const plan = planRepositoryEdit(root, relativePath, candidateRule, undefined, {
            kind: 'sorted',
        });

        // 62 lines: title, head rule and 60 tail rules. Sorting last means the position is the
        // end of the region and there is no following rule to anchor or link.
        expect(plan.edit).toEqual({
            kind: 'insert',
            basis: PlacementBasis.SortedPosition,
            insertionPoint: 62,
        });
        const content = readFileSync(join(root, relativePath), 'utf8');
        const written = applyRepositoryEdit(content, candidateRule, plan.edit).split('\n');
        expect(written.at(-2)).toBe(candidateRule);
    });

    it('inserts inside the ordered body when a tolerated outlier sits at the end', () => {
        // Sixty rules ascend except the first, which a maintainer moved to the end. The section
        // still clears the sortedness threshold, and that small trailing outlier sorts before the
        // candidate: a reverse search that treated it as an anchor would place the rule past it.
        const [head, ...ascending] = networkRules(60);
        const relativePath = 'easylist/easylist_adservers.txt';
        const root = checkoutWith(relativePath, ['! Title: Ad servers', ...ascending, head]);
        const candidateRule = '||ads-30b.example^';

        const plan = planRepositoryEdit(root, relativePath, candidateRule, undefined, {
            kind: 'sorted',
        });

        // The title takes index 0 and `ads-02` opens the ordered body at index 1, so `ads-30` and
        // `ads-31` sit at indices 29 and 30.
        expect(plan.edit).toEqual({
            kind: 'insert',
            basis: PlacementBasis.SortedPosition,
            insertionPoint: 30,
            anchorRule: '||ads-31.example^',
        });
        const content = readFileSync(join(root, relativePath), 'utf8');
        const written = applyRepositoryEdit(content, candidateRule, plan.edit).split('\n');
        expect(written.slice(29, 32)).toEqual([
            '||ads-30.example^',
            candidateRule,
            '||ads-31.example^',
        ]);
    });

    it('anchors on the blank line that sits between the smaller and the next rule', () => {
        // Blank lines do not split a sorted run, so the insertion point between two of its rules
        // can be the blank line itself. It is still the exact boundary the rule is planned to
        // precede, and the applier pins it as the anchor like any other line.
        const rules = cosmeticRules(SORTED_RULE_COUNT);
        const relativePath = 'easylist/easylist_specific_hide.txt';
        const root = checkoutWith(relativePath, [
            '! Title: Specific hide',
            ...rules.slice(0, 12),
            '',
            ...rules.slice(12),
        ]);

        const plan = planRepositoryEdit(
            root,
            relativePath,
            'sitepoint.example###ad-12b',
            undefined,
            { kind: 'sorted' },
        );

        expect(plan.edit).toEqual({
            kind: 'insert',
            basis: PlacementBasis.SortedPosition,
            // Rule `###ad-12` sits at index 12 and the blank line at index 13 precedes the next.
            insertionPoint: 13,
            anchorRule: '',
        });
    });

    it('inserts before the first rule when no rule has a smaller key', () => {
        const relativePath = 'easylist/easylist_specific_hide.txt';
        const root = checkoutWith(relativePath, [
            '! Title: Specific hide',
            ...cosmeticRules(SORTED_RULE_COUNT),
        ]);

        const plan = planRepositoryEdit(root, relativePath, 'sitepoint.example###aaa', undefined, {
            kind: 'sorted',
        });

        expect(plan.edit).toEqual({
            kind: 'insert',
            basis: PlacementBasis.SortedPosition,
            insertionPoint: 1,
            anchorRule: `${SCRAMBLED_DOMAINS[0]}.example###ad-01`,
        });
    });
});

describe('a declared placement chooses its position from the file it names', () => {
    it('takes the sorted position when the declaration carries no comment', () => {
        // The live EasyList run declared `placement: easylist/easylist_specific_hide.txt` and the
        // verified rule was planned at the end of a file EasyList keeps sorted with FOP.
        const relativePath = 'easylist/easylist_specific_hide.txt';
        const root = checkoutWith(relativePath, [
            '! Title: Specific hide',
            ...cosmeticRules(SORTED_RULE_COUNT),
        ]);

        const plan = planRepositoryEdit(
            root,
            relativePath,
            'sitepoint.example###ad-12b',
            { byRuleType: {}, unqualified: { filePath: relativePath } },
            { kind: 'sorted' },
        );

        expect(plan.edit).toMatchObject({
            basis: PlacementBasis.SortedPosition,
            insertionPoint: 13,
        });
    });

    it('appends behind the declared comment, which makes the file a chronological log', () => {
        const relativePath = 'filters/filters-2026.txt';
        const root = checkoutWith(relativePath, [
            '! Title: Year file',
            ...cosmeticRules(SORTED_RULE_COUNT),
        ]);
        const commentLine = '! https://github.com/uBlockOrigin/uAssets/issues/29471';

        const plan = planRepositoryEdit(
            root,
            relativePath,
            'sitepoint.example###ad-12b',
            {
                byRuleType: {},
                unqualified: { filePath: relativePath, commentLine },
            },
            undefined,
        );

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
        const atFileEnd = {
            kind: 'file_end',
            reason: 'No section keeps rules of this kind.',
        } as const;
        expect(
            planRepositoryEdit(root, networkPath, '||tracker.example^', declared, atFileEnd)
                .filePath,
        ).toBe(networkPath);
        expect(
            planRepositoryEdit(root, cosmeticPath, 'site.example##.ad', declared, atFileEnd)
                .filePath,
        ).toBe(cosmeticPath);
        // Any other file for a declared kind is refused, naming the file the kind is declared for.
        expect(() =>
            planRepositoryEdit(
                root,
                'easylist/absent.txt',
                '||tracker.example^',
                declared,
                undefined,
            ),
        ).toThrow(/easylist\/absent\.txt/);
    });
});
