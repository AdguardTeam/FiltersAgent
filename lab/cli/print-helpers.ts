/**
 * The CLI's printed-line helpers for the `fix` face, which prints an investigation's retained
 * artifacts through the agent entry result printer. Every printed path names a file the underlying
 * layout actually carries — the report document is the publication generation's own `report.md`, so
 * the printed derivations stay bound to the real writer's document names.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ENTRY_RESULT_FILE_NAME, type AgentEntryResult } from '../../src/entry/entry-run';
import { DefaultSingleIssueResultKind } from '../../src/entry/single-issue-run-types';
import {
    LOCAL_PUBLICATION_PATCH_FILE_NAME,
    LOCAL_PUBLICATION_REPORT_FILE_NAME,
} from '../../src/local/evidence-publication';
import { serializeFixRunResult, type FixRunResult } from '../../src/types/fix-run-result';
import type { MainRuntimeContext } from './main-secret-boundary';

/**
 * Print the published report line for one generation directory: the agent-facing report document
 * the publication writer actually carried into that generation.
 *
 * @param generationDir - Directory the generation published the report into.
 * @param context - Secret-free runtime context with sanitized writers.
 */
function printGenerationReportLine(generationDir: string, context: MainRuntimeContext): void {
    context.stdout.write(
        `Agent report written to: ${join(generationDir, LOCAL_PUBLICATION_REPORT_FILE_NAME)}\n`,
    );
}

/**
 * Persist an optional unlocked compatibility copy when the CLI requested one explicitly.
 *
 * @param result - Schema-compatible terminal fix result.
 * @param outputPath - Explicit `--output` path.
 * @param context - Secret-free runtime context with sanitized writers.
 */
function persistFixRunResult(
    result: FixRunResult,
    outputPath: string | undefined,
    context: MainRuntimeContext,
): void {
    if (!outputPath) {
        return;
    }
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, serializeFixRunResult(result), 'utf8');
    context.stdout.write(`Fix run result written to: ${outputPath}\n`);
}

/**
 * Print one agent entry result and persist the optional compatibility copy, keeping the printed
 * line set: the entry result path, the published report path, and the candidate patch path. The
 * per-issue artifacts directory is the publication generation of the single `fix` issue, so the
 * printed report path names that generation's own document.
 *
 * @param result - Typed seal of the entry run.
 * @param context - Secret-free runtime context with sanitized writers.
 * @param outputPath - Optional compatibility result path requested by `fix`.
 */
export function printAgentEntryResult(
    result: AgentEntryResult,
    context: MainRuntimeContext,
    outputPath?: string,
): void {
    context.stdout.write(
        `Entry result written to: ${join(result.artifactsDir, ENTRY_RESULT_FILE_NAME)}\n`,
    );
    const outcome = result.perIssue[0];
    if (outcome === undefined) {
        return;
    }
    if (outcome.kind === DefaultSingleIssueResultKind.Failed) {
        context.stdout.write(
            `Issue #${String(outcome.issueNumber)} failed at ${outcome.failureCode}: ${outcome.failureDetail}\n`,
        );
        return;
    }
    if (outcome.kind === DefaultSingleIssueResultKind.Skipped) {
        context.stdout.write(`Issue #${String(outcome.issueNumber)} skipped: ${outcome.reason}\n`);
        return;
    }
    printGenerationReportLine(outcome.artifactsDir, context);
    if (outcome.runResult.candidatePatch) {
        const patchPath = join(outcome.artifactsDir, LOCAL_PUBLICATION_PATCH_FILE_NAME);
        context.stdout.write(`Candidate patch written to: ${patchPath}\n`);
    }
    persistFixRunResult(outcome.runResult, outputPath, context);
}

/**
 * Print a backlog entry result: the result path, every per-issue failure as data, and the tally
 * line. The exit contract stays with the result's exit code.
 *
 * @param result - Typed seal of the backlog entry run.
 * @param context - Secret-free runtime context with sanitized writers.
 */
export function printBacklogEntryResult(
    result: AgentEntryResult,
    context: MainRuntimeContext,
): void {
    context.stdout.write(
        `Entry result written to: ${join(result.artifactsDir, ENTRY_RESULT_FILE_NAME)}\n`,
    );
    let processed = 0;
    let skipped = 0;
    for (const outcome of result.perIssue) {
        if (outcome.kind === DefaultSingleIssueResultKind.Processed) {
            processed += 1;
            continue;
        }
        if (outcome.kind === DefaultSingleIssueResultKind.Skipped) {
            skipped += 1;
            context.stdout.write(
                `Issue #${String(outcome.issueNumber)} skipped: ${outcome.reason}\n`,
            );
            continue;
        }
        context.stdout.write(
            `Issue #${String(outcome.issueNumber)} failed at ${outcome.failureCode}: ${outcome.failureDetail}\n`,
        );
    }
    const failedCount = result.perIssue.length - processed - skipped;
    context.stdout.write(
        `Backlog run ${result.status}: ${String(processed)} processed, ${String(skipped)} skipped, ` +
            `${String(failedCount)} failed.\n`,
    );
}
