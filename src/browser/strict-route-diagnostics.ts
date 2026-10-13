import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger as PlaywrightLogger } from 'playwright-core';

/**
 * Playwright default switches the strict route withholds.
 *
 * Playwright launches Chromium with crash reporting disabled (`--disable-breakpad`), so a launch
 * crash leaves no dump behind. A strict route exists to diagnose filtering runs, and its launch
 * crashes must stay readable: withholding the switch re-enables the crashpad handler, whose dumps
 * land inside the route-owned profile directory and are preserved with the route root on failure.
 */
const STRICT_ROUTE_IGNORED_DEFAULT_ARGS = ['--disable-breakpad'] as const;

/**
 * Diagnostics sinks for one strict-route browser launch.
 *
 * Everything lives under the route root's `logs` directory, so a launch failure that preserves the
 * route root keeps the browser's own words next to the profile and crash dumps it produced.
 */
export interface StrictRouteDiagnostics {
    /**
     * Absolute path Chromium writes its own log to via `--enable-logging --log-file`, including the
     * FATAL line a startup CHECK emits before the process traps.
     */
    chromiumLogPath: string;

    /**
     * Playwright logger sink teeing the browser process tree's merged stdout/stderr into
     * `browser-output.log` beside the Chromium log.
     */
    browserProcessLogger: PlaywrightLogger;

    /**
     * Playwright default switches the route withholds so crash reporting stays enabled.
     */
    ignoreDefaultArgs: readonly string[];
}

/**
 * Create the diagnostics sinks bound to one route-owned logs directory.
 *
 * @param logsDir - Route-owned logs directory, already created and privacy-checked.
 * @returns Chromium log path, browser output tee, and withheld default switches.
 */
export function createStrictRouteDiagnostics(logsDir: string): StrictRouteDiagnostics {
    const browserOutputPath = join(logsDir, 'browser-output.log');
    return {
        chromiumLogPath: join(logsDir, 'browser-chromium.log'),
        ignoreDefaultArgs: STRICT_ROUTE_IGNORED_DEFAULT_ARGS,
        browserProcessLogger: {
            isEnabled: (name) => name === 'browser',
            log: (name, _severity, message) => {
                if (name !== 'browser') {
                    return;
                }
                try {
                    appendFileSync(browserOutputPath, `${String(message)}\n`);
                } catch {
                    // The tee is a diagnostic side channel: it must never break the launch it
                    // observes, even when the logs directory disappears under it.
                }
            },
        },
    };
}

/**
 * Read the bounded tail of a strict-route log for the run log.
 *
 * @param logPath - Absolute log path, possibly never written by the crashed browser.
 * @param maxBytes - Maximum characters kept from the end of the file.
 * @returns The tail, or undefined when the log does not exist or cannot be read.
 */
export function readLogFileTail(logPath: string, maxBytes = 4_096): string | undefined {
    try {
        const content = readFileSync(logPath, 'utf8');
        return content.length > maxBytes ? content.slice(-maxBytes) : content;
    } catch {
        return undefined;
    }
}
