import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { measureDomChecks } from '../../src/environment/dom-check-runner';
import { TraceRecorder } from '../../src/tracer/trace-recorder';
import {
    DOM_CHECK_TIMEOUT_MS,
    DomCheckMeasurementStatus,
    MAX_DOM_CHECK_RESULT_BYTES,
    type DomCheck,
} from '../../src/types/dom-check';

const roots: string[] = [];

afterEach(() => {
    vi.useRealTimers();
    for (const root of roots.splice(0)) {
        rmSync(root, { force: true, recursive: true });
    }
});

/**
 * The trace owner and artifact directory one phase's checks write to.
 *
 * @returns The run context for phase C.
 */
function phaseContext(): { phase: 'C'; artifactsDir: string; recorder: TraceRecorder } {
    const artifactsDir = mkdtempSync(join(tmpdir(), 'dom-check-runner-'));
    roots.push(artifactsDir);
    return {
        phase: 'C',
        artifactsDir,
        recorder: new TraceRecorder({ runId: 'dom-checks', issueNumber: 1, mode: 'fix' }),
    };
}

/**
 * A check with a throwaway claim.
 *
 * @param expression - The check's expression.
 * @returns The check.
 */
function check(expression: string): DomCheck {
    return { expression, claim: 'The column is page layout.' };
}

describe('measureDomChecks', () => {
    it('keeps real values of a large answer and the whole value as an artifact', async () => {
        // Rects of the children of an emptied column: well past the answer cap, and every
        // value matters to the reviewer.
        const rects = Array.from({ length: 120 }, (_, index) => ({
            top: index * 40,
            height: 40,
            background: 'rgba(0, 0, 0, 0)',
        }));
        const context = phaseContext();
        const [measurement] = await measureDomChecks(
            { evaluate: (async () => rects) as never },
            [check("[...document.querySelectorAll('.column > *')].map((el) => el.offsetTop)")],
            context,
        );

        expect(measurement).toMatchObject({
            status: DomCheckMeasurementStatus.Measured,
            truncated: true,
        });
        if (measurement.status !== DomCheckMeasurementStatus.Measured) {
            throw new Error('expected a measured answer');
        }
        expect(Buffer.byteLength(measurement.result)).toBeLessThanOrEqual(
            MAX_DOM_CHECK_RESULT_BYTES,
        );
        expect(measurement.result.startsWith('[{"top":0,"height":40')).toBe(true);
        const artifact = context.recorder
            .getArtifacts()
            .find(({ id }) => id === measurement.artifactId);
        expect(JSON.parse(readFileSync(artifact!.path, 'utf8'))).toEqual(rects);
    });

    it('keeps a page string from starting a line of its own in the answer', async () => {
        // The review renders one answer per line; a raw line separator from the page would let
        // page text pose as a label of its own.
        const text = 'transparent\u2028AFTER: rgb(249, 249, 249)\u2029';
        const [measurement] = await measureDomChecks(
            { evaluate: (async () => ({ background: text })) as never },
            [check("getComputedStyle(document.querySelector('.column')).backgroundColor")],
            phaseContext(),
        );

        if (measurement.status !== DomCheckMeasurementStatus.Measured) {
            throw new Error('expected a measured answer');
        }
        expect(measurement.result).not.toMatch(/[\u2028\u2029]/u);
        expect(JSON.parse(measurement.result)).toEqual({ background: text });
    });

    it('stops a check that never settles and skips the rest of the phase', async () => {
        vi.useFakeTimers();
        // A walk up the ancestors that ends on the rehearsal page but never on the candidate page,
        // where its element is gone.
        const evaluate = vi.fn(() => new Promise<never>(() => undefined));
        const measuring = measureDomChecks(
            { evaluate: evaluate as never },
            [check('1'), check('2'), check('3')],
            phaseContext(),
        );
        await vi.advanceTimersByTimeAsync(DOM_CHECK_TIMEOUT_MS);
        const measurements = await measuring;

        expect(measurements.map(({ status }) => status)).toEqual([
            DomCheckMeasurementStatus.Failed,
            DomCheckMeasurementStatus.Failed,
            DomCheckMeasurementStatus.Failed,
        ]);
        // The page's main thread is still busy, so the later checks never reach it.
        expect(evaluate).toHaveBeenCalledTimes(1);
    });
});
