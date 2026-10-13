import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/logger/logger';
import { createListLineCounter } from '../../src/orchestrator/list-slice-launch';

const BASE_FILTER_ID = 2;
const HEBREW_FILTER_ID = 108;

let extensionPath: string | undefined;

afterEach(() => {
    if (extensionPath !== undefined) {
        rmSync(extensionPath, { recursive: true, force: true });
        extensionPath = undefined;
    }
});

function silentLogger(): Logger {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

/**
 * Writes one list's ruleset JSON under an unpacked build root, its dummy first rule carrying the
 * list text.
 */
function writeRuleset(root: string, filterId: number, lines: readonly string[]): string {
    const rulesetDir = join(root, 'filters', 'declarative', `ruleset_${filterId}`);
    mkdirSync(rulesetDir, { recursive: true });
    const rulesetPath = join(rulesetDir, `ruleset_${filterId}.json`);
    writeFileSync(
        rulesetPath,
        JSON.stringify([
            {
                id: 1,
                priority: 1,
                action: { type: 'allow' },
                condition: { urlFilter: 'dummy-metadata-rule' },
                metadata: { filterContent: `${lines.join('\r\n')}\r\n` },
            },
        ]),
    );
    return rulesetPath;
}

describe('createListLineCounter', () => {
    it('reads each list once per run, whether the build carries its text or not', () => {
        extensionPath = mkdtempSync(join(tmpdir(), 'list-line-counter-'));
        const basePath = writeRuleset(extensionPath, BASE_FILTER_ID, ['! Title: Base', 'a##.b']);
        const lineCountOf = createListLineCounter(extensionPath, silentLogger());

        expect(lineCountOf(BASE_FILTER_ID)).toBe(2);
        expect(lineCountOf(HEBREW_FILTER_ID)).toBeNull();

        // The run answers from memory after the first read: a ruleset removed or added afterwards
        // changes nothing until the next run, and a list without text is read (and logged) once.
        rmSync(basePath);
        writeRuleset(extensionPath, HEBREW_FILTER_ID, ['! Title: Hebrew', 'c##.d', 'e##.f']);
        expect(lineCountOf(BASE_FILTER_ID)).toBe(2);
        expect(lineCountOf(HEBREW_FILTER_ID)).toBeNull();
    });
});
