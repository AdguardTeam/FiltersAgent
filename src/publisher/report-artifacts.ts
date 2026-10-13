/**
 * Run artifact set of the Publisher.
 *
 * One run's artifacts — phase screenshots, network log, extracts, and the run generation files —
 * are collected as entries so the report comment can link them and the publication layer can upload
 * or copy them. Failure outcomes list everything that was collected, so a broken run still carries
 * its evidence. The collector reads only `artifactPaths` and the intake extraction payload, and the
 * extracted `Report` is isolated by its JSON artifact renderer.
 */

import type { IntakeExtractionPayload } from '../intake/report';
import type { FixRunArtifactPaths, FixRunResult } from '../types/fix-run-result';

/*
 * The fixed generation file names are imported from the generation writer itself
 * (`src/local/evidence-publication.ts`, which writes and manifest-binds those bytes) — the
 * publisher links artifacts by the writer's own names, so a rename can only move both sides
 * together, never split the linked set from what the run actually wrote.
 */

import {
    AGENT_RUN_ARTIFACTS_FILE_NAME,
    LLM_USAGE_FILE_NAME,
    RUN_RESULT_FILE_NAME,
} from '../local/evidence-publication';

/**
 * Family of one collected run artifact.
 */
export const RunArtifactKind = {
    /**
     * A phase or candidate screenshot.
     */
    Screenshot: 'screenshot',

    /**
     * The network log (HAR).
     */
    NetworkLog: 'network-log',

    /**
     * The run trace.
     */
    Trace: 'trace',

    /**
     * The captured DOM snapshot.
     */
    DomSnapshot: 'dom-snapshot',

    /**
     * The browser console log.
     */
    BrowserLog: 'browser-log',

    /**
     * The generation file holding the agent decision and the tool log.
     */
    Decision: 'decision',

    /**
     * The extracted `Report` of the intake payload.
     */
    ReportSchema: 'report-schema',

    /**
     * The generation file holding the LLM usage summary.
     */
    Usage: 'usage',

    /**
     * The generation file holding the locked run record.
     */
    RunResult: 'run-result',

    /**
     * Host-collected evidence bound to the result (settings proof, visual inventories).
     */
    SummaryEvidence: 'summary-evidence',
} as const;

/**
 * RunArtifactKind value.
 */
export type RunArtifactKind = (typeof RunArtifactKind)[keyof typeof RunArtifactKind];

/**
 * Name of the artifact this module renders the extracted `IntakeExtractionPayload` into — persisted
 * nowhere else in the run output, so the file travels with the publication this slice prepares.
 */
export const REPORT_SCHEMA_ARTIFACT_FILE_NAME = 'report.json';

/**
 * Name of the artifact holding the exact rendered report body — the Markdown that was or would be
 * posted as the issue comment, minus the hidden revision marker. Written on every sealed outcome,
 * `noComment` included, so the report text is always inspectable from the artifacts alone.
 */
export const RENDERED_REPORT_ARTIFACT_FILE_NAME = 'report-comment.md';

/**
 * Name of the artifact holding this module's own `collectRunArtifacts` output, so the action's
 * uploaded artifacts are individually labeled and linkable without re-deriving the entry list from
 * the raw run result.
 */
export const RUN_ARTIFACTS_MANIFEST_FILE_NAME = 'artifacts-manifest.json';

/**
 * Human labels for the entries this module always assembles.
 */
const AGENT_RUN_ARTIFACTS_ENTRY_LABEL = 'Agent run artifacts (decision and tool log)';

/**
 * Human label for the LLM usage generation entry.
 */
const LLM_USAGE_ENTRY_LABEL = 'LLM usage';

/**
 * Human label for the run record generation entry.
 */
const RUN_RESULT_ENTRY_LABEL = 'Run result';

/**
 * Human label for the extracted-report entry.
 */
const REPORT_ENTRY_LABEL = 'Extracted report';

/**
 * Labels of the verified candidate screenshots, in capture order.
 */
const VERIFIED_CANDIDATE_SCREENSHOT_LABELS = {
    before: 'Candidate before (viewport)',
    after: 'Candidate after (viewport)',
    beforeFullPage: 'Candidate before (full page)',
    afterFullPage: 'Candidate after (full page)',
} as const;

/**
 * Labels of the representative rejected candidate screenshots, in capture order.
 */
const REJECTED_CANDIDATE_SCREENSHOT_LABELS = {
    before: 'Rejected candidate before (viewport)',
    after: 'Rejected candidate after (viewport)',
    beforeFullPage: 'Rejected candidate before (full page)',
    afterFullPage: 'Rejected candidate after (full page)',
} as const;

/**
 * One run artifact as collected for publication: its family, human label, and path.
 */
export interface RunArtifactEntry {
    /**
     * The artifact family.
     */
    kind: RunArtifactKind;

    /**
     * Human-readable label shown beside the link in the report and upload manifests.
     */
    label: string;

    /**
     * Path collected by the run, or the fixed generation file name.
     */
    path: string;
}

/**
 * One single-path field of `FixRunArtifactPaths` as collected, with family and label.
 */
interface RunArtifactSinglePathField {
    /**
     * The `FixRunArtifactPaths` field holding the collected path.
     */
    field: keyof FixRunArtifactPaths;

    /**
     * The artifact family the path belongs to.
     */
    kind: RunArtifactKind;

    /**
     * Human-readable label for the assembled entry.
     */
    label: string;
}

/**
 * Single-path fields of `FixRunArtifactPaths` collected as one entry each, with family and label.
 *
 * Total over the fixed single-path vocabulary: a new single-path field is added to this table next
 * to its kind and label, or the run's collected evidence silently drops out of publication.
 */
const RUN_ARTIFACT_SINGLE_PATH_FIELDS = [
    { field: 'har', kind: RunArtifactKind.NetworkLog, label: 'Network log (HAR)' },
    { field: 'trace', kind: RunArtifactKind.Trace, label: 'Run trace' },
    { field: 'domSnapshot', kind: RunArtifactKind.DomSnapshot, label: 'DOM snapshot' },
    { field: 'browserLog', kind: RunArtifactKind.BrowserLog, label: 'Browser log' },
    { field: 'settingsProof', kind: RunArtifactKind.SummaryEvidence, label: 'Settings proof' },
    {
        field: 'symptomObservationEvidence',
        kind: RunArtifactKind.SummaryEvidence,
        label: 'Symptom observation evidence',
    },
    {
        field: 'preCandidateVisualInventory',
        kind: RunArtifactKind.SummaryEvidence,
        label: 'Pre-candidate visual inventory',
    },
    {
        field: 'candidateVisualReview',
        kind: RunArtifactKind.SummaryEvidence,
        label: 'Candidate visual review',
    },
] as const satisfies ReadonlyArray<RunArtifactSinglePathField>;

/**
 * Character indent of the artifact JSON serialization, matching the run generation writer's format
 * (`src/local/run-output.ts` serializes 2-space with one trailing newline).
 */
const ARTIFACT_JSON_INDENT = 2;

/**
 * Human label for one raw run screenshot.
 *
 * @param index - Zero-based position of the screenshot in the run's capture list.
 * @returns The 1-based human label.
 */
function screenshotLabel(index: number): string {
    return `Screenshot ${index + 1}`;
}

/**
 * Collect the run artifact set from the locked result and the intake extraction payload.
 *
 * Failure outcomes list everything that was collected: null or absent paths are omitted, and the
 * fixed generation files (decision and tool log, LLM usage, run record) are always included because
 * the generation writer emits them for every run. Paths shared between families are deduplicated —
 * the first collected occurrence keeps its entry, so a repeated path is never uploaded twice.
 *
 * @param result - The run result slice holding `artifactPaths`; a complete `FixRunResult` is
 *   assignable, and tests pass the plain shape.
 * @param report - The validated intake extraction payload, when one was collected for the run.
 * @returns The collected artifact entries in collection order, deduplicated by path.
 */
export function collectRunArtifacts(
    result: Pick<FixRunResult, 'artifactPaths'>,
    report?: IntakeExtractionPayload,
): RunArtifactEntry[] {
    const { artifactPaths } = result;
    const entries: RunArtifactEntry[] = [];
    const seen = new Set<string>();
    const push = (kind: RunArtifactKind, label: string, path: string | null | undefined): void => {
        if (path === null || path === undefined || path.length === 0) {
            return;
        }
        if (seen.has(path)) {
            return;
        }
        seen.add(path);
        entries.push({ kind, label, path });
    };
    const verified = artifactPaths.verifiedCandidateScreenshots;
    if (verified !== undefined) {
        push(
            RunArtifactKind.Screenshot,
            VERIFIED_CANDIDATE_SCREENSHOT_LABELS.before,
            verified.before,
        );
        push(
            RunArtifactKind.Screenshot,
            VERIFIED_CANDIDATE_SCREENSHOT_LABELS.after,
            verified.after,
        );
        push(
            RunArtifactKind.Screenshot,
            VERIFIED_CANDIDATE_SCREENSHOT_LABELS.beforeFullPage,
            verified.beforeFullPage,
        );
        push(
            RunArtifactKind.Screenshot,
            VERIFIED_CANDIDATE_SCREENSHOT_LABELS.afterFullPage,
            verified.afterFullPage,
        );
    }
    const rejected = artifactPaths.rejectedCandidateScreenshots;
    for (const position of ['before', 'after', 'beforeFullPage', 'afterFullPage'] as const) {
        push(
            RunArtifactKind.Screenshot,
            REJECTED_CANDIDATE_SCREENSHOT_LABELS[position],
            rejected?.[position],
        );
    }
    push(
        RunArtifactKind.SummaryEvidence,
        'Candidate visual review',
        rejected?.visualReviewArtifactPath,
    );
    artifactPaths.screenshots.forEach((path, index) => {
        push(RunArtifactKind.Screenshot, screenshotLabel(index), path);
    });
    for (const single of RUN_ARTIFACT_SINGLE_PATH_FIELDS) {
        push(single.kind, single.label, artifactPaths[single.field]);
    }
    push(RunArtifactKind.Decision, AGENT_RUN_ARTIFACTS_ENTRY_LABEL, AGENT_RUN_ARTIFACTS_FILE_NAME);
    push(RunArtifactKind.Usage, LLM_USAGE_ENTRY_LABEL, LLM_USAGE_FILE_NAME);
    push(RunArtifactKind.RunResult, RUN_RESULT_ENTRY_LABEL, RUN_RESULT_FILE_NAME);
    if (report !== undefined) {
        push(RunArtifactKind.ReportSchema, REPORT_ENTRY_LABEL, REPORT_SCHEMA_ARTIFACT_FILE_NAME);
    }
    return entries;
}

/**
 * Render the extracted `Report` JSON artifact for one validated intake extraction payload.
 *
 * The payload is already validated by the intake schema; the renderer only serializes it, in the
 * run generation writer's artifact format (2-space, trailing newline) so the file diffs and parses
 * like the run's other artifacts.
 *
 * @param payload - The validated extraction payload, either verdict.
 * @returns Stable JSON text of the payload.
 */
export function renderReportSchemaArtifact(payload: IntakeExtractionPayload): string {
    return `${JSON.stringify(payload, null, ARTIFACT_JSON_INDENT)}\n`;
}
