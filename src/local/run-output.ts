import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { RunUsageSummarySchema, type RunUsageSummary } from '../types/usage-summary';
import { createRunUsageCollector } from '../pi/usage-collector';
import { AgentRunArtifactsSchema, type AgentRunArtifacts } from '../types/agent-run-artifacts';
import {
    FixRunResultSchema,
    type CandidatePatch,
    type FixRunResult,
} from '../types/fix-run-result';
import type { FixOutcome } from '../types/fix-outcome';
import { clearLocalRunOutputDir, materializeLocalRunOutputDir } from './output-directory';
import { renderValidatedLocalAgentReport } from './run-report-render';
import {
    collectEvidenceDigests,
    createArtifactDigest,
    readImmutableFile,
} from './run-artifact-digest';
import {
    LLM_USAGE_SUMMARY_FILE_NAME,
    LOCAL_RUN_MANIFEST_FILE_NAME,
    LocalRunManifestVersion,
    createRunId,
    verifyLocalRunManifest,
    type LocalRunManifest,
} from './run-manifest';
import { EXTENSION_ENVIRONMENT_KIND_VALUES } from '../types/extension-environment-kind';
import { PreparedExtensionProvenanceSchema } from '../environment/environment-proofs';
import { RepositoryEditKind } from '../types/repository-edit-kind';
import { SETTINGS_APPLICATION_STATUS_VALUES } from '../types/settings-application-status';
import { ACTIVATION_PROOF_VALUES } from '../types/activation-proof';
import { SETTINGS_PROFILE_KIND_VALUES } from '../types/settings-profile-kind';
import { PROVENANCE_SOURCE_VALUES } from '../types/provenance-source';
import { KNOWLEDGE_BASE_ENVIRONMENT_KIND_VALUES } from '../types/knowledge-base-environment-kind';
import {
    LocalInstructionProvenanceSchema,
    LocalKnowledgeGuidanceCitationSchema,
} from './run-record-guidance-schemas';

export const LocalEnabledFilterEvidenceSchema = v.object({
    id: v.union([v.string(), v.number()]),
    name: v.string(),
    group: v.nullable(v.string()),
    version: v.nullable(v.string()),
    metadataEnabled: v.boolean(),
    runtimeEnabled: v.boolean(),
});

export const LocalSettingsProfileEvidenceSchema = v.object({
    name: v.picklist(SETTINGS_PROFILE_KIND_VALUES),
    status: v.picklist(SETTINGS_APPLICATION_STATUS_VALUES),
    detail: v.nullable(v.string()),
    activationProof: v.picklist(ACTIVATION_PROOF_VALUES),
    // Null when the run wrote no settings proof and the enabled set was never observed; the report
    // renders it as "not observed" instead of an empty filter table.
    enabledFilters: v.nullable(v.array(LocalEnabledFilterEvidenceSchema)),
});

export const LocalExtensionProvenanceSchema = PreparedExtensionProvenanceSchema;

export const LocalKnowledgeBaseProvenanceSchema = v.object({
    environment: v.picklist(KNOWLEDGE_BASE_ENVIRONMENT_KIND_VALUES),
    source: v.picklist(PROVENANCE_SOURCE_VALUES),
    sourceLocation: v.pipe(v.string(), v.minLength(1)),
    requestedRevision: v.pipe(v.string(), v.minLength(1)),
    commit: v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/i)),
    filtersCommit: v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/i)),
    documents: v.array(v.pipe(v.string(), v.minLength(1))),
    citations: v.array(LocalKnowledgeGuidanceCitationSchema),
});

export const LocalRunProvenanceSchema = v.object({
    environment: v.picklist(EXTENSION_ENVIRONMENT_KIND_VALUES),
    headless: v.boolean(),
    extension: v.nullable(LocalExtensionProvenanceSchema),
    knowledgeBase: v.optional(v.nullable(LocalKnowledgeBaseProvenanceSchema)),
    instruction: v.optional(LocalInstructionProvenanceSchema),
    settingsProfiles: v.array(LocalSettingsProfileEvidenceSchema),
});

export const LocalRejectedCandidatePairSchema = v.object({
    reason: v.pipe(v.string(), v.minLength(1)),
    beforeScreenshots: v.array(v.string()),
    afterScreenshots: v.array(v.string()),
    beforeFullPageScreenshots: v.array(v.string()),
    afterFullPageScreenshots: v.array(v.string()),
});

export const LocalProfileScreenshotEvidenceSchema = v.object({
    name: v.picklist(SETTINGS_PROFILE_KIND_VALUES),
    screenshots: v.array(v.string()),
});

export const LocalRunEvidenceSchema = v.object({
    summary: v.string(),
    userScreenshots: v.array(v.string()),
    unfilteredScreenshots: v.array(v.string()),
    profileScreenshots: v.array(LocalProfileScreenshotEvidenceSchema),
    beforeScreenshots: v.array(v.string()),
    afterScreenshots: v.array(v.string()),
    beforeFullPageScreenshots: v.array(v.string()),
    afterFullPageScreenshots: v.array(v.string()),
    rejectedScreenshots: v.array(v.string()),
    rejectedPairs: v.optional(v.array(LocalRejectedCandidatePairSchema)),
});

export const LocalArtifactLinkSchema = v.object({
    label: v.pipe(v.string(), v.minLength(1)),
    path: v.pipe(v.string(), v.minLength(1)),
});

/**
 * Stable local wrapper around the GitHub-independent core fix result.
 */
export type LocalRunRecord = {
    /**
     * Core investigation result.
     */
    result: FixRunResult;
    /**
     * Exact environment provenance.
     */
    provenance: v.InferOutput<typeof LocalRunProvenanceSchema>;
    /**
     * Human-readable and visual evidence.
     */
    evidence: v.InferOutput<typeof LocalRunEvidenceSchema>;
    /**
     * Named artifact links.
     */
    artifacts: v.InferOutput<typeof LocalArtifactLinkSchema>[];
};

export const LocalRunRecordSchema: v.GenericSchema<LocalRunRecord> = v.pipe(
    v.object({
        result: FixRunResultSchema,
        provenance: LocalRunProvenanceSchema,
        evidence: LocalRunEvidenceSchema,
        artifacts: v.array(LocalArtifactLinkSchema),
    }),
    v.check((record) => {
        const verified = record.result.artifactPaths.verifiedCandidateScreenshots;
        const expected = verified
            ? [verified.before, verified.after, verified.beforeFullPage, verified.afterFullPage]
            : [];
        const actual = [
            ...record.evidence.beforeScreenshots,
            ...record.evidence.afterScreenshots,
            ...record.evidence.beforeFullPageScreenshots,
            ...record.evidence.afterFullPageScreenshots,
        ];
        return (
            actual.length === expected.length &&
            actual.every((path, index) => path === expected[index])
        );
    }, 'Local report visual evidence must match the runner-bound candidate screenshot paths.'),
    v.check((record) => {
        const rejected = record.result.artifactPaths.rejectedCandidateScreenshots;
        const expectedScreenshots = rejected
            ? [rejected.before, rejected.after, rejected.beforeFullPage, rejected.afterFullPage]
            : [];
        const pairs = record.evidence.rejectedPairs ?? [];
        if (
            record.evidence.rejectedScreenshots.length !== expectedScreenshots.length ||
            !record.evidence.rejectedScreenshots.every(
                (path, index) => path === expectedScreenshots[index],
            )
        ) {
            return false;
        }
        if (!rejected) {
            return pairs.length === 0;
        }
        if (pairs.length !== 1) {
            return false;
        }
        const pair = pairs[0];
        return (
            pair.reason === rejected.rejectionReasons.join(', ') &&
            pair.beforeScreenshots.length === 1 &&
            pair.beforeScreenshots[0] === rejected.before &&
            pair.afterScreenshots.length === 1 &&
            pair.afterScreenshots[0] === rejected.after &&
            pair.beforeFullPageScreenshots.length === 1 &&
            pair.beforeFullPageScreenshots[0] === rejected.beforeFullPage &&
            pair.afterFullPageScreenshots.length === 1 &&
            pair.afterFullPageScreenshots[0] === rejected.afterFullPage
        );
    }, 'Local report rejected visual evidence must match the runner-bound four-image pair.'),
);

/**
 * Result of applying and proving one deterministic browser settings profile.
 */
export type LocalSettingsProfileEvidence = v.InferOutput<typeof LocalSettingsProfileEvidenceSchema>;

/**
 * Exact extension and filters checkout used for a local run.
 */
export type LocalExtensionProvenance = v.InferOutput<typeof LocalExtensionProvenanceSchema>;

/**
 * Prepared KnowledgeBase and exact consulted citations stored beside a local run.
 */
export type LocalKnowledgeBaseProvenance = v.InferOutput<typeof LocalKnowledgeBaseProvenanceSchema>;

/**
 * Live screenshots captured under one applied extension settings profile.
 */
export type LocalProfileScreenshotEvidence = v.InferOutput<
    typeof LocalProfileScreenshotEvidenceSchema
>;

/**
 * Before/after evidence rejected by the candidate vision review.
 */
export type LocalRejectedCandidatePair = v.InferOutput<typeof LocalRejectedCandidatePairSchema>;

/**
 * Caller-controlled filesystem options for one local run output.
 */
export interface WriteLocalRunOutputOptions {
    /**
     * Absolute directory where local-only files will be written.
     */
    outputDir: string;

    /**
     * Workspace root used to constrain project-local output to its `tmp/` tree.
     */
    workspaceRoot: string;

    /**
     * Exact unified diff corresponding to a non-null candidate patch.
     */
    candidatePatchText?: string;

    /**
     * Model-owned decision and exact tool results captured by the AgentRuntime Host.
     */
    agentRunArtifacts?: AgentRunArtifacts;

    /**
     * Complete provider-level usage summary for this fix-agent run.
     */
    llmUsage?: RunUsageSummary;
}

/**
 * Paths produced by a local run output write.
 */
export interface LocalRunOutputPaths {
    /**
     * Canonical deterministic report rendered without evaluation or human material.
     */
    agentReportPath: string;

    /**
     * Exact typed `finish_fix` payload, or null when the model did not reach `finish_fix`.
     */
    agentDecisionPath: string | null;

    /**
     * Ordered tool results that were actually appended to the model conversation.
     */
    agentObservationsPath: string;

    /**
     * Canonical trusted Host consolidation.
     */
    runResultPath: string;

    /**
     * Digest manifest that locks the complete canonical artifact set.
     */
    manifestPath: string;

    /**
     * Exact candidate diff path, or null when no candidate exists.
     */
    candidatePatchPath: string | null;

    /**
     * Aggregate provider usage and cost summary.
     */
    llmUsageSummaryPath?: string;
}

/**
 * Render a deterministic agent-first report without access to any human reference.
 *
 * The validating entry point: the schema lives here with the reader and the writer, so the renderer
 * module can depend on this one's types alone and the two never import each other at runtime.
 *
 * @param record - Local core result, provenance, evidence, and artifact links.
 * @param decision - Exact model-owned terminal decision, when one was accepted.
 * @returns Markdown ending in one newline.
 */
export function renderLocalAgentReport(
    record: LocalRunRecord,
    decision: FixOutcome | null = null,
): string {
    return renderValidatedLocalAgentReport(v.parse(LocalRunRecordSchema, record), decision);
}

/**
 * Confirm that a supplied unified diff contains the exact runner-derived mutation.
 *
 * @param candidate - Locked issue-scoped candidate and repository edit.
 * @param patchText - Exact unified diff about to be persisted.
 * @returns True when the diff represents the locked insert, domain extension, replacement, or
 *   deletion.
 */
function candidatePatchTextMatches(candidate: CandidatePatch, patchText: string): boolean {
    const edit = candidate.repositoryEdit;
    // A replacement takes the same both-sides branch as a domain extension: an additive `+rule`
    // check would accept a diff that never removed the line the run actually corrected.
    if (
        edit?.kind === RepositoryEditKind.ExtendDomains ||
        edit?.kind === RepositoryEditKind.Replace
    ) {
        return (
            patchText.includes(`-${edit.originalRule}`) &&
            patchText.includes(`+${edit.replacementRule}`)
        );
    }
    // A deletion is proved by both halves: the line must leave, and it must not come back. The
    // additive `+rule` fallthrough would accept a diff that never removed anything.
    if (edit?.kind === RepositoryEditKind.Remove) {
        return (
            patchText.includes(`-${edit.originalRule}`) &&
            !patchText.includes(`+${edit.originalRule}`)
        );
    }
    return patchText.includes(`+${candidate.rule}`);
}

/**
 * Normalize a text artifact to exactly one terminal newline.
 *
 * @param text - Text artifact content.
 * @returns Content with one terminal newline.
 */
function withTerminalNewline(text: string): string {
    return `${text.trimEnd()}\n`;
}

/**
 * Atomically replace one UTF-8 artifact with owner-only permissions.
 *
 * @param path - Final artifact path.
 * @param content - Exact UTF-8 content.
 */
function writeAtomicText(path: string, content: string): void {
    const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
    try {
        writeFileSync(temporaryPath, content, { encoding: 'utf8', mode: 0o600 });
        rmSync(path, { force: true });
        renameSync(temporaryPath, path);
    } finally {
        rmSync(temporaryPath, { force: true });
    }
}

/**
 * Persist local-only agent output without accepting or accessing a human reference.
 *
 * @param record - Core result and browser evidence to persist.
 * @param options - Valid local output directory and exact candidate diff.
 * @returns Absolute paths to files produced by the write.
 */
export function writeLocalRunOutput(
    record: LocalRunRecord,
    options: WriteLocalRunOutputOptions,
): LocalRunOutputPaths {
    const parsed = v.parse(LocalRunRecordSchema, record);
    const agentRunArtifacts = v.parse(
        AgentRunArtifactsSchema,
        options.agentRunArtifacts ?? { decision: null, observations: [] },
    );
    const llmUsage = v.parse(
        RunUsageSummarySchema,
        options.llmUsage ?? createRunUsageCollector({}).summary(),
    );
    const outputPath = materializeLocalRunOutputDir(options.outputDir, options.workspaceRoot);
    const candidate = parsed.result.candidatePatch;
    if (candidate && options.candidatePatchText === undefined) {
        throw new Error('An exact candidatePatchText is required when a candidate exists.');
    }
    if (!candidate && options.candidatePatchText !== undefined) {
        throw new Error('candidatePatchText cannot be written without a candidate result.');
    }
    if (
        candidate &&
        options.candidatePatchText !== undefined &&
        !candidatePatchTextMatches(candidate, options.candidatePatchText)
    ) {
        throw new Error('candidatePatchText does not contain the locked repository edit.');
    }

    clearLocalRunOutputDir(outputPath, options.workspaceRoot, ['artifacts']);
    mkdirSync(outputPath, { recursive: true });
    const agentReportPath = join(outputPath, 'agent-report.md');
    const agentDecisionPath = join(outputPath, 'agent-decision.json');
    const agentObservationsPath = join(outputPath, 'agent-observations.json');
    const runResultPath = join(outputPath, 'run-result.json');
    const manifestPath = join(outputPath, LOCAL_RUN_MANIFEST_FILE_NAME);
    const candidatePatchPath = join(outputPath, 'candidate.patch');
    const llmUsageSummaryPath = join(outputPath, LLM_USAGE_SUMMARY_FILE_NAME);
    const serializedResult = `${JSON.stringify(parsed, null, 2)}\n`;
    const renderedReport = withTerminalNewline(
        renderValidatedLocalAgentReport(parsed, agentRunArtifacts.decision),
    );
    const serializedObservations = `${JSON.stringify(agentRunArtifacts.observations, null, 2)}\n`;
    const serializedDecision = agentRunArtifacts.decision
        ? `${JSON.stringify(agentRunArtifacts.decision, null, 2)}\n`
        : null;
    const serializedCandidate =
        candidate && options.candidatePatchText !== undefined
            ? withTerminalNewline(options.candidatePatchText)
            : null;
    const serializedUsageSummary = `${JSON.stringify(llmUsage, null, 2)}\n`;
    const artifacts: LocalRunManifest['artifacts'] = {
        agentDecision: serializedDecision
            ? createArtifactDigest('agent-decision.json', serializedDecision)
            : null,
        agentObservations: createArtifactDigest('agent-observations.json', serializedObservations),
        agentReport: createArtifactDigest('agent-report.md', renderedReport),
        runResult: createArtifactDigest('run-result.json', serializedResult),
        candidatePatch: serializedCandidate
            ? createArtifactDigest('candidate.patch', serializedCandidate)
            : null,
        llmUsageSummary: createArtifactDigest(LLM_USAGE_SUMMARY_FILE_NAME, serializedUsageSummary),
    };
    const evidence = collectEvidenceDigests(outputPath);
    const manifest: LocalRunManifest = {
        schemaVersion: LocalRunManifestVersion.UsageSummary,
        runId: createRunId(artifacts, evidence),
        artifacts,
        evidence,
    };

    writeAtomicText(runResultPath, serializedResult);
    writeAtomicText(agentObservationsPath, serializedObservations);
    if (serializedDecision) {
        writeAtomicText(agentDecisionPath, serializedDecision);
    } else {
        rmSync(agentDecisionPath, { force: true });
    }
    writeAtomicText(agentReportPath, renderedReport);
    if (serializedCandidate) {
        writeAtomicText(candidatePatchPath, serializedCandidate);
    } else {
        rmSync(candidatePatchPath, { force: true });
    }
    writeAtomicText(llmUsageSummaryPath, serializedUsageSummary);
    writeAtomicText(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    verifyLocalRunManifest(outputPath);
    return {
        agentReportPath,
        agentDecisionPath: agentRunArtifacts.decision ? agentDecisionPath : null,
        agentObservationsPath,
        runResultPath,
        manifestPath,
        candidatePatchPath: candidate ? candidatePatchPath : null,
        llmUsageSummaryPath,
    };
}

/**
 * Read and validate a locked local run record from disk.
 *
 * @param resultPath - Absolute path to the canonical local run wrapper.
 * @returns The schema-validated local run record.
 */
export function readLocalRunOutput(resultPath: string): LocalRunRecord {
    let serializedRecord: unknown;
    try {
        serializedRecord = JSON.parse(
            readImmutableFile(resultPath, 'run-result.json').toString('utf8'),
        );
    } catch (error) {
        throw new Error(`Cannot parse locked run result: ${(error as Error).message}`, {
            cause: error,
        });
    }
    return v.parse(LocalRunRecordSchema, serializedRecord);
}
