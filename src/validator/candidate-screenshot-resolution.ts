import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import type { ArtifactRef } from '../types/trace';
import { ScreenshotArtifactType, type FullPageTileCoverage } from '../types/validation';
import type {
    CandidateVisualDocumentSize,
    CandidateVisualEvidenceImage,
    CandidateVisualEvidenceTile,
    CandidateVisualTileWindowMap,
} from './candidate-visual-evidence';

/**
 * Binding of the screenshots one factual validation names to registered, contained files: each
 * screenshot by its exact media role, and each phase's tiles with the mechanical check of what they
 * cover. It judges nothing the screenshots show.
 */

/**
 * Canonical tile paths and the mechanically checked coverage outcome for one page state.
 */
export interface ResolvedTileCoverage {
    /**
     * Registered original-resolution tiles in document order.
     */
    tiles: CandidateVisualEvidenceTile[];

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
     * Short of it, the review answers only for the window the tiles cover.
     */
    documentComplete: boolean;

    /**
     * Document extent the capture measured, absent when the phase recorded no tile coverage.
     */
    document?: CandidateVisualDocumentSize;

    /**
     * Map of the tile window, present only for a document too tall for its overview to be read.
     */
    map?: CandidateVisualTileWindowMap;
}

/**
 * Resolve a canonical regular file contained by the configured artifacts root.
 *
 * @param artifactsDir - Trusted root directory for the current browser run.
 * @param artifactPath - Registered path to resolve.
 * @param artifactId - Artifact identifier used in errors.
 * @returns Canonical path to the contained regular file.
 */
export function resolveContainedFile(
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
export function resolveScreenshot(
    artifacts: readonly ArtifactRef[],
    artifactsDir: string,
    artifactId: string,
    expectedType: ScreenshotArtifactType,
): CandidateVisualEvidenceImage {
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
    // document, and the review answers for that window alone; the overview is only its map.
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
export function resolveTileCoverage(
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
            ScreenshotArtifactType.Tile,
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
    const map = coverage.map;
    return {
        tiles,
        complete: coverage.complete && tilesCoverDocument(coverage),
        documentComplete: coverage.complete && !coverage.window && tilesCoverDocument(coverage),
        document: { width: coverage.documentWidth, height: coverage.documentHeight },
        ...(map === undefined
            ? {}
            : {
                  map: {
                      ...resolveScreenshot(
                          artifacts,
                          artifactsDir,
                          map.artifactId,
                          ScreenshotArtifactType.TileWindowMap,
                      ),
                      y: map.y,
                      height: map.height,
                  },
              }),
    };
}
