import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { BlockerContract } from '../../src/blocker-contract/blocker-contract';
import {
    DefaultSingleIssueResultKind,
    type DefaultSingleIssueDependencies,
    type DefaultSingleIssueRequest,
} from '../../src/entry/single-issue-run-types';
import type { FixCoreOptions } from '../../src/orchestrator/fix-core-inputs';
import type { BlockerModuleRunDependencies } from '../../src/proxy-blocker/blocker-module-executor';
import { createBlockerModuleRunIssue } from '../../src/proxy-blocker/blocker-module-run-issue';
import { BrowserMode } from '../../src/types/browser-mode';
import { EffectiveMode, FixRunStatus, VerificationStatus } from '../../src/types/fix-run-result';
import type { FixRunResult } from '../../src/types/fix-run-result';
import { testCoreConfig } from '../config/test-core-config';

const EXECUTOR = 'demo_proxy';

/**
 * Real directory the per-issue artifacts and workspaces live under: the seam creates each issue's
 * artifacts directory before it reserves the private workspace.
 */
const ROOT = mkdtempSync(join(tmpdir(), 'module-run-issue-'));

afterAll(() => {
    rmSync(ROOT, { recursive: true, force: true });
});

function fixtureRunResult(issueNumber: number): FixRunResult {
    return {
        issueNumber,
        domain: 'example.com',
        runStatus: FixRunStatus.NotReproduced,
        requestedBrowserMode: BrowserMode.Auto,
        effectiveMode: EffectiveMode.Browser,
        verificationStatus: VerificationStatus.NotAttempted,
        fallbackReason: null,
        fallbackDetail: null,
        candidatePatch: null,
        artifactPaths: { screenshots: [], domSnapshot: null, har: null, trace: null },
        reasoning: 'The reported symptom was absent.',
        repository: null,
        baseSha: null,
    };
}

function requestFixture(issueNumber: number, artifactsDir: string): DefaultSingleIssueRequest {
    return {
        config: testCoreConfig(),
        slug: { owner: 'AdguardTeam', repo: 'AdguardFilters' },
        issueNumber,
        commentsEnabled: true,
        screenshotsBranch: 'filters-agent-screenshots',
        token: 'read-token',
        executors: [EXECUTOR],
        artifactsDir,
    };
}

/**
 * The public engine stand-in: calls the investigation seam exactly as the real engine does.
 */
function engineCallingInvestigate() {
    return vi.fn(
        async (
            request: DefaultSingleIssueRequest,
            dependencies: DefaultSingleIssueDependencies,
        ) => {
            const runResult = await dependencies.investigate!(
                request.config,
                { number: request.issueNumber } as never,
                {
                    artifactsDir: request.artifactsDir,
                    agentRuntime: { executors: request.executors },
                },
                {},
            );
            return {
                kind: DefaultSingleIssueResultKind.Processed,
                issueNumber: request.issueNumber,
                runResult,
                publication: null,
                artifactsDir: request.artifactsDir,
            } as const;
        },
    );
}

describe('createBlockerModuleRunIssue', () => {
    it("wires each enabled module into every issue's own investigation, in a private workspace it removes", async () => {
        const capturedOptions: FixCoreOptions[] = [];
        const startBlocker = vi.fn(() => ({}) as BlockerContract);
        const runIssue = createBlockerModuleRunIssue(ROOT, [{ executor: EXECUTOR, startBlocker }], {
            runDefaultSingleIssue: engineCallingInvestigate() as never,
            runFixCore: (async (_config: unknown, _issue: unknown, options: FixCoreOptions) => {
                capturedOptions.push(options);
                return fixtureRunResult(7);
            }) as never,
        });

        // The action hands over an artifacts path the entry itself creates later.
        const outcome = await runIssue(requestFixture(7, join(ROOT, 'out', 'issue-7')));

        expect(outcome).toMatchObject({ kind: 'processed', issueNumber: 7 });
        const wired = capturedOptions[0]?.agentRuntime?.executorDependencies?.[EXECUTOR] as
            | BlockerModuleRunDependencies
            | undefined;
        expect(wired?.startBlocker).toBe(startBlocker);
        expect(wired?.filterCacheDir).toBe(join(ROOT, 'tmp', 'filter-cache'));
        expect(wired?.workspaceDir.startsWith(join(ROOT, 'out'))).toBe(false);
        expect(existsSync(wired!.workspaceDir)).toBe(false);
    });

    it("keeps the module's logs in the issue's artifacts when it removes the workspace", async () => {
        // When the blocker never filters the page, the only record of why is its own log, which
        // would otherwise be deleted with the workspace.
        const artifactsDir = join(ROOT, 'out', 'issue-9');
        const runIssue = createBlockerModuleRunIssue(
            ROOT,
            [{ executor: EXECUTOR, startBlocker: () => ({}) as BlockerContract }],
            {
                runDefaultSingleIssue: engineCallingInvestigate() as never,
                runFixCore: (async (_config: unknown, _issue: unknown, options: FixCoreOptions) => {
                    const wired = options.agentRuntime?.executorDependencies?.[
                        EXECUTOR
                    ] as BlockerModuleRunDependencies;
                    const blockerDir = join(wired.workspaceDir, 'blocker');
                    mkdirSync(blockerDir, { recursive: true });
                    writeFileSync(
                        join(blockerDir, 'access.log'),
                        'GET https://example.com/a?token=probe-session-secret\n',
                    );
                    writeFileSync(join(blockerDir, 'proxy.yaml'), 'config: true\n');
                    return fixtureRunResult(9);
                }) as never,
            },
        );

        await runIssue(requestFixture(9, artifactsDir));

        const copied = join(artifactsDir, 'blocker-logs', EXECUTOR, 'blocker');
        const copiedLog = readFileSync(join(copied, 'access.log'), 'utf8');
        expect(copiedLog).toContain('https://example.com/a');
        expect(copiedLog).not.toContain('probe-session-secret');
        expect(existsSync(join(copied, 'proxy.yaml'))).toBe(false);
    });

    it('gives two issues in the same backlog run their own workspaces', async () => {
        const workspaces: string[] = [];
        const runIssue = createBlockerModuleRunIssue(
            ROOT,
            [{ executor: EXECUTOR, startBlocker: () => ({}) as BlockerContract }],
            {
                runDefaultSingleIssue: engineCallingInvestigate() as never,
                runFixCore: (async (_config: unknown, _issue: unknown, options: FixCoreOptions) => {
                    const wired = options.agentRuntime?.executorDependencies?.[
                        EXECUTOR
                    ] as BlockerModuleRunDependencies;
                    workspaces.push(wired.workspaceDir);
                    return fixtureRunResult(1);
                }) as never,
            },
        );

        await runIssue(requestFixture(1, join(ROOT, 'out', 'issue-1')));
        await runIssue(requestFixture(2, join(ROOT, 'out', 'issue-2')));

        expect(workspaces).toHaveLength(2);
        expect(workspaces[0]).not.toBe(workspaces[1]);
    });
});
