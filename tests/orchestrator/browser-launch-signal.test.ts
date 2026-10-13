import { describe, expect, it } from 'vitest';
import { extractBrowserLaunchSignal } from '../../src/orchestrator/browser-launch-signal';

const SIGTRAP_MESSAGE =
    'browserType.launchPersistentContext: Target page, context or browser has been closed\n' +
    '[pid=132] <gracefully close start>\n' +
    '[pid=132] <process did exit: exitCode=null, signal=SIGTRAP>';

describe('extractBrowserLaunchSignal', () => {
    it('reads the fatal signal from a direct launch failure', () => {
        expect(extractBrowserLaunchSignal(new Error(SIGTRAP_MESSAGE))).toBe('SIGTRAP');
    });

    it('walks wrapper causes down to the engine error carrying the signal', () => {
        const engineError = new Error(SIGTRAP_MESSAGE);
        const wrapped = new Error('Failed to launch cloakbrowser through strict route.', {
            cause: engineError,
        });
        const routeError = new Error('AdGuard CLI evidence route failed: browser_launch_failed.', {
            cause: wrapped,
        });

        expect(extractBrowserLaunchSignal(routeError)).toBe('SIGTRAP');
    });

    it('returns null when no process signal appears anywhere in the chain', () => {
        const timeout = new Error('browserType.launchPersistentContext: Timeout 30000ms exceeded');
        expect(extractBrowserLaunchSignal(timeout)).toBeNull();
        expect(extractBrowserLaunchSignal(new Error('plain failure'))).toBeNull();
        expect(extractBrowserLaunchSignal('not an error')).toBeNull();
        expect(extractBrowserLaunchSignal(null)).toBeNull();
    });

    it('stops at a bounded cause depth instead of looping on a cyclic chain', () => {
        const cyclic: Error & { cause?: unknown } = new Error('cycle without signal');
        cyclic.cause = cyclic;

        expect(extractBrowserLaunchSignal(cyclic)).toBeNull();
    });
});
