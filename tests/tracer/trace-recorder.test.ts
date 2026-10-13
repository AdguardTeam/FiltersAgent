import { describe, it, expect } from 'vitest';
import * as v from 'valibot';
import { TraceRecorder } from '../../src/tracer/trace-recorder';
import { RunMode, RunTraceSchema } from '../../src/types/trace';
import { createRunUsageCollector } from '../../src/pi/usage-collector';

const makeClock = () => {
    let n = 0;
    const now = (): string => new Date(Date.UTC(2025, 0, 1, 0, 0, 0, n++)).toISOString();
    return { now };
};

describe('TraceRecorder', () => {
    it('auto-records run_start with seq 0 and payload in the constructor', () => {
        const clock = makeClock();
        const rec = new TraceRecorder({
            runId: 'run-1',
            issueNumber: 12345,
            mode: 'fix',
            now: clock.now,
        });

        const json = rec.toJSON();
        expect(json.startedAt).toBe('2025-01-01T00:00:00.000Z');
        expect(json.events).toHaveLength(1);
        expect(json.events[0].seq).toBe(0);
        expect(json.events[0].type).toBe('run_start');
        expect(json.events[0].payload).toEqual({
            runId: 'run-1',
            issueNumber: 12345,
            mode: 'fix',
        });
        expect(json.endedAt).toBeUndefined();
        expect(json.outcome).toBeUndefined();
    });

    it('record produces contiguous seqs and timestamps from the injected clock', () => {
        const clock = makeClock();
        const rec = new TraceRecorder({
            runId: 'run-2',
            issueNumber: 1,
            mode: 'fix',
            now: clock.now,
        });

        const e1 = rec.record('decision', { reason: 'first' });
        const e2 = rec.record('error', { msg: 'boom' });

        expect(e1.seq).toBe(1);
        expect(e2.seq).toBe(2);
        expect(e1.timestamp).toBe('2025-01-01T00:00:00.001Z');
        expect(e2.timestamp).toBe('2025-01-01T00:00:00.002Z');
        expect(e1.payload).toEqual({ reason: 'first' });
        expect(e2.payload).toEqual({ msg: 'boom' });
    });

    it('record defaults payload to empty object when omitted', () => {
        const rec = new TraceRecorder({
            runId: 'run-3',
            issueNumber: 1,
            mode: 'fix',
            now: () => '2025-01-01T00:00:00.000Z',
        });
        const e = rec.record('retry');
        expect(e.payload).toEqual({});
    });

    it('recordToolCall appends tool_call then tool_result in order', () => {
        const rec = new TraceRecorder({
            runId: 'run-4',
            issueNumber: 1,
            mode: 'fix',
            now: () => '2025-01-01T00:00:00.000Z',
        });

        const [callEv, resEv] = rec.recordToolCall('search', { query: 'ads' }, { matches: 3 });

        expect(callEv.seq).toBe(1);
        expect(callEv.type).toBe('tool_call');
        expect(callEv.payload).toEqual({ tool: 'search', args: { query: 'ads' } });
        expect(resEv.seq).toBe(2);
        expect(resEv.type).toBe('tool_result');
        expect(resEv.payload).toEqual({ tool: 'search', result: { matches: 3 } });

        const events = rec.toJSON().events;
        expect(events[1]).toBe(callEv);
        expect(events[2]).toBe(resEv);
    });

    it('recordLlmTurn appends both events and accumulates token totals', () => {
        const rec = new TraceRecorder({
            runId: 'run-5',
            issueNumber: 1,
            mode: 'fix',
            now: () => '2025-01-01T00:00:00.000Z',
        });

        rec.recordLlmTurn({ model: 'x' }, { model: 'x', promptTokens: 100, completionTokens: 50 });
        rec.recordLlmTurn({ model: 'x' }, { model: 'x', promptTokens: 200, completionTokens: 150 });

        const json = rec.toJSON();
        // run_start(0), llm_request(1), llm_response(2), llm_request(3), llm_response(4)
        expect(json.events).toHaveLength(5);
        expect(json.events[1].type).toBe('llm_request');
        expect(json.events[2].type).toBe('llm_response');
        expect(json.tokenTotals.promptTokens).toBe(300);
        expect(json.tokenTotals.completionTokens).toBe(200);
        expect(json.tokenTotals.totalTokens).toBe(500);
    });

    it('recordLlmTurn ignores non-finite token values', () => {
        const rec = new TraceRecorder({
            runId: 'run-6',
            issueNumber: 1,
            mode: 'fix',
            now: () => '2025-01-01T00:00:00.000Z',
        });

        rec.recordLlmTurn(
            { model: 'x' },
            { model: 'x', promptTokens: NaN, completionTokens: undefined },
        );

        expect(rec.toJSON().tokenTotals.totalTokens).toBe(0);
    });

    it('addArtifact shows up in toJSON artifacts', () => {
        const rec = new TraceRecorder({
            runId: 'run-7',
            issueNumber: 1,
            mode: 'fix',
            now: () => '2025-01-01T00:00:00.000Z',
        });

        const ref = { id: 'art-1', path: '/tmp/har.json', type: 'har', bytes: 4096 };
        rec.addArtifact(ref);

        expect(rec.toJSON().artifacts).toEqual([ref]);
    });

    it('end records run_end, sets endedAt + outcome, and satisfies RunTraceSchema', () => {
        const clock = makeClock();
        const rec = new TraceRecorder({
            runId: 'run-8',
            issueNumber: 42,
            mode: 'fix',
            now: clock.now,
        });

        rec.record('decision', { ok: true });
        const trace = rec.end('merged-fix');

        expect(trace.endedAt).toBe('2025-01-01T00:00:00.002Z');
        expect(trace.outcome).toBe('merged-fix');
        const last = trace.events[trace.events.length - 1];
        expect(last.type).toBe('run_end');
        expect(last.payload).toEqual({ outcome: 'merged-fix' });

        // Schema validation must succeed.
        expect(() => v.parse(RunTraceSchema, trace)).not.toThrow();
    });

    it('redacts payloads when redact option is provided', () => {
        const rec = new TraceRecorder({
            runId: 'run-redact',
            issueNumber: 1,
            mode: 'fix',
            now: () => '2025-01-01T00:00:00.000Z',
            redact: (payload) => {
                const result = { ...payload };
                if (typeof result.token === 'string') {
                    result.token = '[redacted]';
                }
                return result;
            },
        });

        rec.record('decision', { reason: 'ok', token: 'secret123' });
        const events = rec.toJSON().events;
        // run_start (seq 0), decision (seq 1)
        expect(events[1].payload).toEqual({ reason: 'ok', token: '[redacted]' });
    });

    it('recordToolCall redacts both call and result payloads when redact is configured', () => {
        const rec = new TraceRecorder({
            runId: 'run-redact-tc',
            issueNumber: 1,
            mode: 'fix',
            now: () => '2025-01-01T00:00:00.000Z',
            redact: (payload) => {
                // The payload is { tool, args } for tool_call and { tool, result } for tool_result.
                // The redaction function must reach into nested structures.
                const result = { ...payload };
                if (result.args && typeof result.args === 'object') {
                    const args = { ...(result.args as Record<string, unknown>) };
                    if (typeof args.authorization === 'string') {
                        args.authorization = '[redacted]';
                    }
                    result.args = args;
                }
                return result;
            },
        });

        const [, resEv] = rec.recordToolCall(
            'search',
            { query: 'ads', authorization: 'Bearer xyz' },
            { matches: 3, token: 'sekret' },
        );

        const events = rec.toJSON().events;
        // run_start(0), tool_call(1), tool_result(2)
        expect(events[1].payload).toEqual({
            tool: 'search',
            args: { query: 'ads', authorization: '[redacted]' },
        });
        expect(resEv.payload).toEqual({
            tool: 'search',
            result: { matches: 3, token: 'sekret' },
        });
    });

    it('run_start payload is also redacted when redact is provided', () => {
        const rec = new TraceRecorder({
            runId: 'run-redacted-start',
            issueNumber: 42,
            mode: 'fix',
            now: () => '2025-01-01T00:00:00.000Z',
            redact: (payload) => ({ ...payload, mode: 'redacted-mode' as const }),
        });

        const events = rec.toJSON().events;
        expect(events[0].payload).toEqual({
            runId: 'run-redacted-start',
            issueNumber: 42,
            mode: 'redacted-mode',
        });
    });

    it('getArtifacts returns a snapshot of registered artifacts (finding 1)', () => {
        const rec = new TraceRecorder({ runId: 'r', issueNumber: 1, mode: 'fix' });
        expect(rec.getArtifacts()).toEqual([]);
        rec.addArtifact({ id: 'a1', path: '/tmp/a.png', type: 'screenshot', bytes: 10 });
        rec.addArtifact({ id: 'a2', path: '/tmp/b.har', type: 'har', bytes: 20 });
        expect(rec.getArtifacts()).toEqual([
            { id: 'a1', path: '/tmp/a.png', type: 'screenshot', bytes: 10 },
            { id: 'a2', path: '/tmp/b.har', type: 'har', bytes: 20 },
        ]);
        // Snapshot is a copy — mutating it does not affect the recorder.
        rec.getArtifacts().pop();
        expect(rec.getArtifacts()).toHaveLength(2);
    });

    it('includes a usage summary set before sealing and omits it otherwise', () => {
        const summary = createRunUsageCollector({ rates: {} }).summary();
        const withUsage = new TraceRecorder({ runId: 'a', issueNumber: 1, mode: RunMode.Fix });
        withUsage.setUsageSummary(summary);

        expect(withUsage.toJSON().usage).toEqual(summary);
        expect(v.parse(RunTraceSchema, withUsage.end('done')).usage).toEqual(summary);

        const withoutUsage = new TraceRecorder({
            runId: 'b',
            issueNumber: 1,
            mode: RunMode.Fix,
        });
        expect(v.parse(RunTraceSchema, withoutUsage.end('done')).usage).toBeUndefined();
    });
});
