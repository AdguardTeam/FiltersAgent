import { describe, expect, it } from 'vitest';
import { OutlineMarkerKind, buildFileOutline } from '../../src/repo/file-outline';
import { openHeadingAt } from '../../src/repo/file-heading';
import { openConditionAt } from '../../src/repo/file-condition';

/**
 * Rules long enough to prove an order, written in ascending text order.
 *
 * @returns The rules of one sorted region.
 */
function sortedRules(): string[] {
    return Array.from({ length: 24 }, (_unused, index) => {
        const ordinal = String(index + 1).padStart(2, '0');
        return `||ads-${ordinal}.example^`;
    });
}

/**
 * Rules whose pairs go down then up, so barely half the adjacent pairs ascend.
 *
 * @returns The rules of one chronological-log region.
 */
function logRules(): string[] {
    return Array.from({ length: 24 }, (_unused, index) => {
        const ordinal = String(index + 1).padStart(2, '0');
        return index % 2 === 0
            ? `zulu-${ordinal}.example##.late-${ordinal}`
            : `alpha-${ordinal}.example##.early-${ordinal}`;
    });
}

describe('buildFileOutline', () => {
    it('lists every marker kind with its line number and verbatim text', () => {
        const lines = [
            '! Title: Example list',
            '! SECTION: Example widgets',
            '  ! SECTION: Nested widgets',
            '! SECTION[draft]: Example ads',
            '! !SECTION: Example ads',
            '! NOTE: Regular rules',
            '! NOTE: Regular rules end ⬆️',
            '! !SECTION: Nested widgets',
            '! START: example.org',
            '! END: example.org',
            '!#if (adguard_app_ios)',
            '!#else',
            '!#endif',
            '!#safari_cb_affinity(privacy)',
            '!#safari_cb_affinity',
            '!---------------- Example banner -----------------',
            '!----------',
        ];

        const outline = buildFileOutline(lines);

        expect(outline.lineCount).toBe(17);
        expect(outline.markers.map(({ line, kind, text }) => ({ line, kind, text }))).toEqual([
            { line: 2, kind: OutlineMarkerKind.Section, text: '! SECTION: Example widgets' },
            { line: 3, kind: OutlineMarkerKind.Section, text: '! SECTION: Nested widgets' },
            { line: 4, kind: OutlineMarkerKind.Section, text: '! SECTION[draft]: Example ads' },
            { line: 5, kind: OutlineMarkerKind.SectionEnd, text: '! !SECTION: Example ads' },
            { line: 6, kind: OutlineMarkerKind.Note, text: '! NOTE: Regular rules' },
            { line: 7, kind: OutlineMarkerKind.NoteEnd, text: '! NOTE: Regular rules end ⬆️' },
            { line: 8, kind: OutlineMarkerKind.SectionEnd, text: '! !SECTION: Nested widgets' },
            { line: 9, kind: OutlineMarkerKind.Group, text: '! START: example.org' },
            { line: 10, kind: OutlineMarkerKind.GroupEnd, text: '! END: example.org' },
            { line: 11, kind: OutlineMarkerKind.Condition, text: '!#if (adguard_app_ios)' },
            { line: 12, kind: OutlineMarkerKind.Condition, text: '!#else' },
            { line: 13, kind: OutlineMarkerKind.ConditionEnd, text: '!#endif' },
            {
                line: 14,
                kind: OutlineMarkerKind.Condition,
                text: '!#safari_cb_affinity(privacy)',
            },
            { line: 15, kind: OutlineMarkerKind.ConditionEnd, text: '!#safari_cb_affinity' },
            {
                line: 16,
                kind: OutlineMarkerKind.Banner,
                text: '!---------------- Example banner -----------------',
            },
            { line: 17, kind: OutlineMarkerKind.Banner, text: undefined },
        ]);
    });

    it('counts the rules after each marker and says whether that region is sorted', () => {
        const lines = [
            '! SECTION: Sorted rules',
            ...sortedRules(),
            '! SECTION: Log rules',
            ...logRules(),
            '!----------',
        ];

        const outline = buildFileOutline(lines);

        expect(
            outline.markers.map(({ line, ruleCount, sorted }) => ({ line, ruleCount, sorted })),
        ).toEqual([
            { line: 1, ruleCount: 24, sorted: true },
            { line: 26, ruleCount: 24, sorted: false },
            { line: 51, ruleCount: 0, sorted: false },
        ]);
        expect(outline.leadingRuleCount).toBe(0);
        expect(outline.leadingSorted).toBe(false);
    });

    it('describes a file without markers by its leading rule count and line count', () => {
        const outline = buildFileOutline(['||one.example^', '||two.example^']);

        expect(outline).toEqual({
            lineCount: 2,
            leadingRuleCount: 2,
            leadingSorted: false,
            header: '',
            markers: [],
        });
    });

    it('keeps every marker of a file past the old count cap', () => {
        const markerCount = 700;
        const lines = Array.from(
            { length: markerCount },
            (_unused, index) => `! NOTE: Section ${index}`,
        );

        const outline = buildFileOutline(lines);

        expect(outline.markers).toHaveLength(markerCount);
        expect(outline.markers.at(-1)?.line).toBe(markerCount);
    });

    it('returns the leading comment header above the first rule or marker', () => {
        const lines = [
            '[Adblock Plus 2.0]',
            '',
            '! Title: Example list',
            '! Good: advertising rules',
            '! Bad: tracking rules (should be in tracking.txt)',
            '||ads.example^',
            '! SECTION: Example widgets',
            'example.org##.ad',
        ];

        const outline = buildFileOutline(lines);

        expect(outline.header).toBe(
            [
                '! Title: Example list',
                '! Good: advertising rules',
                '! Bad: tracking rules (should be in tracking.txt)',
            ].join('\n'),
        );
        expect(outline.leadingRuleCount).toBe(1);
        expect(outline.markers).toHaveLength(1);
    });

    it('stops the header at the first marker even before any rule', () => {
        const lines = ['! Title: Example list', '! SECTION: Example widgets', 'example.org##.ad'];

        expect(buildFileOutline(lines).header).toBe('! Title: Example list');
    });

    it('does not count a list header line as a rule', () => {
        const lines = ['[$path=BaseFilter/sections/foreign.txt]', '||ads.example^'];

        const outline = buildFileOutline(lines);

        expect(outline.header).toBe('');
        expect(outline.leadingRuleCount).toBe(1);
    });
});

describe('openHeadingAt', () => {
    it('names the nearest open heading above a line, past a closed section and a condition block', () => {
        const lines = [
            '! SECTION: Example widgets',
            '! NOTE: Regular rules',
            'example.org##.first',
            '!#if (adguard_app_ios)',
            'example.org##.second',
            '!#endif',
            '! !SECTION: Example widgets',
            'example.org##.outside',
        ];

        expect(openHeadingAt(lines, 3)).toBe('! NOTE: Regular rules');
        expect(openHeadingAt(lines, 5)).toBe('! NOTE: Regular rules');
        expect(openHeadingAt(lines, 8)).toBeUndefined();
    });

    it('returns undefined above the first heading', () => {
        const lines = ['example.org##.first', '! SECTION: Example widgets', 'example.org##.second'];

        expect(openHeadingAt(lines, 1)).toBeUndefined();
        expect(openHeadingAt(lines, 2)).toBeUndefined();
        expect(openHeadingAt(lines, 3)).toBe('! SECTION: Example widgets');
    });

    it('does not name an end note or a bare dashed line as the heading', () => {
        const lines = [
            '! SECTION: Example widgets',
            '! NOTE: Regular rules',
            'example.org##.under-note',
            '! NOTE: Regular rules end ⬆️',
            'example.org##.after-end-note',
            '! !SECTION: Example widgets',
            'example.org##.after-section',
            '! SECTION: Another widget',
            '!---------------- banner with a label -----------------',
            'example.org##.under-label',
            '!----------',
            'example.org##.under-bare-dashes',
        ];

        expect(openHeadingAt(lines, 5)).toBe('! SECTION: Example widgets');
        expect(openHeadingAt(lines, 7)).toBeUndefined();
        expect(openHeadingAt(lines, 9)).toBe('! SECTION: Another widget');
        expect(openHeadingAt(lines, 10)).toBe('banner with a label');
        expect(openHeadingAt(lines, 12)).toBe('! SECTION: Another widget');
    });

    it('ends a banner at a bare frame that does not frame its label', () => {
        const lines = [
            '!---------------- Another banner -----------------',
            'example.org##.under-another',
            '!----------',
            'example.org##.after-the-frame',
            '!--------------------------------------!',
            '!------- CSS fixes --------------------!',
            '!--------------------------------------!',
            'example.org##.framed',
        ];

        expect(openHeadingAt(lines, 2)).toBe('Another banner');
        expect(openHeadingAt(lines, 4)).toBeUndefined();
        expect(openHeadingAt(lines, 8)).toBe('CSS fixes');
    });

    it('does not let a bare frame inside a section close an outer banner', () => {
        const lines = [
            '!--- Outer banner ---',
            '! SECTION: Inner',
            '!----------',
            'example.com##.ad',
        ];

        expect(openHeadingAt(lines, 4)).toBe('! SECTION: Inner');
    });

    it('names a banner by its label with the framing stripped from both ends', () => {
        const lines = ['!------- JS rules ---------------------!', 'example.org##.ad'];

        expect(buildFileOutline(lines).markers[0]?.text).toBe(
            '!------- JS rules ---------------------!',
        );
        expect(openHeadingAt(lines, 2)).toBe('JS rules');
    });

    it('does not name a bare dashed frame line as the heading', () => {
        const lines = [
            '!--------------------------------------!',
            '!------- CSS fixes --------------------!',
            '!--------------------------------------!',
            'example.com##.ad',
        ];

        const outline = buildFileOutline(lines);

        expect(outline.markers.map(({ line, kind, text }) => ({ line, kind, text }))).toEqual([
            { line: 1, kind: OutlineMarkerKind.Banner, text: undefined },
            {
                line: 2,
                kind: OutlineMarkerKind.Banner,
                text: '!------- CSS fixes --------------------!',
            },
            { line: 3, kind: OutlineMarkerKind.Banner, text: undefined },
        ]);
        expect(openHeadingAt(lines, 4)).toBe('CSS fixes');
    });

    it('does not read a prose comment as a note heading', () => {
        const lines = [
            '! SECTION: Example widgets',
            '! Note: remove these rules if you find incorrect blocking',
            'example.org##.ad',
            '! NOTE: Regular rules',
            'example.org##.another',
        ];

        const outline = buildFileOutline(lines);

        expect(outline.markers.map(({ line, kind }) => ({ line, kind }))).toEqual([
            { line: 1, kind: OutlineMarkerKind.Section },
            { line: 4, kind: OutlineMarkerKind.Note },
        ]);
        expect(openHeadingAt(lines, 3)).toBe('! SECTION: Example widgets');
        expect(openHeadingAt(lines, 5)).toBe('! NOTE: Regular rules');
    });

    it('closes the innermost open section even when the closing names another section', () => {
        const lines = [
            '! SECTION: A',
            '! NOTE: Inner note',
            '! !SECTION: B',
            'example.org##.outside',
        ];

        expect(openHeadingAt(lines, 4)).toBeUndefined();
    });

    it('closes a group at its end and keeps the enclosing section as the heading', () => {
        const lines = [
            '! SECTION: Example widgets',
            '! START: example.org',
            '! NOTE: Inside the group',
            'example.org##.inside',
            '! END: example.org',
            'example.org##.outside-the-group',
        ];

        expect(openHeadingAt(lines, 4)).toBe('! NOTE: Inside the group');
        expect(openHeadingAt(lines, 6)).toBe('! SECTION: Example widgets');
    });

    it('closes a group at its end without inventing a heading when none encloses it', () => {
        const lines = ['! START: example.org', 'example.org##.inside', '! END: example.org', ''];

        expect(openHeadingAt(lines, 2)).toBe('! START: example.org');
        expect(openHeadingAt(lines, 4)).toBeUndefined();
    });

    it('leaves a nested section open when a group in an outer section ends', () => {
        const lines = [
            '! SECTION: Outer section',
            '! START: example.org',
            '! SECTION: Nested section',
            '! NOTE: Nested note',
            'example.org##.inside-nested-section',
            '! END: example.org',
            'example.org##.after-the-group',
        ];

        expect(openHeadingAt(lines, 5)).toBe('! NOTE: Nested note');
        // The outer group closes in its own scope; the nested section and its note stay open.
        expect(openHeadingAt(lines, 7)).toBe('! NOTE: Nested note');
    });

    it('leaves a nested section open when a group above every section ends', () => {
        const lines = [
            '! START: example.org',
            '! SECTION: Nested section',
            '! NOTE: Nested note',
            'example.org##.inside-nested-section',
            '! END: example.org',
            'example.org##.after-the-group',
        ];

        expect(openHeadingAt(lines, 4)).toBe('! NOTE: Nested note');
        expect(openHeadingAt(lines, 6)).toBe('! NOTE: Nested note');
    });

    it('closes a group at a bare end marker in any letter case', () => {
        const lines = [
            '! START: example.org',
            'example.org##.inside',
            '! end',
            'example.org##.after',
        ];

        expect(openHeadingAt(lines, 2)).toBe('! START: example.org');
        expect(openHeadingAt(lines, 4)).toBeUndefined();
    });

    it('names no heading for a group that never ends', () => {
        const lines = ['! START: example.org', 'example.org##.inside', 'example.org##.last'];

        expect(openHeadingAt(lines, 2)).toBeUndefined();
        expect(openHeadingAt(lines, 3)).toBeUndefined();
    });

    it('does not let an end outside a closed scope close the group it held', () => {
        const lines = [
            '! SECTION: Example widgets',
            '! START: example.org',
            '! START: example.com',
            'example.com##.inside',
            '! END: example.com',
            'example.org##.after-the-nested-group',
            '! !SECTION: Example widgets',
            '! END: example.org',
            'example.org##.after-the-section',
        ];

        expect(openHeadingAt(lines, 2)).toBe('! SECTION: Example widgets');
        expect(openHeadingAt(lines, 6)).toBe('! SECTION: Example widgets');
        expect(openHeadingAt(lines, 9)).toBeUndefined();
    });

    it('does not bring back a note opened above a closed section', () => {
        const lines = [
            '! NOTE: Contributor rules',
            '! SECTION: Example widgets',
            'example.org##.inside',
            '! !SECTION: Example widgets',
            'example.org##.after',
        ];

        expect(openHeadingAt(lines, 3)).toBe('! SECTION: Example widgets');
        expect(openHeadingAt(lines, 5)).toBeUndefined();
    });
});

describe('openConditionAt', () => {
    it('names the conditional block a line sits inside', () => {
        const lines = [
            'example.org##.outside',
            '!#if (adguard_app_ios)',
            'example.org##.inside-ios',
            '!#endif',
            '!#safari_cb_affinity(privacy)',
            'example.org##.inside-safari',
            '!#safari_cb_affinity',
            'example.org##.after',
        ];

        expect(openConditionAt(lines, 3)).toBe('!#if (adguard_app_ios)');
        expect(openConditionAt(lines, 6)).toBe('!#safari_cb_affinity(privacy)');
        expect(openConditionAt(lines, 8)).toBeUndefined();
    });

    it('keeps the alternative branch instead of claiming the positive one', () => {
        const lines = [
            '!#if (adguard_ext_chromium_mv3)',
            'example.org##.positive-branch',
            '!#else',
            'example.org##.alternative-branch',
            '!#endif',
        ];

        // Inserting before !#else still lands in the positive branch.
        expect(openConditionAt(lines, 3)).toBe('!#if (adguard_ext_chromium_mv3)');
        expect(openConditionAt(lines, 4)).toBe('!#if (adguard_ext_chromium_mv3) !#else');
        expect(openConditionAt(lines, 5)).toBe('!#if (adguard_ext_chromium_mv3) !#else');
    });

    it('names the innermost open block and forgets a closed one', () => {
        const lines = [
            '!#if (adguard_app_android)',
            '!#if (adguard_ext_android_cb)',
            'example.org##.both',
            '!#endif',
            'example.org##.outer-only',
            '!#endif',
            'example.org##.after-both',
        ];

        expect(openConditionAt(lines, 3)).toBe('!#if (adguard_ext_android_cb)');
        expect(openConditionAt(lines, 5)).toBe('!#if (adguard_app_android)');
        expect(openConditionAt(lines, 7)).toBeUndefined();
    });

    it('reads nothing above the opener or on it', () => {
        const lines = ['example.org##.before', '!#if (adguard_app_ios)', 'example.org##.inside'];

        expect(openConditionAt(lines, 1)).toBeUndefined();
        expect(openConditionAt(lines, 2)).toBeUndefined();
    });

    it('closes a block whose body never names a rule', () => {
        const lines = ['!#if (adguard_app_ios)', '!#endif', 'example.org##.after'];

        expect(openConditionAt(lines, 3)).toBeUndefined();
    });
});
