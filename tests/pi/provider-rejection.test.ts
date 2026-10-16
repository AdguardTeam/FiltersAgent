import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SealKind } from '../../src/pi/seal-types';
import { ProviderRefusalStopReason } from '../../src/pi/stop-reason';
import {
    isDeterministicProviderMessage,
    parseProviderFailureStatus,
} from '../../src/pi/run-sealing';
import {
    HermeticScenario,
    type HermeticProvider,
    type ScriptedReply,
    ScriptedReplyKind,
    startHermeticProvider,
} from './hermetic-provider';
import { runScriptedSession, TEST_TERMINAL_TOOL_NAME as TERMINAL_TOOL_NAME } from './test-runtime';
import { LlmApi } from '../../src/config/llm-api';

/**
 * The fault text a live campaign run was answered with at loop turn 51, verbatim: the gateway
 * relaying its own upstream's HTTP/2 body-read failure. Quoted rather than paraphrased because the
 * whole retry classification happens on this string.
 */
const UPSTREAM_STREAM_FAULT_MESSAGE =
    'Upstream error from Together: Stream error: h2 protocol error: ' +
    'error reading a body from connection';

/**
 * Upstream code the gateway relays inside the in-stream error chunk. It never reaches the composed
 * message — the HTTP response itself was 200 — so it must not be what makes the retry fire.
 */
const UPSTREAM_STREAM_FAULT_CODE = 502;

let workDir: string;
let provider: HermeticProvider | undefined;

beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'pi-provider-rejection-'));
});

afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
});

afterEach(async () => {
    if (!provider) {
        return;
    }
    await provider.close();
    provider = undefined;
});

/**
 * Start a hermetic provider and run one session whose every completion comes from the script.
 *
 * @param script - The reply sequence the provider serves.
 * @param retries - Retry bounds for the session.
 * @param scriptExhausted - Reply served past the end of the script; defaults to a 500 that ends the
 *   run, so a suite that scripts a finite sequence never hangs. A suite proving what happens when
 *   EVERY request fails the same way passes that failing reply here.
 * @returns The sealed outcome and the provider's recorded requests.
 */
async function runScripted(
    script: ScriptedReply[],
    retries: { maxRetries: number; baseDelayMs: number },
    scriptExhausted: ScriptedReply = {
        kind: ScriptedReplyKind.Error,
        status: 500,
        message: 'script exhausted',
    },
) {
    provider = await startHermeticProvider({
        scenario: HermeticScenario.Scripted,
        script,
        scriptExhausted,
    });
    const outcome = await runScriptedSession({
        baseUrl: provider.baseUrl,
        api: LlmApi.OpenAiCompletions,
        retries: retries,
        workDir,
    });
    return { outcome, requests: provider.requests };
}

describe('isDeterministicProviderMessage', () => {
    it('reads the leading status with or without a colon', () => {
        expect(isDeterministicProviderMessage('400: {...}')).toBe(true);
        expect(isDeterministicProviderMessage('400 {...}')).toBe(true);
        expect(isDeterministicProviderMessage('404 status code (no body)')).toBe(true);
        expect(isDeterministicProviderMessage('503 {...}')).toBe(false);
        expect(parseProviderFailureStatus('413 too large')).toBe(413);
    });

    it('detects deterministic rejections by a leading status token', () => {
        expect(isDeterministicProviderMessage('400: Invalid request')).toBe(true);
        expect(isDeterministicProviderMessage('404: unknown model')).toBe(true);
        expect(isDeterministicProviderMessage('413: payload too large')).toBe(true);
        expect(isDeterministicProviderMessage('422: unprocessable')).toBe(true);
    });

    it('treats transient statuses and unparseable messages as non-deterministic', () => {
        expect(isDeterministicProviderMessage('503: overloaded')).toBe(false);
        expect(isDeterministicProviderMessage('429: rate limited')).toBe(false);
        expect(isDeterministicProviderMessage('Context length exceeded')).toBe(false);
        expect(isDeterministicProviderMessage('')).toBe(false);
    });
});

describe('ProviderFailureSealed determinism', () => {
    it('marks a 400-shaped provider failure sealed deterministic', async () => {
        // A deterministic 400 is not retried by pi's in-run classification (its pattern list
        // covers timeouts/429/5xx/network only), so the single failing reply seals the run.
        const { outcome, requests } = await runScripted(
            [{ kind: ScriptedReplyKind.Error, status: 400, message: 'malformed request' }],
            { maxRetries: 0, baseDelayMs: 0 },
        );

        expect(outcome.kind).toBe(SealKind.ProviderFailure);
        if (outcome.kind !== SealKind.ProviderFailure) {
            return;
        }
        expect(outcome.message).toContain('400');
        expect(outcome.deterministic).toBe(true);
        expect(requests).toHaveLength(1);
    });

    it('leaves a 503-shaped provider failure sealed transient', async () => {
        const { outcome, requests } = await runScripted(
            [{ kind: ScriptedReplyKind.Error, status: 503, message: 'overloaded' }],
            { maxRetries: 0, baseDelayMs: 0 },
        );

        expect(outcome.kind).toBe(SealKind.ProviderFailure);
        if (outcome.kind !== SealKind.ProviderFailure) {
            return;
        }
        expect(outcome.message).toContain('503');
        expect(outcome.deterministic).toBe(false);
        expect(requests).toHaveLength(1);
    });
});

describe('transient gateway failures', () => {
    it('retries a bodiless 520 and reaches the terminal seal', async () => {
        // The live-campaign shape: the gateway's edge answers 520 with no body, so the composed
        // message is nothing but the status. Pi's own pattern list does not carry it, so without the
        // seam this run would seal provider-failure after one request and lose the case.
        const { outcome, requests } = await runScripted(
            [
                { kind: ScriptedReplyKind.BareStatus, status: 520 },
                {
                    kind: ScriptedReplyKind.ToolCall,
                    toolName: TERMINAL_TOOL_NAME,
                    toolArguments: JSON.stringify({ verdict: 'ok', summary: 'after the retry' }),
                },
            ],
            { maxRetries: 2, baseDelayMs: 0 },
        );

        expect(outcome.kind).toBe(SealKind.Terminal);
        if (outcome.kind !== SealKind.Terminal) {
            return;
        }
        expect(outcome.payload.summary).toBe('after the retry');
        expect(requests).toHaveLength(2);
    });

    it('retries an upstream stream fault relayed mid-stream and reaches the terminal seal', async () => {
        // The other live-campaign shape: the gateway answered 200 and faulted mid-stream, so the
        // composed message is prose with no status anywhere in it. Pi's own pattern list does not
        // carry this wording either, and without the seam the run sealed provider-failure at loop
        // turn 51 after a single attempt, losing the investigation that came before it.
        const { outcome, requests } = await runScripted(
            [
                {
                    kind: ScriptedReplyKind.StreamFault,
                    message: UPSTREAM_STREAM_FAULT_MESSAGE,
                    code: UPSTREAM_STREAM_FAULT_CODE,
                },
                {
                    kind: ScriptedReplyKind.ToolCall,
                    toolName: TERMINAL_TOOL_NAME,
                    toolArguments: JSON.stringify({
                        verdict: 'ok',
                        summary: 'after the stream fault',
                    }),
                },
            ],
            { maxRetries: 2, baseDelayMs: 0 },
        );

        expect(outcome.kind).toBe(SealKind.Terminal);
        if (outcome.kind !== SealKind.Terminal) {
            return;
        }
        expect(outcome.payload.summary).toBe('after the stream fault');
        expect(requests).toHaveLength(2);
    });

    it('retries a completion the gateway ended with finish_reason error', async () => {
        // The in-band shape: the upstream failed while generating, so the gateway ended the
        // completion with `finish_reason: "error"` and pi composed `Provider finish_reason: error`.
        // A live bench run sealed provider-failure on loop turn 2 from exactly this, 34 tokens in.
        const { outcome, requests } = await runScripted(
            [
                { kind: ScriptedReplyKind.FinishReason, reason: 'error' },
                {
                    kind: ScriptedReplyKind.ToolCall,
                    toolName: TERMINAL_TOOL_NAME,
                    toolArguments: JSON.stringify({
                        verdict: 'ok',
                        summary: 'after the upstream failure',
                    }),
                },
            ],
            { maxRetries: 2, baseDelayMs: 0 },
        );

        expect(outcome.kind).toBe(SealKind.Terminal);
        if (outcome.kind !== SealKind.Terminal) {
            return;
        }
        expect(outcome.payload.summary).toBe('after the upstream failure');
        expect(requests).toHaveLength(2);
    });

    it('seals a content_filter finish reason as a deterministic rejection without a retry', async () => {
        // A verdict on the request's content is deterministic: the same request meets the same
        // verdict, so the bare-reason pattern must not sweep it in.
        const { outcome, requests } = await runScripted(
            [
                {
                    kind: ScriptedReplyKind.FinishReason,
                    reason: ProviderRefusalStopReason.ContentFilter,
                },
                {
                    kind: ScriptedReplyKind.ToolCall,
                    toolName: TERMINAL_TOOL_NAME,
                    toolArguments: JSON.stringify({ verdict: 'ok', summary: 'unreachable' }),
                },
            ],
            { maxRetries: 2, baseDelayMs: 0 },
        );

        expect(outcome.kind).toBe(SealKind.ProviderFailure);
        expect(outcome).toMatchObject({ deterministic: true });
        expect(requests).toHaveLength(1);
    });

    it('still seals provider-failure when every request is answered 520', async () => {
        // The retry is bounded, not unconditional: a gateway that is down rather than blipping ends
        // the run after the configured attempts (one initial request plus maxRetries retries).
        const { outcome, requests } = await runScripted(
            [],
            { maxRetries: 2, baseDelayMs: 0 },
            {
                kind: ScriptedReplyKind.BareStatus,
                status: 520,
            },
        );

        expect(outcome.kind).toBe(SealKind.ProviderFailure);
        if (outcome.kind !== SealKind.ProviderFailure) {
            return;
        }
        expect(outcome.message).toContain('520');
        expect(outcome.deterministic).toBe(false);
        expect(requests).toHaveLength(3);
    });
});
