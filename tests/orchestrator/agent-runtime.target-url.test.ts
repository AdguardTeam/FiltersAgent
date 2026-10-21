import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../../src/agent/tool-registry';
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

/**
 * The reported page as Markdown-rendered issue text carries it: query separators escaped.
 */
const ESCAPED_REPORTED_URL = 'https://www.example.com/compare.php?first=1&amp;second=2';

/**
 * The page the reporter actually visited.
 */
const DECODED_REPORTED_URL = 'https://www.example.com/compare.php?first=1&second=2';

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

async function createRuntime(allowedTargetUrls: string[]): Promise<AgentRuntime> {
    const root = mkdtempSync(join(tmpdir(), 'target-url-runtime-'));
    roots.push(root);
    writeFileSync(
        join(root, 'manifest.json'),
        JSON.stringify({ manifest_version: 3, version: '5.5.2.3' }),
    );
    const issue = {
        number: 1,
        url: 'https://github.com/example-owner/example-repo/issues/1',
        title: 'example.com',
        body: `### Issue URL (Incorrect Blocking)\n${ESCAPED_REPORTED_URL}`,
        state: 'open' as const,
        labels: [],
        assignee: null,
        comments: [],
    };
    const runtime = await AgentRuntime.create(
        {
            issue,
            issueFacts: {
                issueNumber: issue.number,
                issueUrl: issue.url,
                reportedSiteUrls: allowedTargetUrls,
                labels: [],
                problemType: 'unknown',
                product: 'AdGuard Browser Extension v5.5.2.3 MV3',
                enabledFilters: [{ name: 'AdGuard Base filter', officialFilterId: 2 }],
                screenshots: [],
            } as IssueFacts,
            issueAttachmentArtifactIds: [],
            allowedTargetUrls,
            artifactsDir: root,
            filtersPath: root,
            preparedExtension: {
                extensionPath: root,
                manifestVersion: ExtensionManifestVersion.Mv3,
                userScriptsPermission: true,
                source: PreparedExtensionSource.PinnedRelease,
                extensionSourceSha256: 'e'.repeat(64),
                extensionSourceTag: 'v5.5.2.3',
            },
            headless: true,
            noSandbox: false,
            vision: {} as SingleShotClient,
            recorder: new TraceRecorder({
                runId: 'target-url-runtime',
                issueNumber: 1,
                mode: 'fix',
            }),
            llm: testCoreConfig().llm,
            piRuntime: {} as PiRuntime,
        },
        {
            createBaseRegistry: async () => new ToolRegistry(),
            createBrowserSession: async () => ({ close: vi.fn() }) as unknown as BrowserSession,
            createBrowserRegistry: async () => new ToolRegistry(),
        },
    );
    await runtime.registry.dispatch('fetch_issue', { issueNumber: 1 });
    return runtime;
}

async function launch(runtime: AgentRuntime, targetUrl: string) {
    return await runtime.registry.dispatch('launch_browser', {
        extension: 'none',
        targetUrl,
        profile: {
            viewport: 'desktop',
            locale: 'en-US',
            timezone: 'UTC',
            consentStrategy: 'untouched',
        },
    });
}

describe('AgentRuntime target URL binding', () => {
    it.each([
        ['the decoded spelling', ESCAPED_REPORTED_URL, DECODED_REPORTED_URL],
        ['the escaped spelling', ESCAPED_REPORTED_URL, ESCAPED_REPORTED_URL],
        ['the escaped spelling of a decoded report', DECODED_REPORTED_URL, ESCAPED_REPORTED_URL],
    ])(
        'binds %s of an allowed URL to the decoded reported page',
        async (_spelling, allowedUrl, requestedUrl) => {
            // A model that decodes the issue's `&amp;` separators asks for the page the reporter
            // visited; one that copies the issue text verbatim must still bind to it, so
            // validation never opens a page whose parameters are named `amp;<name>`.
            const runtime = await createRuntime([allowedUrl]);
            try {
                await expect(launch(runtime, requestedUrl)).resolves.toMatchObject({
                    launched: true,
                    targetUrl: DECODED_REPORTED_URL,
                });
            } finally {
                await runtime.dispose();
            }
        },
    );

    it('still refuses a page the issue does not report', async () => {
        const runtime = await createRuntime([ESCAPED_REPORTED_URL]);
        try {
            await expect(
                launch(runtime, 'https://www.example.com/compare.php?first=1&second=3'),
            ).resolves.toMatchObject({ errorKind: 'target_url_not_allowed', retryable: true });
        } finally {
            await runtime.dispose();
        }
    });
});
