import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordPreflightDiagnostic } from '../../src/local/preflight-diagnostic-log';
import { runFiltersAgentAction, type AgentActionDependencies } from '../../src/action/action-main';
import { workspaceArtifactsAncestors } from '../../src/action/container-context';
import {
    AgentEntryExitCode,
    AgentEntryStatus,
    type AgentEntryResult,
} from '../../src/entry/entry-run';
import { AgentRunMode, type AgentRunInputs } from '../../src/entry/entry-inputs';
import {
    DefaultSingleIssueFailure,
    DefaultSingleIssueResultKind,
    type DefaultSingleIssueResult,
    type FailedDefaultSingleIssue,
} from '../../src/entry/single-issue-run-types';

/**
 * Repository slug the runner guarantees; the fork's own identity.
 */
const GITHUB_REPOSITORY_SLUG = 'AdguardTeam/filters-agent-demo';

/**
 * The artifacts directory the workflow's explicit input names; distinct from the workspace default.
 */
const ARTIFACTS_DIR = '/home/runner/_temp/filters-agent-artifacts';

/**
 * Workspace directory the runner binds; the base of the artifacts default and the root the
 * `artifacts-dir` output relativizes against.
 */
const GITHUB_WORKSPACE_DIR = '/github/workspace';

/**
 * The artifacts directory the binding resolves under the workspace when no `artifactsDir` input is
 * set; the directory name is not hidden, so `actions/upload-artifact` uploads it by default.
 */
const WORKSPACE_ARTIFACTS_DIR = '/github/workspace/filters-agent-artifacts/artifacts';

/**
 * The workspace-relative form of {@link WORKSPACE_ARTIFACTS_DIR}; the `artifacts-dir` output
 * carries it so the host-side `actions/upload-artifact` step resolves it against the checkout.
 */
const WORKSPACE_ARTIFACTS_RELATIVE_PATH = 'filters-agent-artifacts/artifacts';

/**
 * Workspace owner ids the ownership seam reports; distinct from root so a handover to the wrong ids
 * cannot pass by coincidence.
 */
const WORKSPACE_OWNER = { uid: 1001, gid: 1001 } as const;

/**
 * An artifacts directory pointing outside the workspace; the output must keep it absolute rather
 * than rewrite it into a traversal.
 */
const OUTSIDE_WORKSPACE_ARTIFACTS_DIR = '/outside/artifacts';

/**
 * LLM quartet values the `INPUT_*` variables carry into `config.llm`.
 */
const INPUT_LLM_BASE_URL = 'https://llm.example.test/v1';
const INPUT_LLM_API_KEY = 'llm-api-key';
const INPUT_LLM_MODEL = 'llm-model-a';
const INPUT_LLM_VISION_MODEL = 'llm-vision-a';

/**
 * Passthrough string inputs the validated inputs must carry unchanged.
 */
const INPUT_GITHUB_TOKEN = 'gh-token-123';

/**
 * Problem names the combined resolution failure must carry for diagnosability.
 */
const MISSING_TOKEN_PROBLEM_NAME = 'GITHUB_TOKEN';
const MISSING_LLM_INPUT_PROBLEM_NAME = 'llm.apiKey';

/**
 * Binary path the present-browser probe reports; only the presence signal drives the run.
 */
const FAKE_BROWSER_BINARY = '/fake/.cloakbrowser/chrome';

/**
 * Binary path the missing-browser probe reports; the failure message must name it so the log points
 * at the image path that lacks the browser.
 */
const MISSING_BROWSER_BINARY_PATH = '/fake/.cloakbrowser/absent-chrome';

/**
 * The failure detail the face must report when the probe marks the browser absent.
 */
const MISSING_BROWSER_PROBLEM = `browser binary missing at ${MISSING_BROWSER_BINARY_PATH}`;

/**
 * The issue number the failed row of the exit-code table reports; the job-log line must name it.
 */
const FAILED_ISSUE_NUMBER = 42;

/**
 * The failure detail the failed row of the exit-code table carries; the job-log line must reproduce
 * it verbatim.
 */
const FAILED_ISSUE_DETAIL = 'git ls-remote exited 128: could not resolve host';

/**
 * One failed per-issue outcome the failed row of the exit-code table returns.
 */
const FAILED_ISSUE_OUTCOME: FailedDefaultSingleIssue = {
    kind: DefaultSingleIssueResultKind.Failed,
    issueNumber: FAILED_ISSUE_NUMBER,
    failureCode: DefaultSingleIssueFailure.WorkspaceUnavailable,
    failureDetail: FAILED_ISSUE_DETAIL,
};

/**
 * Call-order tags proving the presence probe strictly precedes the entry run and the artifacts
 * handover sits between the run and the published outputs.
 */
const CALL_ORDER_PROBE = 'probe' as const;
const CALL_ORDER_RUN = 'run' as const;
const CALL_ORDER_OWNER = 'owner' as const;
const CALL_ORDER_HANDOVER = 'handover' as const;
const CALL_ORDER_OUTPUT = 'output' as const;

/**
 * Compose one runner-shaped action environment: the runner's guaranteed variables plus the
 * `INPUT_*` names of the workflow, overridable per case.
 *
 * @param overrides - Variable overrides for one scenario; `undefined` removes a variable.
 * @returns The composed environment.
 */
function runnerEnv(
    overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
    return {
        GITHUB_REPOSITORY: GITHUB_REPOSITORY_SLUG,
        GITHUB_WORKSPACE: GITHUB_WORKSPACE_DIR,
        INPUT_ISSUENUMBER: '42',
        INPUT_BACKLOG: 'false',
        // The real name the action's own registry registers (`extension-filtering-executor.ts`):
        // `mapAgentRunSources` now checks `--executors` against it before any seam runs.
        INPUT_EXECUTORS: 'browser_extension',
        INPUT_ARTIFACTSDIR: ARTIFACTS_DIR,
        INPUT_MODEL: 'reasoning-model-b',
        INPUT_NOCOMMENT: 'false',
        INPUT_GITHUBTOKEN: INPUT_GITHUB_TOKEN,
        INPUT_LLMBASEURL: INPUT_LLM_BASE_URL,
        INPUT_LLMAPIKEY: INPUT_LLM_API_KEY,
        INPUT_LLMMODEL: INPUT_LLM_MODEL,
        INPUT_LLMVISIONMODEL: INPUT_LLM_VISION_MODEL,
        INPUT_LLMCONTEXTWINDOWTOKENS: '131072',
        INPUT_LLMMAXOUTPUTTOKENS: '32768',
        INPUT_LLMVISIONMAXOUTPUTTOKENS: '8192',
        ...overrides,
    };
}

/**
 * Build one entry-result fixture the `runEntry` seam returns.
 *
 * @param status - How the run sealed.
 * @param exitCode - Exit code the result carries.
 * @param artifactsDir - Artifacts directory the report lines name.
 * @param perIssue - Per-issue outcomes the result carries; empty for a successful seal.
 * @returns The entry-result fixture.
 */
function entryResult(
    status: AgentEntryStatus,
    exitCode: AgentEntryExitCode,
    artifactsDir: string = ARTIFACTS_DIR,
    perIssue: readonly DefaultSingleIssueResult[] = [],
): AgentEntryResult {
    return { exitCode, status, artifactsDir, perIssue, remainingIssueNumbers: [] };
}

/**
 * Build the fake-seam dependency set: a successful entry run against a browser-present probe, a
 * runner-shaped environment, and a recording output sink.
 *
 * @param overrides - Dependency overrides for one scenario.
 * @returns The dependency set with its fake seams.
 */
function actionDependencies(
    overrides: Partial<AgentActionDependencies> = {},
): AgentActionDependencies {
    return {
        probeBrowserBinary: vi.fn(() => ({ installed: true, binaryPath: FAKE_BROWSER_BINARY })),
        runEntry: vi.fn(
            async (): Promise<AgentEntryResult> =>
                entryResult(AgentEntryStatus.Success, AgentEntryExitCode.Success),
        ),
        workspaceOwner: vi.fn(() => ({ ...WORKSPACE_OWNER })),
        handOverArtifactsTree: vi.fn(),
        openDiagnosticLog: () => null,
        env: runnerEnv(),
        outputSink: vi.fn(),
        ...overrides,
    };
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('runFiltersAgentAction', () => {
    it('probes the binary before the run, hands the entry its validated inputs, writes outputs, exits 0', async () => {
        const callOrder: string[] = [];
        let capturedInputs: AgentRunInputs | undefined;
        const deps = actionDependencies({
            probeBrowserBinary: vi.fn(() => {
                callOrder.push(CALL_ORDER_PROBE);
                return { installed: true, binaryPath: FAKE_BROWSER_BINARY };
            }),
            runEntry: vi.fn(async (inputs: AgentRunInputs): Promise<AgentEntryResult> => {
                callOrder.push(CALL_ORDER_RUN);
                capturedInputs = inputs;
                return entryResult(AgentEntryStatus.Success, AgentEntryExitCode.Success);
            }),
        });
        const env = runnerEnv();

        const exitCode = await runFiltersAgentAction({ ...deps, env });

        expect(callOrder).toEqual([CALL_ORDER_PROBE, CALL_ORDER_RUN]);
        expect(capturedInputs?.mode).toEqual({ kind: AgentRunMode.SingleIssue, issueNumber: 42 });
        expect(capturedInputs?.config.llm.model).toBe(INPUT_LLM_MODEL);
        expect(capturedInputs?.config.llm.apiKey).toBe(INPUT_LLM_API_KEY);
        expect(capturedInputs?.config.llm.visionModel).toBe(INPUT_LLM_VISION_MODEL);
        expect(capturedInputs?.config.llm.baseUrl).toBe(INPUT_LLM_BASE_URL);
        expect(capturedInputs?.comments).toEqual({
            enabled: true,
            token: INPUT_GITHUB_TOKEN,
            screenshotsBranch: 'filters-agent-screenshots',
        });
        expect(capturedInputs?.artifactsDir).toBe(ARTIFACTS_DIR);
        expect(capturedInputs?.slug).toEqual({ owner: 'AdguardTeam', repo: 'filters-agent-demo' });
        expect(exitCode).toBe(AgentEntryExitCode.Success);
        expect(deps.outputSink).toHaveBeenCalledWith(`artifacts-dir=${ARTIFACTS_DIR}`);
        expect(deps.outputSink).toHaveBeenCalledWith(`status=${AgentEntryStatus.Success}`);
        expect(env.CLOAKBROWSER_AUTO_UPDATE).toBeUndefined();
    });

    it('hands the entry artifacts tree to the workspace owner after the run and before the outputs', async () => {
        const callOrder: string[] = [];
        const deps = actionDependencies({
            runEntry: vi.fn(async (): Promise<AgentEntryResult> => {
                callOrder.push(CALL_ORDER_RUN);
                return entryResult(AgentEntryStatus.Success, AgentEntryExitCode.Success);
            }),
            workspaceOwner: vi.fn(() => {
                callOrder.push(CALL_ORDER_OWNER);
                return { ...WORKSPACE_OWNER };
            }),
            handOverArtifactsTree: vi.fn(() => {
                callOrder.push(CALL_ORDER_HANDOVER);
            }),
            outputSink: vi.fn(() => {
                callOrder.push(CALL_ORDER_OUTPUT);
            }),
        });

        const exitCode = await runFiltersAgentAction(deps);

        expect(exitCode).toBe(AgentEntryExitCode.Success);
        expect(deps.workspaceOwner).toHaveBeenCalledWith(GITHUB_WORKSPACE_DIR);
        expect(deps.handOverArtifactsTree).toHaveBeenCalledWith(
            ARTIFACTS_DIR,
            WORKSPACE_OWNER,
            GITHUB_WORKSPACE_DIR,
        );
        expect(callOrder).toEqual([
            CALL_ORDER_RUN,
            CALL_ORDER_OWNER,
            CALL_ORDER_HANDOVER,
            CALL_ORDER_OUTPUT,
            CALL_ORDER_OUTPUT,
        ]);
    });

    it('reports a failed handover with the tree, the ids and the caught message, and writes no outputs', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const handoverError = new Error('EACCES: permission denied, chown failed');
        const deps = actionDependencies({
            handOverArtifactsTree: vi.fn(() => {
                throw handoverError;
            }),
        });

        const exitCode = await runFiltersAgentAction(deps);

        expect(exitCode).toBe(AgentEntryExitCode.RunFailed);
        const reported = errorSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
        expect(reported).toContain(ARTIFACTS_DIR);
        expect(reported).toContain(`uid ${WORKSPACE_OWNER.uid}`);
        expect(reported).toContain(`gid ${WORKSPACE_OWNER.gid}`);
        expect(reported).toContain(handoverError.message);
        expect(deps.outputSink).not.toHaveBeenCalled();
    });

    it('reports a throwing entry in full, hands the tree over, publishes the failed outputs, and fails the job', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const entryError = new Error('entry run exploded');
        const deps = actionDependencies({
            runEntry: vi.fn(async (): Promise<AgentEntryResult> => {
                throw entryError;
            }),
        });

        const exitCode = await runFiltersAgentAction(deps);

        expect(exitCode).toBe(AgentEntryExitCode.RunFailed);
        expect(deps.workspaceOwner).toHaveBeenCalledWith(GITHUB_WORKSPACE_DIR);
        expect(deps.handOverArtifactsTree).toHaveBeenCalledWith(
            ARTIFACTS_DIR,
            WORKSPACE_OWNER,
            GITHUB_WORKSPACE_DIR,
        );
        expect(deps.outputSink).toHaveBeenCalledWith(`artifacts-dir=${ARTIFACTS_DIR}`);
        expect(deps.outputSink).toHaveBeenCalledWith(`status=${AgentEntryStatus.Failed}`);
        const reported = errorSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
        expect(reported).toContain(entryError.message);
        expect(reported).toContain(entryError.stack ?? '');
    });

    it('publishes no failure outputs when the throwing entry handover also fails', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const entryError = new Error('entry run exploded');
        const handoverError = new Error('EACCES: permission denied, chown failed');
        const deps = actionDependencies({
            runEntry: vi.fn(async (): Promise<AgentEntryResult> => {
                throw entryError;
            }),
            handOverArtifactsTree: vi.fn(() => {
                throw handoverError;
            }),
        });

        const exitCode = await runFiltersAgentAction(deps);

        expect(exitCode).toBe(AgentEntryExitCode.RunFailed);
        expect(deps.handOverArtifactsTree).toHaveBeenCalledWith(
            ARTIFACTS_DIR,
            WORKSPACE_OWNER,
            GITHUB_WORKSPACE_DIR,
        );
        const reported = errorSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
        expect(reported).toContain(entryError.message);
        expect(reported).toContain(handoverError.message);
        expect(deps.outputSink).not.toHaveBeenCalled();
    });

    it.each([
        ['success', AgentEntryStatus.Success, AgentEntryExitCode.Success, 0, []],
        ['partial', AgentEntryStatus.PartialFailure, AgentEntryExitCode.Success, 0, []],
        [
            'failed',
            AgentEntryStatus.Failed,
            AgentEntryExitCode.RunFailed,
            1,
            [FAILED_ISSUE_OUTCOME],
        ],
    ])(
        'applies the entry %s result exit code and reports its status',
        async (_label, status, entryExitCode, expectedExit, perIssue) => {
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const deps = actionDependencies({
                runEntry: vi.fn(
                    async (): Promise<AgentEntryResult> =>
                        entryResult(status, entryExitCode, undefined, perIssue),
                ),
            });

            const exitCode = await runFiltersAgentAction(deps);

            expect(exitCode).toBe(expectedExit);
            expect(deps.outputSink).toHaveBeenCalledWith(`status=${status}`);
            const reported = errorSpy.mock.calls
                .map((call) => call.map(String).join(' '))
                .join('\n');
            if (status === AgentEntryStatus.Failed) {
                expect(reported).toContain(
                    `Issue #${FAILED_ISSUE_NUMBER} failed at ` +
                        `${DefaultSingleIssueFailure.WorkspaceUnavailable}: ${FAILED_ISSUE_DETAIL}`,
                );
            } else {
                expect(reported).not.toContain('Issue #');
            }
        },
    );

    it('fails combined on stderr before any seam runs when resolution drops inputs', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const probeBrowserBinary = vi.fn();
        const runEntry = vi.fn();

        const exitCode = await runFiltersAgentAction({
            probeBrowserBinary,
            runEntry,
            env: runnerEnv({ INPUT_GITHUBTOKEN: undefined, INPUT_LLMAPIKEY: undefined }),
            outputSink: vi.fn(),
        });

        expect(exitCode).toBe(AgentEntryExitCode.RunFailed);
        const reported = errorSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
        expect(reported).toContain(MISSING_LLM_INPUT_PROBLEM_NAME);
        expect(reported).toContain(MISSING_TOKEN_PROBLEM_NAME);
        expect(probeBrowserBinary).not.toHaveBeenCalled();
        expect(runEntry).not.toHaveBeenCalled();
    });

    it('fails named before any seam when the runner workspace is missing', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const probeBrowserBinary = vi.fn();
        const runEntry = vi.fn();

        const exitCode = await runFiltersAgentAction({
            probeBrowserBinary,
            runEntry,
            env: runnerEnv({ GITHUB_WORKSPACE: undefined }),
            outputSink: vi.fn(),
        });

        expect(exitCode).toBe(AgentEntryExitCode.RunFailed);
        const reported = errorSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
        expect(reported).toContain('GITHUB_WORKSPACE is required');
        expect(probeBrowserBinary).not.toHaveBeenCalled();
        expect(runEntry).not.toHaveBeenCalled();
    });

    it('reports the missing browser binary by path, exits run-failed, and skips the run', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const runEntry = vi.fn();
        const deps = actionDependencies({
            probeBrowserBinary: vi.fn(() => ({
                installed: false,
                binaryPath: MISSING_BROWSER_BINARY_PATH,
            })),
            runEntry,
        });

        const exitCode = await runFiltersAgentAction(deps);

        expect(exitCode).toBe(AgentEntryExitCode.RunFailed);
        const reported = errorSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
        expect(reported).toContain(MISSING_BROWSER_PROBLEM);
        expect(runEntry).not.toHaveBeenCalled();
        expect(deps.outputSink).not.toHaveBeenCalled();
    });

    it('keeps the native cause a deep layer records in a log file inside the artifacts tree', async () => {
        // The blocker's reason for candidate_application_failed was once recorded to a sink only
        // the lab installs, so the action run lost it.
        const artifactsDir = mkdtempSync(join(tmpdir(), 'action-diagnostics-'));
        const deps = actionDependencies({
            env: runnerEnv({ INPUT_ARTIFACTSDIR: artifactsDir }),
            openDiagnosticLog: undefined,
            runEntry: vi.fn(async (): Promise<AgentEntryResult> => {
                recordPreflightDiagnostic('cli_phase', {
                    note: 'baseline_edit_apply_failed',
                    error: { message: 'baseline_line_not_found' },
                });
                return entryResult(
                    AgentEntryStatus.Success,
                    AgentEntryExitCode.Success,
                    artifactsDir,
                );
            }),
        });

        try {
            await runFiltersAgentAction(deps);

            const logs = readdirSync(artifactsDir).filter((name) => name.endsWith('.log'));
            expect(logs).toHaveLength(1);
            expect(readFileSync(join(artifactsDir, logs[0]!), 'utf8')).toContain(
                'baseline_line_not_found',
            );
        } finally {
            rmSync(artifactsDir, { recursive: true, force: true });
        }
    });

    it('defaults artifacts under the workspace and writes the workspace-relative output', async () => {
        let capturedInputs: AgentRunInputs | undefined;
        const deps = actionDependencies({
            env: runnerEnv({ INPUT_ARTIFACTSDIR: undefined }),
            runEntry: vi.fn(async (inputs: AgentRunInputs): Promise<AgentEntryResult> => {
                capturedInputs = inputs;
                return entryResult(
                    AgentEntryStatus.Success,
                    AgentEntryExitCode.Success,
                    inputs.artifactsDir,
                );
            }),
        });

        const exitCode = await runFiltersAgentAction(deps);

        expect(capturedInputs?.artifactsDir).toBe(WORKSPACE_ARTIFACTS_DIR);
        expect(deps.outputSink).toHaveBeenCalledWith(
            `artifacts-dir=${WORKSPACE_ARTIFACTS_RELATIVE_PATH}`,
        );
        expect(exitCode).toBe(AgentEntryExitCode.Success);
    });

    it('keeps the artifacts-dir output absolute when the entry result escapes the workspace', async () => {
        const deps = actionDependencies({
            env: runnerEnv({ INPUT_ARTIFACTSDIR: undefined }),
            runEntry: vi.fn(
                async (): Promise<AgentEntryResult> =>
                    entryResult(
                        AgentEntryStatus.Success,
                        AgentEntryExitCode.Success,
                        OUTSIDE_WORKSPACE_ARTIFACTS_DIR,
                    ),
            ),
        });

        await runFiltersAgentAction(deps);

        expect(deps.outputSink).toHaveBeenCalledWith(
            `artifacts-dir=${OUTSIDE_WORKSPACE_ARTIFACTS_DIR}`,
        );
    });
});

describe('workspaceArtifactsAncestors', () => {
    // The upload step runs as the runner user and has to get through every directory above the
    // tree; the entry creates the missing ones as root 0700, so each of them is handed over too.
    it('names the directory the default layout creates above the artifacts tree', () => {
        expect(workspaceArtifactsAncestors(WORKSPACE_ARTIFACTS_DIR, GITHUB_WORKSPACE_DIR)).toEqual([
            '/github/workspace/filters-agent-artifacts',
        ]);
    });

    it('names every directory of a deeper artifactsDir input, outermost first', () => {
        expect(
            workspaceArtifactsAncestors('/github/workspace/out/runs/42', GITHUB_WORKSPACE_DIR),
        ).toEqual(['/github/workspace/out', '/github/workspace/out/runs']);
    });

    it('names nothing for a tree directly in the workspace or outside it', () => {
        expect(workspaceArtifactsAncestors('/github/workspace/out', GITHUB_WORKSPACE_DIR)).toEqual(
            [],
        );
        expect(workspaceArtifactsAncestors(ARTIFACTS_DIR, GITHUB_WORKSPACE_DIR)).toEqual([]);
    });
});
