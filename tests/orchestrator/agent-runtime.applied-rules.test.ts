import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserContext, Page, Worker } from 'playwright-core';
import { ToolRegistry } from '../../src/agent/tool-registry';
import { AdGuardExtensionMessageType } from '../../src/browser/adguard-extension-message-types';
import type { BrowserSession } from '../../src/browser/browser-session';
import {
    ExtensionManifestVersion,
    PreparedExtensionSource,
} from '../../src/environment/extension-preparation';
import { AgentRuntime } from '../../src/orchestrator/agent-runtime';
import type { PiRuntime } from '../../src/pi/runtime';
import type { SingleShotClient } from '../../src/pi/single-shot-types';
import { TraceRecorder } from '../../src/tracer/trace-recorder';
import type { IssueFacts } from '../../src/types/issue-facts';
import { testCoreConfig } from '../config/test-core-config';
import {
    fakePreparedExtensionSurface,
    readBackStateFixture,
} from '../environment/test-filtering-environment-fixtures';

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';

const rawIssue = {
    number: 242336,
    url: 'https://github.com/AdguardTeam/AdguardFilters/issues/242336',
    title: 'www.walla.co.il',
    body: 'AdGuard Browser Extension v5.5.2.47 MV3',
    state: 'open' as const,
    labels: ['T: Incorrect Blocking'],
    assignee: null,
    comments: [],
};

const facts: IssueFacts = {
    issueNumber: 242336,
    issueUrl: rawIssue.url,
    reportedSiteUrls: [],
    labels: rawIssue.labels,
    problemType: 'unknown',
    product: 'AdGuard Browser Extension v5.5.2.47 MV3',
    enabledFilters: [{ name: 'AdGuard Base filter', officialFilterId: 2 }],
    screenshots: [],
};

const visionStub: SingleShotClient = {
    modelId: 'vision-model',
    structured: async () => {
        throw new Error('not used by this suite');
    },
    text: async () => {
        throw new Error('not used by this suite');
    },
};

const temporaryRoots: string[] = [];

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

/**
 * A prepared-extension context that records, in order, every extension page it opened and every
 * message the host sent, answering the settings protocol through the shared fake surface and the
 * filtering-log protocol itself.
 */
function recordingExtensionContext(): { context: BrowserContext; order: string[] } {
    const surface = fakePreparedExtensionSurface();
    const order: string[] = [];
    const context = {
        serviceWorkers: () => [
            { url: () => `chrome-extension://${EXTENSION_ID}/pages/background.js` } as Worker,
        ],
        newPage: async (): Promise<Page> => {
            const page = await surface.context.newPage();
            return {
                ...page,
                goto: async (url: string) => {
                    order.push(`open ${new URL(url).pathname}`);
                    return null;
                },
                evaluate: async (fn: unknown, message?: { type: string }) => {
                    if (message === undefined) {
                        return '5.5.2.3';
                    }
                    order.push(message.type);
                    switch (message.type) {
                        case AdGuardExtensionMessageType.GetFilteringLogData:
                            return { filtersMetadata: [] };
                        case AdGuardExtensionMessageType.SynchronizeOpenTabs:
                            return [];
                        default:
                            return await page.evaluate(fn as never, message as never);
                    }
                },
            } as unknown as Page;
        },
    } as unknown as BrowserContext;
    return { context, order };
}

describe('AgentRuntime applied-rules log', () => {
    it("opens the extension's filtering log before the Baseline application imports settings", async () => {
        // The contract: the extension reports the declarative rules Chrome fires only when its log
        // is open while its engine is configured, and the Baseline import is what configures it.
        // Opened after the import, the log would never report a rule such as the EasyList Hebrew
        // $csp rule of walla.co.il, which only Chrome's declarative matching reports.
        const extensionPath = mkdtempSync(join(tmpdir(), 'applied-rules-runtime-'));
        temporaryRoots.push(extensionPath);
        writeFileSync(
            join(extensionPath, 'manifest.json'),
            JSON.stringify({ manifest_version: 3, version: '5.5.2.3' }),
        );
        const { context, order } = recordingExtensionContext();
        const runtime = await AgentRuntime.create(
            {
                issue: rawIssue,
                issueFacts: facts,
                issueAttachmentArtifactIds: [],
                allowedTargetUrls: ['https://www.walla.co.il/'],
                artifactsDir: extensionPath,
                filtersPath: extensionPath,
                headless: true,
                noSandbox: false,
                vision: visionStub,
                recorder: new TraceRecorder({
                    runId: 'agent-runtime-applied-rules',
                    issueNumber: rawIssue.number,
                    mode: 'fix',
                }),
                preparedExtension: {
                    extensionPath,
                    manifestVersion: ExtensionManifestVersion.Mv3,
                    source: PreparedExtensionSource.PinnedRelease,
                    extensionSourceSha256: 'e'.repeat(64),
                    extensionSourceTag: 'v5.5.2.3',
                },
                llm: testCoreConfig().llm,
                piRuntime: {} as unknown as PiRuntime,
            },
            {
                createBaseRegistry: async () => new ToolRegistry(),
                createBrowserSession: async () =>
                    ({ close: vi.fn(), extensionContext: context }) as unknown as BrowserSession,
                createBrowserRegistry: async () => new ToolRegistry(),
                readAdGuardExtensionState: vi.fn(async () => readBackStateFixture([2])),
                findExtensionRuntime: vi.fn(async () => ({
                    extensionId: EXTENSION_ID,
                    manifestVersion: ExtensionManifestVersion.Mv3,
                })),
            },
        );
        await runtime.registry.dispatch('fetch_issue', { issueNumber: rawIssue.number });

        const launched = await runtime.registry.dispatch('launch_browser', {
            extension: 'prepared',
            targetUrl: 'https://www.walla.co.il/',
            profile: {
                viewport: 'desktop',
                locale: 'he-IL',
                timezone: 'Asia/Jerusalem',
                consentStrategy: 'untouched',
            },
            settings: { kind: 'agent_selected', filterIds: [2], stealthEnabled: false },
        });

        expect(launched).toMatchObject({ launched: true });
        const logOpened = order.indexOf('open /pages/filtering-log.html');
        const settingsImported = order.indexOf(AdGuardExtensionMessageType.ApplySettingsJson);
        expect(logOpened).toBeGreaterThanOrEqual(0);
        expect(settingsImported).toBeGreaterThan(logOpened);
        await runtime.dispose();
    });
});
