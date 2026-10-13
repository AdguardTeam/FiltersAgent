/**
 * The `entry-result.json` projection: the file's persisted shape — the run's statuses, skip
 * tallies, prerequisite detail, and compact per-issue records — and the writer that lands it in the
 * run's artifacts directory. The dispatch in `entry-run.ts` composes this leaf, so the persisted
 * run contract is read and changed in one module, apart from the dispatch itself.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEntryExitCode, AgentEntryResult, AgentEntryStatus } from './entry-run';
import type { AgentRunMode } from './entry-inputs';
import {
    DefaultSingleIssueResultKind,
    type DefaultSingleIssueFailure,
    type DefaultSingleIssueResult,
} from './single-issue-run-types';
import type { BacklogSkipTally } from '../queue/backlog-selection';

/**
 * Name of the result file the entry writes into the run's artifacts directory.
 *
 * Exported so the CLI print helpers name the same document the entry writer creates, instead of
 * restating the file name at each printed line. `entry-run.ts` re-exports it, so the entry's public
 * import surface stays anchored on the dispatch.
 */
export const ENTRY_RESULT_FILE_NAME = 'entry-result.json';

/**
 * Schema version of the persisted entry-result file.
 */
const ENTRY_RESULT_SCHEMA_VERSION = 1;

/**
 * Compact per-issue status persisted in the entry-result file; run records stay in the returned
 * outcome, the file carries statuses and tallies only.
 */
interface EntryResultIssueRecord {
    /**
     * Issue the record describes.
     */
    issueNumber: number;

    /**
     * How that per-issue run sealed.
     */
    kind: DefaultSingleIssueResultKind;

    /**
     * Directory the processed run's artifacts landed in.
     */
    artifactsDir?: string;

    /**
     * Publication action when a report was (de)published, else null.
     */
    publicationAction?: string | null;

    /**
     * Why intake extraction skipped the issue; skipped runs only.
     */
    reason?: string;

    /**
     * Stable failure stage for a failed run.
     */
    failureCode?: DefaultSingleIssueFailure;

    /**
     * Underlying failure detail kept for diagnosis.
     */
    failureDetail?: string;
}

/**
 * The persisted shape of `entry-result.json`: statuses, skip tallies, and the run's contract.
 */
interface EntryResultFile {
    /**
     * Persisted shape version.
     */
    schemaVersion: typeof ENTRY_RESULT_SCHEMA_VERSION;

    /**
     * Run mode the entry dispatched on.
     */
    runMode: AgentRunMode;

    /**
     * How the run sealed.
     */
    status: AgentEntryStatus;

    /**
     * Process exit code the face applies.
     */
    exitCode: AgentEntryExitCode;

    /**
     * Artifacts directory the run wrote into.
     */
    artifactsDir: string;

    /**
     * Clock capture backing the revision-window arithmetic; backlog mode only.
     */
    capturedAt: string | null;

    /**
     * Per-issue statuses in run order.
     */
    perIssue: EntryResultIssueRecord[];

    /**
     * Taken backlog issues the loop's wall-clock budget left unstarted; always empty for a
     * single-issue run.
     */
    remainingIssueNumbers: readonly number[];

    /**
     * Visited issues the backlog left untaken, keyed by skip class; null without a selection.
     */
    skippedIssues: BacklogSkipTally | null;

    /**
     * Detail of the prerequisite that failed the run, else null.
     */
    prerequisiteFailureDetail: string | null;
}

/**
 * Project one outcome into its persisted compact status.
 *
 * @param outcome - The per-issue outcome.
 * @returns The record the entry-result file carries.
 */
function entryIssueRecord(outcome: DefaultSingleIssueResult): EntryResultIssueRecord {
    if (outcome.kind === DefaultSingleIssueResultKind.Processed) {
        return {
            issueNumber: outcome.issueNumber,
            kind: outcome.kind,
            artifactsDir: outcome.artifactsDir,
            publicationAction: outcome.publication?.action ?? null,
        };
    }
    if (outcome.kind === DefaultSingleIssueResultKind.Skipped) {
        return {
            issueNumber: outcome.issueNumber,
            kind: outcome.kind,
            artifactsDir: outcome.artifactsDir,
            publicationAction: outcome.publication?.action ?? null,
            reason: outcome.reason,
        };
    }
    return {
        issueNumber: outcome.issueNumber,
        kind: outcome.kind,
        failureCode: outcome.failureCode,
        failureDetail: outcome.failureDetail,
    };
}

/**
 * Dispatch-owned facts the persisted result file carries beyond the returned seal.
 */
export interface EntryResultFileMeta {
    /**
     * Run mode the entry dispatched on.
     */
    runMode: AgentRunMode;

    /**
     * Clock capture backing the revision-window arithmetic; backlog mode only.
     */
    capturedAt: string | null;

    /**
     * Visited issues the backlog left untaken, keyed by skip class; null without a selection.
     */
    skippedIssues: BacklogSkipTally | null;

    /**
     * Detail of the prerequisite that failed the run, else null.
     */
    prerequisiteFailureDetail: string | null;
}

/**
 * Persist the run's result file into the artifacts directory, so the run's statuses and skip
 * tallies survive the process for the operator.
 *
 * @param artifactsDir - Directory the run owns.
 * @param result - The typed seal to project.
 * @param meta - Run-mode, clock, tallies, and prerequisite detail the dispatch knows.
 */
export function writeEntryResultFile(
    artifactsDir: string,
    result: AgentEntryResult,
    meta: EntryResultFileMeta,
): void {
    const file: EntryResultFile = {
        schemaVersion: ENTRY_RESULT_SCHEMA_VERSION,
        runMode: meta.runMode,
        status: result.status,
        exitCode: result.exitCode,
        artifactsDir,
        capturedAt: meta.capturedAt,
        perIssue: result.perIssue.map(entryIssueRecord),
        remainingIssueNumbers: result.remainingIssueNumbers,
        skippedIssues: meta.skippedIssues,
        prerequisiteFailureDetail: meta.prerequisiteFailureDetail,
    };
    mkdirSync(artifactsDir, { recursive: true, mode: 0o700 });
    writeFileSync(
        join(artifactsDir, ENTRY_RESULT_FILE_NAME),
        `${JSON.stringify(file, null, 2)}\n`,
        {
            encoding: 'utf8',
            mode: 0o600,
        },
    );
}
