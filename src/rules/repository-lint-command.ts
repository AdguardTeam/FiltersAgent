/**
 * Runs the repository's own lint command over one candidate rule.
 *
 * The rule is written to a temporary file in the directory of the list file it targets, so a linter
 * whose configuration is scoped by directory lints it under the same configuration as that list;
 * the command runs through the shell in the checkout root with the file's checkout-relative path
 * appended as its last argument, under a time bound, and the file is removed afterwards. The
 * verdict is the exit code: 0 is clean, anything else is the linter's objection, whose combined
 * output is returned bounded. Nothing here ever throws on the command's account — a command that
 * cannot start or does not finish is a result too, logged with everything known about it.
 */
import { randomUUID } from 'node:crypto';
import { realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import type { Logger } from '../logger/logger';
import {
    BoundedOutput,
    REPOSITORY_LINT_TIMEOUT_MS,
    runShellCommand,
    type ChildEnding,
} from './repository-lint-process';
import { RepositoryLintStatus, type RepositoryLintNote } from '../types/repository-lint';

/**
 * The repository's lint command as one run binds it.
 */
export interface RepositoryLintCommand {
    /**
     * Shell command line the repository lints its list files with, e.g. `npx aglint`; the candidate
     * file's checkout-relative path is appended as its last argument.
     */
    command: string;

    /**
     * Absolute root of the checkout the command runs in: the repository the workflow checked out
     * and installed the linter's dependencies into.
     */
    checkoutRoot: string;
}

/**
 * The rule one lint run checks and the list file it is meant for.
 */
export interface RepositoryLintCandidate {
    /**
     * The single-line candidate rule, written verbatim.
     */
    rule: string;

    /**
     * Checkout-relative path of the list file the rule goes into; the temporary file lands in its
     * directory and takes its extension.
     */
    filePath: string;
}

/**
 * The outcome of one lint run.
 */
export interface RepositoryLintResult {
    /**
     * How the run ended.
     */
    status: RepositoryLintStatus;

    /**
     * The command line as configured.
     */
    command: string;

    /**
     * The command's exit code, when it exited by itself.
     */
    exitCode?: number;

    /**
     * Why the command could not run to a verdict; present only for a not-run status.
     */
    detail?: string;

    /**
     * The command's combined stdout and stderr in arrival order, bounded at
     * {@link REPOSITORY_LINT_OUTPUT_CAP_BYTES}, with the checkout's absolute path removed.
     */
    output: string;

    /**
     * Whether the output was cut at the cap.
     */
    outputTruncated: boolean;
}

/**
 * Ceiling on the lint output the report and the model see.
 *
 * A linter's findings for one rule are a few lines; 4 KiB holds dozens of them while keeping the
 * issue comment and the tool result short. Output past that is a misconfigured command talking
 * (install logs, a stack trace), whose head says enough and whose whole lands in the run log.
 */
export const REPOSITORY_LINT_OUTPUT_CAP_BYTES = 4_096;

/**
 * Ceiling on the lint output the run log keeps, so a runaway command cannot flood it.
 */
const REPOSITORY_LINT_LOG_CAP_BYTES = 262_144;

/**
 * Prefix of the temporary candidate file's name, so a file left behind by a killed run is
 * recognizable in the checkout.
 */
const CANDIDATE_FILE_PREFIX = 'filters-agent-lint-';

/**
 * Exit codes a POSIX shell reports when the command itself never ran: 126 for a command found but
 * not executable, 127 for a command not found.
 */
const SHELL_COULD_NOT_RUN_EXIT_CODES: ReadonlySet<number> = new Set([126, 127]);

/**
 * The directory a candidate file goes into, inside the checkout.
 */
interface TargetDirectory {
    /**
     * The resolved absolute directory.
     */
    directory: string;
}

/**
 * Why the candidate file cannot be placed.
 */
interface UnusableTargetDirectory {
    /**
     * The reason, worded for the report.
     */
    problem: string;
}

/**
 * Remove the checkout's absolute path from text the command printed, so the report and the model
 * see checkout-relative paths only.
 *
 * @param text - Command output.
 * @param roots - The checkout root as configured and as resolved, longest first.
 * @returns The text with every absolute checkout prefix made relative.
 */
function relativizeCheckoutPaths(text: string, roots: readonly string[]): string {
    let result = text;
    for (const root of roots) {
        result = result.split(`${root}${sep}`).join('').split(root).join('.');
    }
    return result;
}

/**
 * Resolve the directory the candidate file goes into, refusing one outside the checkout.
 *
 * The list path comes from the model (the `lint_rule` tool) or from the accepted proposal, so it is
 * checked here like any path that did not originate in this process.
 *
 * @param checkoutRoot - The resolved checkout root.
 * @param filePath - Checkout-relative path of the target list file.
 * @returns The resolved directory, or the reason it cannot be used.
 */
function resolveTargetDirectory(
    checkoutRoot: string,
    filePath: string,
): TargetDirectory | UnusableTargetDirectory {
    if (filePath.trim().length === 0 || isAbsolute(filePath)) {
        return { problem: `the list path "${filePath}" is not a checkout-relative path` };
    }
    const lexical = join(checkoutRoot, dirname(filePath));
    let directory: string;
    try {
        directory = realpathSync(lexical);
    } catch {
        return {
            problem: `the directory of ${filePath} does not exist in the checkout`,
        };
    }
    const fromRoot = relative(checkoutRoot, directory);
    if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
        return { problem: `the directory of ${filePath} lies outside the checkout` };
    }
    if (!statSync(directory).isDirectory()) {
        return { problem: `the directory of ${filePath} is not a directory in the checkout` };
    }
    return { directory };
}

/**
 * Turn how the child ended into the lint verdict.
 *
 * @param ending - How the child ended.
 * @returns The status, exit code and not-run reason.
 */
function classifyEnding(
    ending: ChildEnding,
): Pick<RepositoryLintResult, 'status' | 'exitCode' | 'detail'> {
    if (ending.startError !== undefined) {
        return {
            status: RepositoryLintStatus.NotRun,
            detail: `the shell could not start: ${ending.startError.message}`,
        };
    }
    if (ending.timedOut) {
        return {
            status: RepositoryLintStatus.NotRun,
            detail: `the command did not finish within ${REPOSITORY_LINT_TIMEOUT_MS / 1_000} s and was killed`,
        };
    }
    if (ending.exitCode === null) {
        return {
            status: RepositoryLintStatus.NotRun,
            detail: `the command was killed by ${ending.signal ?? 'an unknown signal'}`,
        };
    }
    if (SHELL_COULD_NOT_RUN_EXIT_CODES.has(ending.exitCode)) {
        return {
            status: RepositoryLintStatus.NotRun,
            exitCode: ending.exitCode,
            detail: `the shell could not find or execute the command (exit code ${ending.exitCode})`,
        };
    }
    if (ending.exitCode === 0) {
        return { status: RepositoryLintStatus.Clean, exitCode: 0 };
    }
    return { status: RepositoryLintStatus.Problems, exitCode: ending.exitCode };
}

/**
 * Lint one candidate rule with the repository's own command.
 *
 * @param lint - The bound command and checkout root.
 * @param candidate - The rule and the list file it goes into.
 * @param logger - Run logger; every run is logged, a failed one with its whole output.
 * @returns The verdict with the bounded, checkout-relative output.
 */
export async function runRepositoryLint(
    lint: RepositoryLintCommand,
    candidate: RepositoryLintCandidate,
    logger: Logger,
): Promise<RepositoryLintResult> {
    const notRun = (detail: string): RepositoryLintResult => ({
        status: RepositoryLintStatus.NotRun,
        command: lint.command,
        detail,
        output: '',
        outputTruncated: false,
    });
    let checkoutRoot: string;
    try {
        checkoutRoot = realpathSync(lint.checkoutRoot);
    } catch (error) {
        logger.error(
            { err: error, checkoutRoot: lint.checkoutRoot, command: lint.command },
            'repository lint checkout root is unavailable',
        );
        return notRun('the checkout the command runs in is unavailable');
    }
    const target = resolveTargetDirectory(checkoutRoot, candidate.filePath);
    if ('problem' in target) {
        logger.warn(
            {
                checkoutRoot,
                filePath: candidate.filePath,
                command: lint.command,
                problem: target.problem,
            },
            'repository lint could not place the candidate file',
        );
        return notRun(target.problem);
    }
    const fileName = `${CANDIDATE_FILE_PREFIX}${randomUUID()}${extname(candidate.filePath)}`;
    const absolutePath = join(target.directory, fileName);
    const candidatePath = relative(checkoutRoot, absolutePath);
    try {
        writeFileSync(absolutePath, `${candidate.rule}\n`, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
        logger.error(
            { err: error, candidatePath, command: lint.command },
            'repository lint could not write the candidate file',
        );
        return notRun(`the candidate file could not be written: ${(error as Error).message}`);
    }
    const output = new BoundedOutput(REPOSITORY_LINT_LOG_CAP_BYTES);
    const startedAt = Date.now();
    let ending: ChildEnding;
    try {
        logger.info(
            { command: lint.command, checkoutRoot, candidatePath, rule: candidate.rule },
            'repository lint started',
        );
        ending = await runShellCommand(lint.command, checkoutRoot, candidatePath, output);
    } finally {
        try {
            rmSync(absolutePath, { force: true });
        } catch (error) {
            logger.warn(
                { err: error, candidatePath },
                'repository lint could not remove the candidate file',
            );
        }
    }
    const roots = [...new Set([lint.checkoutRoot, checkoutRoot])].sort(
        (left, right) => right.length - left.length,
    );
    const reported = output.text(REPOSITORY_LINT_OUTPUT_CAP_BYTES);
    const verdict = classifyEnding(ending);
    const result: RepositoryLintResult = {
        ...verdict,
        command: lint.command,
        output: relativizeCheckoutPaths(reported.text, roots),
        outputTruncated: reported.truncated,
    };
    const logged = output.text(REPOSITORY_LINT_LOG_CAP_BYTES);
    const logFields = {
        command: lint.command,
        checkoutRoot,
        candidatePath,
        status: verdict.status,
        exitCode: ending.exitCode,
        signal: ending.signal,
        timedOut: ending.timedOut,
        durationMs: Date.now() - startedAt,
        outputBytes: output.receivedBytes(),
        output: logged.text,
        outputTruncatedInLog: logged.truncated,
    };
    if (ending.startError !== undefined) {
        logger.error({ ...logFields, err: ending.startError }, 'repository lint could not start');
    } else if (verdict.status === RepositoryLintStatus.NotRun) {
        logger.error({ ...logFields, detail: verdict.detail }, 'repository lint did not run');
    } else if (verdict.status === RepositoryLintStatus.Problems) {
        logger.warn(logFields, 'repository lint flagged the candidate');
    } else {
        logger.info(logFields, 'repository lint passed');
    }
    return result;
}

/**
 * Lint the candidate a run publishes and keep what the report says about it: nothing for a clean
 * lint, nothing when the run has no lint command or publishes no candidate.
 *
 * @param lint - The run's bound lint command, when it has one.
 * @param candidate - The published candidate, or null when the run publishes none.
 * @param logger - Run logger.
 * @returns The report note, or undefined when there is nothing to say.
 */
export async function lintPublishedCandidate(
    lint: RepositoryLintCommand | undefined,
    candidate: RepositoryLintCandidate | null,
    logger: Logger,
): Promise<RepositoryLintNote | undefined> {
    if (lint === undefined || candidate === null) {
        return undefined;
    }
    const result = await runRepositoryLint(lint, candidate, logger);
    if (result.status === RepositoryLintStatus.Clean) {
        return undefined;
    }
    return {
        status: result.status,
        command: result.command,
        ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
        ...(result.detail === undefined ? {} : { detail: result.detail }),
        output: result.output,
        outputTruncated: result.outputTruncated,
    };
}
