import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scanScript = join(repoRoot, 'lint', 'scan-prompt-documents.mjs');

/**
 * Write one fixture document under a throwaway scan root.
 */
function writeFixture(root: string, rel: string, content: string): void {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
}

/**
 * Run the real prompt-documents scan script over a fixture root.
 */
function scanFixture(files: Record<string, string>): { status: number; output: string } {
    const root = mkdtempSync(join(tmpdir(), 'prompt-document-scan-'));
    for (const [rel, content] of Object.entries(files)) {
        writeFixture(root, rel, content);
    }
    try {
        const output = execFileSync('node', [scanScript, root], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { status: 0, output };
    } catch (error) {
        const failure = error as { status?: number; stdout?: string; stderr?: string };
        return {
            status: failure.status ?? -1,
            output: `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`,
        };
    }
}

describe('prompt documents boundary scan', () => {
    it('fails and names every document that mentions the lab executor vocabulary', () => {
        const { status, output } = scanFixture({
            'src/prompts/documents/system.md':
                'Lock `adguard_cli` or one of the other advertised environments.\n',
            'src/prompts/documents/fix-context/selection-first.md':
                'A ready adguard_cli selection exposes the proxied browser.\n',
            'src/prompts/documents/nudge.md': 'End the run with the terminal tool.\n',
        });
        expect(status).not.toBe(0);
        expect(output).toContain('src/prompts/documents/system.md');
        expect(output).toContain('src/prompts/documents/fix-context/selection-first.md');
        expect(output).not.toContain('src/prompts/documents/nudge.md');
    });

    it('passes a clean document tree, including lab vocabulary kept outside the scanned root', () => {
        const { status, output } = scanFixture({
            'src/prompts/documents/system.md':
                'Lock one of the environments the description advertises.\n',
            'src/prompts/documents/fix-context/selection-first.md':
                'Call select_environment exactly once.\n',
            'src/prompts/notes.md': 'Registration prose lives in the lab executor module.\n',
        });
        expect(status).toBe(0);
        expect(output).toContain('passed');
    });
});
