/**
 * The lab CLI's delegation into the shared entry: map one parsed command and the environment onto
 * validated `AgentRunInputs`, and adapt the lab's local cycle into the entry's per-issue seam. The
 * cycles run unchanged — option assembly and publication trust stay with the lab; the entry only
 * gains the mode dispatch, the input surface, and the result contract.
 */

import { dirname } from 'node:path';
import { type AgentRunInputSources, type AgentRunInputs } from '../../src/entry/entry-inputs';
import { resolveAgentRunInputs } from '../../src/entry/entry-inputs-resolution';
import {
    DefaultSingleIssueFailure,
    DefaultSingleIssueResultKind,
    type DefaultSingleIssueRequest,
    type DefaultSingleIssueResult,
    type FailedDefaultSingleIssue,
    type ProcessedDefaultSingleIssue,
} from '../../src/entry/single-issue-run-types';
import { resolveLocalRunOutputDir } from '../../src/local/output-directory';
import { readLocalRunOutput } from '../../src/local/run-output';
import { createLogger } from '../../src/logger/logger';
import { filteringExecutors } from '../../src/orchestrator/filtering-executors';
import { enableBlockerModules } from '../../src/proxy-blocker/blocker-module-loader';
import type { LoadedBlockerModule } from '../../src/proxy-blocker/blocker-module-manifest';
import type { FixRunResult } from '../../src/types/fix-run-result';
import { labExecutorSet } from '../local/blocker-modules';
import type { LocalCycleResult } from '../local/local-cycle';
import {
    runExportedSnapshotFixCommand,
    runTargetedLiveIssueFixCommand,
    type ExportedSnapshotFixCommandResult,
    type LiveCycleCommandResult,
    type LocalCycleCommandContext,
    type LocalCycleCommandDependencies,
} from './local-cycle-commands';
import type { BacklogParsedCommand, ParsedCommand } from './program';
import { readCheckoutOriginUrl } from './repository-origin';

/**
 * Host-owned process context the delegate maps onto the shared entry inputs.
 */
export interface LabEntryDelegateContext {
    /**
     * Raw environment read by the shared resolver and the identity adapters.
     */
    env: Record<string, string | undefined>;

    /**
     * Canonical agent workspace root anchoring cycle output.
     */
    workspaceRoot: string;

    /**
     * Optional merged command interruption signal, threaded into the cycle untouched.
     */
    signal?: AbortSignal;

    /**
     * The blocker modules the command plugs in, already loaded and registered; absent plugs in
     * none.
     */
    blockerModules?: readonly LoadedBlockerModule[];
}

/**
 * Injectable seams of the lab delegation: deterministic cycle-command seams passed through to the
 * existing `local-cycle-commands` adapters unchanged, plus the trusted completed-record reader.
 */
export interface LabEntryDelegateDependencies {
    /**
     * Cycle-command seams forwarded to the local-cycle command adapters verbatim.
     */
    cycleCommands?: LocalCycleCommandDependencies;

    /**
     * Completed-investigation record reader; production reads the locked run-result record.
     */
    readInvestigationResult?: (resultPath: string) => FixRunResult;
}

/**
 * One bound lab delegation: the entry inputs the shared resolver produced, and the entry
 * dependencies whose `runIssue` seam drives the lab cycle.
 */
export interface LabEntryDelegate {
    /**
     * Validated entry inputs for the parsed command.
     */
    inputs: AgentRunInputs;

    /**
     * Entry dependencies carrying the lab cycle adapter.
     */
    dependencies: {
        /**
         * Per-issue seam that unwraps into the lab local cycle.
         */
        runIssue: (request: DefaultSingleIssueRequest) => Promise<DefaultSingleIssueResult>;
    };
}

/**
 * Resolve the shared entry inputs from the lab environment and one command's explicit sources.
 *
 * @param context - Host-owned process context.
 * @param dependencies - Delegation seams, carrying the checkout-origin reader.
 * @param sources - Explicit non-environment sources the command parsed.
 * @returns The validated combined entry inputs.
 * @throws {ConfigError} One combined error naming every missing mandatory input.
 */
function resolveLabEntryInputs(
    context: LabEntryDelegateContext,
    dependencies: LabEntryDelegateDependencies,
    sources: AgentRunInputSources,
): AgentRunInputs {
    return resolveAgentRunInputs(context.env, {
        ...sources,
        checkoutOriginUrl: readCheckoutOriginUrl(
            context.env,
            dependencies.cycleCommands?.gitCheckoutOriginReader,
        ),
        knownExecutorNames: filteringExecutors.names(),
    });
}

/**
 * The executor set a command locks: a parsed `--executors` wins; absent, the browser extension and
 * every module the command plugs in, instead of whatever happens to be registered.
 *
 * @param executors - The parsed `--executors` value, when given.
 * @param context - Host-owned process context carrying the loaded modules.
 * @returns The comma-separated executor names the entry resolver validates.
 */
function labExecutorsSource(
    executors: string | undefined,
    context: LabEntryDelegateContext,
): string {
    return (
        executors ??
        labExecutorSet(
            (context.blockerModules ?? []).map((module) => module.manifest.executor),
        ).join(',')
    );
}

/**
 * Map one cycle failure selection onto the shared per-issue failure stage: snapshot and live-issue
 * acquisition problems name the issue unavailable, everything else names the investigation failed.
 *
 * @param cycleResult - The terminal cycle result.
 * @returns The shared failure stage to report.
 */
function cycleFailureStage(cycleResult: LocalCycleResult): DefaultSingleIssueFailure {
    const code = cycleResult.failure?.code;
    if (
        code === 'invalid_snapshot' ||
        code === 'invalid_live_revision' ||
        code === 'live_intake_failed'
    ) {
        return DefaultSingleIssueFailure.IssueUnavailable;
    }
    return DefaultSingleIssueFailure.InvestigationFailed;
}

/**
 * Project one completed cycle's investigation directory: the bound run-result path's directory,
 * falling back to the cycle output root for a recovery-recorded result.
 *
 * @param execution - The completed cycle execution paths.
 * @returns The directory the investigation's artifacts landed in.
 */
function investigationArtifactsDir(
    execution: ExportedSnapshotFixCommandResult | LiveCycleCommandResult,
): string {
    const cycleResult = execution.result;
    if (cycleResult.investigationResultPath !== null) {
        return dirname(cycleResult.investigationResultPath);
    }
    return execution.outputDir;
}

/**
 * Map one terminal cycle execution onto the shared per-issue outcome. Completed cycles produce
 * processed records whose publication stays null — the lab keeps its publication trust — and every
 * other status names a failed outcome with its bounded detail.
 *
 * @param execution - The cycle execution the command adapter returned.
 * @param issueNumber - Issue the entry requested.
 * @param dependencies - Delegation seams carrying the record reader.
 * @returns The shared per-issue outcome.
 */
function cycleExecutionToOutcome(
    execution: ExportedSnapshotFixCommandResult | LiveCycleCommandResult,
    issueNumber: number,
    dependencies: LabEntryDelegateDependencies,
): DefaultSingleIssueResult {
    const cycleResult = execution.result;
    if (cycleResult.status === 'completed') {
        const runResult =
            cycleResult.investigationResultPath !== null
                ? (dependencies.readInvestigationResult ?? readCompletedRunResult)(
                      cycleResult.investigationResultPath,
                  )
                : cycleResult.recoveryInvestigationResult;
        if (runResult === undefined) {
            return failedSingleIssue(
                issueNumber,
                DefaultSingleIssueFailure.InvestigationFailed,
                'The completed cycle bound no investigation record.',
            );
        }
        const processed: ProcessedDefaultSingleIssue = {
            kind: DefaultSingleIssueResultKind.Processed,
            issueNumber,
            runResult,
            publication: null,
            artifactsDir: investigationArtifactsDir(execution),
        };
        return processed;
    }
    return failedSingleIssue(
        issueNumber,
        cycleFailureStage(cycleResult),
        cycleResult.failure?.message ?? `The cycle sealed with status ${cycleResult.status}.`,
    );
}

/**
 * Read one completed cycle's locked investigation record.
 *
 * @param resultPath - The cycle's bound run-result path.
 * @returns The locked core result.
 */
function readCompletedRunResult(resultPath: string): FixRunResult {
    return readLocalRunOutput(resultPath).result;
}

/**
 * Build one failed per-issue outcome with the named stage and underlying detail.
 *
 * @param issueNumber - Issue the run was asked to process.
 * @param failureCode - The shared failure stage.
 * @param failureDetail - The underlying detail kept for diagnosis.
 * @returns The typed failed outcome.
 */
function failedSingleIssue(
    issueNumber: number,
    failureCode: DefaultSingleIssueFailure,
    failureDetail: string,
): FailedDefaultSingleIssue {
    return { kind: DefaultSingleIssueResultKind.Failed, issueNumber, failureCode, failureDetail };
}

/**
 * Build the lab run-issue seam binding the parsed fix command to the entry's per-issue requests:
 * the existing command adapters run the cycle unchanged, and the terminal result is projected into
 * the shared outcome vocabulary.
 *
 * @param command - The parsed fix command the delegate bound.
 * @param context - Host-owned process context.
 * @param dependencies - Delegation seams.
 * @param executors - The resolved entry-input executor set (the entry resolver already rejected an
 *   unknown name at this point), threaded into the lab cycle so a parsed `--executors` actually
 *   reaches the investigation, and the plugged-in modules it names start.
 * @param lintCommand - The resolved repository lint command line, threaded into the lab cycle the
 *   same way; absent runs no lint.
 * @returns The per-issue seam.
 */
function labCycleRunIssue(
    command: ParsedCommand,
    context: LabEntryDelegateContext,
    dependencies: LabEntryDelegateDependencies,
    executors: readonly string[] | undefined,
    lintCommand: string | undefined,
): (request: DefaultSingleIssueRequest) => Promise<DefaultSingleIssueResult> {
    return async (request: DefaultSingleIssueRequest): Promise<DefaultSingleIssueResult> => {
        if (request.issueNumber !== command.issueNumber) {
            return failedSingleIssue(
                request.issueNumber,
                DefaultSingleIssueFailure.IssueUnavailable,
                `The lab cycle adapter is bound to issue ${String(command.issueNumber)}, not ${String(request.issueNumber)}.`,
            );
        }
        const cycleContext: LocalCycleCommandContext = {
            env: context.env,
            workspaceRoot: context.workspaceRoot,
            signal: context.signal,
            executors,
            blockerModules: enableBlockerModules(
                executors,
                context.blockerModules ?? [],
                context.env,
                createLogger(),
            ),
            ...(lintCommand === undefined ? {} : { lintCommand }),
        };
        const passthrough: LocalCycleCommandDependencies = dependencies.cycleCommands ?? {};
        const execution = command.flags.issueFile
            ? await runExportedSnapshotFixCommand(command, cycleContext, passthrough)
            : await runTargetedLiveIssueFixCommand(command, cycleContext, passthrough);
        return cycleExecutionToOutcome(execution, request.issueNumber, dependencies);
    };
}

/**
 * Map one parsed `fix` command and the environment onto the shared entry delegation: the resolver
 * validates the shared input surface (the lab inherits the combined mandatory-input checks), and
 * the lab cycle takes the per-issue seam with every existing fix flag threaded unchanged.
 *
 * @param command - The parsed fix command.
 * @param context - Host-owned process context.
 * @param dependencies - Delegation seams.
 * @returns The bound delegation.
 * @throws {ConfigError} One combined error naming every missing mandatory input.
 */
export function createLabFixEntryDelegate(
    command: ParsedCommand,
    context: LabEntryDelegateContext,
    dependencies: LabEntryDelegateDependencies = {},
): LabEntryDelegate {
    // The lab resolves the cycle's output directory itself — explicit `--output-dir` or the same
    // command-adapter default — so the entry request and the cycle share one artifacts root.
    const artifactsDir = resolveLocalRunOutputDir(
        context.workspaceRoot,
        command.issueNumber,
        command.flags.environment,
        command.flags.outputDir,
    );
    const inputs = resolveLabEntryInputs(context, dependencies, {
        repository: command.flags.repository,
        issueNumber: command.issueNumber,
        artifactsDir,
        issueSnapshotPath: command.flags.issueFile,
        model: command.flags.model,
        // The resolver rejects an unknown name here, so `inputs.executors` below is the validated
        // set the lab cycle itself must honor rather than re-locking its own.
        executors: labExecutorsSource(command.flags.executors, context),
        // Mapped for parity with the action face: `fix`'s own lab cycle never publishes
        // (`--dry-run`'s own description already says so), so neither field changes this face's
        // behavior today, but both flow into the validated entry inputs like every other source.
        instructionPath: command.flags.instructionPath,
        lintCommand: command.flags.lintCommand,
        noComment: command.flags.noComment,
    });
    return {
        inputs,
        dependencies: {
            runIssue: labCycleRunIssue(
                command,
                context,
                dependencies,
                inputs.executors,
                inputs.lintCommand,
            ),
        },
    };
}

/**
 * Map one parsed backlog command and the environment onto the shared entry inputs. No `runIssue`
 * seam is bound: the entry's public default composition runs each issue, and the GitHub reader
 * reads the queue with the token configuration.
 *
 * @param command - The parsed backlog command.
 * @param context - Host-owned process context.
 * @param dependencies - Delegation seams.
 * @returns The validated backlog entry inputs.
 * @throws {ConfigError} One combined error naming every missing mandatory input.
 */
export function createLabBacklogEntryInputs(
    command: BacklogParsedCommand,
    context: LabEntryDelegateContext,
    dependencies: LabEntryDelegateDependencies = {},
): AgentRunInputs {
    return resolveLabEntryInputs(context, dependencies, {
        repository: command.flags.repository,
        backlog: true,
        limit: command.flags.limit,
        artifactsDir: command.flags.outputDir,
        model: command.flags.model,
        // Same executor lock as the fix face.
        executors: labExecutorsSource(command.flags.executors, context),
        trustedRoles: command.flags.trustedRoles,
        maxRevisionsPerWindow: command.flags.maxRevisionsPerWindow,
        revisionWindowMs: command.flags.revisionWindowMs,
        // Without this mapping, comments were enabled whenever GITHUB_TOKEN was set (the backlog
        // reader requires it) with no CLI way to disable them: a run against a checkout
        // of the real upstream tracker had no way to avoid posting real reports there.
        instructionPath: command.flags.instructionPath,
        lintCommand: command.flags.lintCommand,
        noComment: command.flags.noComment,
    });
}
