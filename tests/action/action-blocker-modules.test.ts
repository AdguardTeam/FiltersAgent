import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    ACTION_MODULE_ENVIRONMENT_NAME,
    blockerModuleEntryDependencies,
} from '../../src/action/action-blocker-modules';
import { runFiltersAgentAction } from '../../src/action/action-main';
import {
    AgentEntryExitCode,
    AgentEntryStatus,
    type AgentEntryResult,
} from '../../src/entry/entry-run';
import type { AgentRunInputs } from '../../src/entry/entry-inputs';
import type { Logger } from '../../src/logger/logger';
import { loadBlockerModules } from '../../src/proxy-blocker/blocker-module-loader';

const temporaryRoots: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
});

/**
 * A workspace holding one module manifest.
 */
async function workspaceWithManifest(manifest: unknown): Promise<string> {
    const workspace = await mkdtemp(join(tmpdir(), 'action-modules-'));
    temporaryRoots.push(workspace);
    await writeFile(join(workspace, 'blocker-module.json'), JSON.stringify(manifest));
    return workspace;
}

const MANIFEST = {
    executor: 'demo_proxy',
    selectionGuidance: 'Desktop reports belong to demo_proxy.',
    command: ['node', './module.mjs'],
    env: ['DEMO_LICENSE_KEY'],
};

const quietLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

describe('blocker modules on the action face', () => {
    it('lets the executors input name a plugged-in module beside the browser extension', async () => {
        const workspace = await workspaceWithManifest(MANIFEST);
        let captured: AgentRunInputs | undefined;

        const exitCode = await runFiltersAgentAction({
            probeBrowserBinary: () => ({ installed: true, binaryPath: '/opt/browser' }),
            workspaceOwner: () => ({ uid: 1001, gid: 1001 }),
            handOverArtifactsTree: vi.fn(),
            outputSink: vi.fn(),
            runEntry: async (inputs): Promise<AgentEntryResult> => {
                captured = inputs;
                return {
                    exitCode: AgentEntryExitCode.Success,
                    status: AgentEntryStatus.Success,
                    artifactsDir: join(workspace, 'artifacts'),
                    perIssue: [],
                    remainingIssueNumbers: [],
                };
            },
            env: {
                GITHUB_REPOSITORY: 'AdguardTeam/filters-agent-demo',
                GITHUB_WORKSPACE: workspace,
                INPUT_ISSUENUMBER: '42',
                INPUT_EXECUTORS: 'browser_extension,demo_proxy',
                INPUT_BLOCKERMODULES: 'blocker-module.json',
                INPUT_GITHUBTOKEN: 'gh-token',
                INPUT_LLMBASEURL: 'https://llm.example.test/v1',
                INPUT_LLMAPIKEY: 'llm-key',
                INPUT_LLMMODEL: 'model-a',
                INPUT_LLMVISIONMODEL: 'vision-a',
                INPUT_LLMCONTEXTWINDOWTOKENS: '131072',
                INPUT_LLMMAXOUTPUTTOKENS: '32768',
                INPUT_LLMVISIONMAXOUTPUTTOKENS: '8192',
                DEMO_LICENSE_KEY: 'licence-1',
            },
        });

        expect(exitCode).toBe(AgentEntryExitCode.Success);
        expect(captured?.executors).toEqual(['browser_extension', 'demo_proxy']);
    });

    it('starts modules only for a run that enables them, with only the variables they list', async () => {
        const workspace = await workspaceWithManifest({ ...MANIFEST, executor: 'listed_proxy' });
        const environment = { DEMO_LICENSE_KEY: 'licence-1', UNRELATED_SECRET: 'nope' };
        const modules = loadBlockerModules(
            ['blocker-module.json'],
            workspace,
            environment,
            ACTION_MODULE_ENVIRONMENT_NAME,
        );
        const createRunIssue = vi.fn(() => vi.fn());

        expect(
            blockerModuleEntryDependencies(
                ['browser_extension'],
                modules,
                environment,
                quietLogger,
                createRunIssue,
            ),
        ).toEqual({});
        expect(createRunIssue).not.toHaveBeenCalled();

        blockerModuleEntryDependencies(
            ['listed_proxy'],
            modules,
            environment,
            quietLogger,
            createRunIssue,
        );
        expect(createRunIssue).toHaveBeenCalledWith(expect.any(String), [
            expect.objectContaining({ executor: 'listed_proxy' }),
        ]);
    });
});
