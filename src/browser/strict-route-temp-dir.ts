import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Short-lived private temporary directory for one strict-route browser process tree.
 *
 * Chromium's `ProcessSingleton` creates its singleton socket at
 * `$TMPDIR/org.chromium.Chromium.XXXXXX/SingletonSocket` and guards the copy into
 * `sockaddr_un::sun_path` with `CHECK(path.length() < 108)` on Linux glibc — a browser whose
 * `TMPDIR` is deeper than ~60 characters dies on SIGTRAP during startup, before its own logging
 * initializes. The strict route's route-owned directory tree is exactly that deep (a `<route
 * root>/evidence-browser-<cycle>/tmp` shape is ~90 characters), so the browser's temporary
 * directory must live under a short, flat path instead. The directory holds only the dead singleton
 * socket and browser scratch: everything with diagnostic value (profile, XDG directories carrying
 * crashpad dumps, logs) stays route-owned.
 */
export interface StrictRouteTempDir {
    /**
     * Absolute short path passed to the browser as `TMPDIR`/`TMP`/`TEMP`.
     */
    path: string;

    /**
     * Best-effort recursive removal; safe to call after the browser already cleaned up.
     */
    dispose: () => void;
}

/**
 * Create the private temporary directory for one strict-route browser launch.
 *
 * Anchored at `/tmp` rather than `os.tmpdir()`: the budget is `TMPDIR` length plus the fixed
 * 45-character singleton-socket suffix staying under the 108-byte `sun_path`, and an inherited
 * `TMPDIR` (or a macOS per-user temp root) can be arbitrarily deep. `/tmp` is the shortest base
 * every supported host already has.
 *
 * @returns The directory path and its disposal handle.
 */
export function createStrictRouteTempDir(): StrictRouteTempDir {
    const path = mkdtempSync(join('/tmp', 'adguard-agent-cb-'));
    chmodSync(path, 0o700);
    return {
        path,
        dispose: () => rmSync(path, { recursive: true, force: true }),
    };
}
