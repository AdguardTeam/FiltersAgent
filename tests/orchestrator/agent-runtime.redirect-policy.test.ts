import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../../src/agent/tool-registry';
import type { BrowserSession } from '../../src/browser/browser-session';
import { RedirectOriginPolicy } from '../../src/browser/redirect-origin-policy';
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

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

async function launchedSessionPolicies(policy?: RedirectOriginPolicy) {
    const root = mkdtempSync(join(tmpdir(), 'redirect-runtime-'));
    roots.push(root);
    writeFileSync(
        join(root, 'manifest.json'),
        JSON.stringify({ manifest_version: 3, version: '5.5.2.3' }),
    );
    const issue = {
        number: 1,
        url: 'https://github.com/example-owner/example-repo/issues/1',
        title: 'example.com',
        body: '',
        state: 'open' as const,
        labels: [],
        assignee: null,
        comments: [],
    };
    const policies: RedirectOriginPolicy[] = [];
    const runtime = await AgentRuntime.create(
        {
            issue,
            issueFacts: {
                issueNumber: issue.number,
                issueUrl: issue.url,
                reportedSiteUrls: [],
                labels: [],
                problemType: 'unknown',
                product: 'AdGuard Browser Extension v5.5.2.3 MV3',
                enabledFilters: [{ name: 'AdGuard Base filter', officialFilterId: 2 }],
                screenshots: [],
            } as IssueFacts,
            issueAttachmentArtifactIds: [],
            allowedTargetUrls: ['https://example.com/'],
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
            recorder: new TraceRecorder({ runId: 'redirect-runtime', issueNumber: 1, mode: 'fix' }),
            llm: testCoreConfig().llm,
            piRuntime: {} as PiRuntime,
            ...(policy === undefined ? {} : { redirectOriginPolicy: policy }),
        },
        {
            createBaseRegistry: async () => new ToolRegistry(),
            createBrowserSession: async () => ({ close: vi.fn() }) as unknown as BrowserSession,
            createBrowserRegistry: async (context) => {
                policies.push(context.redirectOriginPolicy);
                return new ToolRegistry();
            },
        },
    );
    try {
        await runtime.registry.dispatch('fetch_issue', { issueNumber: 1 });
        for (const viewport of ['desktop', 'mobile']) {
            const launched = await runtime.registry.dispatch('launch_browser', {
                extension: 'none',
                targetUrl: 'https://example.com/',
                profile: {
                    viewport,
                    locale: 'en-US',
                    timezone: 'UTC',
                    consentStrategy: 'untouched',
                },
            });
            expect(launched).toMatchObject({ launched: true });
        }
        return policies;
    } finally {
        await runtime.dispose();
    }
}

describe('AgentRuntime redirect policy', () => {
    it("hands the run's redirect policy to every session's browser tools", async () => {
        // Each isolated browser session must preserve the historical navigation boundary.
        expect(await launchedSessionPolicies(RedirectOriginPolicy.KeepRelatedHosts)).toEqual([
            RedirectOriginPolicy.KeepRelatedHosts,
            RedirectOriginPolicy.KeepRelatedHosts,
        ]);
    });

    it('defaults session browser tools to keeping every landing origin', async () => {
        // Existing callers retain live navigation behavior without setting a policy.
        expect(await launchedSessionPolicies()).toEqual([
            RedirectOriginPolicy.KeepEveryLanding,
            RedirectOriginPolicy.KeepEveryLanding,
        ]);
    });
});
