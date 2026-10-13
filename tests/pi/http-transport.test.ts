import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('the HTTP transport a run uses', () => {
    it('survives a response read after the server closed the connection', async () => {
        // Live passes 2026-09-28..30: the gateway closed a connection whose streamed body the
        // client had not drained, Node's bundled HTTP client asserted inside its parser, and the
        // whole process died — more than half of all runs. The assertion is thrown from a socket
        // event, so it cannot be caught; the probe runs in its own process for that reason.
        const { stdout } = await execFileAsync(
            resolve('node_modules/.bin/tsx'),
            [resolve('tests/pi/fixtures/http-transport-fin-probe.ts')],
            { cwd: resolve('.'), timeout: 20_000 },
        );

        expect(JSON.parse(stdout)).toEqual({ bytes: 64 * 1024, status: 200 });
    }, 30_000);
});
