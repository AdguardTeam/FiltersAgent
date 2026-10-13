import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { createRuntimeTraceRecorder } from '../../src/tracer/runtime-recorder';
import {
    COMPACTION_DECISION_PHASE,
    recordSessionCompaction,
    recordSessionTurn,
    SEAL_DECISION_PHASE,
    sealSessionTrace,
} from '../../src/tracer/session-trace';
import { TurnStopReason } from '../../src/pi/stop-reason';
import { GuardCause } from '../../src/pi/guard-types';
import { RejectionCap, SealKind, type TerminalOutcome } from '../../src/pi/seal-types';
import { CompactionReason } from '../../src/pi/session-observations';
import type { TraceRecorder } from '../../src/tracer/trace-recorder';
import { RunMode, RunTraceSchema, TraceEventType, type RunTrace } from '../../src/types/trace';

const API_KEY = 'sk-live-provider-key-9f3a';

/**
 * Seal one outcome through the production recorder wiring and validate the persisted trace.
 *
 * @param outcome - The sealed pi outcome under test.
 * @returns The schema-validated run trace, as it would be written to disk.
 */
function seal(outcome: TerminalOutcome<unknown>): RunTrace {
    return sealWithCompaction(outcome, () => 0);
}

/**
 * Seal one outcome through the production recorder wiring, letting the caller drive the run's
 * compaction recording first.
 *
 * @param outcome - The sealed pi outcome under test.
 * @param compact - Records the run's compactions and returns how many there were.
 * @returns The schema-validated run trace, as it would be written to disk.
 */
function sealWithCompaction(
    outcome: TerminalOutcome<unknown>,
    compact: (recorder: TraceRecorder) => number,
): RunTrace {
    const recorder = createRuntimeTraceRecorder({
        runId: 'seal-trace',
        issueNumber: 42,
        mode: RunMode.Fix,
        now: () => '2026-01-01T00:00:00.000Z',
        exactSecrets: [API_KEY],
    });
    const compactions = compact(recorder);
    return v.parse(
        RunTraceSchema,
        JSON.parse(JSON.stringify(sealSessionTrace(recorder, outcome, compactions))),
    );
}

/**
 * Read the typed detail record the seal event carries.
 *
 * @param trace - A sealed run trace.
 * @returns The `details` payload of the run_sealed decision event.
 */
function sealDetails(trace: RunTrace): Record<string, unknown> {
    const event = trace.events.find(
        (candidate) =>
            candidate.type === TraceEventType.Decision &&
            candidate.payload['phase'] === SEAL_DECISION_PHASE,
    );
    expect(event).toBeDefined();
    return event!.payload['details'] as Record<string, unknown>;
}

describe('sealSessionTrace', () => {
    it('seals a deterministic provider rejection as llm_rejected and a transient failure as llm_error', () => {
        const deterministic = seal({
            kind: SealKind.ProviderFailure,
            message: 'HTTP 400: context window exceeded',
            deterministic: true,
        });
        const transient = seal({
            kind: SealKind.ProviderFailure,
            message: 'HTTP 503: upstream unavailable',
            deterministic: false,
        });
        const unknownTransience = seal({
            kind: SealKind.ProviderFailure,
            message: 'socket hang up',
        });

        // A deterministic rejection of the pinned request can never succeed on a resend: the fix
        // path reads this outcome back as llm_rejected and must not pay for the identical call
        // again, while a transient outage stays retryable.
        expect(deterministic.outcome).toBe('llm_rejected');
        expect(transient.outcome).toBe('llm_error');
        expect(unknownTransience.outcome).toBe('llm_error');
    });

    it('persists redacted provider failure detail with the seal', () => {
        const trace = seal({
            kind: SealKind.ProviderFailure,
            message: `HTTP 401 for key ${API_KEY}: invalid api key`,
            deterministic: true,
        });

        const details = sealDetails(trace);
        expect(details['providerMessage']).toContain('HTTP 401');
        expect(details['deterministic']).toBe(true);
        expect(JSON.stringify(trace)).not.toContain(API_KEY);
    });

    it('keeps the no-terminal diagnosis, rejection reason, budget detail, and abort context', () => {
        expect(
            sealDetails(seal({ kind: SealKind.NoTerminal, diagnosis: 'stopped at prose reply' })),
        ).toEqual({ diagnosis: 'stopped at prose reply' });

        expect(
            sealDetails(
                seal({
                    kind: SealKind.RejectedTerminal,
                    lastReason: 'outcome: invalid closure class',
                    rejections: 3,
                    cappedBy: RejectionCap.Streak,
                }),
            ),
        ).toEqual({
            lastReason: 'outcome: invalid closure class',
            rejections: 3,
            cappedBy: RejectionCap.Streak,
        });

        expect(
            sealDetails(
                seal({
                    kind: SealKind.BudgetExceeded,
                    budget: GuardCause.Turns,
                    detail: 'turn backstop 20 reached',
                }),
            ),
        ).toEqual({ budget: GuardCause.Turns, budgetDetail: 'turn backstop 20 reached' });

        // Each seal kind keeps its own key: `providerMessage`, `budgetDetail` and `abortMessage`
        // are three different things, and a reader that has to re-derive the seal kind before it
        // can tell which one a bare `message` meant is a reader that will get it wrong.
        expect(
            sealDetails(seal({ kind: SealKind.Aborted, message: 'caller cancelled the run' })),
        ).toEqual({ abortMessage: 'caller cancelled the run' });
    });
});

describe('recordSessionTurn', () => {
    it('records the cause of a failed turn and omits token counts nobody reported', () => {
        // A turn pi retries away is deleted from agent state before the retry, so the seal never
        // sees it: this event is the run's only record of the attempt, and without the cause it
        // says `error` and nothing else. The pino warn does not count — that is process log
        // output, not part of the locked run evidence.
        const recorder = createRuntimeTraceRecorder({
            runId: 'turn-trace',
            issueNumber: 42,
            mode: RunMode.Fix,
            now: () => '2026-01-01T00:00:00.000Z',
            exactSecrets: [API_KEY],
        });
        recordSessionTurn(recorder)({
            index: 0,
            stopReason: TurnStopReason.Error,
            errorMessage: `503 for key ${API_KEY}: upstream unavailable`,
            model: 'deepseek-v4-flash',
            text: '',
            toolCallNames: [],
            usage: {
                model: 'deepseek-v4-flash',
                reported: false,
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                reasoningTokens: 0,
            },
        });
        const trace = v.parse(
            RunTraceSchema,
            JSON.parse(JSON.stringify(recorder.end('llm_error'))),
        );

        const response = trace.events.find(
            (candidate) => candidate.type === TraceEventType.LlmResponse,
        );
        expect(response).toBeDefined();
        expect(response!.payload['errorMessage']).toContain('upstream unavailable');
        expect(JSON.stringify(trace)).not.toContain(API_KEY);
        // No usage chunk arrived, so the event carries no counts at all rather than four zeros a
        // reader would take for a free request.
        expect(response!.payload['promptTokens']).toBeUndefined();
        expect(response!.payload['completionTokens']).toBeUndefined();
    });
});

describe('recordSessionCompaction', () => {
    it('redacts a secret carried in the compaction summary and marks the run at the seal', () => {
        // pi's summary is model-authored prose over the transcript it is about to discard, so it
        // can quote anything the run saw — a provider key included. It is persisted exactly like
        // every other payload, which means through the recorder's redaction pass.
        const trace = sealWithCompaction(
            { kind: SealKind.Terminal, payload: null, rejections: 0 },
            (recorder) => {
                const compaction = recordSessionCompaction(recorder);
                compaction.observe({
                    index: 0,
                    reason: CompactionReason.Threshold,
                    summary: `## Critical Context\n- the provider answered ${API_KEY} to the probe`,
                    tokensBefore: 120_005,
                    estimatedTokensAfter: 36_027,
                    aborted: false,
                    willRetry: false,
                });
                return compaction.count();
            },
        );

        const compactionEvent = trace.events.find(
            (candidate) =>
                candidate.type === TraceEventType.Decision &&
                candidate.payload['phase'] === COMPACTION_DECISION_PHASE,
        );
        expect(compactionEvent).toBeDefined();
        const details = compactionEvent!.payload['details'] as Record<string, unknown>;
        // The summary survives — it is the only evidence of what the rewrite kept — minus the key.
        expect(details['summary']).toContain('Critical Context');
        expect(details['summary']).not.toContain(API_KEY);
        // Redaction must not swallow the counters that say how much context was traded away.
        expect(details['tokensBefore']).toBe(120_005);
        expect(details['estimatedTokensAfter']).toBe(36_027);
        expect(JSON.stringify(trace)).not.toContain(API_KEY);
        // A reader of the seal sees the run reasoned over a summarized transcript.
        expect(sealDetails(trace)).toEqual({ rejections: 0, compactions: 1 });
    });
});
