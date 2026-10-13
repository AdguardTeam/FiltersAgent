/**
 * Report-artifact persistence for the default single-issue engine.
 *
 * Every sealed outcome that has something report-shaped to say — a skip, an investigation failure
 * once extraction succeeded, or a full run — writes the exact rendered comment body into the run's
 * artifacts, `noComment` included, and the extracted `Report` (or the skip verdict) beside it when
 * one exists. A full run additionally writes the decision, LLM usage and run-result generation
 * files plus their manifest, so the action's upload always carries the same evidence the CLI's
 * default engine does.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    AGENT_RUN_ARTIFACTS_FILE_NAME,
    LLM_USAGE_FILE_NAME,
    RUN_RESULT_FILE_NAME,
} from '../local/evidence-publication';
import type { IntakeExtractionPayload } from '../intake/report';
import {
    collectRunArtifacts,
    renderReportSchemaArtifact,
    RENDERED_REPORT_ARTIFACT_FILE_NAME,
    REPORT_SCHEMA_ARTIFACT_FILE_NAME,
    RUN_ARTIFACTS_MANIFEST_FILE_NAME,
} from '../publisher/report-artifacts';
import type { AgentRunArtifacts } from '../types/agent-run-artifacts';
import type { FixRunResult } from '../types/fix-run-result';
import type { RunUsageSummary } from '../types/usage-summary';

/**
 * The locked run evidence a fully processed outcome writes beside the report.
 */
export interface FullRunArtifactsData {
    /**
     * The locked investigation record.
     */
    runResult: FixRunResult;

    /**
     * The model-owned decision and its observations, or null when the loop delivered none.
     */
    artifacts: AgentRunArtifacts | null;

    /**
     * The run's aggregate LLM usage.
     */
    usageSummary: RunUsageSummary;
}

/**
 * Persist the report artifacts for one sealed outcome.
 *
 * @param artifactsDir - Directory the run writes its artifacts to.
 * @param renderedReportBody - The exact Markdown body that was or would be posted, minus the hidden
 *   revision marker; always written, even when the outcome carries no extracted report.
 * @param payload - The extracted report or the skip verdict, rendered verbatim as `report.json`;
 *   absent only for a technical failure that never reached a verdict at all.
 * @param full - The locked run evidence, present only once an investigation actually completed.
 */
export function writeRunReportArtifacts(
    artifactsDir: string,
    renderedReportBody: string,
    payload?: IntakeExtractionPayload,
    full?: FullRunArtifactsData,
): void {
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(
        join(artifactsDir, RENDERED_REPORT_ARTIFACT_FILE_NAME),
        `${renderedReportBody}\n`,
        'utf8',
    );
    if (payload !== undefined) {
        writeFileSync(
            join(artifactsDir, REPORT_SCHEMA_ARTIFACT_FILE_NAME),
            renderReportSchemaArtifact(payload),
            'utf8',
        );
    }
    if (full === undefined) {
        return;
    }
    if (full.artifacts !== null) {
        writeFileSync(
            join(artifactsDir, AGENT_RUN_ARTIFACTS_FILE_NAME),
            `${JSON.stringify(full.artifacts, null, 2)}\n`,
            'utf8',
        );
    }
    writeFileSync(
        join(artifactsDir, LLM_USAGE_FILE_NAME),
        `${JSON.stringify(full.usageSummary, null, 2)}\n`,
        'utf8',
    );
    writeFileSync(
        join(artifactsDir, RUN_RESULT_FILE_NAME),
        `${JSON.stringify(full.runResult, null, 2)}\n`,
        'utf8',
    );
    const entries = collectRunArtifacts(full.runResult, payload);
    writeFileSync(
        join(artifactsDir, RUN_ARTIFACTS_MANIFEST_FILE_NAME),
        `${JSON.stringify(entries, null, 2)}\n`,
        'utf8',
    );
}
