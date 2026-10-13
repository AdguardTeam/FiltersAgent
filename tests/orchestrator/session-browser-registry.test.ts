import { describe, expect, it, vi } from 'vitest';
import type { BrowserContext, Page, Worker } from 'playwright-core';
import type { BrowserSession } from '../../src/browser/browser-session';
import type { AppliedRulesLog } from '../../src/environment/applied-rules';
import { ExtensionLaunchFamily } from '../../src/environment/extension-launch';
import {
    ExtensionManifestVersion,
    PreparedExtensionSource,
} from '../../src/environment/extension-preparation';
import type { EvidenceRouteHost } from '../../src/local/evidence-route-contract';
import type { PreparedExtension } from '../../src/local/prepared-extension';
import type { Logger } from '../../src/logger/logger';
import { openSessionAppliedRulesLog } from '../../src/orchestrator/session-browser-registry';

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';

/**
 * The pinned release a built-in AdGuard run loads.
 */
const PINNED_BUILD: PreparedExtension = {
    extensionPath: '/prepared/extension',
    manifestVersion: ExtensionManifestVersion.Mv3,
    source: PreparedExtensionSource.PinnedRelease,
    extensionSourceSha256: 'e'.repeat(64),
    extensionSourceTag: 'v5.5.2.3',
};

function capturingLogger(): Logger & { error: ReturnType<typeof vi.fn> } {
    return {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    } as unknown as Logger & { error: ReturnType<typeof vi.fn> };
}

/**
 * A prepared-extension session whose extension pages fail to load.
 */
function sessionWhosePagesFail(): BrowserSession {
    const page = {
        goto: vi.fn().mockRejectedValue(new Error('net::ERR_FILE_NOT_FOUND')),
        close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Page;
    const context = {
        serviceWorkers: () => [
            { url: () => `chrome-extension://${EXTENSION_ID}/pages/background.js` } as Worker,
        ],
        newPage: vi.fn().mockResolvedValue(page),
    } as unknown as BrowserContext;
    return { extensionContext: context } as unknown as BrowserSession;
}

describe('openSessionAppliedRulesLog', () => {
    it('reads a proxied session through the route that launched it', async () => {
        const routeLog: AppliedRulesLog = { read: vi.fn() };
        const route = {
            openAppliedRulesLog: vi.fn(async () => routeLog),
        } as unknown as EvidenceRouteHost;
        const session = {} as BrowserSession;
        const logger = capturingLogger();

        const log = await openSessionAppliedRulesLog({
            session,
            evidenceRoute: route,
            extension: undefined,
            builtInAdGuardRoute: true,
            logger,
        });

        expect(log).toBe(routeLog);
        // The route reads the session's own pages, so it must get that session.
        expect(route.openAppliedRulesLog).toHaveBeenCalledWith(session, logger);
    });

    it('gives a control session no log, so it never offers the tool', async () => {
        const log = await openSessionAppliedRulesLog({
            session: {} as BrowserSession,
            evidenceRoute: null,
            extension: undefined,
            builtInAdGuardRoute: true,
            logger: capturingLogger(),
        });

        expect(log).toBeUndefined();
    });

    it('gives an instruction-defined or Firefox blocker no log', async () => {
        const firefoxBuild = {
            ...PINNED_BUILD,
            launchFamily: ExtensionLaunchFamily.Firefox,
        } as unknown as PreparedExtension;
        for (const [extension, builtInAdGuardRoute] of [
            [firefoxBuild, true],
            [PINNED_BUILD, false],
        ] as const) {
            const log = await openSessionAppliedRulesLog({
                session: sessionWhosePagesFail(),
                evidenceRoute: null,
                extension,
                builtInAdGuardRoute,
                logger: capturingLogger(),
            });

            expect(log).toBeUndefined();
        }
    });

    it('logs a log page that failed to open, with its cause, and gives the session no log', async () => {
        const logger = capturingLogger();

        const log = await openSessionAppliedRulesLog({
            session: sessionWhosePagesFail(),
            evidenceRoute: null,
            extension: PINNED_BUILD,
            builtInAdGuardRoute: true,
            logger,
        });

        expect(log).toBeUndefined();
        const [fields] = logger.error.mock.calls[0] as [{ err: Error }];
        expect(fields.err.message).toContain('net::ERR_FILE_NOT_FOUND');
    });
});
