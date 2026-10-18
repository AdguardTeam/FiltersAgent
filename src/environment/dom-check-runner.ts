/**
 * Runs the DOM checks attached to `apply_rule` on one phase's page and records what they returned.
 *
 * Each expression, already held to the `evaluate_js` rules at the `apply_rule` boundary, is
 * evaluated on the page load the phase just captured, so the answer describes the document the
 * screenshots show. The record is this module's own: every answer is cut to one byte cap whatever
 * its size, a cut value is kept whole as an artifact, and a check that does not settle in time is
 * stopped from holding the phase.
 */
import type { Page } from 'playwright-core';
import { truncateUtf8 } from '../agent/truncate-utf8';
import { writeArtifact } from '../browser/full-page-tiles';
import { createLogger } from '../logger/logger';
import type { TraceRecorder } from '../tracer/trace-recorder';
import {
    DOM_CHECK_TIMEOUT_MS,
    DomCheckMeasurementStatus,
    MAX_DOM_CHECK_RESULT_BYTES,
    type DomCheck,
    type DomCheckMeasurement,
    type DomCheckRecord,
} from '../types/dom-check';
import type { PhaseLabel } from '../types/validation';

/**
 * The two characters JSON leaves raw although JavaScript and the review read them as line breaks.
 */
const LINE_SEPARATORS = /[\u2028\u2029]/gu;

/**
 * Artifact type of a value cut from a check's record, kept whole for `get_detail`.
 */
const DOM_CHECK_RESULT_ARTIFACT_TYPE = 'dom-check-result';

/**
 * Where a phase's checks record what they cannot carry inline, and which phase they belong to.
 */
export interface DomCheckRunContext {
    /**
     * Phase whose page the checks run on, named in diagnostics.
     */
    phase: PhaseLabel;

    /**
     * Directory a cut value is written to.
     */
    artifactsDir: string;

    /**
     * Trace owner registering a cut value as an artifact.
     */
    recorder: TraceRecorder;
}

/**
 * How one evaluation on the page ended.
 */
type CheckEvaluation =
    | {
          /**
           * The expression returned this value.
           */
          value: unknown;
      }
    | {
          /**
           * Why the expression produced no value.
           */
          error: string;

          /**
           * Whether the page may still be busy with it, so later checks cannot run.
           */
          blocking: boolean;
      };

/**
 * Evaluate one expression on the page, within the per-check time bound.
 *
 * @param page - The phase page.
 * @param expression - The check's expression.
 * @param context - Phase named in diagnostics.
 * @returns The value, or why there is none.
 */
async function evaluateCheck(
    page: Pick<Page, 'evaluate'>,
    expression: string,
    context: DomCheckRunContext,
): Promise<CheckEvaluation> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    const timedOut = new Promise<CheckEvaluation>((resolve) => {
        timer = setTimeout(() => {
            expired = true;
            resolve({
                error: `The check did not settle within ${DOM_CHECK_TIMEOUT_MS} ms.`,
                blocking: true,
            });
        }, DOM_CHECK_TIMEOUT_MS);
    });
    // Called inside an async function, so a fault thrown before Playwright returns a promise is
    // recorded like a rejection rather than escaping the phase.
    const evaluation = (async () => await page.evaluate(expression))().then(
        (value): CheckEvaluation => ({ value }),
        (error: unknown): CheckEvaluation => {
            // A page exception and a Playwright fault ("Execution context was destroyed") read
            // the same in the record; the log tells them apart. An evaluation that already timed
            // out rejects only when the phase closes its page, which is no news.
            if (!expired) {
                createLogger().warn(
                    { err: error, phase: context.phase },
                    'a DOM check threw on the phase page',
                );
            }
            return {
                error: error instanceof Error ? error.message : String(error),
                blocking: false,
            };
        },
    );
    try {
        const outcome = await Promise.race([evaluation, timedOut]);
        if ('error' in outcome && outcome.blocking) {
            createLogger().warn(
                { phase: context.phase, timeoutMs: DOM_CHECK_TIMEOUT_MS },
                'a DOM check did not settle on the phase page',
            );
        }
        return outcome;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Record a value the page returned, cut to the per-answer byte cap and kept whole when cut.
 *
 * @param value - The value the expression returned.
 * @param context - Where a cut value is written.
 * @returns The measurement as the review and the tool result carry it.
 */
function measured(value: unknown, context: DomCheckRunContext): DomCheckMeasurement {
    let json: string;
    try {
        // JSON leaves the line and paragraph separators raw; escaped, the value is the same JSON,
        // and a page string cannot start a line of its own where the review renders the answer.
        // Escaped before the cut, so the byte cap bounds the escaped text.
        json = (JSON.stringify(value) ?? 'null').replace(
            LINE_SEPARATORS,
            (separator) => `\\u${separator.codePointAt(0)!.toString(16)}`,
        );
    } catch (error) {
        return failed(`The value is not JSON: ${String(error)}`);
    }
    if (Buffer.byteLength(json) <= MAX_DOM_CHECK_RESULT_BYTES) {
        return { status: DomCheckMeasurementStatus.Measured, result: json, truncated: false };
    }
    return {
        status: DomCheckMeasurementStatus.Measured,
        result: truncateUtf8(json, MAX_DOM_CHECK_RESULT_BYTES),
        truncated: true,
        artifactId: writeArtifact(
            context.artifactsDir,
            'json',
            json,
            DOM_CHECK_RESULT_ARTIFACT_TYPE,
            context.recorder,
        ),
    };
}

/**
 * Record why a check produced no value, bounded like a value.
 *
 * @param detail - The page's exception, the timeout, or why the value is not JSON.
 * @returns The failed measurement.
 */
function failed(detail: string): DomCheckMeasurement {
    return {
        status: DomCheckMeasurementStatus.Failed,
        error: truncateUtf8(detail, MAX_DOM_CHECK_RESULT_BYTES),
    };
}

/**
 * Evaluate every check on the current page, one after another.
 *
 * The checks arrive validated: `parseDomChecks` held every expression to the `evaluate_js` rules
 * when `apply_rule` accepted the call, and that plan is their only source.
 *
 * A check whose expression throws is an answer, not a fault of the phase: the element it looked for
 * may be gone after the candidate. It is recorded as failed and the next check runs. A check that
 * runs out of time leaves the page's main thread busy, so the phase's remaining checks are recorded
 * as skipped instead of queueing behind it.
 *
 * @param page - The phase page, as captured.
 * @param checks - The checks the call attached, in the agent's order.
 * @param context - Phase, artifact directory and trace owner.
 * @returns One measurement per check, in the same order.
 */
export async function measureDomChecks(
    page: Pick<Page, 'evaluate'>,
    checks: readonly DomCheck[],
    context: DomCheckRunContext,
): Promise<DomCheckMeasurement[]> {
    const measurements: DomCheckMeasurement[] = [];
    for (const [index, check] of checks.entries()) {
        const outcome = await evaluateCheck(page, check.expression, context);
        if (!('error' in outcome)) {
            measurements.push(measured(outcome.value, context));
            continue;
        }
        measurements.push(failed(outcome.error));
        if (outcome.blocking) {
            for (let skipped = index + 1; skipped < checks.length; skipped += 1) {
                measurements.push(
                    failed(`Skipped: check ${index + 1} did not settle and holds the page.`),
                );
            }
            break;
        }
    }
    return measurements;
}

/**
 * Pair each check with what it returned in the baseline and in the candidate phase.
 *
 * @param checks - The checks the call attached.
 * @param before - Measurements from the published-baseline phase.
 * @param after - Measurements from the candidate phase.
 * @returns One record per check.
 */
export function pairDomCheckMeasurements(
    checks: readonly DomCheck[],
    before: readonly DomCheckMeasurement[],
    after: readonly DomCheckMeasurement[],
): DomCheckRecord[] {
    return checks.map((check, index) => ({
        expression: check.expression,
        claim: check.claim,
        before: before[index],
        after: after[index],
    }));
}
