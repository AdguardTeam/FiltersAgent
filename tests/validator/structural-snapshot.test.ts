import { describe, expect, it, vi } from 'vitest';
import { probeStructuralSnapshot } from '../../src/validator/structural-snapshot';
import { mockPage } from './phase-fixtures';
import type { Page } from 'playwright-core';
import { runInNewContext } from 'node:vm';
import type { TrustedPageEvaluator } from '../../src/browser/trusted-page-evaluator';

/**
 * Adapt an explicit Playwright page test double to the trusted evaluator interface.
 */
function trustedEvaluatorFromPage(page: Page): TrustedPageEvaluator {
    return { evaluate: async (expression: string) => page.evaluate(expression) };
}

/**
 * Create a deterministic DOM element for structural-probe VM tests.
 */
function makeStructuralProbeElement(id: string, classList: string[], tagName = 'DIV') {
    return {
        id,
        nodeType: 1,
        tagName,
        classList,
        hidden: false,
        parentElement: null,
        innerText: '',
        getAttribute: () => null,
        getBoundingClientRect: () => ({
            left: 0,
            right: 1920,
            top: 100,
            bottom: 500,
            width: 1920,
            height: 400,
        }),
        contains: () => false,
        closest: () => null,
    };
}

/**
 * Execute structural-probe JavaScript against a controlled semantic family.
 */
function structuralFamilyEvaluator(
    primary: ReturnType<typeof makeStructuralProbeElement>,
    family: unknown[] | Record<string, unknown[]>,
    targetSelector = '#article-primary',
    targetElements: unknown[] = [primary],
): TrustedPageEvaluator {
    return {
        evaluate: async (expression: string): Promise<unknown> =>
            runInNewContext(expression, {
                document: {
                    body: { innerText: '', scrollHeight: 2400 },
                    documentElement: { scrollHeight: 2400 },
                    elementFromPoint: () => null,
                    getElementsByClassName: (className: string) => {
                        if (className === 'unique-ad') {
                            return [primary];
                        }
                        return Array.isArray(family) ? family : (family[className] ?? []);
                    },
                    querySelectorAll: (selector: string) =>
                        selector === targetSelector ? targetElements : [],
                },
                window: {
                    innerHeight: 1080,
                    innerWidth: 1920,
                    getComputedStyle: () => ({
                        contentVisibility: 'visible',
                        display: 'block',
                        opacity: '1',
                        overflowX: 'visible',
                        overflowY: 'visible',
                        position: 'static',
                        visibility: 'visible',
                    }),
                },
                performance: { timeOrigin: 1_000 },
            }),
    };
}

interface StructuralProbeRect {
    left: number;
    right: number;
    top: number;
    bottom: number;
    width: number;
    height: number;
}

interface StructuralProbeElement {
    id: string;
    nodeType: number;
    tagName: string;
    classList: string[];
    hidden: boolean;
    parentElement: StructuralProbeElement | null;
    children: StructuralProbeElement[];
    innerText: string;
    getAttribute: (name: string) => string | null;
    getBoundingClientRect: () => StructuralProbeRect;
    contains: (candidate: StructuralProbeElement) => boolean;
    closest: () => null;
}

function makeGeometryProbeElement(
    id: string,
    tagName: string,
    rect: StructuralProbeRect,
    parentElement: StructuralProbeElement | null = null,
): StructuralProbeElement {
    const element: StructuralProbeElement = {
        id,
        nodeType: 1,
        tagName,
        classList: [],
        hidden: false,
        parentElement,
        children: [],
        innerText: tagName === 'P' ? 'Meaningful article copy used by the structural probe.' : '',
        getAttribute: () => null,
        getBoundingClientRect: () => rect,
        contains: (candidate) => {
            let current: StructuralProbeElement | null = candidate;
            while (current) {
                if (current === element) {
                    return true;
                }
                current = current.parentElement;
            }
            return false;
        },
        closest: () => null,
    };
    if (parentElement) {
        parentElement.children.push(element);
    }
    return element;
}

function structuralGeometryEvaluator(
    target: StructuralProbeElement,
    meaningful: StructuralProbeElement,
    blocker: StructuralProbeElement,
    elementFromPoint: (x: number, y: number) => StructuralProbeElement | null,
): TrustedPageEvaluator {
    return {
        evaluate: async (expression: string): Promise<unknown> =>
            runInNewContext(expression, {
                document: {
                    body: {
                        innerText: meaningful.innerText,
                        scrollHeight: 2400,
                    },
                    documentElement: { scrollHeight: 2400 },
                    elementFromPoint,
                    getElementsByClassName: () => [],
                    querySelectorAll: (selector: string) => {
                        if (selector === '#ad-target') {
                            return [target];
                        }
                        if (selector === 'body *') {
                            return [target, meaningful, blocker];
                        }
                        if (selector === 'h1, h2, h3, p, li, blockquote, figcaption') {
                            return [meaningful];
                        }
                        return [];
                    },
                },
                window: {
                    innerHeight: 100,
                    innerWidth: 100,
                    getComputedStyle: (element: StructuralProbeElement) => ({
                        backgroundColor:
                            element.id === 'modal-overlay'
                                ? 'rgba(0, 0, 0, 0.6)'
                                : 'rgba(0, 0, 0, 0)',
                        backgroundImage: 'none',
                        backdropFilter: 'none',
                        contentVisibility: 'visible',
                        display: 'block',
                        opacity: '1',
                        overflowX: 'visible',
                        overflowY: 'visible',
                        position: 'static',
                        visibility: 'visible',
                    }),
                },
                performance: { timeOrigin: 1_000 },
            }),
    };
}

describe('probeStructuralSnapshot', () => {
    it('samples the viewport intersection instead of clamping an offscreen center', async () => {
        const target = makeGeometryProbeElement('ad-target', 'DIV', {
            left: 0,
            right: 100,
            top: 20,
            bottom: 80,
            width: 100,
            height: 60,
        });
        const meaningful = makeGeometryProbeElement('article-copy', 'P', {
            left: 0,
            right: 100,
            top: -90,
            bottom: 10,
            width: 100,
            height: 100,
        });
        const blocker = makeGeometryProbeElement('viewport-edge', 'DIV', {
            left: 0,
            right: 100,
            top: 0,
            bottom: 1,
            width: 100,
            height: 1,
        });
        const sampledY: number[] = [];
        const evaluator = structuralGeometryEvaluator(target, meaningful, blocker, (_x, y) => {
            sampledY.push(y);
            return y <= 0 ? blocker : meaningful;
        });

        await expect(probeStructuralSnapshot(evaluator, '#ad-target')).resolves.toMatchObject({
            textGeometry: {
                totalCount: 1,
                occludedCount: 0,
            },
        });
        expect(sampledY.length).toBeGreaterThan(1);
        expect(sampledY.every((y) => y > 0 && y < 10)).toBe(true);
    });

    it('does not classify a single blocked sample as material content occlusion', async () => {
        const target = makeGeometryProbeElement('ad-target', 'DIV', {
            left: 0,
            right: 100,
            top: 0,
            bottom: 100,
            width: 100,
            height: 100,
        });
        const meaningful = makeGeometryProbeElement('article-copy', 'P', {
            left: 10,
            right: 90,
            top: 10,
            bottom: 90,
            width: 80,
            height: 80,
        });
        const blocker = makeGeometryProbeElement('small-badge', 'DIV', {
            left: 49,
            right: 51,
            top: 49,
            bottom: 51,
            width: 2,
            height: 2,
        });
        const evaluator = structuralGeometryEvaluator(target, meaningful, blocker, (x, y) =>
            x === 50 && y === 50 ? blocker : meaningful,
        );

        await expect(probeStructuralSnapshot(evaluator, '#ad-target')).resolves.toMatchObject({
            textGeometry: {
                occludedCount: 0,
            },
        });
    });

    it('ignores a transparent stretched-link hit area covering meaningful content', async () => {
        const target = makeGeometryProbeElement('ad-target', 'DIV', {
            left: 0,
            right: 100,
            top: 0,
            bottom: 10,
            width: 100,
            height: 10,
        });
        const meaningful = makeGeometryProbeElement('article-copy', 'P', {
            left: 10,
            right: 90,
            top: 10,
            bottom: 90,
            width: 80,
            height: 80,
        });
        const transparentLink = makeGeometryProbeElement('stretched-link', 'A', {
            left: 10,
            right: 90,
            top: 10,
            bottom: 90,
            width: 80,
            height: 80,
        });
        const evaluator = structuralGeometryEvaluator(
            target,
            meaningful,
            transparentLink,
            () => transparentLink,
        );

        await expect(probeStructuralSnapshot(evaluator, '#ad-target')).resolves.toMatchObject({
            textGeometry: {
                occludedCount: 0,
                occlusionEvidence: [],
            },
        });
    });

    it('excludes meaningful descendants of the candidate target from occlusion counting', async () => {
        const target = makeGeometryProbeElement('ad-target', 'DIV', {
            left: 0,
            right: 100,
            top: 0,
            bottom: 100,
            width: 100,
            height: 100,
        });
        const meaningful = makeGeometryProbeElement(
            'ad-copy',
            'P',
            {
                left: 10,
                right: 90,
                top: 10,
                bottom: 90,
                width: 80,
                height: 80,
            },
            target,
        );
        const blocker = makeGeometryProbeElement('page-overlay', 'DIV', {
            left: 0,
            right: 100,
            top: 0,
            bottom: 100,
            width: 100,
            height: 100,
        });
        const evaluator = structuralGeometryEvaluator(target, meaningful, blocker, () => blocker);

        await expect(probeStructuralSnapshot(evaluator, '#ad-target')).resolves.toMatchObject({
            textGeometry: {
                totalCount: 1,
                occludedCount: 0,
            },
        });
    });

    it('records a material overlay and keeps it available to the hard regression guard', async () => {
        const target = makeGeometryProbeElement('ad-target', 'DIV', {
            left: 0,
            right: 100,
            top: 0,
            bottom: 100,
            width: 100,
            height: 100,
        });
        const meaningful = makeGeometryProbeElement('article-copy', 'P', {
            left: 10,
            right: 90,
            top: 10,
            bottom: 90,
            width: 80,
            height: 80,
        });
        const blocker = makeGeometryProbeElement('modal-overlay', 'DIV', {
            left: 0,
            right: 100,
            top: 0,
            bottom: 100,
            width: 100,
            height: 100,
        });
        const evaluator = structuralGeometryEvaluator(target, meaningful, blocker, () => blocker);

        await expect(probeStructuralSnapshot(evaluator, '#ad-target')).resolves.toMatchObject({
            textGeometry: {
                occludedCount: 1,
                occlusionEvidence: [
                    {
                        targetKey: 'id:article-copy',
                        blockerKeys: ['id:modal-overlay'],
                        occludedSampleCount: 5,
                        sampleCount: 5,
                    },
                ],
            },
        });
    });

    it('keeps an exact semantic class family instead of a broader utility class', async () => {
        const targets = Array.from({ length: 4 }, (_, index) =>
            makeStructuralProbeElement(`article-${index}`, ['single-post-top-ad', 'z-20']),
        );
        const unrelatedUtilityElements = Array.from({ length: 27 }, (_, index) =>
            makeStructuralProbeElement(`utility-${index}`, ['z-20']),
        );

        await expect(
            probeStructuralSnapshot(
                structuralFamilyEvaluator(
                    targets[0],
                    {
                        'single-post-top-ad': targets,
                        'z-20': [...targets, ...unrelatedUtilityElements],
                    },
                    '.single-post-top-ad',
                    targets,
                ),
                '.single-post-top-ad',
            ),
        ).resolves.toMatchObject({
            probeSucceeded: true,
            targetCount: 4,
            targetFamilyClass: 'single-post-top-ad',
            familyProbeTruncated: false,
            familyTargetCount: 4,
            familyTargetVisibleCount: 4,
        });
    });

    it('keeps a tag-qualified multi-target semantic family over a broader utility class', async () => {
        const targets = Array.from({ length: 4 }, (_, index) =>
            makeStructuralProbeElement(`article-${index}`, ['single-post-top-ad', 'z-20']),
        );
        const unrelatedUtilityElements = Array.from({ length: 27 }, (_, index) =>
            makeStructuralProbeElement(`utility-${index}`, ['z-20']),
        );

        await expect(
            probeStructuralSnapshot(
                structuralFamilyEvaluator(
                    targets[0],
                    {
                        'single-post-top-ad': targets,
                        'z-20': [...targets, ...unrelatedUtilityElements],
                    },
                    'article.single-post-top-ad',
                    targets,
                ),
                'article.single-post-top-ad',
            ),
        ).resolves.toMatchObject({
            probeSucceeded: true,
            targetCount: 4,
            targetFamilyClass: 'single-post-top-ad',
            familyTargetCount: 4,
            familyTargetVisibleCount: 4,
        });
    });

    it('keeps a tag-qualified singleton semantic family over a broader utility class', async () => {
        const primary = makeStructuralProbeElement('article-primary', [
            'single-post-top-ad',
            'z-20',
        ]);
        const unrelatedUtilityElements = Array.from({ length: 27 }, (_, index) =>
            makeStructuralProbeElement(`utility-${index}`, ['z-20']),
        );

        await expect(
            probeStructuralSnapshot(
                structuralFamilyEvaluator(
                    primary,
                    {
                        'single-post-top-ad': [primary],
                        'z-20': [primary, ...unrelatedUtilityElements],
                    },
                    'article.single-post-top-ad',
                    [primary],
                ),
                'article.single-post-top-ad',
            ),
        ).resolves.toMatchObject({
            probeSucceeded: true,
            targetCount: 1,
            targetFamilyClass: 'single-post-top-ad',
            familyTargetCount: 1,
            familyTargetVisibleCount: 1,
        });
    });

    it('rejects an exact non-semantic class as a complete repeated-slot family', async () => {
        const primary = makeStructuralProbeElement('article-primary', [
            'article-primary',
            'single-post-top-ad',
        ]);
        const family = [
            primary,
            makeStructuralProbeElement('clone-1', ['single-post-top-ad']),
            makeStructuralProbeElement('clone-2', ['single-post-top-ad']),
            makeStructuralProbeElement('clone-3', ['single-post-top-ad']),
        ];

        await expect(
            probeStructuralSnapshot(
                structuralFamilyEvaluator(
                    primary,
                    {
                        'article-primary': [primary],
                        'single-post-top-ad': family,
                    },
                    '.article-primary',
                    [primary],
                ),
                '.article-primary',
            ),
        ).resolves.toMatchObject({
            probeSucceeded: true,
            targetCount: 1,
            targetFamilyClass: 'single-post-top-ad',
            familyTargetCount: 4,
            familyTargetVisibleCount: 4,
        });
    });

    it('rejects an exact singleton semantic class when a broader semantic family exists', async () => {
        const primary = makeStructuralProbeElement('article-primary', [
            'ad-slot-primary',
            'single-post-top-ad',
        ]);
        const family = [
            primary,
            makeStructuralProbeElement('clone-1', ['single-post-top-ad']),
            makeStructuralProbeElement('clone-2', ['single-post-top-ad']),
            makeStructuralProbeElement('clone-3', ['single-post-top-ad']),
        ];

        await expect(
            probeStructuralSnapshot(
                structuralFamilyEvaluator(
                    primary,
                    {
                        'ad-slot-primary': [primary],
                        'single-post-top-ad': family,
                    },
                    '.ad-slot-primary',
                    [primary],
                ),
                '.ad-slot-primary',
            ),
        ).resolves.toMatchObject({
            probeSucceeded: true,
            targetCount: 1,
            targetFamilyClass: 'single-post-top-ad',
            familyTargetCount: 4,
            familyTargetVisibleCount: 4,
        });
    });

    it('rejects an exact semantic subset when a broader semantic family exists', async () => {
        const subset = [
            makeStructuralProbeElement('article-primary', [
                'ad-slot-primary',
                'single-post-top-ad',
            ]),
            makeStructuralProbeElement('article-secondary', [
                'ad-slot-primary',
                'single-post-top-ad',
            ]),
        ];
        const family = [
            ...subset,
            makeStructuralProbeElement('clone-1', ['single-post-top-ad']),
            makeStructuralProbeElement('clone-2', ['single-post-top-ad']),
        ];

        await expect(
            probeStructuralSnapshot(
                structuralFamilyEvaluator(
                    subset[0],
                    {
                        'ad-slot-primary': subset,
                        'single-post-top-ad': family,
                    },
                    '.ad-slot-primary',
                    subset,
                ),
                '.ad-slot-primary',
            ),
        ).resolves.toMatchObject({
            probeSucceeded: true,
            targetCount: 2,
            targetFamilyClass: 'single-post-top-ad',
            familyTargetCount: 4,
            familyTargetVisibleCount: 4,
        });
    });

    it('uses the broadest semantic class across element tags as the target family', async () => {
        const primary = makeStructuralProbeElement(
            'article-primary',
            ['unique-ad', 'single-post-top-ad'],
            'DIV',
        );
        const family = [
            primary,
            makeStructuralProbeElement('clone-1', ['single-post-top-ad'], 'SECTION'),
            makeStructuralProbeElement('clone-2', ['single-post-top-ad'], 'ASIDE'),
            makeStructuralProbeElement('clone-3', ['single-post-top-ad'], 'DIV'),
        ];

        await expect(
            probeStructuralSnapshot(structuralFamilyEvaluator(primary, family), '#article-primary'),
        ).resolves.toMatchObject({
            probeSucceeded: true,
            targetCount: 1,
            targetFamilyClass: 'single-post-top-ad',
            familyProbeTruncated: false,
            familyTargetCount: 4,
            familyTargetVisibleCount: 4,
            familyTargetMaximumHeight: 400,
            familyTargetMeasurements: expect.arrayContaining([
                expect.objectContaining({ key: 'id:clone-1', height: 400 }),
                expect.objectContaining({ key: 'id:clone-2', height: 400 }),
            ]),
        });
    });

    it('marks an oversized semantic family unavailable instead of selecting a unique class', async () => {
        const primary = makeStructuralProbeElement('article-primary', [
            'unique-ad',
            'single-post-top-ad',
        ]);
        const family = [
            primary,
            ...Array.from({ length: 128 }, (_, index) =>
                makeStructuralProbeElement(`clone-${index}`, ['single-post-top-ad']),
            ),
        ];

        await expect(
            probeStructuralSnapshot(structuralFamilyEvaluator(primary, family), '#article-primary'),
        ).resolves.toMatchObject({
            probeSucceeded: true,
            targetFamilyClass: 'single-post-top-ad',
            familyProbeTruncated: true,
            familyTargetCount: 129,
            familyTargetMeasurements: [],
        });
    });

    it('normalizes camelCase ad-slot classes when binding a related target family', async () => {
        const primary = makeStructuralProbeElement('article-primary', ['unique-ad', 'adSlot']);
        const family = [
            primary,
            makeStructuralProbeElement('clone-1', ['adSlot']),
            makeStructuralProbeElement('clone-2', ['adSlot']),
        ];

        await expect(
            probeStructuralSnapshot(structuralFamilyEvaluator(primary, family), '#article-primary'),
        ).resolves.toMatchObject({
            targetFamilyClass: 'adSlot',
            familyTargetCount: 3,
        });
    });

    it('uses a broader opaque co-member class instead of a unique semantic class', async () => {
        const primary = makeStructuralProbeElement('article-primary', ['unique-ad', 'promoBox']);
        const family = [
            primary,
            makeStructuralProbeElement('clone-1', ['promoBox']),
            makeStructuralProbeElement('clone-2', ['promoBox']),
        ];

        await expect(
            probeStructuralSnapshot(structuralFamilyEvaluator(primary, family), '#article-primary'),
        ).resolves.toMatchObject({
            targetFamilyClass: 'promoBox',
            familyTargetCount: 3,
        });
    });

    it('prefers a strictly broader opaque family over a repeated semantic subset', async () => {
        const primary = makeStructuralProbeElement('article-primary', ['adSlot', 'promoBox']);
        const semanticSibling = makeStructuralProbeElement('semantic-sibling', [
            'adSlot',
            'promoBox',
        ]);
        const opaqueOnlySiblings = [
            makeStructuralProbeElement('opaque-1', ['promoBox']),
            makeStructuralProbeElement('opaque-2', ['promoBox']),
        ];

        await expect(
            probeStructuralSnapshot(
                structuralFamilyEvaluator(primary, {
                    adSlot: [primary, semanticSibling],
                    promoBox: [primary, semanticSibling, ...opaqueOnlySiblings],
                }),
                '#article-primary',
            ),
        ).resolves.toMatchObject({
            targetFamilyClass: 'promoBox',
            familyTargetCount: 4,
        });
    });

    it('accepts a complete deterministic browser snapshot', async () => {
        const page = mockPage();

        await expect(
            probeStructuralSnapshot(trustedEvaluatorFromPage(page), '.ad-slot'),
        ).resolves.toMatchObject({
            probeSucceeded: true,
            targetCount: 1,
            targetMaximumHeight: 320,
            targetFamilyClass: 'ad-slot',
            familyTargetCount: 1,
            fixedTopOverlayBottom: 80,
        });
        expect(page.evaluate).toHaveBeenCalledWith(expect.stringContaining('".ad-slot"'));
    });

    it('fails closed for malformed browser output', async () => {
        const page = mockPage();
        vi.mocked(page.evaluate).mockResolvedValueOnce({ targetCount: 1 });

        await expect(
            probeStructuralSnapshot(trustedEvaluatorFromPage(page), '.ad-slot'),
        ).resolves.toMatchObject({
            probeSucceeded: false,
            targetCount: 0,
        });
    });
});
