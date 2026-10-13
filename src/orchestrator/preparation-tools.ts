/**
 * The preparation stage's two step tools over the shared subprocess runner.
 *
 * The instruction's preparation steps are command lines and file writes, and nothing else: the
 * model gets exactly `run_command` and `write_file`, both locked to the preparation workdir, both
 * running through {@link runPreparationSubprocess} so the command environment is the strict
 * allowlist without this run's credentials. A failed step latches the shared gate: the two tools
 * answer every later call with the typed `step-failed` refusal, and only the session's terminal —
 * not these tools — decides what the failure means. Every invocation of either tool is logged
 * full-text (command, captured streams) so a failed preparation step is diagnosable from one run.
 *
 * These tools never register on any other session surface: they are the model's "command on the
 * machine" and "file in the working folder" for the preparation stage alone.
 */
import { chmodSync, chownSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as v from 'valibot';
import { FIX_TOOL_PARAMETER_SCHEMAS } from '../agent/tool-catalog';
import { ToolName } from '../agent/tool-names';
import type { Logger } from '../logger/logger';
import type { AdaptedToolInput } from '../pi/session-tools';
import { ToolGateCause, type ToolGateState } from '../pi/session-tool-types';
import {
    runPreparationSubprocess,
    type PreparationSubprocessResult,
} from '../local/preparation-subprocess';
import {
    resolveRealPathInsideWorkdir,
    writeFileAsUnprivilegedIdentity,
} from './preparation-write-safety';

/**
 * Default wall-clock bound for one model-invoked preparation command in milliseconds.
 *
 * Why this value: a hung preparation step must not consume the whole phase budget, and the per-step
 * bound has to stay far below that phase budget so the model keeps one chance to see and report the
 * failure itself. `timeoutMs` stays opt-in on the shared runner (host callers clone whole filter
 * repositories unbounded); only this model path supplies the bound, overridable downward by the
 * call and never upward past it.
 */
export const PREPARATION_COMMAND_TIMEOUT_MS = 5 * 60_000;

/**
 * Payload ceiling, in bytes, for one `write_file` call.
 *
 * Why this value: preparation writes manifests, rule fragments, and small patch files — never
 * artifacts, which belong to the run's own store. One mebibyte is far above every legitimate
 * preparation text and far below anything that could fill a run disk through a few hallucinated
 * calls.
 */
export const PREPARATION_WRITE_MAX_BYTES = 1_048_576;

/**
 * The uid of the unprivileged account model-issued preparation commands drop to.
 *
 * Why 65534: `nobody` is the one unprivileged account present in the action's base image, so the
 * identity exists without provisioning anything; the paired gid keeps the group side closed too.
 */
export const UNPRIVILEGED_PREPARATION_UID = 65_534;

/**
 * The gid paired with {@link UNPRIVILEGED_PREPARATION_UID}.
 */
export const UNPRIVILEGED_PREPARATION_GID = 65_534;

/**
 * How many directories above the preparation workdir its unprivileged identity may adjust.
 *
 * Why 2: the workdir sits at `<artifactsDir>/preparation`, so its parent is the artifacts directory
 * and its grandparent is the run's `filters-agent-artifacts` root. Everything above those is
 * runner-owned (`/github/workspace` and its mounted parents) and must never be touched by this
 * run.
 */
const UNPRIVILEGED_WORKDIR_ANCESTOR_DEPTH = 2;

/**
 * Permission mask selecting the mode bits preserved when the traversal bit is added.
 */
const PERMISSION_MODE_MASK = 0o7777;

/**
 * Traversal bits: execute for owner, group and other, so the child can descend into the directory.
 */
const TRAVERSAL_PERMISSION_BITS = 0o111;

/**
 * The unprivileged identity model-issued preparation commands run under.
 */
export interface PreparationCommandIdentity {
    /**
     * The uid the child process runs as.
     */
    uid: number;

    /**
     * The gid the child process runs as.
     */
    gid: number;
}

/**
 * Decide the identity model-issued preparation commands run under.
 *
 * The commands execute arbitrary instruction-supplied sources, so a root child could read the run
 * process's environment (`/proc/1/environ`) and with it the LLM key. Only a process that actually
 * is root can drop the privilege, so a non-root host keeps the current user — the drop is a no-op
 * there, never a change of identity to something the process lacks the rights to become.
 *
 * @param currentUid - The uid the run process executes as, or `undefined` where the platform
 *   exposes none.
 * @returns The nobody identity when the run process is root, otherwise `undefined`.
 */
export function preparationCommandIdentity(
    currentUid: number | undefined,
): PreparationCommandIdentity | undefined {
    return currentUid === 0
        ? { uid: UNPRIVILEGED_PREPARATION_UID, gid: UNPRIVILEGED_PREPARATION_GID }
        : undefined;
}

/**
 * Hand the preparation workdir to the unprivileged identity and keep the path to it traversable.
 *
 * The workdir was created by the root process, so the nobody child could not enter it; it is
 * chowned to the child's identity. Its already-root-owned ancestors up to the run's own
 * `filters-agent-artifacts` root receive the traversal bit only — bounded, because everything above
 * is runner-owned. The walk stops at the first non-root owner, so runner-created directories stay
 * exactly as their owner left them.
 *
 * @param workDir - Absolute preparation workdir the child runs in.
 * @param identity - The nobody identity the child runs under.
 */
function prepareWorkdirForUnprivilegedCommands(
    workDir: string,
    identity: PreparationCommandIdentity,
): void {
    chownSync(workDir, identity.uid, identity.gid);
    let directory = dirname(workDir);
    for (let depth = 0; depth < UNPRIVILEGED_WORKDIR_ANCESTOR_DEPTH; depth += 1) {
        // Never touch the filesystem root: the depth bound keeps this loop inside the run's own
        // artifact tree, and the root check is the last belt for a shallow workdir.
        if (dirname(directory) === directory) {
            break;
        }
        const stats = statSync(directory);
        if (stats.uid !== 0) {
            break;
        }
        chmodSync(directory, (stats.mode & PERMISSION_MODE_MASK) | TRAVERSAL_PERMISSION_BITS);
        directory = dirname(directory);
    }
}

/**
 * The gate a failed preparation step installs over the two step tools.
 */
export interface PreparationStepFailureGate {
    /**
     * The typed refusal both step tools answer with once a failure is latched, or `undefined` while
     * the phase is still clean.
     *
     * @returns The `step-failed` gate state, or `undefined`.
     */
    refusalFor: () => ToolGateState | undefined;

    /**
     * Latch the first failed step. Later calls are ignored — the first failure is the phase's
     * verdict, and a second one must not rewrite it.
     *
     * @param command - The failing command's executable, as invoked.
     * @param detail - Bounded captured failure detail kept beside the latch.
     */
    latchFailure: (command: string, detail: string) => void;

    /**
     * The failing command of the latched step, or `undefined` while no failure is latched.
     *
     * @returns The failing command, or `undefined`.
     */
    failedCommand: () => string | undefined;

    /**
     * Bounded detail of the latched failure, or `undefined`.
     *
     * @returns The latched failure detail, or `undefined`.
     */
    failureDetail: () => string | undefined;
}

/**
 * The latched record of the first failed preparation step.
 */
interface PreparationFailureRecord {
    /**
     * The failing command's executable, as the model invoked it.
     */
    command: string;

    /**
     * Bounded captured output beside the latch, for the core's failure reporting.
     */
    detail: string;
}

/**
 * Build the step-failure latch the two preparation tools share.
 *
 * @returns The fresh, clean latch.
 */
export function buildPreparationStepFailureGate(): PreparationStepFailureGate {
    let failure: PreparationFailureRecord | undefined;
    return {
        refusalFor: () =>
            failure === undefined
                ? undefined
                : {
                      cause: ToolGateCause.StepFailed,
                      reason:
                          `A preparation step already failed (${failure.command}); the remaining ` +
                          'steps are refused for the rest of this session.',
                      remedy:
                          'Do not retry the failed step and do not run further steps. Call ' +
                          'finish_preparation with status failed naming the failing command in ' +
                          'failedCommand.',
                  },
        latchFailure: (command, detail) => {
            // The first failure is the phase's verdict; later calls must not rewrite it.
            if (failure === undefined) {
                failure = { command, detail: detail.slice(0, 1_000) };
            }
        },
        failedCommand: () => failure?.command,
        failureDetail: () => failure?.detail,
    };
}

/**
 * What building the two preparation tools needs.
 */
export interface PreparationToolsOptions {
    /**
     * The workdir every command runs in and every write resolves inside — already resolved to an
     * absolute path by the session.
     */
    workDir: string;

    /**
     * The shared step-failure latch, consulted before every step and latched by every failure.
     */
    gate: PreparationStepFailureGate;

    /**
     * Parent environment the filtered subprocess environment is built from. Injectable for
     * deterministic tests; production passes `process.env`.
     */
    sourceEnvironment: NodeJS.ProcessEnv;

    /**
     * Application logger receiving every invocation in full text.
     */
    logger: Logger;

    /**
     * The uid the run process executes as; injectable so tests exercise both the root and the
     * non-root branch on any host. Defaults to `process.getuid?.()`, absent where the platform
     * exposes none — a non-root branch.
     */
    currentUid?: number;

    /**
     * The subprocess seam the `run_command` executor calls; injectable so tests observe the exact
     * spawn command without starting a process. Defaults to {@link runPreparationSubprocess}.
     */
    runSubprocess?: typeof runPreparationSubprocess;

    /**
     * Hook handing the unprivileged identity ownership of the workdir before the first command
     * runs; injectable so tests observe the call without changing real permissions. Defaults to the
     * production chown-and-traverse implementation.
     */
    prepareWorkdirForUnprivilegedCommands?: (
        workDir: string,
        identity: PreparationCommandIdentity,
    ) => void;
}

/**
 * The parsed tool arguments of one run_command invocation.
 */
interface PreparedCommandInvocation {
    /**
     * The exact argv, executable first.
     */
    command: string[];

    /**
     * The effective per-call bound in milliseconds, after the downward clamp.
     */
    timeoutMs?: number;
}

/**
 * Log one full-text subprocess invocation before returning anything.
 *
 * @param logger - Application logger receiving the full text.
 * @param workDir - Locked working directory the command ran in.
 * @param args - The invocation to log.
 * @param result - The captured subprocess result.
 */
function logInvocation(
    logger: Logger,
    workDir: string,
    args: PreparedCommandInvocation,
    result: PreparationSubprocessResult,
): void {
    logger.info(
        {
            tool: ToolName.RunCommand,
            cwd: workDir,
            command: args.command,
            timeoutMs: args.timeoutMs ?? PREPARATION_COMMAND_TIMEOUT_MS,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            stdout: result.stdout,
            stderr: result.stderr,
        },
        'Preparation run_command invocation (full text)',
    );
}

/**
 * Build the two preparation step tools: `run_command` and `write_file`.
 *
 * @param options - Workdir, shared latch, source environment, and logger.
 * @returns The adapted session inputs — the wiring wraps them with the shared gate-refusal and
 *   execution-recording semantics.
 */
export function buildPreparationTools(options: PreparationToolsOptions): AdaptedToolInput[] {
    const { workDir, gate, sourceEnvironment, logger } = options;
    const identity = preparationCommandIdentity(options.currentUid ?? process.getuid?.());
    if (identity !== undefined) {
        (options.prepareWorkdirForUnprivilegedCommands ?? prepareWorkdirForUnprivilegedCommands)(
            workDir,
            identity,
        );
    }
    const runSubprocess = options.runSubprocess ?? runPreparationSubprocess;
    const runCommandSchema = FIX_TOOL_PARAMETER_SCHEMAS[ToolName.RunCommand]!;
    const writeFileSchema = FIX_TOOL_PARAMETER_SCHEMAS[ToolName.WriteFile]!;
    return [
        {
            name: ToolName.RunCommand,
            parameters: runCommandSchema,
            gate: () => gate.refusalFor(),
            execute: async (rawArgs) => {
                const parsed = v.safeParse(runCommandSchema, rawArgs);
                const rawCommand = parsed.success ? parsed.output['command'] : undefined;
                if (
                    !Array.isArray(rawCommand) ||
                    rawCommand.length === 0 ||
                    rawCommand.some((entry) => typeof entry !== 'string')
                ) {
                    return {
                        error: 'run_command requires a non-empty command argv array.',
                        errorKind: 'validation_error',
                        retryable: false,
                    };
                }
                const commandArgs = rawCommand.map((entry) => String(entry));
                // Never upward past the default bound: a hung step loses this budget, not the
                // phase budget, and the model cannot buy more by asking.
                const rawTimeout = parsed.success ? parsed.output['timeoutMs'] : undefined;
                const effectiveTimeoutMs = Math.min(
                    typeof rawTimeout === 'number' ? rawTimeout : PREPARATION_COMMAND_TIMEOUT_MS,
                    PREPARATION_COMMAND_TIMEOUT_MS,
                );
                const result = await runSubprocess(
                    {
                        executable: commandArgs[0]!,
                        args: commandArgs.slice(1),
                        cwd: workDir,
                        timeoutMs: effectiveTimeoutMs,
                        // The no-secrets contract is absolute for model-invoked commands: git
                        // receives no derived credential either.
                        allowGitCredential: false,
                        // A root run drops the model's commands to nobody, with HOME inside the
                        // workdir it owns; a non-root run keeps today's identity exactly.
                        ...(identity === undefined
                            ? {}
                            : {
                                  uid: identity.uid,
                                  gid: identity.gid,
                                  environment: { HOME: workDir },
                              }),
                    },
                    sourceEnvironment,
                );
                logInvocation(
                    logger,
                    workDir,
                    { command: commandArgs, timeoutMs: effectiveTimeoutMs },
                    result,
                );
                if (result.exitCode !== 0 || result.timedOut) {
                    gate.latchFailure(
                        commandArgs[0]!,
                        `exit ${result.exitCode} stdout: ${result.stdout} stderr: ${result.stderr}`,
                    );
                }
                return {
                    content:
                        `run_command exit ${result.exitCode}` +
                        (result.timedOut ? ' (timed out)' : '') +
                        '.',
                    details: {
                        command: commandArgs,
                        cwd: workDir,
                        exitCode: result.exitCode,
                        timedOut: result.timedOut,
                        stdout: result.stdout,
                        stderr: result.stderr,
                    },
                };
            },
        },
        {
            name: ToolName.WriteFile,
            parameters: writeFileSchema,
            gate: () => gate.refusalFor(),
            execute: async (rawArgs) => {
                const parsed = v.safeParse(writeFileSchema, rawArgs);
                const requestedPath =
                    parsed.success && typeof parsed.output['path'] === 'string'
                        ? parsed.output['path']
                        : '';
                const content =
                    parsed.success && typeof parsed.output['content'] === 'string'
                        ? parsed.output['content']
                        : '';
                if (requestedPath.length === 0) {
                    return {
                        error: 'write_file requires a relative path and string content.',
                        errorKind: 'validation_error',
                        retryable: false,
                    };
                }
                const resolution = await resolveRealPathInsideWorkdir(workDir, requestedPath);
                if (resolution.resolved === undefined) {
                    logger.warn(
                        { path: requestedPath },
                        'Preparation write refused outside the workdir',
                    );
                    return {
                        error: resolution.refusal,
                        errorKind: 'validation_error',
                        retryable: false,
                    };
                }
                const byteLength = Buffer.byteLength(content, 'utf8');
                if (byteLength > PREPARATION_WRITE_MAX_BYTES) {
                    logger.warn(
                        { path: resolution.resolved, byteLength },
                        'Preparation write refused over the payload cap',
                    );
                    return {
                        error:
                            `write_file payload is ${byteLength} bytes, over the ` +
                            `${PREPARATION_WRITE_MAX_BYTES}-byte cap; refuse and split the file.`,
                        errorKind: 'validation_error',
                        retryable: false,
                    };
                }
                if (identity === undefined) {
                    await mkdir(dirname(resolution.resolved), { recursive: true });
                    await writeFile(resolution.resolved, content, 'utf8');
                } else {
                    // On a privileged host the write itself — not only the earlier check — runs as
                    // the unprivileged identity, so the kernel refuses anything that identity does
                    // not itself own or may write, closing the check/use race a purely
                    // application-level containment check cannot.
                    const failureDetail = await writeFileAsUnprivilegedIdentity(
                        runSubprocess,
                        workDir,
                        identity.uid,
                        identity.gid,
                        resolution.resolved,
                        content,
                        sourceEnvironment,
                    );
                    if (failureDetail !== undefined) {
                        logger.warn(
                            { path: resolution.resolved, detail: failureDetail },
                            'Preparation write refused by the unprivileged identity',
                        );
                        return {
                            error:
                                `write_file could not write "${requestedPath}": ` + failureDetail,
                            errorKind: 'validation_error',
                            retryable: false,
                        };
                    }
                }
                logger.info(
                    { path: resolution.resolved, bytes: byteLength },
                    'Preparation write_file invocation',
                );
                return {
                    content: `Wrote ${requestedPath} (${byteLength} bytes) inside the workdir.`,
                    details: { path: resolution.resolved, bytes: byteLength },
                };
            },
        },
    ];
}
