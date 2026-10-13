/**
 * The action face of the shared entry point: bind the runner-shaped environment
 * (`mapAgentRunSources`), resolve the validated inputs, verify the browser binary's presence, run
 * the entry, hand the artifacts tree over to the workspace owner, and publish the step outputs — in
 * that order, so a failed job is named by the resolver's combined `ConfigError` before any seam
 * (network, browser) is reachable. Every work seam is injectable the same way
 * `AgentEntryDependencies` is; production wires `runFiltersAgentEntry`, cloakbrowser's
 * `binaryInfo`, and the filesystem ownership probes.
 */

import {
    appendFileSync,
    chownSync,
    existsSync,
    lchownSync,
    lstatSync,
    readdirSync,
    statSync,
    type Stats,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { binaryInfo } from 'cloakbrowser';
import { ConfigError } from '../config/config-error';
import {
    AgentEntryExitCode,
    AgentEntryStatus,
    runFiltersAgentEntry,
    type AgentEntryResult,
} from '../entry/entry-run';
import type { AgentRunInputs } from '../entry/entry-inputs';
import { resolveAgentRunInputs } from '../entry/entry-inputs-resolution';
import { DefaultSingleIssueResultKind } from '../entry/single-issue-run-types';
import { filteringExecutors } from '../orchestrator/filtering-executors';
import type { LoadedBlockerModule } from '../proxy-blocker/blocker-module-manifest';
import { createLogger } from '../logger/logger';
import {
    installPreflightDiagnosticLog,
    openPreflightDiagnosticLog,
    type PreflightDiagnosticLog,
} from '../local/preflight-diagnostic-log';
import { blockerModuleEntryDependencies, loadActionBlockerModules } from './action-blocker-modules';
import { mapAgentRunSources } from './action-input-binding';
import {
    workspaceArtifactsAncestors,
    workspaceArtifactsDefault,
    workspaceRelativeArtifactsDir,
} from './container-context';

/**
 * Environment variable naming the file the runner parses step outputs from; the face appends
 * `key=value` lines there at runtime.
 */
const GITHUB_OUTPUT_VAR = 'GITHUB_OUTPUT';

/**
 * Severity prefix every action-face failure report carries, so the stderr channel stays greppable
 * in the Actions log while the combined resolution detail follows it verbatim.
 */
const FAILURE_REPORT_PREFIX = 'filters-agent action failed:';

/**
 * The presence report of the image's browser binary: whether the executable exists at the resolved
 * cache path, plus that path so the failure message can name where the browser is missing.
 */
interface BrowserBinaryPresence {
    /**
     * Whether the browser executable exists at the resolved cache path; a `false` value stops the
     * run named — the Docker image installs the browser at build time, never at run time.
     */
    installed: boolean;

    /**
     * The absolute path the probe resolved the browser executable at.
     */
    binaryPath: string;
}

/**
 * The uid:gid pair owning the runner's workspace, to which the finished artifacts tree is handed
 * over so the host-side `actions/upload-artifact` step — running as the runner user, not as the
 * root the container runs as — can read what the run wrote.
 */
export interface WorkspaceOwnership {
    /**
     * Numeric user id owning the mounted workspace on the runner.
     */
    uid: number;

    /**
     * Numeric group id owning the mounted workspace on the runner.
     */
    gid: number;
}

/**
 * Injectable seams of the action face; production passes nothing and gets the shared entry
 * resolution and run against the image's pre-installed browser.
 */
export interface AgentActionDependencies {
    /**
     * Run seam; production wires `runFiltersAgentEntry`, which re-validates and dispatches.
     */
    runEntry?: (inputs: AgentRunInputs) => Promise<AgentEntryResult>;

    /**
     * Browser presence seam; production wires cloakbrowser's `binaryInfo`, which resolves the
     * browser cache path (`CLOAKBROWSER_CACHE_DIR`, else the home cache) with `existsSync` only.
     * The Docker image installs the browser at build time, so absence is a named failure here —
     * never a download fallback.
     */
    probeBrowserBinary?: () => BrowserBinaryPresence;

    /**
     * Diagnostic log seam; production opens a log file in the run's artifacts directory, and a null
     * log records nothing.
     */
    openDiagnosticLog?: (artifactsDir: string) => PreflightDiagnosticLog | null;

    /**
     * Ownership seam: resolve the uid:gid owning the runner's workspace directory. Production stats
     * the bound workspace; the container writes the artifacts as root, while the mount and the
     * host-side reader belong to the runner user.
     */
    workspaceOwner?: (workspaceDir: string) => WorkspaceOwnership;

    /**
     * Handover seam: transfer the artifacts tree, and every directory the entry created between the
     * workspace and it, to the workspace owner's ids. Production recurses over the tree
     * (`chownSync`, `lchownSync` for symlinks), changes the owner of each directory in between on
     * its own, and skips a tree that does not exist with a log; modes stay exactly as the entry
     * wrote them — only ownership changes.
     */
    handOverArtifactsTree?: (
        artifactsDir: string,
        owner: WorkspaceOwnership,
        workspaceDir: string,
    ) => void;

    /**
     * Environment the runner provides; defaults to `process.env` for the action run.
     */
    env?: Readonly<Record<string, string | undefined>>;

    /**
     * Output sink receiving one `$GITHUB_OUTPUT`-format `key=value` line per call; production
     * appends to the file named by `GITHUB_OUTPUT` when the runner set it.
     */
    outputSink?: (line: string) => void;
}

/**
 * Report one action-face failure to stderr with its full combined detail: the exit code alone would
 * leave the Actions log without a cause, and `GITHUB_OUTPUT` must only ever carry `key=value`
 * lines.
 *
 * @param detail - The combined failure detail (problems named, underlying messages verbatim).
 */
function reportActionFailure(detail: string): void {
    console.error(`${FAILURE_REPORT_PREFIX}\n${detail}`);
}

/**
 * Build the production output sink: a line appender over the file named by `GITHUB_OUTPUT`,
 * newline-terminated as the runner's parser requires; a no-op when the variable is absent (local
 * execution), where printed outputs would have no consumer.
 *
 * @param env - The environment the face was invoked with.
 * @returns The production sink for the run's outputs.
 */
function productionOutputSink(
    env: Readonly<Record<string, string | undefined>>,
): (line: string) => void {
    const outputFile = env[GITHUB_OUTPUT_VAR];
    return outputFile === undefined
        ? () => undefined
        : (line: string) => {
              appendFileSync(outputFile, `${line}\n`);
          };
}

/**
 * Resolve the workspace owner the production way: the uid:gid the mounted checkout directory
 * carries on the runner. The container runs as root and its artifacts belong to root; the mount
 * exposes the runner user's ids, which is exactly who the host-side upload step runs as.
 *
 * @param workspaceDir - The runner-bound checkout directory.
 * @returns The ids owning the workspace.
 */
function productionWorkspaceOwner(workspaceDir: string): WorkspaceOwnership {
    const stats = statSync(workspaceDir);
    return { uid: stats.uid, gid: stats.gid };
}

/**
 * Hand exactly one entry over to the owner, without recursing: a symlink is re-pointed with
 * `lchownSync` so the link itself changes owner without following it anywhere.
 *
 * @param entryPath - Absolute path of the entry being handed over.
 * @param owner - The ids receiving the entry.
 * @returns The entry's own `lstat`, taken before the change.
 */
function chownOneEntry(entryPath: string, owner: WorkspaceOwnership): Stats {
    const stats = lstatSync(entryPath);
    if (stats.isSymbolicLink()) {
        lchownSync(entryPath, owner.uid, owner.gid);
    } else {
        chownSync(entryPath, owner.uid, owner.gid);
    }
    return stats;
}

/**
 * Hand one artifacts-tree entry over to the owner, recursing through directories; a symlink is
 * re-pointed with `lchownSync` so the link itself changes owner without following it out of the
 * tree.
 *
 * @param entryPath - Absolute path of the entry being handed over.
 * @param owner - The ids receiving the entry.
 */
function chownArtifactsTreeEntry(entryPath: string, owner: WorkspaceOwnership): void {
    const stats = chownOneEntry(entryPath, owner);
    if (stats.isDirectory() && !stats.isSymbolicLink()) {
        for (const child of readdirSync(entryPath)) {
            chownArtifactsTreeEntry(join(entryPath, child), owner);
        }
    }
}

/**
 * Hand the run's artifacts tree over to the workspace owner the production way: every directory
 * between the workspace and the tree on its own, then a recursive walk that chowns every entry of
 * the tree. The directories in between matter as much as the tree: the entry created the missing
 * ones as root 0700, and the upload step cannot reach a tree it cannot get to. They change owner
 * one by one, never recursively, so a directory that already existed keeps its other content as it
 * was. A tree that does not exist is a logged no-op — a run that wrote no artifacts has nothing to
 * hand over, and that is not a failure.
 *
 * @param artifactsDir - The finished run's artifacts directory.
 * @param owner - The ids receiving the tree.
 * @param workspaceDir - The runner-bound checkout directory the tree lives under.
 */
function productionHandOverArtifactsTree(
    artifactsDir: string,
    owner: WorkspaceOwnership,
    workspaceDir: string,
): void {
    if (!existsSync(artifactsDir)) {
        console.info(`artifacts tree ${artifactsDir} does not exist; nothing to hand over`);
        return;
    }
    for (const directory of workspaceArtifactsAncestors(artifactsDir, workspaceDir)) {
        chownOneEntry(directory, owner);
    }
    chownArtifactsTreeEntry(artifactsDir, owner);
}

/**
 * Publish one run's step outputs: the artifacts directory — workspace-relative, so the host-side
 * `actions/upload-artifact` step resolves it against the mounted checkout — and the seal status, in
 * the `$GITHUB_OUTPUT` `key=value` format the consuming workflow steps read.
 *
 * @param outputSink - The output sink for the run.
 * @param artifactsDir - The artifacts directory the outputs point the upload step at.
 * @param status - The run's seal status.
 * @param workspaceDir - The workspace the run executed in.
 */
function writeAgentActionOutputs(
    outputSink: (line: string) => void,
    artifactsDir: string,
    status: AgentEntryStatus,
    workspaceDir: string,
): void {
    outputSink(`artifacts-dir=${workspaceRelativeArtifactsDir(artifactsDir, workspaceDir)}`);
    outputSink(`status=${status}`);
}

/**
 * Print every failed per-issue outcome of a failed entry run to stderr in the CLI's own per-issue
 * line format, so a red job's log names each failure's code and detail before the step exits 1; the
 * success path prints nothing, and the failed outcomes are read from the typed result rather than
 * matched out of a message. The typed entry result carries no top-level failure code, so a failed
 * run whose per-issue outcomes all succeeded has nothing to print here — this per-issue line, the
 * same one the CLI prints, is the only failure text the result carries.
 *
 * @param result - The sealed result the face is about to apply.
 */
function printFailedIssueOutcomes(result: AgentEntryResult): void {
    for (const outcome of result.perIssue) {
        if (outcome.kind === DefaultSingleIssueResultKind.Failed) {
            console.error(
                `Issue #${String(outcome.issueNumber)} failed at ` +
                    `${outcome.failureCode}: ${outcome.failureDetail}`,
            );
        }
    }
}

/**
 * Render one caught error for the failure report: its message and stack, each in full, so the
 * Actions log carries both the cause and the location; any other thrown value is rendered by its
 * string form.
 *
 * @param error - The caught value.
 * @returns The report detail.
 */
function fullErrorDetail(error: unknown): string {
    return error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
}

/**
 * Open the run's diagnostic log inside its artifacts tree.
 *
 * Deep layers record the native cause behind a finite refusal code — a blocker that would not apply
 * a candidate, a baseline it rejected — through the process-wide diagnostic sink. Without a sink
 * those records are dropped, and an action run keeps only the code, so the cause of a
 * `candidate_application_failed` cannot be recovered. The artifacts tree is uploaded with the run,
 * so the file travels with the rest of its evidence.
 *
 * @param artifactsDir - The run's artifacts directory.
 * @returns The opened log, or null when the directory cannot hold it; diagnostics never fail a run.
 */
function openRunDiagnosticLog(artifactsDir: string): PreflightDiagnosticLog | null {
    try {
        return openPreflightDiagnosticLog(artifactsDir);
    } catch (error) {
        console.warn(
            `diagnostic log not opened in ${artifactsDir}: ` +
                `${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
    }
}

/**
 * Run one action step end to end: binding, env additions, then resolution, then the browser
 * presence check, then the entry run, then the artifacts handover, then the outputs. A binding
 * (missing runner workspace), resolution, or presence failure reports its combined detail on stderr
 * and exits non-zero before the failing-less seams run. A throwing entry is recorded, the `finally`
 * hands whatever the entry wrote over first, and only then is the caught error reported with its
 * message and stack in full and `artifacts-dir`/`status=failed` published — and only when the
 * handover did not fail, so the failure outputs never point the upload step at a tree it cannot
 * read. A handover failure on either path reports its own detail, publishes no outputs, and fails
 * the job: a tree the upload step cannot read is worse than no tree at all.
 *
 * @param dependencies - Injectable seams; production passes nothing.
 * @returns The applied exit code.
 */
export async function runFiltersAgentAction(
    dependencies: AgentActionDependencies = {},
): Promise<AgentEntryExitCode> {
    const env = dependencies.env ?? process.env;
    let inputs: AgentRunInputs;
    let workspaceDir: string;
    let runEnv: Readonly<Record<string, string | undefined>>;
    let modules: LoadedBlockerModule[];
    try {
        // The binding requires the runner's workspace before anything else: the whole face anchors
        // its paths on it, so its absence fails named ahead of the resolver's combined problems.
        const binding = mapAgentRunSources(env);
        workspaceDir = binding.workspaceDir;
        runEnv = { ...env, ...binding.envAdditions };
        // Modules register their executors before resolution, so the `executors` input may name
        // them; a manifest that cannot be read or a variable the step does not set fails named.
        modules = loadActionBlockerModules(binding.blockerModulePaths, workspaceDir, runEnv);
        inputs = resolveAgentRunInputs(runEnv, {
            ...binding.sources,
            knownExecutorNames: filteringExecutors.names(),
        });
    } catch (error) {
        if (error instanceof ConfigError) {
            reportActionFailure(error.message);
            return AgentEntryExitCode.RunFailed;
        }
        throw error;
    }

    // The image ships the browser installed at build time; the probe is a read-only existence
    // check, and absence stops the run named — a run-time download would swap binaries silently.
    const probe = dependencies.probeBrowserBinary ?? binaryInfo;
    const browser = probe();
    if (!browser.installed) {
        reportActionFailure(`browser binary missing at ${browser.binaryPath}`);
        return AgentEntryExitCode.RunFailed;
    }

    // The action binding always resolves the artifacts directory — the explicit input or the
    // workspace default — so the throw path, which has no entry result to ask, hands over exactly
    // what the resolved inputs named.
    const inputArtifactsDir = inputs.artifactsDir ?? workspaceArtifactsDefault(workspaceDir);
    const outputSink = dependencies.outputSink ?? productionOutputSink(env);
    let result: AgentEntryResult | undefined;
    let entryError: unknown;
    let entryThrew = false;
    let handoverFailed = false;
    const diagnosticLog = (dependencies.openDiagnosticLog ?? openRunDiagnosticLog)(
        inputArtifactsDir,
    );
    installPreflightDiagnosticLog(diagnosticLog);
    try {
        result = await (
            dependencies.runEntry ??
            ((runInputs: AgentRunInputs) =>
                runFiltersAgentEntry(
                    runInputs,
                    blockerModuleEntryDependencies(
                        runInputs.executors,
                        modules,
                        runEnv,
                        createLogger(),
                    ),
                ))
        )(inputs);
    } catch (error) {
        // Recorded, not reported or published here: the `finally` still has to hand the partial
        // tree over, and the failure outputs must only point the upload step at a tree that came
        // out of the handover readable.
        entryThrew = true;
        entryError = error;
    } finally {
        // Closed before the handover, so the file is complete when ownership moves to the uploader.
        diagnosticLog?.close({ entryThrew });
        installPreflightDiagnosticLog(null);
        // The container runs as root while the host-side upload step runs as the runner user, so
        // the finished tree is handed over before the outputs publish it. A tree the runner cannot
        // read is a failed run, not a success whose artifact silently uploads nothing — and on the
        // throw path the handover is the only chance the partial tree gets to reach the uploader.
        const artifactsDir = result === undefined ? inputArtifactsDir : result.artifactsDir;
        let owner: WorkspaceOwnership | undefined;
        try {
            owner = (dependencies.workspaceOwner ?? productionWorkspaceOwner)(workspaceDir);
        } catch (error) {
            handoverFailed = true;
            reportActionFailure(
                `artifacts handover for ${artifactsDir} failed: cannot resolve the owner of ` +
                    `${workspaceDir}: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
        if (owner !== undefined) {
            try {
                (dependencies.handOverArtifactsTree ?? productionHandOverArtifactsTree)(
                    artifactsDir,
                    owner,
                    workspaceDir,
                );
                console.info(
                    `artifacts tree ${artifactsDir} handed over to uid ${owner.uid}, gid ${owner.gid}`,
                );
            } catch (error) {
                handoverFailed = true;
                reportActionFailure(
                    `artifacts handover to uid ${owner.uid}, gid ${owner.gid} failed for ` +
                        `${artifactsDir}: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }
    }
    if (entryThrew) {
        // The exit code alone would leave the Actions log without a cause: the entry's own failure
        // is reported with its message and stack in full, after the handover above. The failure
        // outputs publish only when the handover left the tree readable: pointing the upload step
        // at a tree it cannot read is worse than skipping it.
        reportActionFailure(fullErrorDetail(entryError));
        if (!handoverFailed) {
            writeAgentActionOutputs(
                outputSink,
                inputArtifactsDir,
                AgentEntryStatus.Failed,
                workspaceDir,
            );
        }
        return AgentEntryExitCode.RunFailed;
    }
    if (handoverFailed) {
        // A handover failure publishes no outputs on the success path: pointing the upload step at
        // a tree it cannot read is worse than skipping it. The handover already reported why.
        return AgentEntryExitCode.RunFailed;
    }
    if (result === undefined) {
        // A seam that resolved no result leaves nothing to publish; the run fails rather than
        // inventing outputs for a result that never existed.
        return AgentEntryExitCode.RunFailed;
    }
    writeAgentActionOutputs(outputSink, result.artifactsDir, result.status, workspaceDir);
    if (result.exitCode !== AgentEntryExitCode.Success) {
        // The exit code alone would leave a red job's log without a cause: a returned failure
        // names each failed issue's code and detail, exactly like the CLI's per-issue line.
        printFailedIssueOutcomes(result);
    }
    return result.exitCode;
}

/**
 * The file URL of this module file, as every ESM load of it provides — tsx booting the sources in
 * the Docker action image, tsc's emitted modules day-to-day, vitest's transform in tests. There is
 * no second form: the repository ships sources, never a bundle, so `import.meta.url` always names
 * this file.
 */
const MODULE_FILE_URL: string = import.meta.url;

/**
 * Whether this module file is the process's entry point: true for the action image's tsx boot
 * (`node --import tsx src/action/action-main.ts` on the runner), false for library imports —
 * including the test suite importing this file, which must never boot a run.
 */
const BOOTED_DIRECTLY: boolean = (() => {
    const entryArgument = process.argv[1];
    if (entryArgument === undefined) {
        return false;
    }
    try {
        return MODULE_FILE_URL === pathToFileURL(entryArgument).href;
    } catch {
        return false;
    }
})();

if (BOOTED_DIRECTLY) {
    void runFiltersAgentAction().then((exitCode) => {
        // Applied, not forced: a normal drain lets every stderr/stdout buffer flush before exit.
        process.exitCode = exitCode;
    });
}
