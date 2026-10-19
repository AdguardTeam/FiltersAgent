import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import type { TrustedPageEvaluator } from '../../src/browser/trusted-page-evaluator';
import { materializePage } from '../../src/validator/page-materialization';

describe('materializePage', () => {
    it('names the evaluation error instead of a height that did not settle', async () => {
        await expect(
            materializePage({
                evaluate: async () => {
                    throw new Error('execution context was destroyed');
                },
            }),
        ).resolves.toEqual({
            settled: false,
            reason: expect.stringContaining('execution context was destroyed'),
        });
    });

    it('accepts only a completed stable materialization pass', async () => {
        await expect(
            materializePage({
                evaluate: async () => ({ materialized: true, stable: true, height: 2400 }),
            }),
        ).resolves.toEqual({ settled: true });
        await expect(
            materializePage({
                evaluate: async () => ({ materialized: true, stable: false, height: 3600 }),
            }),
        ).resolves.toMatchObject({ settled: false });
    });

    it('fails closed before scrolling a document above the supported height', async () => {
        const scrollPositions: number[] = [];
        const evaluator: TrustedPageEvaluator = {
            evaluate: async (expression: string): Promise<unknown> =>
                runInNewContext(expression, {
                    document: {
                        body: { scrollHeight: 100_000 },
                        documentElement: { scrollHeight: 100_000 },
                    },
                    setTimeout: (callback: () => void) => callback(),
                    window: {
                        innerHeight: 1080,
                        scrollX: 0,
                        scrollY: 0,
                        scrollTo: (_x: number, y: number) => scrollPositions.push(y),
                    },
                }),
        };

        await expect(materializePage(evaluator)).resolves.toEqual({
            settled: false,
            reason: 'document_height_exceeds_materialization_limit',
        });
        expect(scrollPositions).toEqual([]);
    });

    it('uses viewport-overlapping scroll steps across a supported long document', async () => {
        const scrollPositions: number[] = [];
        const viewportHeight = 1080;
        const documentHeight = 23_500;
        const evaluator: TrustedPageEvaluator = {
            evaluate: async (expression: string): Promise<unknown> =>
                runInNewContext(expression, {
                    document: {
                        body: { scrollHeight: documentHeight },
                        documentElement: { scrollHeight: documentHeight },
                    },
                    setTimeout: (callback: () => void) => callback(),
                    window: {
                        innerHeight: viewportHeight,
                        scrollX: 0,
                        scrollY: 0,
                        scrollTo: (_x: number, y: number) => scrollPositions.push(y),
                    },
                }),
        };

        await expect(materializePage(evaluator)).resolves.toEqual({ settled: true });
        const scanPositions = scrollPositions.slice(0, -1);
        expect(scanPositions.at(-1)).toBe(documentHeight);
        expect(scrollPositions.at(-1)).toBe(0);
        for (let index = 1; index < scanPositions.length; index += 1) {
            expect(scanPositions[index] - scanPositions[index - 1]).toBeLessThan(viewportHeight);
        }
    });
});
