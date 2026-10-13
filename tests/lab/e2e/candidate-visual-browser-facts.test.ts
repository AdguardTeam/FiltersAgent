import { describe, expect, it } from 'vitest';
import { buildCandidateVisualBrowserFacts } from '../../../lab/e2e/candidate-visual-browser-facts';
import type { FactualValidationResult } from '../../../src/types/validation';

describe('buildCandidateVisualBrowserFacts', () => {
    it('keeps compact before and after family facts without raw measurements or HAR data', () => {
        // oxlint-disable-next-line unicorn/consistent-function-scoping -- Scenario-local fixture.
        const snapshot = (visibleCount: number) => ({
            probeSucceeded: true,
            documentHeight: 12_000,
            targetCount: 1,
            targetVisibleCount: visibleCount,
            targetTotalHeight: visibleCount * 300,
            targetFamilyClass: 'banner',
            familyProbeTruncated: false,
            familyTargetCount: 13,
            familyTargetVisibleCount: visibleCount,
            familyTargetTotalHeight: visibleCount * 300,
            targetMeasurements: [{ key: 'private-dom-key', width: 1_920, height: 300 }],
        });
        const facts = buildCandidateVisualBrowserFacts({
            validatedSelector: 'body > div.banner',
            adElementStatus: { selector: '.banner', phaseB: 'visible', phaseC: 'hidden' },
            phaseB: {
                tileCoverage: { complete: true, tiles: [{ artifactId: 'before-tile' }] },
            },
            phaseC: {
                tileCoverage: { complete: true, tiles: [{ artifactId: 'after-tile' }] },
                harArtifactId: 'should-not-be-in-vision-context',
            },
            structureFacts: {
                before: snapshot(13),
                after: snapshot(12),
                afterArtifacts: snapshot(12),
            },
        } as unknown as FactualValidationResult);

        expect(facts).toMatchObject({
            family: {
                before: { targetFamilyClass: 'banner', familyTargetVisibleCount: 13 },
                after: { targetFamilyClass: 'banner', familyTargetVisibleCount: 12 },
            },
            captureCoverage: {
                before: { complete: true, tileCount: 1 },
                after: { complete: true, tileCount: 1 },
            },
        });
        expect(JSON.stringify(facts)).not.toContain('private-dom-key');
        expect(JSON.stringify(facts)).not.toContain('should-not-be-in-vision-context');
    });
});
