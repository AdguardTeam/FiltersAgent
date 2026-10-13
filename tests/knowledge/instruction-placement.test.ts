import { describe, expect, it } from 'vitest';
import {
    declaredPlacementForRun,
    parseInstructionPlacement,
} from '../../src/knowledge/instruction-placement';
import { declaredPlacementFor } from '../../src/types/declared-placement';
import { PlacementRuleType } from '../../src/types/placement-rule-type';

/**
 * The declaration an EasyList-shaped repository writes: one line per rule kind, because it keeps
 * site-specific hiding, site-specific blocking and ad servers in three different lists.
 */
const PER_KIND_INSTRUCTION = [
    '# Run instruction',
    '',
    'placement: cosmetic easylist/easylist_specific_hide.txt',
    'placement: network easylist/easylist_specific_block.txt',
    'placement: easylist/easylist_general_hide.txt',
    '',
].join('\n');

describe('a per-kind placement declaration', () => {
    it('sends each kind to its own list and everything else to the line that names no kind', () => {
        const declared = declaredPlacementForRun(
            parseInstructionPlacement(PER_KIND_INSTRUCTION),
            undefined,
        );

        expect(declaredPlacementFor(declared, PlacementRuleType.Cosmetic)?.filePath).toBe(
            'easylist/easylist_specific_hide.txt',
        );
        expect(declaredPlacementFor(declared, PlacementRuleType.Network)?.filePath).toBe(
            'easylist/easylist_specific_block.txt',
        );
        // Neither exceptions nor scriptlets have a line of their own, so the unqualified one
        // covers them rather than leaving them to the default.
        expect(declaredPlacementFor(declared, PlacementRuleType.Exception)?.filePath).toBe(
            'easylist/easylist_general_hide.txt',
        );
        expect(declaredPlacementFor(declared, PlacementRuleType.Scriptlet)?.filePath).toBe(
            'easylist/easylist_general_hide.txt',
        );
    });

    it('keeps a per-kind comment on that kind alone', () => {
        const declared = declaredPlacementForRun(
            parseInstructionPlacement(
                'placement: network filters/network-{{year}}.txt comment: ! {{issueUrl}}\n' +
                    'placement: filters/filters-{{year}}.txt\n',
            ),
            'https://example.test/issues/1',
        );

        expect(declaredPlacementFor(declared, PlacementRuleType.Network)).toStrictEqual({
            filePath: `filters/network-${new Date().getUTCFullYear()}.txt`,
            commentLine: '! https://example.test/issues/1',
        });
        expect(declaredPlacementFor(declared, PlacementRuleType.Cosmetic)).toStrictEqual({
            filePath: `filters/filters-${new Date().getUTCFullYear()}.txt`,
        });
    });

    it('refuses a kind declared twice rather than picking one of the two files', () => {
        expect(() =>
            parseInstructionPlacement(
                'placement: cosmetic easylist/one.txt\nplacement: cosmetic easylist/two.txt\n',
            ),
        ).toThrow(/cosmetic/);
    });

    it('refuses a kind the placement vocabulary does not have', () => {
        expect(() => parseInstructionPlacement('placement: annoyance filters/a.txt\n')).toThrow(
            /unknown rule kind/i,
        );
    });
});
