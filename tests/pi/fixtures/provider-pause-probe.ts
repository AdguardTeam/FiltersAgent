import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai';
import type { PiRuntime } from '../../../src/pi/runtime';
import { completeOnce } from '../../../src/pi/single-shot-completion';
import { TurnStopReason } from '../../../src/pi/stop-reason';

/**
 * The pause the fake provider asks for: long enough that nothing but the retry wait is pending
 * while it runs, short enough for a test.
 */
const PAUSE_SECONDS = 1;

/**
 * Build one assistant message the fake provider answers with.
 *
 * @param fields - The stop reason and, for a failure, its error text.
 * @returns The complete message.
 */
function reply(fields: Pick<AssistantMessage, 'stopReason' | 'errorMessage'>): AssistantMessage {
    return {
        role: 'assistant',
        content:
            fields.stopReason === TurnStopReason.Stop ? [{ type: 'text', text: 'answer' }] : [],
        api: 'openai-completions',
        provider: 'probe',
        model: 'probe-model',
        usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        timestamp: Date.now(),
        ...fields,
    };
}

// The first request is refused the way pi refuses a provider pause above its own cap; the second
// one succeeds. No server, socket or timer of the probe's own is alive while the call waits, which
// is the state a run is in when the gateway asks for a pause before its browser starts.
const replies = [
    reply({
        stopReason: TurnStopReason.Error,
        errorMessage: `Server requested ${PAUSE_SECONDS}s retry delay (max: 0s). 522 status code`,
    }),
    reply({ stopReason: TurnStopReason.Stop }),
];
let requests = 0;
const runtime = {
    modelRuntime: {
        streamSimple: () => {
            const message = replies[requests];
            requests += 1;
            return {
                async *[Symbol.asyncIterator]() {},
                result: async () => message,
            };
        },
    },
} as unknown as PiRuntime;

const completion = await completeOnce(
    runtime,
    { id: 'probe-model' } as Model<Api>,
    undefined,
    [{ role: 'user', content: 'inspect', timestamp: Date.now() }],
    { maxRetries: 1 },
);

process.stdout.write(JSON.stringify({ stopReason: completion.message.stopReason, requests }));
