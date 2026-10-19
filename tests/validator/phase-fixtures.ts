import { vi } from 'vitest';
import type { Page } from 'playwright-core';

/**
 * Create a Playwright page double whose `evaluate` returns one complete structural snapshot.
 *
 * @returns Page double exposing only `evaluate`.
 */
export function mockPage(): Page {
    return {
        evaluate: vi.fn().mockResolvedValue({
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
            targetMeasurements: [{ key: 'id:slot', width: 1280, height: 320 }],
            familyTargetMeasurements: [{ key: 'id:slot', width: 1280, height: 320 }],
            documentTimeOrigin: 1_000,
            documentHeight: 1600,
            fixedTopOverlayBottom: 80,
            visibleHeadingCount: 1,
            visibleBreadcrumbCount: 1,
            overlappedHeadingCount: 0,
            overlappedBreadcrumbCount: 0,
            minimumOverlappedLandmarkTop: null,
            meaningfulTextLength: 4000,
            textGeometry: {
                totalCount: 20,
                visibleCount: 20,
                visibleArea: 600_000,
                clippedCount: 0,
                occludedCount: 0,
            },
            mediaGeometry: {
                totalCount: 3,
                visibleCount: 3,
                visibleArea: 300_000,
                clippedCount: 0,
                occludedCount: 0,
            },
            controlGeometry: {
                totalCount: 4,
                visibleCount: 4,
                visibleArea: 24_000,
                clippedCount: 0,
                occludedCount: 0,
            },
        }),
    } as unknown as Page;
}
