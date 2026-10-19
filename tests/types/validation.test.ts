import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import {
    AdElementPresenceSchema,
    FactualValidationResultSchema,
    PhaseLabelSchema,
    PhaseResultSchema,
    StructuralSnapshotSchema,
} from '../../src/types/validation';

function structuralSnapshot() {
    return {
        probeSucceeded: true,
        targetCount: 1,
        targetVisibleCount: 1,
        targetTotalHeight: 320,
        targetTotalArea: 409_600,
        targetMaximumHeight: 320,
        targetFamilyClass: 'ad-slot',
        familyProbeTruncated: false,
        familyTargetCount: 1,
        familyTargetVisibleCount: 1,
        familyTargetTotalHeight: 320,
        familyTargetMaximumHeight: 320,
        targetMeasurements: [{ key: 'target-1', width: 1280, height: 320 }],
        familyTargetMeasurements: [{ key: 'target-1', width: 1280, height: 320 }],
        documentTimeOrigin: 123,
        documentHeight: 1200,
        fixedTopOverlayBottom: 0,
        visibleHeadingCount: 1,
        visibleBreadcrumbCount: 0,
        overlappedHeadingCount: 0,
        overlappedBreadcrumbCount: 0,
        minimumOverlappedLandmarkTop: null,
        meaningfulTextLength: 2400,
        textGeometry: {
            totalCount: 12,
            visibleCount: 12,
            visibleArea: 300_000,
            clippedCount: 0,
            occludedCount: 0,
        },
        mediaGeometry: {
            totalCount: 2,
            visibleCount: 2,
            visibleArea: 180_000,
            clippedCount: 0,
            occludedCount: 0,
        },
        controlGeometry: {
            totalCount: 3,
            visibleCount: 3,
            visibleArea: 18_000,
            clippedCount: 0,
            occludedCount: 0,
        },
    };
}

function phase(phaseLabel: 'A' | 'B' | 'C') {
    return {
        phase: phaseLabel,
        screenshotArtifactId: `screenshot-${phaseLabel}`,
        fullPageScreenshotArtifactId: `full-page-${phaseLabel}`,
        harArtifactId: `har-${phaseLabel}`,
        domArtifactId: `dom-${phaseLabel}`,
        url: 'https://example.com',
        appliedRules: [],
        antiAdblockDetected: false,
    };
}

describe('validation schemas', () => {
    it('parses raw phase evidence without a page-safety verdict', () => {
        const result = v.parse(PhaseResultSchema, {
            ...phase('A'),
            contentIntact: false,
        });

        expect(result.phase).toBe('A');
        expect(result).not.toHaveProperty('contentIntact');
    });

    it('parses raw structure facts', () => {
        const before = structuralSnapshot();
        const after = {
            ...before,
            targetTotalHeight: 52,
            targetTotalArea: 66_560,
            targetMaximumHeight: 52,
            targetMeasurements: [{ key: 'target-1', width: 1280, height: 52 }],
        };
        const result = v.parse(FactualValidationResultSchema, {
            trustedValidationContext: {
                reportedUrl: 'https://example.com',
                baselineHash: 'a'.repeat(64),
                existingRuleCount: 1,
            },
            phaseA: phase('A'),
            phaseB: phase('B'),
            phaseC: phase('C'),
            validatedSelector: '.reserved-slot',
            adElementStatus: {
                selector: '.reserved-slot',
                phaseB: 'visible',
                phaseC: 'visible',
            },
            structureFacts: { before, after },
            structuralValidation: { status: 'regressed' },
            layoutValidation: { effect: 'height_reduced' },
            contentIntact: false,
            summary: 'Raw facts only.',
        });

        expect(result.structureFacts?.after.targetMaximumHeight).toBe(52);
        expect(result).not.toHaveProperty('structuralValidation');
        expect(result).not.toHaveProperty('layoutValidation');
        expect(result).not.toHaveProperty('contentIntact');
    });

    it('requires runner-bound validation context and selector facts', () => {
        expect(() =>
            v.parse(FactualValidationResultSchema, {
                phaseA: phase('A'),
                phaseB: phase('B'),
                phaseC: phase('C'),
                summary: 'Incomplete.',
            }),
        ).toThrow();
    });

    it('validates raw labels, presence, and structure values', () => {
        expect(v.parse(PhaseLabelSchema, 'B')).toBe('B');
        expect(v.parse(AdElementPresenceSchema, 'visible')).toBe('visible');
        expect(v.parse(StructuralSnapshotSchema, structuralSnapshot()).probeSucceeded).toBe(true);

        expect(() => v.parse(PhaseLabelSchema, 'D')).toThrow();
        expect(() => v.parse(AdElementPresenceSchema, 'maybe')).toThrow();
    });
});
