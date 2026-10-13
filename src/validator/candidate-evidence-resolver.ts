import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, relative, sep } from 'node:path';
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
    type FactualValidationResult,
    type FullPageTileCoverage,
    type PhaseResult,
} from '../types/validation';
import type { CandidateVisualDocumentSize } from './candidate-visual-evidence';

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
 * One registered screenshot bound to its canonical on-disk path.
 */
export interface ResolvedCandidateScreenshot {
    /**
     * Runner-issued artifact identifier.
     */
    id: string;

    /**
     * Canonical path contained by the configured artifacts directory.
     */
    path: string;
}

/**
 * One registered original-resolution tile bound to its document coordinates and local path.
 */
export interface ResolvedCandidateTile extends ResolvedCandidateScreenshot {
    /**
     * Stable zero-based tile position in document order.
     */
    index: number;

    /**
     * Horizontal document coordinate of the tile.
     */
    x: number;

    /**
     * Vertical document coordinate of the tile.
     */
    y: number;

    /**
     * Tile width in CSS pixels.
     */
    width: number;

    /**
     * Tile height in CSS pixels.
     */
    height: number;

    /**
     * Bounded runner-collected page landmark attached to the tile.
     */
    landmark: string;
}

/**
 * Canonical tile paths and the mechanically checked coverage outcome for one page state.
 */
interface ResolvedTileCoverage {
    /**
     * Registered original-resolution tiles in document order.
     */
    tiles: ResolvedCandidateTile[];

    /**
     * Whether the declared rectangles continuously cover the proven capture scope.
     *
     * For a window-bounded capture the scope is the recorded symptom window; otherwise it is the
     * complete document.
     */
    complete: boolean;

    /**
     * Whether the declared rectangles continuously cover the whole document.
     *
     * Only an unwindowed capture can substitute the original-resolution tiles for an oversized
     * full-page overview.
     */
    documentComplete: boolean;

    /**
     * Document extent the capture measured, absent when the phase recorded no tile coverage.
     */
    document?: CandidateVisualDocumentSize;
}

/**
 * Mechanically resolved before/after evidence for candidate visual review.
 */
export interface CandidateVisualEvidence {
    /**
     * Schema-validated factual browser record produced by the validation runner.
     */
    factualValidation: FactualValidationResult;

    /**
     * Viewport screenshot captured before applying the candidate.
     */
    beforeViewport: ResolvedCandidateScreenshot;

    /**
     * Full-page screenshot captured before applying the candidate.
     */
    beforeFullPage: ResolvedCandidateScreenshot;

    /**
     * Viewport screenshot captured after applying the candidate.
     */
    afterViewport: ResolvedCandidateScreenshot;

    /**
     * Full-page screenshot captured after applying the candidate.
     */
    afterFullPage: ResolvedCandidateScreenshot;

    /**
     * Original-resolution tiles covering the before document.
     */
    beforeTiles: ResolvedCandidateTile[];

    /**
     * Original-resolution tiles covering the after document.
     */
    afterTiles: ResolvedCandidateTile[];

    /**
     * Whether runner metadata and resolved tiles cover the proven before capture scope.
     */
    beforeCoverageComplete: boolean;

    /**
     * Whether runner metadata and resolved tiles cover the proven after capture scope.
     */
    afterCoverageComplete: boolean;

    /**
     * Whether runner metadata and resolved tiles cover the complete before document.
     */
    beforeDocumentCoverageComplete: boolean;

    /**
     * Whether runner metadata and resolved tiles cover the complete after document.
     */
    afterDocumentCoverageComplete: boolean;

    /**
     * Document extent of the before capture, absent when that phase recorded no tile coverage.
     *
     * The review needs it to decide whether the full-page overview can be read as one image at all.
     */
    beforeDocument?: CandidateVisualDocumentSize;

    /**
     * Document extent of the after capture, absent when that phase recorded no tile coverage.
     */
    afterDocument?: CandidateVisualDocumentSize;
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
 * Resolve a canonical regular file contained by the configured artifacts root.
 *
 * @param artifactsDir - Trusted root directory for the current browser run.
 * @param artifactPath - Registered path to resolve.
 * @param artifactId - Artifact identifier used in errors.
 * @returns Canonical path to the contained regular file.
 */
function resolveContainedFile(
    artifactsDir: string,
    artifactPath: string,
    artifactId: string,
): string {
    let artifactsRoot: string;
    let canonicalPath: string;
    try {
        artifactsRoot = realpathSync(artifactsDir);
        canonicalPath = realpathSync(artifactPath);
    } catch {
        throw new Error(`Artifact file cannot be resolved: ${artifactId}`);
    }
    const relativePath = relative(artifactsRoot, canonicalPath);
    if (
        relativePath.length === 0 ||
        relativePath === '..' ||
        relativePath.startsWith(`..${sep}`) ||
        isAbsolute(relativePath)
    ) {
        throw new Error(`Artifact escapes the artifacts directory: ${artifactId}`);
    }
    if (!statSync(canonicalPath).isFile()) {
        throw new Error(`Artifact path is not a regular file: ${artifactId}`);
    }
    return canonicalPath;
}

/**
 * Resolve one uniquely registered screenshot with its exact expected artifact type.
 *
 * @param artifacts - Runner-owned artifact registry.
 * @param artifactsDir - Trusted root directory for the current browser run.
 * @param artifactId - Screenshot artifact ID referenced by factual validation.
 * @param expectedType - Exact screenshot media role required by the caller.
 * @returns Bound screenshot ID and canonical path.
 */
function resolveScreenshot(
    artifacts: readonly ArtifactRef[],
    artifactsDir: string,
    artifactId: string,
    expectedType: 'screenshot' | 'screenshot-full-page' | 'screenshot-tile',
): ResolvedCandidateScreenshot {
    const matches = artifacts.filter((artifact) => artifact.id === artifactId);
    if (matches.length !== 1 || matches[0].type !== expectedType) {
        throw new Error(
            `Registered ${expectedType} artifact not found or ambiguous: ${artifactId}`,
        );
    }
    return {
        id: artifactId,
        path: resolveContainedFile(artifactsDir, matches[0].path, artifactId),
    };
}

/**
 * Determine whether tile rectangles mechanically cover the complete declared document.
 *
 * @param coverage - Schema-validated runner tile metadata.
 * @returns Whether every horizontal band is continuously covered from left to right.
 */
function tilesCoverDocument(coverage: FullPageTileCoverage): boolean {
    if (
        coverage.documentWidth <= 0 ||
        coverage.documentHeight <= 0 ||
        coverage.tiles.length === 0
    ) {
        return false;
    }
    if (
        coverage.tiles.some(
            (tile, index) =>
                tile.index !== index ||
                tile.x + tile.width > coverage.documentWidth ||
                tile.y + tile.height > coverage.documentHeight,
        )
    ) {
        return false;
    }
    // A bounded capture proves continuous coverage over its recorded window instead of the whole
    // document; the full-page overview carries the remaining context at overview resolution.
    const coverageTop = coverage.window ? coverage.window.fromY : 0;
    const coverageBottom = coverage.window ? coverage.window.toY : coverage.documentHeight;
    if (coverageBottom <= coverageTop) {
        return false;
    }
    const yBoundaries = [
        coverageTop,
        coverageBottom,
        ...coverage.tiles.flatMap((tile) => [tile.y, tile.y + tile.height]),
    ]
        .filter((value) => value >= coverageTop && value <= coverageBottom)
        .sort((left, right) => left - right);
    const uniqueYBoundaries = [...new Set(yBoundaries)];
    for (let index = 0; index < uniqueYBoundaries.length - 1; index += 1) {
        const top = uniqueYBoundaries[index];
        const bottom = uniqueYBoundaries[index + 1];
        if (bottom <= top) {
            continue;
        }
        const ranges = coverage.tiles
            .filter((tile) => tile.y <= top && tile.y + tile.height >= bottom)
            .map((tile) => [tile.x, tile.x + tile.width] as const)
            .sort((left, right) => left[0] - right[0]);
        let coveredUntil = 0;
        for (const [left, right] of ranges) {
            if (left > coveredUntil) {
                break;
            }
            coveredUntil = Math.max(coveredUntil, right);
        }
        if (coveredUntil < coverage.documentWidth) {
            return false;
        }
    }
    return true;
}

/**
 * Resolve every declared tile through the runner artifact registry and validate page coverage.
 *
 * @param coverage - Optional schema-validated coverage metadata from one phase.
 * @param artifacts - Runner-owned artifact registry.
 * @param artifactsDir - Trusted root directory for the current browser run.
 * @returns Canonical tile paths plus the mechanical completeness outcome.
 */
function resolveTileCoverage(
    coverage: FullPageTileCoverage | undefined,
    artifacts: readonly ArtifactRef[],
    artifactsDir: string,
): ResolvedTileCoverage {
    if (!coverage) {
        return { tiles: [], complete: false, documentComplete: false };
    }
    const tiles = coverage.tiles.map((tile) => {
        const resolved = resolveScreenshot(
            artifacts,
            artifactsDir,
            tile.artifactId,
            'screenshot-tile',
        );
        return {
            ...resolved,
            index: tile.index,
            x: tile.x,
            y: tile.y,
            width: tile.width,
            height: tile.height,
            landmark: tile.landmark,
        };
    });
    return {
        tiles,
        complete: coverage.complete && tilesCoverDocument(coverage),
        documentComplete: coverage.complete && !coverage.window && tilesCoverDocument(coverage),
        document: { width: coverage.documentWidth, height: coverage.documentHeight },
    };
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
 * Determine whether Phase C contains every field needed for a same-document pair.
 *
 * @param phaseC - Parsed Phase C factual result.
 * @returns Whether both screenshot IDs and both viewport coordinates are present.
 */
function hasCompleteSameDocumentPair(phaseC: PhaseResult): boolean {
    return (
        typeof phaseC.sameDocumentControlScreenshotArtifactId === 'string' &&
        phaseC.sameDocumentControlScreenshotArtifactId.length > 0 &&
        typeof phaseC.sameDocumentControlFullPageScreenshotArtifactId === 'string' &&
        phaseC.sameDocumentControlFullPageScreenshotArtifactId.length > 0 &&
        phaseC.sameDocumentControlViewport !== undefined &&
        phaseC.candidateViewport !== undefined
    );
}

/**
 * Determine whether Phase C contains any same-document capture field.
 *
 * @param phaseC - Parsed Phase C factual result.
 * @returns Whether the runner attempted to bind a same-document control pair.
 */
function hasAnySameDocumentEvidence(phaseC: PhaseResult): boolean {
    return (
        phaseC.sameDocumentControlScreenshotArtifactId !== undefined ||
        phaseC.sameDocumentControlFullPageScreenshotArtifactId !== undefined ||
        phaseC.sameDocumentControlTileCoverage !== undefined ||
        phaseC.sameDocumentControlViewport !== undefined ||
        phaseC.candidateViewport !== undefined ||
        phaseC.sameDocumentControlError !== undefined
    );
}

/**
 * Assert that a complete Phase C same-document capture is aligned and error-free.
 *
 * @param phaseC - Parsed Phase C factual result.
 */
function assertAlignedSameDocumentPair(phaseC: PhaseResult): void {
    if (phaseC.sameDocumentControlError !== undefined) {
        throw new Error('Factual validation contains a same-document control error.');
    }
    const before = phaseC.sameDocumentControlViewport;
    const after = phaseC.candidateViewport;
    if (!before || !after || Math.abs(before.x - after.x) > 1 || Math.abs(before.y - after.y) > 1) {
        throw new Error('Factual validation has no aligned same-document viewport pair.');
    }
}

/**
 * Resolve the latest runner-owned factual validation and its visual before/after evidence.
 *
 * This function performs artifact identity, containment, type, completeness, and alignment checks
 * only. It deliberately makes no semantic judgment about whether the candidate fixed or damaged the
 * page.
 *
 * @param options - Runner artifact root, registry, and selected validation artifact ID.
 * @returns Parsed factual data and four canonical screenshot references.
 */
export function resolveCandidateVisualEvidence(
    options: ResolveCandidateVisualEvidenceOptions,
): CandidateVisualEvidence {
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
    const useSameDocumentPair = hasCompleteSameDocumentPair(phaseC);
    if (hasAnySameDocumentEvidence(phaseC) && !useSameDocumentPair) {
        throw new Error('Factual validation contains a partial same-document evidence pair.');
    }
    if (useSameDocumentPair) {
        assertAlignedSameDocumentPair(phaseC);
    }

    const beforeViewportId = useSameDocumentPair
        ? phaseC.sameDocumentControlScreenshotArtifactId
        : phaseB.screenshotArtifactId;
    const beforeFullPageId = useSameDocumentPair
        ? phaseC.sameDocumentControlFullPageScreenshotArtifactId
        : phaseB.fullPageScreenshotArtifactId;
    const afterViewportId = phaseC.screenshotArtifactId;
    const afterFullPageId = phaseC.fullPageScreenshotArtifactId;
    if (!beforeViewportId || !beforeFullPageId || !afterViewportId || !afterFullPageId) {
        throw new Error(
            `Factual validation has incomplete viewport or full-page evidence: ${options.validationArtifactId}`,
        );
    }

    const beforeTileCoverage = resolveTileCoverage(
        useSameDocumentPair ? phaseC.sameDocumentControlTileCoverage : phaseB.tileCoverage,
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
        beforeViewport: resolveScreenshot(
            artifacts,
            options.artifactsDir,
            beforeViewportId,
            'screenshot',
        ),
        beforeFullPage: resolveScreenshot(
            artifacts,
            options.artifactsDir,
            beforeFullPageId,
            'screenshot-full-page',
        ),
        afterViewport: resolveScreenshot(
            artifacts,
            options.artifactsDir,
            afterViewportId,
            'screenshot',
        ),
        afterFullPage: resolveScreenshot(
            artifacts,
            options.artifactsDir,
            afterFullPageId,
            'screenshot-full-page',
        ),
        beforeTiles: beforeTileCoverage.tiles,
        afterTiles: afterTileCoverage.tiles,
        beforeCoverageComplete: beforeTileCoverage.complete,
        afterCoverageComplete: afterTileCoverage.complete,
        beforeDocumentCoverageComplete: beforeTileCoverage.documentComplete,
        afterDocumentCoverageComplete: afterTileCoverage.documentComplete,
        beforeDocument: beforeTileCoverage.document,
        afterDocument: afterTileCoverage.document,
    };
}
