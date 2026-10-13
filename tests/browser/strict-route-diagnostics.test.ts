import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    createStrictRouteDiagnostics,
    readLogFileTail,
} from '../../src/browser/strict-route-diagnostics';

describe('strict-route diagnostics', () => {
    let dir: string | undefined;

    afterEach(() => {
        if (dir) {
            rmSync(dir, { recursive: true, force: true });
        }
        dir = undefined;
    });

    it('points the Chromium log inside the route logs directory and keeps crash reporting', () => {
        dir = mkdtempSync(join(tmpdir(), 'strict-diag-'));
        const diagnostics = createStrictRouteDiagnostics(dir);

        expect(diagnostics.chromiumLogPath).toBe(join(dir, 'browser-chromium.log'));
        expect(diagnostics.ignoreDefaultArgs).toContain('--disable-breakpad');
    });

    it('tees only browser process output into the route logs directory', () => {
        dir = mkdtempSync(join(tmpdir(), 'strict-diag-'));
        const diagnostics = createStrictRouteDiagnostics(dir);

        expect(diagnostics.browserProcessLogger.isEnabled('browser', 'error')).toBe(true);
        expect(diagnostics.browserProcessLogger.isEnabled('api', 'error')).toBe(false);
        diagnostics.browserProcessLogger.log(
            'api',
            'info',
            'launchPersistentContext called',
            [],
            {},
        );
        diagnostics.browserProcessLogger.log(
            'browser',
            'error',
            '[1:1:0101/000000.000000:FATAL:check.cc] Check failed: example.',
            [],
            {},
        );

        const teed = readFileSync(join(dir, 'browser-output.log'), 'utf8');
        expect(teed).toContain('FATAL:check.cc');
        expect(teed).not.toContain('launchPersistentContext called');
    });

    it('reads a bounded log tail and tolerates a missing log', () => {
        dir = mkdtempSync(join(tmpdir(), 'strict-diag-'));
        const logPath = join(dir, 'browser-chromium.log');
        expect(readLogFileTail(logPath)).toBeUndefined();

        writeFileSync(logPath, 'line one\n');
        expect(readLogFileTail(logPath)).toBe('line one\n');

        writeFileSync(logPath, `head${'x'.repeat(10_000)}tail`);
        const tail = readLogFileTail(logPath, 2_048);
        expect(tail?.length).toBe(2_048);
        expect(tail).toContain('tail');
        expect(tail).not.toContain('head');
    });
});
