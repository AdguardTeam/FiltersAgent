import type { Browser, BrowserContext } from 'playwright-core';
import type { Logger } from 'pino';

/**
 * The kill handle every browser launch keeps: the pid of Playwright's own browser process.
 *
 * A close on a wedged page can block in the protocol forever, and the escalation after the close
 * deadline is only as good as what it has to kill. A `/proc` command-line scan for a session-unique
 * profile path cannot find a plain `launch()`, which has no such path (Playwright picks its own
 * temporary profile and never tells the caller where): without the pid the forced kill reports "no
 * session-owned profile path: this browser cannot be force-killed" with `killedProcesses: 0`, and
 * every session spends 35 s waiting for a kill that cannot happen.
 *
 * Playwright publishes no process accessor on `Browser` (only `BrowserServer.process()`, which
 * belongs to the `launchServer` route this repo does not take), so the pid comes from the
 * in-process client-to-server bridge every local `playwright-core` connection carries. It is an
 * internal seam by necessity: reached defensively, logged when it is not there, and never required
 * for a launch to succeed.
 */

/**
 * The client-side connection field of a playwright-core object, with the in-process bridge that
 * resolves a client handle to its server-side implementation.
 *
 * Shaped as "everything optional" deliberately: this is a private seam of a pinned dependency, so
 * the reader proves what it found instead of asserting a contract nobody promised.
 */
interface PlaywrightClientHandle {
    /**
     * The client connection owning this handle, when the object is a playwright channel owner.
     */
    _connection?: {
        /**
         * In-process bridge from a client handle to its server-side implementation; present only
         * for a local connection (absent over `connect`/`connectOverCDP`).
         */
        toImpl?: (handle: unknown) => unknown;
    };
}

/**
 * The server-side browser implementation, as far as the pid read needs it.
 */
interface PlaywrightBrowserImpl {
    /**
     * Launch options of the server-side browser, carrying the spawned process handle.
     */
    options?: {
        /**
         * The spawned browser process wrapper Playwright manages.
         */
        browserProcess?: {
            /**
             * The Node child process of the browser, absent for a connected (not spawned) browser.
             */
            process?: {
                /**
                 * Operating-system pid of the browser process.
                 */
                pid?: number;
            };
        };
    };
}

/**
 * Resolve the `Browser` behind a launched session handle.
 *
 * A persistent context exposes its browser through the public `BrowserContext.browser()`; a plain
 * launch already is the browser.
 *
 * @param handle - The launched browser or persistent context the session owns.
 * @returns The browser handle, or undefined when a persistent context reports none.
 */
function resolveBrowser(handle: Browser | BrowserContext): Browser | undefined {
    if ('browser' in handle && typeof handle.browser === 'function') {
        return handle.browser() ?? undefined;
    }
    return handle as Browser;
}

/**
 * Read the pid of the browser process behind one launched session handle.
 *
 * @param handle - The launched browser or persistent context the session owns.
 * @param logger - Logger receiving the resolved pid, or the reason there is none.
 * @returns The browser process pid, or undefined when this handle exposes none.
 */
export function readBrowserProcessPid(
    handle: Browser | BrowserContext,
    logger: Logger,
): number | undefined {
    const browser = resolveBrowser(handle);
    if (browser === undefined) {
        logger.warn({}, 'browser kill handle unavailable: the session handle exposes no browser');
        return undefined;
    }
    // The leading underscore is playwright's own spelling of the member, not a convention this
    // codebase adopts: the seam IS that private field, so the name cannot be chosen.
    /* oxlint-disable no-underscore-dangle */
    const connection = (browser as unknown as PlaywrightClientHandle)._connection;
    /* oxlint-enable no-underscore-dangle */
    const toImpl = connection?.toImpl;
    if (typeof toImpl !== 'function') {
        logger.warn(
            { hasConnection: connection !== undefined },
            'browser kill handle unavailable: this playwright connection exposes no in-process ' +
                'bridge, so the browser process cannot be named',
        );
        return undefined;
    }
    let impl: unknown;
    try {
        impl = toImpl(browser);
    } catch (error) {
        logger.warn(
            { error: error instanceof Error ? error.message : String(error) },
            'browser kill handle unavailable: the in-process bridge rejected the browser handle',
        );
        return undefined;
    }
    const pid = (impl as PlaywrightBrowserImpl | undefined)?.options?.browserProcess?.process?.pid;
    if (typeof pid !== 'number') {
        logger.warn(
            { implResolved: impl !== undefined },
            'browser kill handle unavailable: the launched browser reports no process pid',
        );
        return undefined;
    }
    logger.info({ browserProcessPid: pid }, 'browser launch kill handle recorded');
    return pid;
}

/**
 * SIGKILL one browser process and the process group it leads.
 *
 * Playwright spawns the browser detached on every non-Windows platform, which makes it the leader
 * of its own process group — so signalling the negated pid reaches the renderers and helper
 * processes too, not just the parent. The group signal is attempted first and the parent second, so
 * a browser whose children already exited is still killed.
 *
 * @param pid - Pid of the browser process recorded at launch.
 * @param logger - Logger receiving each delivered signal and each refusal.
 * @returns How many kill signals were delivered.
 */
export function forceKillBrowserProcessTree(pid: number, logger: Logger): number {
    let killed = 0;
    const targets =
        process.platform === 'win32'
            ? [pid]
            : // The group first: it carries the renderers, the GPU process and every helper.
              [-pid, pid];
    for (const target of targets) {
        try {
            process.kill(target, 'SIGKILL');
            killed += 1;
            logger.warn(
                { browserProcessPid: pid, signalledPid: target },
                'force-killed the browser process recorded at launch',
            );
        } catch (error) {
            logger.warn(
                {
                    browserProcessPid: pid,
                    signalledPid: target,
                    error: error instanceof Error ? error.message : String(error),
                },
                'force kill of the recorded browser process was refused (it may already be gone)',
            );
        }
    }
    return killed;
}
