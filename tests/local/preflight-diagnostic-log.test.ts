import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    installPreflightDiagnosticLog,
    openPreflightDiagnosticLog,
    recordPreflightDiagnostic,
} from '../../src/local/preflight-diagnostic-log';

function readRecords(path: string): { channel: string; detail: unknown }[] {
    return readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { channel: string; detail: unknown });
}

describe('preflight diagnostic log', () => {
    const roots: string[] = [];

    afterEach(() => {
        installPreflightDiagnosticLog(null);
        for (const root of roots.splice(0)) {
            rmSync(root, { recursive: true, force: true });
        }
    });

    /*
     * The contract: a run whose public transcript reports only a finite code still leaves the
     * native cause behind it on disk, and never leaves the license there with it.
     */
    it('accepts records when no sink is installed and stops recording after close', () => {
        const root = mkdtempSync(join(tmpdir(), 'preflight-diagnostic-'));
        roots.push(root);
        expect(() => recordPreflightDiagnostic('run', { phase: 'started' })).not.toThrow();

        const log = openPreflightDiagnosticLog(join(root, 'artifacts'));
        installPreflightDiagnosticLog(log);
        log.close({ phase: 'finished' });
        recordPreflightDiagnostic('browser', { error: 'after close' });

        const records = readRecords(log.path);
        expect(records).toHaveLength(1);
        expect(records[0]?.channel).toBe('run');
    });
});
