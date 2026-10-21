import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import * as v from 'valibot';
import type { TraceRecorder } from '../tracer/trace-recorder';
import type { ArtifactRef } from '../types/trace';
import {
    candidateArtifactIdentitiesEqual,
    parseCandidateValidationArtifactFilename,
    parseCandidateValidationArtifactId,
    type CandidateArtifactIdentity,
} from '../types/candidate-artifact-identity';
import {
    FactualValidationResultSchema,
    ScreenshotArtifactType,
    type FactualValidationResult,
} from '../types/validation';
import type { CandidateVisualEvidence } from './candidate-visual-evidence';
import {
    resolveContainedFile,
    resolveScreenshot,
    resolveTileCoverage,
} from './candidate-screenshot-resolution';
import { mapCandidateOverviews } from '../types/candidate-screenshot-paths';

/**
 * Inputs used to resolve browser evidence for one candidate review.
 */
export interface ResolveCandidateVisualEvidenceOptions {
    /**
     * Root directory that must contain every resolved evidence file.
     */
    artifactsDir: string;

    /**
     * Runner-owned trace recorder containing the authoritative artifact registry.
     */
    recorder: TraceRecorder;

    /**
     * Opaque factual-validation artifact ID returned by the latest `apply_rule` call.
     */
    validationArtifactId: string;
}

/**
 * Mechanically resolved before/after evidence for candidate visual review: the evidence the review
 * reads, with the factual record it came from and both document-coverage proofs always measured.
 */
export interface ResolvedCandidateVisualEvidence extends CandidateVisualEvidence {
    /**
     * Schema-validated factual browser record produced by the validation runner.
     */
    factualValidation: FactualValidationResult;

    /**
     * Whether runner metadata and resolved tiles cover the complete before document.
     */
    beforeDocumentCoverageComplete: boolean;

    /**
     * Whether runner metadata and resolved tiles cover the complete after document.
     */
    afterDocumentCoverageComplete: boolean;
}

/**
 * Return the shared runner identity hash encoded in a factual artifact reference.
 *
 * @param artifact - Registered artifact metadata to inspect.
 * @returns Matching semantic and physical identity, or null for a non-runner artifact.
 */
function runnerValidationArtifactIdentity(artifact: ArtifactRef): CandidateArtifactIdentity | null {
    if (artifact.type !== 'application/json') {
        return null;
    }
    const idIdentity = parseCandidateValidationArtifactId(artifact.id);
    const filenameIdentity = parseCandidateValidationArtifactFilename(basename(artifact.path));
    return candidateArtifactIdentitiesEqual(idIdentity, filenameIdentity) ? idIdentity : null;
}

/**
 * Parse one runner-owned factual-validation JSON file with the shared schema.
 *
 * @param path - Canonical factual-validation JSON path.
 * @param validationArtifactId - Artifact identifier used in errors.
 * @returns Validated factual browser record.
 */
function parseFactualValidation(
    path: string,
    validationArtifactId: string,
): FactualValidationResult {
    let value: unknown;
    try {
        value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    } catch {
        throw new Error(`Factual validation artifact is not valid JSON: ${validationArtifactId}`);
    }
    const parsed = v.safeParse(FactualValidationResultSchema, value);
    if (!parsed.success) {
        throw new Error(`Factual validation artifact is malformed: ${validationArtifactId}`);
    }
    return parsed.output;
}

/**
 * Resolve the latest runner-owned factual validation and its visual before/after evidence.
 *
 * This function performs artifact identity, containment, type, and completeness checks only. It
 * deliberately makes no semantic judgment about whether the candidate fixed or damaged the page.
 *
 * @param options - Runner artifact root, registry, and selected validation artifact ID.
 * @returns Parsed factual data and canonical screenshot references: both viewports and the
 *   full-page overviews the browser captured.
 */
export function resolveCandidateVisualEvidence(
    options: ResolveCandidateVisualEvidenceOptions,
): ResolvedCandidateVisualEvidence {
    const artifacts = options.recorder.getArtifacts();
    const factualArtifacts = artifacts.filter(
        (artifact) =>
            artifact.type === 'application/json' &&
            artifact.id.startsWith('validation-') &&
            basename(artifact.path).startsWith('factual-validation-'),
    );
    const latestFactualArtifact = factualArtifacts.at(-1);
    if (!latestFactualArtifact || latestFactualArtifact.id !== options.validationArtifactId) {
        throw new Error(
            `Factual validation artifact is not the latest apply_rule result: ${options.validationArtifactId}`,
        );
    }
    const requestedIdentity = parseCandidateValidationArtifactId(options.validationArtifactId);
    if (
        !candidateArtifactIdentitiesEqual(
            requestedIdentity,
            runnerValidationArtifactIdentity(latestFactualArtifact),
        )
    ) {
        throw new Error(`Factual validation artifact not found: ${options.validationArtifactId}`);
    }

    const validationPath = resolveContainedFile(
        options.artifactsDir,
        latestFactualArtifact.path,
        options.validationArtifactId,
    );
    const factualValidation = parseFactualValidation(validationPath, options.validationArtifactId);
    const phaseB = factualValidation.phaseB;
    const phaseC = factualValidation.phaseC;
    const beforeViewportId = phaseB.screenshotArtifactId;
    const beforeFullPageId = phaseB.fullPageScreenshotArtifactId;
    const afterViewportId = phaseC.screenshotArtifactId;
    const afterFullPageId = phaseC.fullPageScreenshotArtifactId;
    if (!beforeViewportId || !afterViewportId) {
        throw new Error(
            `Factual validation has incomplete viewport evidence: ${options.validationArtifactId}`,
        );
    }
    /**
     * Resolve one registered screenshot of this validation.
     *
     * @param artifactId - Screenshot identity the factual record names.
     * @param role - Media role the artifact must be registered with.
     * @returns The bound screenshot.
     */
    const screenshot = (artifactId: string, role: Parameters<typeof resolveScreenshot>[3]) =>
        resolveScreenshot(artifacts, options.artifactsDir, artifactId, role);

    const beforeTileCoverage = resolveTileCoverage(
        phaseB.tileCoverage,
        artifacts,
        options.artifactsDir,
    );
    const afterTileCoverage = resolveTileCoverage(
        phaseC.tileCoverage,
        artifacts,
        options.artifactsDir,
    );

    return {
        factualValidation,
        beforeViewport: screenshot(beforeViewportId, ScreenshotArtifactType.Viewport),
        afterViewport: screenshot(afterViewportId, ScreenshotArtifactType.Viewport),
        // An overview the browser never captured stays absent; the tiles carry that proof.
        ...mapCandidateOverviews(
            { beforeFullPage: beforeFullPageId, afterFullPage: afterFullPageId },
            (artifactId) => screenshot(artifactId, ScreenshotArtifactType.FullPage),
        ),
        beforeTiles: beforeTileCoverage.tiles,
        afterTiles: afterTileCoverage.tiles,
        beforeCoverageComplete: beforeTileCoverage.complete,
        afterCoverageComplete: afterTileCoverage.complete,
        beforeDocumentCoverageComplete: beforeTileCoverage.documentComplete,
        afterDocumentCoverageComplete: afterTileCoverage.documentComplete,
        beforeDocument: beforeTileCoverage.document,
        afterDocument: afterTileCoverage.document,
        ...(beforeTileCoverage.map === undefined
            ? {}
            : { beforeTileWindowMap: beforeTileCoverage.map }),
        ...(afterTileCoverage.map === undefined
            ? {}
            : { afterTileWindowMap: afterTileCoverage.map }),
    };
}
