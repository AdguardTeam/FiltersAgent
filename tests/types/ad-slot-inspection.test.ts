import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import {
    AdSlotInspectionResultSchema,
    AdSlotScanResultSchema,
} from '../../src/types/ad-slot-inspection';

const element = {
    tag: 'article',
    id: null,
    classes: ['single-post-top-ad'],
    viewportRect: {
        x: 0,
        y: 100,
        top: 100,
        right: 1024,
        bottom: 500,
        left: 0,
        width: 1024,
        height: 400,
    },
    computedStyle: {
        display: 'block',
        visibility: 'visible',
        opacity: '1',
        position: 'static',
        height: '400px',
        minHeight: '400px',
        maxHeight: 'none',
    },
    visibility: {
        state: 'visible',
        occupiesLayoutSpace: true,
        intersectsViewport: true,
        ancestorHidden: false,
    },
} as const;

const scan = {
    scope: 'main_frame_light_dom',
    candidateCount: 1,
    returnedCount: 1,
    truncated: false,
    slots: [
        {
            element,
            ancestors: [],
            ancestorChainTruncated: false,
            matchedSignals: ['class-ad-token'],
            contentState: 'empty',
            creativeSignals: [],
            meaningfulTextLength: 0,
            descendantCount: 0,
            contentScanTruncated: false,
        },
    ],
} as const;

describe('AdSlotScanResultSchema', () => {
    it('accepts the bounded typed scan contract and handler artifact ID', () => {
        expect(v.parse(AdSlotScanResultSchema, scan)).toEqual(scan);
        expect(
            v.parse(AdSlotInspectionResultSchema, { ...scan, artifactId: 'slot-scan-1' }),
        ).toMatchObject({ artifactId: 'slot-scan-1' });
    });

    it('rejects more than 32 returned slots', () => {
        expect(() =>
            v.parse(AdSlotScanResultSchema, {
                ...scan,
                returnedCount: 33,
                truncated: true,
                slots: Array.from({ length: 33 }, () => scan.slots[0]),
            }),
        ).toThrow();
    });

    it('rejects more than 32 ancestors or 16 classes and class strings over 128 chars', () => {
        expect(() =>
            v.parse(AdSlotScanResultSchema, {
                ...scan,
                slots: [
                    {
                        ...scan.slots[0],
                        ancestors: Array.from({ length: 33 }, () => element),
                    },
                ],
            }),
        ).toThrow();
        expect(() =>
            v.parse(AdSlotScanResultSchema, {
                ...scan,
                slots: [
                    {
                        ...scan.slots[0],
                        element: {
                            ...element,
                            classes: Array.from({ length: 17 }, () => 'ad'),
                        },
                    },
                ],
            }),
        ).toThrow();
        expect(() =>
            v.parse(AdSlotScanResultSchema, {
                ...scan,
                slots: [
                    {
                        ...scan.slots[0],
                        element: { ...element, classes: ['a'.repeat(129)] },
                    },
                ],
            }),
        ).toThrow();
    });

    it('rejects control characters in returned page identifiers', () => {
        expect(() =>
            v.parse(AdSlotScanResultSchema, {
                ...scan,
                slots: [
                    {
                        ...scan.slots[0],
                        element: { ...element, id: 'ad\u0000-slot' },
                    },
                ],
            }),
        ).toThrow();
        expect(() =>
            v.parse(AdSlotScanResultSchema, {
                ...scan,
                slots: [
                    {
                        ...scan.slots[0],
                        element: { ...element, classes: ['ad\u001b'] },
                    },
                ],
            }),
        ).toThrow();
    });
});
