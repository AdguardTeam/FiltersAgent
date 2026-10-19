import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import {
    type HermeticUsageSpec,
    readBody,
    type ScriptedReply,
    ScriptedReplyKind,
    STALL_KEEP_ALIVE_INTERVAL_MS,
    type StreamPacing,
} from './hermetic-provider';

/**
 * Script and usage served by one Anthropic Messages test provider.
 */
export interface HermeticAnthropicProviderOptions {
    /**
     * Replies consumed in request order.
     */
    script: ScriptedReply[];
    /**
     * Reply served after the script ends, defaulting to an exhaustion message.
     */
    scriptExhausted?: ScriptedReply;
    /**
     * Token counts for successful replies; null serves zero counts.
     */
    usage?: HermeticUsageSpec | null;
}

/**
 * One request captured at the Anthropic HTTP boundary.
 */
export interface RecordedAnthropicRequest {
    /**
     * Incoming request path.
     */
    url: string;
    /**
     * Incoming HTTP method.
     */
    method: string;
    /**
     * Raw request headers, including the API key.
     */
    headers: IncomingHttpHeaders;
    /**
     * Parsed Messages API JSON payload.
     */
    body: Record<string, unknown>;
}

/**
 * Running Anthropic Messages provider with captured requests.
 */
export interface HermeticAnthropicProvider {
    /**
     * Provider origin without a version suffix.
     */
    baseUrl: string;
    /**
     * Requests in arrival order.
     */
    requests: RecordedAnthropicRequest[];
    /**
     * Stop the server and destroy open responses.
     */
    close: () => Promise<void>;
}

/**
 * Usage for a successful reply when no override is supplied.
 */
const DEFAULT_USAGE: HermeticUsageSpec = { promptTokens: 11, completionTokens: 5 };

/**
 * Marker emitted by paced replies to expose continued streamed progress.
 */
const PACED_DELTA_TEXT = 'thinking ';

/**
 * Map an HTTP status to Anthropic's error type for retry classification.
 *
 * @param status - HTTP status served by the script.
 * @returns The corresponding Anthropic error type.
 */
function anthropicErrorType(status: number): string {
    if (status === 529) {
        return 'overloaded_error';
    }
    if (status >= 500) {
        return 'api_error';
    }
    return status === 401 ? 'authentication_error' : 'invalid_request_error';
}

/**
 * Send an Anthropic SSE event using its payload type as the event name.
 *
 * @param response - Stream to write to.
 * @param payload - Typed event payload.
 */
function sendEvent(response: ServerResponse, payload: Record<string, unknown>): void {
    response.write(`event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

/**
 * Map shared inclusive prompt counts onto Anthropic's separate token counts.
 *
 * @param usage - Counts to serve, null for zero counts, or undefined for defaults.
 * @returns The Messages API usage fields.
 */
function toWireUsage(usage: HermeticUsageSpec | null | undefined) {
    const spec = usage === undefined ? DEFAULT_USAGE : usage;
    return {
        input_tokens:
            spec === null
                ? 0
                : spec.promptTokens - (spec.cachedTokens ?? 0) - (spec.cacheWriteTokens ?? 0),
        cache_read_input_tokens: spec?.cachedTokens ?? 0,
        cache_creation_input_tokens: spec?.cacheWriteTokens ?? 0,
        output_tokens: spec?.completionTokens ?? 0,
    };
}

/**
 * Stream one text block at a specified content index.
 *
 * @param response - Stream to write to.
 * @param index - Content block position.
 * @param text - Text delta to emit.
 */
function textBlock(response: ServerResponse, index: number, text: string): void {
    sendEvent(response, {
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
    });
    sendEvent(response, {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text },
    });
    sendEvent(response, { type: 'content_block_stop', index });
}

/**
 * Emit paced text before the scripted payload, ending early if the client disconnects.
 *
 * @param response - Stream to write to.
 * @param pacing - Optional pacing of streamed text deltas.
 * @returns The index available for the payload block.
 */
async function paceDeltas(
    response: ServerResponse,
    pacing: StreamPacing | undefined,
): Promise<number> {
    if (pacing === undefined) {
        return 0;
    }
    sendEvent(response, {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
    });
    for (let delta = 0; delta < pacing.deltas; delta++) {
        await new Promise<void>((resolve) => setTimeout(resolve, pacing.intervalMs));
        if (response.writableEnded || response.destroyed) {
            return 1;
        }
        sendEvent(response, {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: PACED_DELTA_TEXT },
        });
    }
    sendEvent(response, { type: 'content_block_stop', index: 0 });
    return 1;
}

/**
 * Serve one scripted response on the Messages API wire.
 *
 * @param response - Incoming request's response stream.
 * @param model - Model id echoed in the message.
 * @param reply - Scripted behavior to serve.
 * @param usage - Instance-wide token counts.
 */
async function serveReply(
    response: ServerResponse,
    model: string,
    reply: ScriptedReply,
    usage: HermeticUsageSpec | null | undefined,
): Promise<void> {
    switch (reply.kind) {
        case ScriptedReplyKind.Error:
            response.writeHead(reply.status, { 'content-type': 'application/json' });
            response.end(
                JSON.stringify({
                    type: 'error',
                    error: { type: anthropicErrorType(reply.status), message: reply.message },
                }),
            );
            return;
        case ScriptedReplyKind.BareStatus:
            response.writeHead(
                reply.status,
                reply.retryAfterSeconds === undefined
                    ? {}
                    : { 'retry-after': String(reply.retryAfterSeconds) },
            );
            response.end();
            return;
        case ScriptedReplyKind.Text:
        case ScriptedReplyKind.ToolCall:
        case ScriptedReplyKind.StreamFault:
        case ScriptedReplyKind.FinishReason:
        case ScriptedReplyKind.Stall:
            break;
        default: {
            const exhaustive: never = reply;
            throw new Error(`Unknown scripted reply: ${JSON.stringify(exhaustive)}`);
        }
    }
    const replyUsage = 'usage' in reply && reply.usage !== undefined ? reply.usage : usage;
    const wireUsage = toWireUsage(replyUsage);
    response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
    });
    sendEvent(response, {
        type: 'message_start',
        message: {
            id: 'msg-hermetic',
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: wireUsage,
        },
    });
    let stopReason: string;
    switch (reply.kind) {
        case ScriptedReplyKind.Text: {
            const index = await paceDeltas(response, reply.pacing);
            if (response.destroyed) {
                return;
            }
            textBlock(response, index, reply.text);
            stopReason = 'end_turn';
            break;
        }
        case ScriptedReplyKind.ToolCall: {
            const index = await paceDeltas(response, reply.pacing);
            if (response.destroyed) {
                return;
            }
            sendEvent(response, {
                type: 'content_block_start',
                index,
                content_block: {
                    type: 'tool_use',
                    id: 'tool-hermetic',
                    name: reply.toolName,
                    input: {},
                },
            });
            sendEvent(response, {
                type: 'content_block_delta',
                index,
                delta: { type: 'input_json_delta', partial_json: reply.toolArguments },
            });
            sendEvent(response, { type: 'content_block_stop', index });
            stopReason = 'tool_use';
            break;
        }
        case ScriptedReplyKind.StreamFault:
            sendEvent(response, {
                type: 'error',
                error: { type: anthropicErrorType(reply.code), message: reply.message },
            });
            response.end();
            return;
        case ScriptedReplyKind.FinishReason:
            textBlock(response, 0, 'partial');
            stopReason = reply.reason;
            break;
        case ScriptedReplyKind.Stall: {
            // The shape of a stalled Anthropic stream: an empty text block opens, then only pings
            // arrive, which keep the connection busy and carry nothing the model produced.
            sendEvent(response, {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'text', text: '' },
            });
            const ping = setInterval(() => {
                if (!response.destroyed) {
                    sendEvent(response, { type: 'ping' });
                }
            }, STALL_KEEP_ALIVE_INTERVAL_MS);
            response.on('close', () => clearInterval(ping));
            return;
        }
        default: {
            const exhaustive: never = reply;
            throw new Error(`Unknown streaming reply: ${JSON.stringify(exhaustive)}`);
        }
    }
    sendEvent(response, {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: wireUsage,
    });
    sendEvent(response, { type: 'message_stop' });
    response.end();
}

/**
 * Start a local Anthropic Messages SSE provider on an ephemeral port.
 *
 * @param options - Scripted replies and usage for this server.
 * @returns The running provider and recorded request list.
 */
export async function startHermeticAnthropicProvider(
    options: HermeticAnthropicProviderOptions,
): Promise<HermeticAnthropicProvider> {
    const requests: RecordedAnthropicRequest[] = [];
    const server = createServer((request, response) => {
        void readBody(request).then(async (raw) => {
            const body = JSON.parse(raw || '{}') as Record<string, unknown>;
            requests.push({
                url: request.url ?? '',
                method: request.method ?? '',
                headers: request.headers,
                body,
            });
            if (request.method !== 'POST' || request.url !== '/v1/messages') {
                response.writeHead(404);
                response.end();
                return;
            }
            const reply = options.script[requests.length - 1] ??
                options.scriptExhausted ?? {
                    kind: ScriptedReplyKind.Text,
                    text: 'hermetic script exhausted',
                };
            await serveReply(response, body.model as string, reply, options.usage);
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen({ host: '127.0.0.1', port: 0 }, resolve);
    });
    const address = server.address();
    if (typeof address !== 'object' || address === null) {
        throw new Error('Hermetic Anthropic provider did not expose an address');
    }
    const close = async (): Promise<void> => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    };
    return { baseUrl: `http://127.0.0.1:${address.port}`, requests, close };
}
