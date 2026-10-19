import {
    createServer,
    type IncomingHttpHeaders,
    type IncomingMessage,
    type ServerResponse,
} from 'node:http';

/**
 * A hermetic OpenAI-completions SSE provider on 127.0.0.1 that drives the REAL pi runtime with no
 * network. One server instance serves one scenario for every completion request; each request is
 * recorded for assertions. Adapted from github-knowledge-base's packages/analyze mock-provider.
 */

/**
 * Scripted behaviors the hermetic provider can serve.
 */
export const HermeticScenario = {
    /**
     * Streamed assistant text reply followed by a usage chunk.
     */
    Text: 'text',

    /**
     * One function tool-call reply followed by a usage chunk.
     */
    ToolCall: 'tool-call',

    /**
     * HTTP 401 with a provider-shaped JSON error body.
     */
    AuthError: 'auth-error',

    /**
     * The request is accepted and never answered, until the client aborts or the server closes.
     */
    Hang: 'hang',

    /**
     * The Nth completion request receives the Nth scripted reply of the `script` queue.
     */
    Scripted: 'scripted',
} as const;

/**
 * HermeticScenario value.
 */
export type HermeticScenario = (typeof HermeticScenario)[keyof typeof HermeticScenario];

/**
 * Hermetic control of the usage chunk of one successful reply: counts to serve, or `null` to omit
 * the usage chunk entirely (the no-telemetry path).
 */
export interface HermeticUsageSpec {
    /**
     * Prompt tokens served in the usage chunk. INCLUSIVE of cached tokens per OpenAI wire
     * semantics: the provider reports the full prompt here and the cached subset separately.
     */
    promptTokens: number;

    /**
     * Completion tokens served in the usage chunk.
     */
    completionTokens: number;

    /**
     * Cached subset of the prompt tokens; when set, the chunk carries
     * `prompt_tokens_details.cached_tokens`. Omitted when absent.
     */
    cachedTokens?: number;

    /**
     * Prompt tokens written to the cache, separately metered from uncached input.
     */
    cacheWriteTokens?: number;
}

/**
 * Reply kinds of the Scripted scenario.
 */
export const ScriptedReplyKind = {
    /**
     * A streamed assistant text reply followed by a usage chunk.
     */
    Text: 'text',

    /**
     * One function tool-call reply followed by a usage chunk.
     */
    ToolCall: 'tool-call',

    /**
     * An HTTP error response with an OpenAI-shaped JSON error body. The body's `type` is derived
     * from the status via `errorBodyType`, because pi classifies retries by the message text.
     */
    Error: 'error',

    /**
     * An HTTP error response with NO body at all — what a gateway's edge returns when it never
     * reached the origin.
     *
     * A distinct kind because the absent body is the whole point: with a JSON body the composed
     * message carries the body's `type`, and `errorBodyType` stamps every 5xx `server_error`, which
     * pi's own pattern list already matches — so an `Error` reply can never show what a status
     * alone decides. A bodiless response makes the OpenAI SDK compose `"<status> status code (no
     * body)"`, the exact message a live campaign was answered with from behind Cloudflare, and that
     * message names nothing except the status.
     */
    BareStatus: 'bare-status',

    /**
     * HTTP 200 followed by an in-stream error, represented by the selected provider's SSE wire. The
     * HTTP status stays successful, so classification must read the error event.
     */
    StreamFault: 'stream-fault',

    /**
     * A 200 SSE response that streams one text delta and then ends with a non-standard
     * `finish_reason` instead of `stop`: how a routing gateway reports an upstream that failed
     * while generating (`error`) or a content verdict (`content_filter`). Pi turns it into an error
     * turn whose message is exactly `Provider finish_reason: <reason>`.
     */
    FinishReason: 'finish-reason',

    /**
     * A 200 SSE response that streams one text delta and then goes silent, sending only SSE
     * keep-alive comments until the client gives up: a stream that opened and stalled while its
     * connection stays busy, so no byte-level timeout can see the stall.
     */
    Stall: 'stall',
} as const;

/**
 * ScriptedReplyKind value.
 */
export type ScriptedReplyKind = (typeof ScriptedReplyKind)[keyof typeof ScriptedReplyKind];

/**
 * Pacing of one scripted reply: text deltas trickled out ahead of the reply's own payload, so the
 * stream stays open and PRODUCING for far longer than writing it takes. This is the live-but-slow
 * response a burst-written reply cannot express at all — the shape of a reasoning model that
 * streams its thinking for minutes before it answers, which an inactivity deadline must tolerate
 * and a total-length deadline kills.
 */
export interface StreamPacing {
    /**
     * How many text deltas precede the reply's payload.
     */
    deltas: number;

    /**
     * Delay before each of those deltas, in milliseconds. The stream therefore stays alive for
     * roughly `deltas * intervalMs` with no gap longer than `intervalMs`, which is what lets a test
     * place the whole response past a deadline while every single gap stays inside it.
     */
    intervalMs: number;
}

/**
 * One reply in a scripted sequence: the Nth completion request of this server instance gets the Nth
 * reply (zero-based), letting tests drive multi-turn runs such as reject-then-correct.
 */
export type ScriptedReply =
    | {
          /**
           * Discriminator: a streamed text reply.
           */
          kind: typeof ScriptedReplyKind.Text;

          /**
           * Assistant text to serve.
           */
          text: string;

          /**
           * Usage chunk for THIS reply, overriding the instance-wide `usage` option: a spec sets
           * the counts, `null` omits the chunk. Absent keeps the instance-wide value. A run only
           * compacts around a turn that reports an over-window context, so scripting the usage per
           * reply is what decides which turn that is.
           */
          usage?: HermeticUsageSpec | null;

          /**
           * Trickle this many paced text deltas before the reply's own text; absent writes the
           * whole reply in one burst.
           */
          pacing?: StreamPacing;
      }
    | {
          /**
           * Discriminator: a single function tool-call reply.
           */
          kind: typeof ScriptedReplyKind.ToolCall;

          /**
           * Tool name the scripted model calls.
           */
          toolName: string;

          /**
           * JSON-encoded arguments for the tool call.
           */
          toolArguments: string;

          /**
           * Usage chunk for THIS reply, overriding the instance-wide `usage` option; see the text
           * reply's field.
           */
          usage?: HermeticUsageSpec | null;

          /**
           * Trickle this many paced text deltas before the tool call; absent writes the whole reply
           * in one burst.
           */
          pacing?: StreamPacing;
      }
    | {
          /**
           * Discriminator: an HTTP error response with an OpenAI-shaped JSON error body.
           */
          kind: typeof ScriptedReplyKind.Error;

          /**
           * HTTP status to serve; `errorBodyType` derives the body `type` from it.
           */
          status: number;

          /**
           * Provider-visible message carried in the JSON error body.
           */
          message: string;
      }
    | {
          /**
           * Discriminator: an HTTP error response with no body whatsoever.
           */
          kind: typeof ScriptedReplyKind.BareStatus;

          /**
           * HTTP status to serve; it is the only thing the client learns about the failure.
           */
          status: number;

          /**
           * `retry-after` header value in seconds, when the gateway asks for a pause.
           */
          retryAfterSeconds?: number;
      }
    | {
          /**
           * Discriminator: a 200 SSE response carrying one in-stream error chunk.
           */
          kind: typeof ScriptedReplyKind.StreamFault;

          /**
           * Fault text in error.message; the OpenAI adapter exposes it as the provider message.
           */
          message: string;

          /**
           * OpenAI in-stream error.code; Anthropic maps this status to its error type. Neither
           * changes the HTTP 200 status, so retry classification must read the stream error.
           */
          code: number;

          /**
           * Usage observed before the stream fault, null for zero counts on Anthropic.
           */
          usage?: HermeticUsageSpec | null;
      }
    | {
          /**
           * Discriminator: a 200 SSE response ending with the given non-standard finish reason.
           */
          kind: typeof ScriptedReplyKind.FinishReason;

          /**
           * The `finish_reason` value of the final chunk, for example `error` or `content_filter`.
           */
          reason: string;
      }
    | {
          /**
           * Discriminator: a 200 SSE response that stalls after its first delta.
           */
          kind: typeof ScriptedReplyKind.Stall;
      };

/**
 * Default assistant text served by the Text scenario.
 */
const DEFAULT_REPLY_TEXT = 'pong';

/**
 * Text carried by one paced delta. Its content is irrelevant — what a paced delta proves is that
 * the stream produced something, so the text is a fixed marker rather than a knob.
 */
const PACED_DELTA_TEXT = 'thinking ';

/**
 * Gap between the SSE keep-alive comments of a stalled reply: far inside any stall deadline a suite
 * sets, so the connection never goes quiet while the model does.
 */
export const STALL_KEEP_ALIVE_INTERVAL_MS = 50;

/**
 * Default tool identity served by the ToolCall scenario.
 */
const DEFAULT_TOOL_NAME = 'lookup_issue';
const DEFAULT_TOOL_ARGUMENTS = '{"number":1}';

/**
 * Default provider error message served by the AuthError scenario.
 */
const DEFAULT_AUTH_ERROR_MESSAGE = 'auth failed';

/**
 * Text served when a scripted sequence is exhausted; a run reaching it has gone off-script, which
 * the runner's no-terminal path surfaces instead of hanging.
 */
const SCRIPT_EXHAUSTED_TEXT = 'hermetic script exhausted';

/**
 * The OpenAI error-body `type` for a scripted HTTP status — shared by the AuthError scenario and
 * the scripted Error reply so the wire literal lives exactly once.
 *
 * Pi classifies retryability from the COMPOSED message text (status + JSON body), and its retryable
 * pattern list contains `server.?error` — so the body type is behavior-bearing, not decoration: a
 * 401 stamped `server_error` IS retried (verified against the installed pi-ai@0.84.1 dist). 4xx
 * therefore gets `invalid_request_error` — the shape the committed AuthError scenario uses, which
 * pi fails fast on — and 5xx gets `server_error`, matching real transient upstream failures.
 *
 * @param status - The scripted HTTP status code.
 * @returns The OpenAI error-body type that makes pi classify the reply as intended.
 */
function errorBodyType(status: number): string {
    return status >= 500 ? 'server_error' : 'invalid_request_error';
}

/**
 * Token usage served with every successful completion.
 */
const DEFAULT_USAGE = { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 };

/**
 * Default usage counts, kept as the `DEFAULT_USAGE` wire shape (the existing tests' authority).
 */
const DEFAULT_USAGE_SPEC: HermeticUsageSpec = {
    promptTokens: DEFAULT_USAGE.prompt_tokens,
    completionTokens: DEFAULT_USAGE.completion_tokens,
};

/**
 * Options for one hermetic provider instance.
 */
export interface HermeticProviderOptions {
    /**
     * Scenario served for every completion request.
     */
    scenario: HermeticScenario;

    /**
     * Model id echoed back in the response chunks, when it must differ from the requested one —
     * gateways answer with their own build name, which pricing tables are not keyed by.
     */
    responseModel?: string;

    /**
     * Assistant text for the Text scenario.
     */
    text?: string;

    /**
     * Tool name for the ToolCall scenario.
     */
    toolName?: string;

    /**
     * JSON-encoded tool arguments for the ToolCall scenario.
     */
    toolArguments?: string;

    /**
     * Provider error message for the AuthError scenario.
     */
    errorMessage?: string;

    /**
     * Reply queue for the Scripted scenario.
     */
    script?: ScriptedReply[];

    /**
     * Reply served for requests past the end of the script queue; defaults to the script-exhausted
     * text. Point it at a tool call to script an endless loop, or at an error to make every request
     * fail.
     */
    scriptExhausted?: ScriptedReply;

    /**
     * Usage chunk control: a spec overrides the default 11/5 counts, `null` omits the usage chunk
     * entirely (the no-telemetry path). Default keeps the existing counts.
     */
    usage?: HermeticUsageSpec | null;
}

/**
 * One completion request captured by the hermetic server.
 */
export interface RecordedProviderRequest {
    /**
     * Request path (always `/v1/chat/completions`).
     */
    url: string;

    /**
     * Request method.
     */
    method: string;

    /**
     * Raw request headers (authorization, session affinity).
     */
    headers: IncomingHttpHeaders;

    /**
     * Model id from the request body.
     */
    model: string | null;

    /**
     * Whether the request asked for SSE streaming.
     */
    stream: boolean;

    /**
     * Raw parsed request messages (OpenAI chat-completions shape).
     */
    messages: Record<string, unknown>[];

    /**
     * Raw advertised tools array from the request body (frozen-tool-list and schema assertions).
     */
    tools: unknown;

    /**
     * Sampling temperature from the request body; `null` when the request carried none.
     */
    temperature: number | null;

    /**
     * `reasoning_effort` from the request body; `null` when the request carried none. Pi decides
     * this from the session's thinking level, so it is the wire evidence of that decision.
     */
    reasoningEffort: string | null;

    /**
     * `max_completion_tokens` from the request body; `null` when the request carried none. Pi
     * derives it from the registered catalog entry, clamped to the remaining context window.
     */
    maxCompletionTokens: number | null;
}

/**
 * A running hermetic provider instance.
 */
export interface HermeticProvider {
    /**
     * Base URL ending in `/v1`, ready for `PiRuntimeConfig.baseUrl`.
     */
    baseUrl: string;

    /**
     * Every completion request received, in arrival order.
     */
    requests: RecordedProviderRequest[];

    /**
     * Stop the server, destroying any hanging responses first.
     */
    close: () => Promise<void>;
}

/**
 * Read one request body to completion.
 *
 * @param request - The incoming request.
 * @returns The raw body text.
 */
export function readBody(request: IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
        // Decode once, after the last chunk: a multi-byte UTF-8 character can straddle a chunk
        // boundary, and decoding each chunk on its own turns it into replacement characters.
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
}

/**
 * Write one SSE data event.
 *
 * @param response - The stream response to write to.
 * @param payload - The event payload, serialized as JSON.
 */
function sendEvent(response: ServerResponse, payload: unknown): void {
    response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * The fields every `chat.completion.chunk` event carries before its choices delta.
 *
 * @param model - Model id echoed in the chunk.
 * @returns The shared chunk envelope.
 */
function chunkBase(model: string): Record<string, unknown> {
    return {
        id: 'chatcmpl-hermetic',
        object: 'chat.completion.chunk',
        created: 1,
        model,
    };
}

/**
 * Convert one hermetic usage spec into the OpenAI chat-completions usage chunk shape.
 *
 * @param spec - Hermetic usage counts (prompt total inclusive of cached tokens).
 * @returns The wire usage object carrying the token counts and, when configured, the cached subset
 *   under `prompt_tokens_details.cached_tokens`.
 */
function toWireUsage(spec: HermeticUsageSpec): Record<string, unknown> {
    return {
        prompt_tokens: spec.promptTokens,
        completion_tokens: spec.completionTokens,
        total_tokens: spec.promptTokens + spec.completionTokens,
        ...(spec.cachedTokens === undefined && spec.cacheWriteTokens === undefined
            ? {}
            : {
                  prompt_tokens_details: {
                      ...(spec.cachedTokens === undefined
                          ? {}
                          : { cached_tokens: spec.cachedTokens }),
                      ...(spec.cacheWriteTokens === undefined
                          ? {}
                          : { cache_write_tokens: spec.cacheWriteTokens }),
                  },
              }),
    };
}

/**
 * Emit the trailing usage chunk and end the stream.
 *
 * @param response - The stream response to finish.
 * @param model - Model id echoed in the usage chunk.
 * @param usage - Usage counts to serve; `null` omits the usage chunk entirely (a success reply that
 *   carries no telemetry), `undefined` keeps the 11/5 default.
 */
function finishStream(
    response: ServerResponse,
    model: string,
    usage: HermeticUsageSpec | null | undefined,
): void {
    if (usage !== null) {
        sendEvent(response, {
            ...chunkBase(model),
            choices: [],
            usage: toWireUsage(usage ?? DEFAULT_USAGE_SPEC),
        });
    }
    response.write('data: [DONE]\n\n');
    response.end();
}

/**
 * Start a hermetic provider on an ephemeral 127.0.0.1 port.
 *
 * @param options - The single scenario this instance serves.
 * @returns The running server handle with recorded requests.
 */
export async function startHermeticProvider(
    options: HermeticProviderOptions,
): Promise<HermeticProvider> {
    const requests: RecordedProviderRequest[] = [];
    const hanging = new Set<ServerResponse>();
    const replyText = options.text ?? DEFAULT_REPLY_TEXT;
    const toolName = options.toolName ?? DEFAULT_TOOL_NAME;
    const toolArguments = options.toolArguments ?? DEFAULT_TOOL_ARGUMENTS;
    const errorMessage = options.errorMessage ?? DEFAULT_AUTH_ERROR_MESSAGE;

    // Trickle the reply's paced deltas, stopping early once the client has gone: the run under test
    // may have aborted the request, and writing to a destroyed response is not a scenario.
    const paceDeltas = async (
        response: ServerResponse,
        model: string,
        pacing: StreamPacing | undefined,
    ): Promise<void> => {
        if (pacing === undefined) {
            return;
        }
        hanging.add(response);
        response.on('close', () => hanging.delete(response));
        for (let delta = 0; delta < pacing.deltas; delta++) {
            await new Promise<void>((resolve) => setTimeout(resolve, pacing.intervalMs));
            if (response.writableEnded || response.destroyed) {
                return;
            }
            sendEvent(response, {
                ...chunkBase(model),
                choices: [
                    {
                        index: 0,
                        delta: { role: 'assistant', content: PACED_DELTA_TEXT },
                        finish_reason: null,
                    },
                ],
            });
        }
        hanging.delete(response);
    };
    const textReply = async (
        response: ServerResponse,
        model: string,
        text: string,
        usage: HermeticUsageSpec | null | undefined,
        pacing?: StreamPacing,
    ): Promise<void> => {
        await paceDeltas(response, model, pacing);
        if (response.writableEnded || response.destroyed) {
            return;
        }
        sendEvent(response, {
            ...chunkBase(model),
            choices: [
                {
                    index: 0,
                    delta: { role: 'assistant', content: text },
                    finish_reason: null,
                },
            ],
        });
        sendEvent(response, {
            ...chunkBase(model),
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        });
        finishStream(response, model, usage);
    };
    const toolCallReply = async (
        response: ServerResponse,
        model: string,
        callToolName: string,
        callToolArguments: string,
        usage: HermeticUsageSpec | null | undefined,
        pacing?: StreamPacing,
    ): Promise<void> => {
        await paceDeltas(response, model, pacing);
        if (response.writableEnded || response.destroyed) {
            return;
        }
        sendEvent(response, {
            ...chunkBase(model),
            choices: [
                {
                    index: 0,
                    delta: {
                        role: 'assistant',
                        content: null,
                        tool_calls: [
                            {
                                index: 0,
                                id: `call-hermetic-${requests.length}`,
                                type: 'function',
                                function: { name: callToolName, arguments: callToolArguments },
                            },
                        ],
                    },
                    finish_reason: null,
                },
            ],
        });
        sendEvent(response, {
            ...chunkBase(model),
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        });
        finishStream(response, model, usage);
    };

    const server = createServer((request, response) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (request.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
            response.writeHead(404, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ error: 'not found' }));
            return;
        }
        void readBody(request).then(async (raw) => {
            const body = ((): Record<string, unknown> => {
                try {
                    return JSON.parse(raw) as Record<string, unknown>;
                } catch {
                    return {};
                }
            })();
            requests.push({
                url: url.pathname,
                method: request.method ?? '',
                headers: request.headers,
                model: typeof body.model === 'string' ? body.model : null,
                stream: body.stream === true,
                messages: Array.isArray(body.messages)
                    ? (body.messages as Record<string, unknown>[])
                    : [],
                tools: body.tools ?? null,
                temperature: typeof body.temperature === 'number' ? body.temperature : null,
                reasoningEffort:
                    typeof body.reasoning_effort === 'string' ? body.reasoning_effort : null,
                maxCompletionTokens:
                    typeof body.max_completion_tokens === 'number'
                        ? body.max_completion_tokens
                        : null,
            });
            const model =
                options.responseModel ??
                (typeof body.model === 'string' ? body.model : 'hermetic-model');

            if (options.scenario === HermeticScenario.AuthError) {
                response.writeHead(401, { 'content-type': 'application/json' });
                response.end(
                    JSON.stringify({
                        error: { message: errorMessage, type: errorBodyType(401) },
                    }),
                );
                return;
            }
            if (options.scenario === HermeticScenario.Hang) {
                hanging.add(response);
                response.on('close', () => hanging.delete(response));
                return;
            }
            const scriptedReply =
                options.scenario === HermeticScenario.Scripted
                    ? (options.script?.[requests.length - 1] ??
                      options.scriptExhausted ?? {
                          kind: ScriptedReplyKind.Text,
                          text: SCRIPT_EXHAUSTED_TEXT,
                      })
                    : undefined;
            if (scriptedReply?.kind === ScriptedReplyKind.BareStatus) {
                // No content-type and no payload: `response.end()` with nothing written is what
                // makes the SDK report the status alone.
                response.writeHead(
                    scriptedReply.status,
                    scriptedReply.retryAfterSeconds === undefined
                        ? {}
                        : { 'retry-after': String(scriptedReply.retryAfterSeconds) },
                );
                response.end();
                return;
            }
            if (scriptedReply?.kind === ScriptedReplyKind.Error) {
                response.writeHead(scriptedReply.status, { 'content-type': 'application/json' });
                response.end(
                    JSON.stringify({
                        error: {
                            message: scriptedReply.message,
                            type: errorBodyType(scriptedReply.status),
                        },
                    }),
                );
                return;
            }
            response.writeHead(200, {
                'content-type': 'text/event-stream',
                'cache-control': 'no-cache',
                connection: 'keep-alive',
            });
            if (scriptedReply?.kind === ScriptedReplyKind.StreamFault) {
                // The stream opened successfully; the fault arrives as a chunk, not as a status.
                sendEvent(response, {
                    error: { message: scriptedReply.message, code: scriptedReply.code },
                });
                response.end();
                return;
            }
            if (scriptedReply?.kind === ScriptedReplyKind.Stall) {
                // One delta opens the assistant message; from then on only comments arrive, which
                // keep the socket busy and carry nothing the model produced.
                sendEvent(response, {
                    ...chunkBase(model),
                    choices: [
                        {
                            index: 0,
                            delta: { role: 'assistant', content: 'thinking' },
                            finish_reason: null,
                        },
                    ],
                });
                const keepAlive = setInterval(() => {
                    if (!response.writableEnded && !response.destroyed) {
                        response.write(': keep-alive\n\n');
                    }
                }, STALL_KEEP_ALIVE_INTERVAL_MS);
                hanging.add(response);
                response.on('close', () => {
                    clearInterval(keepAlive);
                    hanging.delete(response);
                });
                return;
            }
            if (scriptedReply?.kind === ScriptedReplyKind.FinishReason) {
                // A few tokens arrive, then the gateway ends the completion with its own reason.
                sendEvent(response, {
                    ...chunkBase(model),
                    choices: [
                        {
                            index: 0,
                            delta: { role: 'assistant', content: 'partial' },
                            finish_reason: null,
                        },
                    ],
                });
                sendEvent(response, {
                    ...chunkBase(model),
                    choices: [{ index: 0, delta: {}, finish_reason: scriptedReply.reason }],
                });
                finishStream(response, model, options.usage);
                return;
            }
            if (scriptedReply !== undefined) {
                const replyUsage =
                    scriptedReply.usage === undefined ? options.usage : scriptedReply.usage;
                if (scriptedReply.kind === ScriptedReplyKind.ToolCall) {
                    await toolCallReply(
                        response,
                        model,
                        scriptedReply.toolName,
                        scriptedReply.toolArguments,
                        replyUsage,
                        scriptedReply.pacing,
                    );
                    return;
                }
                await textReply(
                    response,
                    model,
                    scriptedReply.text,
                    replyUsage,
                    scriptedReply.pacing,
                );
                return;
            }
            if (options.scenario === HermeticScenario.ToolCall) {
                await toolCallReply(response, model, toolName, toolArguments, options.usage);
                return;
            }
            await textReply(response, model, replyText, options.usage);
        });
    });

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen({ host: '127.0.0.1', port: 0 }, resolve);
    });
    const address = server.address();
    if (typeof address !== 'object' || address === null) {
        throw new Error('Hermetic provider did not expose an address');
    }

    const close = async (): Promise<void> => {
        for (const response of hanging) {
            response.destroy();
        }
        hanging.clear();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    };
    return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests, close };
}
