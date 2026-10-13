import { describe, expect, it } from 'vitest';
import { extractInstructionSection } from '../../src/knowledge/instruction-preparation';
import {
    ISSUE_SELECTION_SECTION_KEYWORDS,
    parseIssueSelectionNarrowing,
    SelectionNarrowingError,
} from '../../src/knowledge/instruction-selection';

const INSTRUCTION_WITH_SELECTION = [
    '# AdGuard list agent instruction',
    '',
    '## Rule syntax',
    '',
    'Write network rules.',
    '',
    '## Issue selection',
    '',
    '- labels: T: Ads, T: Registries',
    '- max-age-days: 30',
    '',
    'Skip issues a parallel triage run already owns.',
    '',
    '## Report format',
    '',
    'Close with the short report.',
].join('\n');

describe('extractInstructionSection with the issue-selection keywords', () => {
    it('binds the first selection heading and returns its body up to the next heading', () => {
        const section = extractInstructionSection(
            INSTRUCTION_WITH_SELECTION,
            ISSUE_SELECTION_SECTION_KEYWORDS,
        );

        expect(section).toContain('- labels: T: Ads, T: Registries');
        expect(section).toContain('- max-age-days: 30');
        expect(section).toContain('parallel triage run');
        expect(section).not.toContain('Report format');
        expect(section).not.toContain('Rule syntax');
    });

    it('binds a which-issues heading case-insensitively', () => {
        const instruction = ['## WHICH ISSUES to take', '', '- labels: T: Ads'].join('\n');

        const section = extractInstructionSection(instruction, ISSUE_SELECTION_SECTION_KEYWORDS);

        expect(section).toContain('- labels: T: Ads');
    });

    it('treats headings and keyword matching as inert inside fenced blocks', () => {
        const fencedHeading = [
            '## Blockers',
            '',
            '```md',
            '## Issue selection',
            '- labels: fenced, not a real section',
            '```',
            '',
            '## Closing',
            '',
            'done',
        ].join('\n');
        const fencedBound = [
            '## Issue selection',
            '',
            '- labels: T: Ads',
            '',
            '```md',
            '## quoted example selection that must not bound the list',
            '```',
            '',
            '## Report format',
        ].join('\n');

        expect(
            extractInstructionSection(fencedHeading, ISSUE_SELECTION_SECTION_KEYWORDS),
        ).toBeUndefined();
        expect(extractInstructionSection(fencedBound, ISSUE_SELECTION_SECTION_KEYWORDS)).toContain(
            'quoted example selection',
        );
    });

    it('returns undefined when no selection heading exists or the section body is empty', () => {
        const withoutSelection = ['## Rule syntax', '', 'Write network rules.'].join('\n');
        const emptySelection = ['## Issue selection', '', '   ', '', '## Policy'].join('\n');

        expect(
            extractInstructionSection(withoutSelection, ISSUE_SELECTION_SECTION_KEYWORDS),
        ).toBeUndefined();
        expect(
            extractInstructionSection(emptySelection, ISSUE_SELECTION_SECTION_KEYWORDS),
        ).toBeUndefined();
    });

    it('wins with the first matching heading and never reaches a later definition', () => {
        const instruction = [
            '## Issue selection',
            '',
            '- labels: first definition',
            '',
            '## Which issues',
            '',
            '- labels: later definition',
        ].join('\n');

        const section = extractInstructionSection(instruction, ISSUE_SELECTION_SECTION_KEYWORDS);

        expect(section).toContain('first definition');
        expect(section).not.toContain('later definition');
    });
});

describe('parseIssueSelectionNarrowing', () => {
    it('binds the labels and max-age-days items, trimming labels and dropping empty entries', () => {
        const narrowing = parseIssueSelectionNarrowing(
            ['- labels: T: Ads, , T: Registries, ', '- max-age-days: 30'].join('\n'),
        );

        expect(narrowing).toEqual({ labels: ['T: Ads', 'T: Registries'], maxAgeDays: 30 });
    });

    it('treats every other line as prose and yields an empty narrowing without items', () => {
        const prose = ['Take only what misses.', '- labels: T: Ads', 'But skip duplicates.'].join(
            '\n',
        );

        expect(parseIssueSelectionNarrowing(prose)).toEqual({ labels: ['T: Ads'] });
        expect(parseIssueSelectionNarrowing('no items at all')).toEqual({});
        expect(parseIssueSelectionNarrowing('')).toEqual({});
    });

    it('lets a later item for the same key overwrite the earlier value', () => {
        const narrowing = parseIssueSelectionNarrowing('- max-age-days: 10\n- max-age-days: 20');

        expect(narrowing).toEqual({ maxAgeDays: 20 });
    });

    it('throws SelectionNarrowingError naming the offending line for a non-numeric age', () => {
        expect(() => parseIssueSelectionNarrowing('- max-age-days: yesterday')).toThrowError(
            SelectionNarrowingError,
        );
        expect(() => parseIssueSelectionNarrowing('- max-age-days: yesterday')).toThrowError(
            /max-age-days: yesterday/,
        );
    });

    it('throws SelectionNarrowingError for a negative or zero age, naming the line', () => {
        expect(() => parseIssueSelectionNarrowing('- max-age-days: -3')).toThrowError(
            SelectionNarrowingError,
        );
        expect(() => parseIssueSelectionNarrowing('- max-age-days: -3')).toThrowError(
            /max-age-days: -3/,
        );
        expect(() => parseIssueSelectionNarrowing('- max-age-days: 0')).toThrowError(
            SelectionNarrowingError,
        );
    });
});
