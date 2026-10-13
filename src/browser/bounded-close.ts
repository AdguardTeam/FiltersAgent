import { readdirSync, readFileSync } from 'node:fs';
import type { Logger } from 'pino';

/**
 * Deadline for one graceful browser close before escalating to a forced kill.
 *
 * A close on a wedged page can block in the protocol forever: a close after a navigation timeout
 * has been seen to sit for over an hour inside `close_browser`, until the CI-level SIGTERM killed
 * the process group and the close finally settled. The bound must stay far below every tool
 * deadline so the model regains control.
 */
export const BROWSER_CLOSE_DEADLINE_MS = 30_000;

/**
 * Wait for the graceful close to settle after the browser process was force-killed.
 *
 * Killing the process severs the protocol connection, which normally settles the pending close
 * within milliseconds; this only bounds the pathological case where even that never happens.
 */
export const BROWSER_CLOSE_SETTLE_MS = 5_000;

/**
 * Shortest marker accepted for process-command-line matching.
 *
 * The marker is a session-unique temporary directory path; anything shorter risks matching
 * unrelated processes, and a wrong SIGKILL is worse than an abandoned close.
 */
const MINIMUM_KILL_MARKER_LENGTH = 8;

/**
 * How one bounded browser close ended.
 */
export type BoundedBrowserCloseOutcome = 'graceful' | 'close_failed' | 'forced' | 'abandoned';

/**
 * Per-session overrides for the bounded-close timings.
 */
export interface BrowserCloseTimings {
    /**
     * Wall-clock bound for the graceful close attempt.
     */
    deadlineMs?: number;

    /**
     * Wall-clock bound for the post-kill settlement wait.
     */
    settleMs?: number;
}

/**
 * Inputs for one bounded browser close.
 */
export interface BoundedBrowserCloseOptions {
    /**
     * Starts the graceful close sequence (unroute, listener removal, protocol close).
     */
    gracefulClose: () => Promise<void>;

    /**
     * Force-kills the underlying browser processes; returns how many were killed.
     */
    forceKill: () => number;

    /**
     * Logger receiving the escalation trail.
     */
    logger: Logger;

    /**
     * Wall-clock bound for the graceful close attempt; defaults to the module constant.
     */
    deadlineMs?: number;

    /**
     * Wall-clock bound for the post-kill settlement wait; defaults to the module constant.
     */
    settleMs?: number;
}

/**
 * Race a promise against a wall-clock bound without leaking the timer.
 *
 * @param settled - Promise that resolves when the watched operation settles.
 * @param boundMs - Milliseconds to wait before reporting a timeout.
 * @returns The settlement marker, or 'timeout' when the bound elapsed first.
 */
async function raceAgainstBound<T>(settled: Promise<T>, boundMs: number): Promise<T | 'timeout'> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            settled,
            new Promise<'timeout'>((resolve) => {
                timer = setTimeout(() => resolve('timeout'), boundMs);
            }),
        ]);
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}

/**
 * Close a browser with a hard bound: graceful first, then force-kill, then abandon.
 *
 * Never throws and never blocks past its bounds — a close is teardown, and nothing upstream can act
 * on its failure beyond logging; the escalation trail carries the diagnosis instead.
 *
 * @param options - Close callbacks, logger, and optional timing overrides.
 * @returns How the close ended.
 */
export async function runBoundedBrowserClose(
    options: BoundedBrowserCloseOptions,
): Promise<BoundedBrowserCloseOutcome> {
    const deadlineMs = options.deadlineMs ?? BROWSER_CLOSE_DEADLINE_MS;
    const settleMs = options.settleMs ?? BROWSER_CLOSE_SETTLE_MS;
    let closeError: unknown;
    // Handlers attach immediately so a late rejection after a timeout can never surface as an
    // unhandled rejection.
    const settled = options.gracefulClose().then(
        () => 'closed' as const,
        (error: unknown) => {
            closeError = error;
            return 'close_failed' as const;
        },
    );

    const graceful = await raceAgainstBound(settled, deadlineMs);
    if (graceful === 'closed') {
        return 'graceful';
    }
    if (graceful === 'close_failed') {
        options.logger.warn(
            { error: closeError instanceof Error ? closeError.message : String(closeError) },
            'browser close failed; continuing session teardown',
        );
        return 'close_failed';
    }

    options.logger.warn(
        { deadlineMs },
        'browser close deadline exceeded; force-killing the browser processes',
    );
    let killedProcesses = 0;
    try {
        killedProcesses = options.forceKill();
    } catch (error) {
        options.logger.error(
            { error: error instanceof Error ? error.message : String(error) },
            'browser force kill threw; abandoning the close',
        );
    }

    const afterKill = await raceAgainstBound(settled, settleMs);
    if (afterKill !== 'timeout') {
        options.logger.warn(
            { killedProcesses, closeSettled: afterKill },
            'browser close settled only after the forced kill',
        );
        return 'forced';
    }
    options.logger.error(
        { killedProcesses, deadlineMs, settleMs },
        'browser close abandoned: it never settled even after the forced kill',
    );
    return 'abandoned';
}

/**
 * SIGKILL every process whose command line carries the session-unique directory marker.
 *
 * Playwright exposes no child-process handle for launched browsers, so the only reliable kill route
 * is the kernel's own process table: every process of a persistent-context browser carries its
 * unique `--user-data-dir` (or route-owned temp) path in its command line. Linux-only by
 * construction (`/proc`); on other platforms the caller falls through to the abandoned path, which
 * only ever matters for local development.
 *
 * @param marker - Session-unique directory path expected inside the browser's command line.
 * @param logger - Logger receiving the per-process kill trail.
 * @returns Number of processes killed.
 */
export function forceKillBrowserProcessesByMarker(marker: string, logger: Logger): number {
    if (marker.length < MINIMUM_KILL_MARKER_LENGTH) {
        logger.error(
            { markerLength: marker.length },
            'refusing force kill: marker too short for a safe process match',
        );
        return 0;
    }
    if (process.platform !== 'linux') {
        logger.warn(
            { platform: process.platform },
            'force kill unavailable: process matching relies on /proc and is Linux-only',
        );
        return 0;
    }
    let killed = 0;
    let processEntries: string[];
    try {
        processEntries = readdirSync('/proc');
    } catch (error) {
        logger.error(
            { error: error instanceof Error ? error.message : String(error) },
            'force kill unavailable: /proc could not be read',
        );
        return 0;
    }
    for (const entry of processEntries) {
        if (!/^\d+$/.test(entry)) {
            continue;
        }
        const pid = Number(entry);
        if (pid === process.pid) {
            continue;
        }
        let commandLine: string;
        try {
            commandLine = readFileSync(`/proc/${entry}/cmdline`, 'utf8');
        } catch {
            continue;
        }
        if (!commandLine.includes(marker)) {
            continue;
        }
        try {
            process.kill(pid, 'SIGKILL');
            killed += 1;
            logger.warn(
                { pid, command: commandLine.replaceAll('\0', ' ').slice(0, 200) },
                'force-killed a browser process matched by its session marker',
            );
        } catch (error) {
            logger.warn(
                { pid, error: error instanceof Error ? error.message : String(error) },
                'force kill failed for a matched browser process',
            );
        }
    }
    return killed;
}
