import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { extractPreparationSection } from '../../src/knowledge/instruction-preparation';

const INSTRUCTION_WITH_PREPARATION = [
    '# AdGuard list agent instruction',
    '',
    'The agent prepares the AdGuard extension before reading the issue.',
    '',
    '## Blockers',
    '',
    'Plug in the AdGuard extension; look up rules with the',
    '[AdGuard syntax guide](https://example.com/adguard/syntax).',
    '',
    '## Preparation',
    '',
    'Before the session starts perform these steps on the machine:',
    '',
    '1. Download the extension release from https://example.com/extension/releases/latest.',
    '2. Unpack it into `./artifacts/preparation/ext`.',
    '',
    '```sh',
    '## check that the browser driver is present',
    'which chromium',
    '```',
    '',
    '3. Keep the unpacked dir path at hand for the launch step.',
    '',
    '## Rule syntax',
    '',
    'Follow the [syntax reference](https://example.com/adguard/syntax) when building candidates.',
    '',
    '## List policy',
    '',
    'The [list policy](https://example.com/adguard/policy) forbids wide keywords.',
    '',
    '## Report format',
    '',
    'Close with the short report from the policy links above.',
].join('\n');

const EXPECTED_PREPARATION_BODY = [
    '',
    'Before the session starts perform these steps on the machine:',
    '',
    '1. Download the extension release from https://example.com/extension/releases/latest.',
    '2. Unpack it into `./artifacts/preparation/ext`.',
    '',
    '```sh',
    '## check that the browser driver is present',
    'which chromium',
    '```',
    '',
    '3. Keep the unpacked dir path at hand for the launch step.',
    '',
].join('\n');

describe('extractPreparationSection', () => {
    it('binds the first preparation heading, keeps the fenced body intact, and never swallows later sections', () => {
        const section = extractPreparationSection(INSTRUCTION_WITH_PREPARATION);

        expect(section).toBeDefined();
        expect(section?.content).toBe(EXPECTED_PREPARATION_BODY);
        expect(section?.content).toContain('browser driver');
        expect(section?.content).not.toContain('Rule syntax');
        expect(section?.content).not.toContain('List policy');
        expect(section?.content).not.toContain('Report format');
        expect(section?.content).not.toContain('adguard/syntax');
        expect(section?.sha256).toBe(
            createHash('sha256')
                .update(section?.content ?? '', 'utf8')
                .digest('hex'),
        );
    });

    it('matches the keyword case-insensitively and wins with the first matching heading', () => {
        const instruction = [
            '## PREPARATION STEPS',
            '',
            'step one for the first matching heading',
            '',
            '## preparation again',
            '',
            'step from a later definition the host must ignore',
        ].join('\n');

        const section = extractPreparationSection(instruction);

        expect(section?.content).toContain('step one for the first matching heading');
        expect(section?.content).not.toContain('later definition');
    });

    it('returns undefined when the instruction carries no preparation heading at all', () => {
        const instruction = [
            '# Instruction',
            '',
            '## Rule syntax',
            '',
            'Write network rules.',
        ].join('\n');

        expect(extractPreparationSection(instruction)).toBeUndefined();
    });

    it('returns undefined when the section body is empty or whitespace only', () => {
        expect(
            extractPreparationSection(['## Preparation', '', '## Rule syntax'].join('\n')),
        ).toBeUndefined();
        expect(
            extractPreparationSection(['## Preparation', '', '   ', '', '## Policy'].join('\n')),
        ).toBeUndefined();
    });

    it('serves a preparation section that closes the instruction, running its body to the end', () => {
        const instruction = [
            '# Instruction',
            '',
            '## Preparation',
            '',
            'unzip the launcher into the working folder',
        ].join('\n');

        const section = extractPreparationSection(instruction);

        expect(section?.content).toContain('unzip the launcher');
        // The digest is consistent with the returned content itself, not a pinned literal.
        expect(section?.sha256).toBe(
            createHash('sha256')
                .update(section?.content ?? '', 'utf8')
                .digest('hex'),
        );
    });
});
