import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TraceRecorder } from '../../src/tracer/trace-recorder';
import type { ArtifactRef } from '../../src/types/trace';
import { resolveCandidateVisualEvidence } from '../../src/validator/candidate-evidence-resolver';

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
    const directory = mkdtempSync(join(tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
}

function createRecorder(): TraceRecorder {
    return new TraceRecorder({
        runId: 'candidate-evidence-test',
        issueNumber: 1,
        mode: 'fix',
    });
}

function geometry() {
    return {
        totalCount: 1,
        visibleCount: 1,
        visibleArea: 100,
        clippedCount: 0,
        occludedCount: 0,
    };
}

function structuralSnapshot() {
    return {
        probeSucceeded: true,
        targetCount: 1,
        targetVisibleCount: 1,
        targetTotalHeight: 100,
        targetTotalArea: 100,
        documentHeight: 1_000,
        fixedTopOverlayBottom: 0,
        visibleHeadingCount: 1,
        visibleBreadcrumbCount: 0,
        overlappedHeadingCount: 0,
        overlappedBreadcrumbCount: 0,
        minimumOverlappedLandmarkTop: null,
        meaningfulTextLength: 100,
        textGeometry: geometry(),
        mediaGeometry: geometry(),
        controlGeometry: geometry(),
    };
}

function phase(
    label: 'A' | 'B' | 'C',
    screenshotArtifactId: string,
    fullPageScreenshotArtifactId: string,
) {
    return {
        phase: label,
        screenshotArtifactId,
        fullPageScreenshotArtifactId,
        tileCoverage: tileCoverage(`${label.toLowerCase()}-tile`),
        harArtifactId: `${label}-har`,
        domArtifactId: `${label}-dom`,
        url: 'https://example.com/article',
        appliedRules: label === 'C' ? ['example.com##.ad'] : [],
        antiAdblockDetected: false,
        contentIntact: true,
    };
}

function tileCoverage(artifactId: string, complete = true) {
    return {
        complete,
        documentWidth: 1_920,
        documentHeight: 1_080,
        viewportWidth: 1_920,
        viewportHeight: 1_080,
        overlapPx: 160,
        tiles: [
            {
                artifactId,
                index: 0,
                x: 0,
                y: 0,
                width: 1_920,
                height: 1_080,
                landmark: 'Top story',
            },
        ],
    };
}

function factualValidation() {
    return {
        trustedValidationContext: {
            reportedUrl: 'https://example.com/article',
            baselineHash: 'a'.repeat(64),
            existingRuleCount: 0,
        },
        phaseA: phase('A', 'phase-a-viewport', 'phase-a-full-page'),
        phaseB: phase('B', 'phase-b-viewport', 'phase-b-full-page'),
        phaseC: {
            ...phase('C', 'phase-c-viewport', 'phase-c-full-page'),
            sameDocumentControlScreenshotArtifactId: 'control-viewport',
            sameDocumentControlFullPageScreenshotArtifactId: 'control-full-page',
            sameDocumentControlTileCoverage: tileCoverage('control-tile'),
            sameDocumentControlViewport: { x: 0, y: 120 },
            candidateViewport: { x: 0.5, y: 120.5 },
        },
        validatedSelector: '.ad',
        adElementStatus: {
            selector: '.ad',
            phaseB: 'visible',
            phaseC: 'hidden',
        },
        structuralValidation: {
            phaseB: structuralSnapshot(),
            phaseC: structuralSnapshot(),
            status: 'intact',
            regressionReasons: [],
            requiredAdditionalTopSpacePx: 0,
            strictContentIntact: true,
            documentHeightReductionPx: 0,
            targetHeightReductionPx: 100,
            documentHeightAllowancePx: 0,
        },
        contentIntact: true,
        summary: 'Candidate evidence captured.',
    };
}

function addFileArtifact(
    recorder: TraceRecorder,
    directory: string,
    id: string,
    type: string,
    filename = `${id}.png`,
): ArtifactRef {
    const path = join(directory, filename);
    writeFileSync(path, Buffer.from(id));
    const artifact = { id, path, type, bytes: Buffer.byteLength(id) };
    recorder.addArtifact(artifact);
    return artifact;
}

function addScreenshotEvidence(recorder: TraceRecorder, directory: string): void {
    for (const id of ['phase-b-viewport', 'phase-c-viewport', 'control-viewport']) {
        addFileArtifact(recorder, directory, id, 'screenshot');
    }
    for (const id of ['phase-b-full-page', 'phase-c-full-page', 'control-full-page']) {
        addFileArtifact(recorder, directory, id, 'screenshot-full-page');
    }
    for (const id of ['a-tile', 'b-tile', 'c-tile', 'control-tile']) {
        addFileArtifact(recorder, directory, id, 'screenshot-tile');
    }
}

function addValidationArtifact(
    recorder: TraceRecorder,
    directory: string,
    hash: string,
    value: unknown,
    executionSuffix?: string,
): ArtifactRef {
    const serialized = JSON.stringify(value);
    const suffix = executionSuffix ? `-execution-${executionSuffix}` : '';
    const artifact = addFileArtifact(
        recorder,
        directory,
        `validation-${hash}${suffix}`,
        'application/json',
        `factual-validation-${hash}${suffix}.json`,
    );
    writeFileSync(artifact.path, serialized);
    artifact.bytes = Buffer.byteLength(serialized);
    return artifact;
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

describe('resolveCandidateVisualEvidence', () => {
    it('resolves the aligned same-document viewport and full-page pair', () => {
        const artifactsDir = temporaryDirectory('candidate-evidence-same-document-');
        const recorder = createRecorder();
        const executionSuffix = 'f'.repeat(16);
        addScreenshotEvidence(recorder, artifactsDir);
        addValidationArtifact(
            recorder,
            artifactsDir,
            '123456abcdef',
            factualValidation(),
            executionSuffix,
        );

        const result = resolveCandidateVisualEvidence({
            artifactsDir,
            recorder,
            validationArtifactId: `validation-123456abcdef-execution-${executionSuffix}`,
        });

        expect(result.beforeViewport).toEqual({
            id: 'control-viewport',
            path: realpathSync(join(artifactsDir, 'control-viewport.png')),
        });
        expect(result.beforeFullPage).toEqual({
            id: 'control-full-page',
            path: realpathSync(join(artifactsDir, 'control-full-page.png')),
        });
        expect(result.afterViewport).toEqual({
            id: 'phase-c-viewport',
            path: realpathSync(join(artifactsDir, 'phase-c-viewport.png')),
        });
        expect(result.afterFullPage).toEqual({
            id: 'phase-c-full-page',
            path: realpathSync(join(artifactsDir, 'phase-c-full-page.png')),
        });
        expect(result.beforeCoverageComplete).toBe(true);
        expect(result.afterCoverageComplete).toBe(true);
        expect(result.beforeTiles).toEqual([
            {
                id: 'control-tile',
                path: realpathSync(join(artifactsDir, 'control-tile.png')),
                index: 0,
                x: 0,
                y: 0,
                width: 1_920,
                height: 1_080,
                landmark: 'Top story',
            },
        ]);
        expect(result.afterTiles[0]?.id).toBe('c-tile');
        expect(result.factualValidation.validatedSelector).toBe('.ad');
    });

    it('credits a windowed capture that covers its recorded window without claiming document coverage', () => {
        const artifactsDir = temporaryDirectory('candidate-evidence-windowed-');
        const recorder = createRecorder();
        addScreenshotEvidence(recorder, artifactsDir);
        const validation = factualValidation();
        const windowedCoverage = {
            complete: true,
            documentWidth: 1_920,
            documentHeight: 5_400,
            viewportWidth: 1_920,
            viewportHeight: 1_080,
            overlapPx: 160,
            window: { fromY: 100, toY: 900 },
            tiles: [
                {
                    artifactId: 'control-tile',
                    index: 0,
                    x: 0,
                    y: 0,
                    width: 1_920,
                    height: 1_080,
                    landmark: 'Symptom block',
                },
            ],
        };
        validation.phaseB.tileCoverage = {
            ...windowedCoverage,
            tiles: windowedCoverage.tiles.map((tile) => ({ ...tile, artifactId: 'b-tile' })),
        };
        validation.phaseC.sameDocumentControlTileCoverage = windowedCoverage;
        validation.phaseC.tileCoverage = {
            ...windowedCoverage,
            tiles: windowedCoverage.tiles.map((tile) => ({ ...tile, artifactId: 'c-tile' })),
        };
        addValidationArtifact(recorder, artifactsDir, '123456abcdef', validation);

        const result = resolveCandidateVisualEvidence({
            artifactsDir,
            recorder,
            validationArtifactId: 'validation-123456abcdef',
        });

        expect(result.beforeCoverageComplete).toBe(true);
        expect(result.afterCoverageComplete).toBe(true);
        expect(result.beforeDocumentCoverageComplete).toBe(false);
        expect(result.afterDocumentCoverageComplete).toBe(false);
    });

    it('rejects windowed coverage that leaves a gap inside its recorded window', () => {
        const artifactsDir = temporaryDirectory('candidate-evidence-window-gap-');
        const recorder = createRecorder();
        addScreenshotEvidence(recorder, artifactsDir);
        const validation = factualValidation();
        const gappedCoverage = {
            complete: true,
            documentWidth: 1_920,
            documentHeight: 5_400,
            viewportWidth: 1_920,
            viewportHeight: 1_080,
            overlapPx: 160,
            window: { fromY: 500, toY: 900 },
            tiles: [
                {
                    artifactId: 'control-tile',
                    index: 0,
                    x: 0,
                    y: 0,
                    width: 1_920,
                    height: 400,
                    landmark: 'Above window',
                },
            ],
        };
        validation.phaseB.tileCoverage = {
            ...gappedCoverage,
            tiles: gappedCoverage.tiles.map((tile) => ({ ...tile, artifactId: 'b-tile' })),
        };
        validation.phaseC.sameDocumentControlTileCoverage = gappedCoverage;
        validation.phaseC.tileCoverage = {
            ...gappedCoverage,
            tiles: gappedCoverage.tiles.map((tile) => ({ ...tile, artifactId: 'c-tile' })),
        };
        addValidationArtifact(recorder, artifactsDir, '123456abcdef', validation);

        const result = resolveCandidateVisualEvidence({
            artifactsDir,
            recorder,
            validationArtifactId: 'validation-123456abcdef',
        });

        expect(result.beforeCoverageComplete).toBe(false);
        expect(result.afterCoverageComplete).toBe(false);
    });

    it('falls back to Phase B when the complete same-document pair is unavailable', () => {
        const artifactsDir = temporaryDirectory('candidate-evidence-phase-b-');
        const recorder = createRecorder();
        addScreenshotEvidence(recorder, artifactsDir);
        const validation = factualValidation();
        Reflect.deleteProperty(validation.phaseC, 'sameDocumentControlScreenshotArtifactId');
        Reflect.deleteProperty(
            validation.phaseC,
            'sameDocumentControlFullPageScreenshotArtifactId',
        );
        Reflect.deleteProperty(validation.phaseC, 'sameDocumentControlViewport');
        Reflect.deleteProperty(validation.phaseC, 'candidateViewport');
        Reflect.deleteProperty(validation.phaseC, 'sameDocumentControlTileCoverage');
        addValidationArtifact(recorder, artifactsDir, '123456abcdef', validation);

        const result = resolveCandidateVisualEvidence({
            artifactsDir,
            recorder,
            validationArtifactId: 'validation-123456abcdef',
        });

        expect(result.beforeViewport.id).toBe('phase-b-viewport');
        expect(result.beforeFullPage?.id).toBe('phase-b-full-page');
        expect(result.afterViewport.id).toBe('phase-c-viewport');
        expect(result.afterFullPage?.id).toBe('phase-c-full-page');
    });

    it('rejects a partial same-document pair instead of silently using another baseline', () => {
        const artifactsDir = temporaryDirectory('candidate-evidence-partial-control-');
        const recorder = createRecorder();
        addScreenshotEvidence(recorder, artifactsDir);
        const validation = factualValidation();
        Reflect.deleteProperty(
            validation.phaseC,
            'sameDocumentControlFullPageScreenshotArtifactId',
        );
        addValidationArtifact(recorder, artifactsDir, '123456abcdef', validation);

        expect(() =>
            resolveCandidateVisualEvidence({
                artifactsDir,
                recorder,
                validationArtifactId: 'validation-123456abcdef',
            }),
        ).toThrow(/partial same-document/u);
    });

    it('rejects evidence without a registered full-page candidate screenshot', () => {
        const artifactsDir = temporaryDirectory('candidate-evidence-missing-full-page-');
        const recorder = createRecorder();
        addScreenshotEvidence(recorder, artifactsDir);
        const artifacts = recorder.getArtifacts();
        const missing = artifacts.find((artifact) => artifact.id === 'phase-c-full-page');
        const filteredRecorder = createRecorder();
        for (const artifact of artifacts) {
            if (artifact !== missing) {
                filteredRecorder.addArtifact(artifact);
            }
        }
        addValidationArtifact(filteredRecorder, artifactsDir, '123456abcdef', factualValidation());

        expect(() =>
            resolveCandidateVisualEvidence({
                artifactsDir,
                recorder: filteredRecorder,
                validationArtifactId: 'validation-123456abcdef',
            }),
        ).toThrow(/phase-c-full-page/u);
    });

    it('rejects a forged validation identity and a screenshot path outside artifactsDir', () => {
        const artifactsDir = temporaryDirectory('candidate-evidence-forged-');
        const outsideDir = temporaryDirectory('candidate-evidence-outside-');
        const recorder = createRecorder();
        addScreenshotEvidence(recorder, artifactsDir);
        addValidationArtifact(recorder, artifactsDir, '111111111111', factualValidation());
        const validationArtifact = recorder
            .getArtifacts()
            .find((artifact) => artifact.id === 'validation-111111111111');
        if (!validationArtifact) {
            throw new Error('Test setup failed to register validation artifact.');
        }
        validationArtifact.id = 'validation-222222222222';

        expect(() =>
            resolveCandidateVisualEvidence({
                artifactsDir,
                recorder,
                validationArtifactId: 'validation-222222222222',
            }),
        ).toThrow(/not found|latest/u);

        const safeRecorder = createRecorder();
        addScreenshotEvidence(safeRecorder, artifactsDir);
        const escapedPath = join(outsideDir, 'escaped.png');
        writeFileSync(escapedPath, Buffer.from('escaped'));
        const control = safeRecorder
            .getArtifacts()
            .find((artifact) => artifact.id === 'control-viewport');
        if (!control) {
            throw new Error('Test setup failed to register control screenshot.');
        }
        control.path = escapedPath;
        addValidationArtifact(safeRecorder, artifactsDir, '333333333333', factualValidation());

        expect(() =>
            resolveCandidateVisualEvidence({
                artifactsDir,
                recorder: safeRecorder,
                validationArtifactId: 'validation-333333333333',
            }),
        ).toThrow(/escapes the artifacts directory/u);
    });

    it('rejects stale and malformed factual-validation artifacts', () => {
        const artifactsDir = temporaryDirectory('candidate-evidence-stale-');
        const recorder = createRecorder();
        addScreenshotEvidence(recorder, artifactsDir);
        addValidationArtifact(recorder, artifactsDir, '111111111111', factualValidation());
        addValidationArtifact(recorder, artifactsDir, '222222222222', factualValidation());

        expect(() =>
            resolveCandidateVisualEvidence({
                artifactsDir,
                recorder,
                validationArtifactId: 'validation-111111111111',
            }),
        ).toThrow(/latest apply_rule result/u);

        const malformedRecorder = createRecorder();
        addScreenshotEvidence(malformedRecorder, artifactsDir);
        addValidationArtifact(malformedRecorder, artifactsDir, '333333333333', {
            phaseB: {},
            phaseC: {},
        });

        expect(() =>
            resolveCandidateVisualEvidence({
                artifactsDir,
                recorder: malformedRecorder,
                validationArtifactId: 'validation-333333333333',
            }),
        ).toThrow(/malformed/u);
    });

    it('rejects a same-document pair with an error or misaligned viewport coordinates', () => {
        const artifactsDir = temporaryDirectory('candidate-evidence-unaligned-');
        const recorder = createRecorder();
        addScreenshotEvidence(recorder, artifactsDir);
        const validation = factualValidation();
        validation.phaseC.candidateViewport = { x: 0, y: 122 };
        addValidationArtifact(recorder, artifactsDir, '123456abcdef', validation);

        expect(() =>
            resolveCandidateVisualEvidence({
                artifactsDir,
                recorder,
                validationArtifactId: 'validation-123456abcdef',
            }),
        ).toThrow(/aligned/u);

        const errorRecorder = createRecorder();
        addScreenshotEvidence(errorRecorder, artifactsDir);
        const errored = factualValidation();
        Object.assign(errored.phaseC, { sameDocumentControlError: 'capture failed' });
        addValidationArtifact(errorRecorder, artifactsDir, '222222222222', errored);

        expect(() =>
            resolveCandidateVisualEvidence({
                artifactsDir,
                recorder: errorRecorder,
                validationArtifactId: 'validation-222222222222',
            }),
        ).toThrow(/same-document control error/u);
    });
});
