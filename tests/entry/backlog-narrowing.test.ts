import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveBacklogNarrowing } from '../../src/entry/backlog-narrowing';
import { DEFAULT_INSTRUCTION_PATH } from '../../src/knowledge/instruction-loader';
import { SelectionNarrowingError } from '../../src/knowledge/instruction-selection';

const createdDirs: string[] = [];

/**
 * Create one throwaway checkout root, removed after each test.
 *
 * @returns Absolute path to the created directory.
 */
function checkoutRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'backlog-narrowing-'));
    createdDirs.push(dir);
    return dir;
}

afterEach(() => {
    for (const dir of createdDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

/**
 * Write the default-path instruction file under one checkout root.
 *
 * @param root - The checkout root.
 * @param content - Instruction Markdown.
 */
function writeInstruction(root: string, content: string): void {
    const path = join(root, DEFAULT_INSTRUCTION_PATH);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');
}

describe('resolveBacklogNarrowing', () => {
    it('parses the ## Issue selection section into typed narrowing', async () => {
        const root = checkoutRoot();
        writeInstruction(
            root,
            [
                '# Guidance',
                '',
                '## Issue selection',
                '- labels: T: Ads',
                '- max-age-days: 30',
                '',
            ].join('\n'),
        );

        const narrowing = await resolveBacklogNarrowing(root, undefined);

        expect(narrowing).toEqual({ labels: ['T: Ads'], maxAgeDays: 30 });
    });

    it('returns undefined when the checkout carries no instruction', async () => {
        const narrowing = await resolveBacklogNarrowing(checkoutRoot(), undefined);

        expect(narrowing).toBeUndefined();
    });

    it('returns undefined when the instruction carries no selection section', async () => {
        const root = checkoutRoot();
        writeInstruction(
            root,
            ['# Guidance', '', 'Just prose, no selection section.', ''].join('\n'),
        );

        const narrowing = await resolveBacklogNarrowing(root, undefined);

        expect(narrowing).toBeUndefined();
    });

    it('throws naming a malformed selection item instead of silently dropping it', async () => {
        const root = checkoutRoot();
        writeInstruction(
            root,
            ['# Guidance', '', '## Issue selection', '- max-age-days: not-a-number', ''].join('\n'),
        );

        await expect(resolveBacklogNarrowing(root, undefined)).rejects.toThrow(
            SelectionNarrowingError,
        );
    });
});
