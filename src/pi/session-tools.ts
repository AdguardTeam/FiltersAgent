import * as v from 'valibot';
import { createLogger, type Logger } from '../logger/logger';
import { serializeToolResultForModel } from './tool-result-envelope';
import type { SessionToolResult, SessionToolSpec, ToolGateState } from './session-tool-types';
import { formatIssues } from './valibot-issues';

/**
 * Session tool surface for pi sessions: tool adaptation — the execution semantics every existing
 * tool keeps under the frozen tool list, the per-tool deadline race, and the `withToolDeadline`
 * helper `agent-runtime.ts` calls directly — plus the gate refusal envelope (a tool whose
 * `AdaptedToolInput.gate` callback reports it unavailable stays advertised and answers calls with
 * an explanatory refusal). Three neighbouring concerns are deliberately elsewhere: the wire ceiling
 * and the truncation envelope in `tool-result-envelope.ts`, the model-facing rendering of Valibot
 * issues in `valibot-issues.ts` (the one `formatIssues` this module, `terminal-tool.ts` and
 * `single-shot.ts` all refuse payloads with), and the advertisement conversion pi pre-validates
 * against in `tool-schema.ts`. Per-tool guidance arrives through
 * `AdaptSessionToolsOptions.guidance` (the wiring sources it from the tool catalog at the two
 * production call sites), keeping `src/pi` free of `src/agent` imports.
 */

/**
 * Bounded wait for an aborted tool call to record its own cleanup before the loop moves on.
 *
 * Phase-bound tools (apply_rule) must settle their recorder leases and close phase sessions after
 * the abort lands; the grace keeps that settlement ahead of run finalization without letting a
 * wedged session hold the run forever.
 *
 * Why 90 s: the longest operation such a call can still be inside is one extension-configuration
 * pass, whose in-code default budget is the same 90 s (`DEFAULT_PHASE_READINESS_BUDGET_MS` in the
 * orchestrator's agent runtime — named, not imported, because `src/pi` must not depend on
 * `src/orchestrator`), so the grace covers a pass that started just before the abort. It stays far
 * below the 15-minute apply_rule deadline, so it can never be what ends the run.
 */
export const TOOL_ABORT_SETTLE_GRACE_MS = 90_000;

/**
 * The `errorKind` vocabulary of every model-facing tool refusal this adapter emits.
 *
 * The model is told to read `errorKind` before deciding what to do next, and each member answers a
 * different question: the tool will not run whatever the arguments are, the arguments were wrong
 * and are worth correcting, or the call was cut off by its own wall-clock bound.
 */
export const ToolErrorKind = {
    /**
     * A tool whose gate reports it unavailable; the remedy, not the arguments, unblocks it.
     */
    ToolGated: 'tool_gated',

    /**
     * Arguments that passed pi's pre-execute check but failed the authoritative Valibot schema.
     */
    ValidationError: 'validation_error',

    /**
     * The call did not return inside its per-tool deadline and was aborted.
     */
    DeadlineExceeded: 'tool_deadline_exceeded',
} as const;

/**
 * ToolErrorKind value.
 */
export type ToolErrorKind = (typeof ToolErrorKind)[keyof typeof ToolErrorKind];

/**
 * What the model is told to do next about a refused call, carried as `requiredAction`.
 *
 * Only refusals that leave the model a move carry one; a gate refusal carries its remedy instead.
 */
export const ToolRequiredAction = {
    /**
     * Resubmit the same call with arguments that satisfy the schema.
     */
    CorrectTheArguments: 'correct_the_arguments',

    /**
     * Stop repeating this call and pick another move.
     */
    ChooseADifferentAction: 'choose_a_different_action',
} as const;

/**
 * ToolRequiredAction value.
 */
export type ToolRequiredAction = (typeof ToolRequiredAction)[keyof typeof ToolRequiredAction];

/**
 * Build the model-facing refusal record of a gated tool — the one envelope every gated call answers
 * with, wherever the gate lives (the adapter's own gate check, a stub's defensive execute).
 *
 * @param name - The tool the model called.
 * @param state - Why the tool is unavailable and what unblocks it.
 * @returns The `{ error, errorKind, gate, remedy }` refusal record.
 */
export function toolGatedRefusal(name: string, state: ToolGateState): Record<string, unknown> {
    return {
        error: `${name} is unavailable: ${state.reason}`,
        errorKind: ToolErrorKind.ToolGated,
        gate: state.cause,
        remedy: state.remedy,
    };
}

/**
 * How the race inside one deadline-bound tool call ended.
 */
const ToolCallSettlement = {
    /**
     * The call returned a result before its deadline.
     */
    Result: 'result',

    /**
     * The call rejected before its deadline; the error is rethrown to the adapter.
     */
    Rejected: 'rejected',

    /**
     * The deadline expired first and the call was aborted.
     */
    TimedOut: 'timed-out',
} as const;

/**
 * ToolCallSettlement value.
 */
type ToolCallSettlement = (typeof ToolCallSettlement)[keyof typeof ToolCallSettlement];

/**
 * The raced outcome of one deadline-bound tool call, carrying whatever the winning branch produced.
 */
type ToolCallOutcome =
    | {
          /**
           * Discriminator: the call returned.
           */
          kind: typeof ToolCallSettlement.Result;

          /**
           * The tool result the call resolved with.
           */
          result: Record<string, unknown>;
      }
    | {
          /**
           * Discriminator: the call rejected.
           */
          kind: typeof ToolCallSettlement.Rejected;

          /**
           * The error the call rejected with.
           */
          error: unknown;
      }
    | {
          /**
           * Discriminator: the deadline expired first.
           */
          kind: typeof ToolCallSettlement.TimedOut;
      };

/**
 * Bound one tool call so a stuck operation cannot consume the whole run.
 *
 * The call is started through a factory so an expired deadline can abort it cooperatively: the
 * signal lets in-flight phase work record failed completions instead of leaking bound leases that
 * later fail the whole run as "Every bound phase must be completed".
 *
 * @param name - Tool being dispatched, for the returned error.
 * @param callFactory - Starts the tool call and receives the abort signal.
 * @param deadlineMs - Wall-clock bound for this exact call.
 * @returns The tool result, or a retryable timeout result.
 */
export async function withToolDeadline(
    name: string,
    callFactory: (signal: AbortSignal) => Promise<Record<string, unknown>>,
    deadlineMs: number,
): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const call = callFactory(controller.signal);
    // Attach settlement handlers immediately so a late rejection after a timeout can never surface
    // as an unhandled rejection.
    const settled: Promise<ToolCallOutcome> = call.then(
        (result) => ({ kind: ToolCallSettlement.Result, result }),
        (error: unknown) => ({ kind: ToolCallSettlement.Rejected, error }),
    );
    let timer: NodeJS.Timeout | undefined;
    const deadline: Promise<ToolCallOutcome> = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ kind: ToolCallSettlement.TimedOut }), deadlineMs);
    });
    try {
        const outcome = await Promise.race([settled, deadline]);
        if (outcome.kind === ToolCallSettlement.Result) {
            return outcome.result;
        }
        if (outcome.kind === ToolCallSettlement.Rejected) {
            throw outcome.error;
        }
        controller.abort();
        // Let the aborted call record its own cleanup (failed phase completions, session close)
        // before the agent loop continues, so the run ledger never finalizes over live leases.
        await Promise.race([
            settled,
            new Promise<void>((resolve) => {
                setTimeout(resolve, TOOL_ABORT_SETTLE_GRACE_MS);
            }),
        ]);
        return {
            error: `${name} did not return within ${deadlineMs / 60_000} minutes.`,
            errorKind: ToolErrorKind.DeadlineExceeded,
            retryable: true,
            requiredAction: ToolRequiredAction.ChooseADifferentAction,
        };
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}

/**
 * One existing tool implementation handed to the adapter.
 */
export interface AdaptedToolInput {
    /**
     * Tool name used in the model's tool calls; also the guidance-lookup key.
     */
    name: string;

    /**
     * The tool's one Valibot parameter schema (the existing schema where the tool already declares
     * one). The runner derives pi's advertisement from it via `toAdvertisedSchema`, and pi
     * pre-validates every call against that advertisement before execute runs, coercing unambiguous
     * primitives; this adapter then re-checks the arguments against the FULL Valibot schema —
     * authoritative, per the committed seam contract — so the handler judges exactly what the
     * schema describes. The `Record<string, unknown>` output type is what lets the re-check pass
     * typed args to `execute`; the seam's plain `v.GenericSchema` accepts this specialization
     * unchanged.
     */
    parameters: v.GenericSchema<Record<string, unknown>>;

    /**
     * The existing implementation. It receives the Valibot-PARSED output — pi-coerced primitives,
     * schema defaults applied, undeclared keys stripped — not the raw call. The signal is composed
     * from pi's run abort signal and the deadline controller, so a guard-aborted run and an expired
     * deadline both reach in-flight work; it is `undefined` only when neither exists.
     */
    execute: (
        args: Record<string, unknown>,
        signal: AbortSignal | undefined,
    ) => Promise<Record<string, unknown>>;

    /**
     * Current availability of this tool, read by the adapter immediately BEFORE the Valibot
     * re-check and before `execute`. Returning a gate state refuses the call with the typed
     * `tool_gated` envelope; returning `undefined` lets it through. Unset means always available.
     *
     * The position is load-bearing: a gated tool's remedy (select the environment, relaunch the
     * browser, stop retrying a quarantined diagnostic) is actionable whatever the arguments were,
     * and moving the check after the re-check would turn a `tool_gated` refusal into a
     * `validation_error` the model is told to retry.
     *
     * The callback — rather than a shared mutable gate map — is what keeps the concerns apart: each
     * input's owner closes over its own latch, so clearing one concern's state cannot clear
     * another's.
     */
    gate?: () => ToolGateState | undefined;

    /**
     * Observer of the MODEL-FACING result, fired only for a call that actually executed (never for
     * a gate refusal, a validation bounce, or a thrown handler). It exists so a caller that needs
     * the redacted copy — the fix run's observation sink — reuses the adapter's single
     * serialization instead of redacting and stringifying the result a second time.
     *
     * It receives exactly what `content` carried to the provider, truncation envelope included, so
     * it is bounded by {@link MAX_TOOL_RESULT_BYTES}. The sink writes `agent-observations.json`,
     * documented as the sanitized results proven to have reached the model; handing it the
     * pre-envelope object would fill that artifact with megabytes the model never saw, because
     * `get_console_log` and `get_network_log` return uncapped inventories.
     */
    onResult?: (modelFacing: Record<string, unknown>) => void;

    /**
     * Model-facing description override; defaults to the tool's guidance entry.
     */
    description?: string;

    /**
     * Per-call wall-clock deadline in milliseconds. Unset means no deadline; mode wiring passes the
     * per-tool values.
     */
    deadlineMs?: number;
}

/**
 * Options for one adapted session set.
 */
export interface AdaptSessionToolsOptions {
    /**
     * Pino logger keeping thrown-handler diagnostics (message and stack) in the run log before the
     * model-facing envelope is returned; defaults to the application logger, mirroring the
     * `options.logger ?? createLogger()` convention of `session-runner.ts`.
     */
    logger?: Logger;

    /**
     * Per-tool usage guidance the wiring sources from the relocated tool catalog. A tool whose
     * `AdaptedToolInput.description` is unset resolves its model-facing description from this map.
     */
    guidance?: Readonly<Record<string, string>>;
}

/**
 * Adapt existing tool implementations into one session's frozen pi tool set.
 *
 * Every adapted execute keeps one model-facing semantics: a gated call returns the
 * reason-plus-remedy refusal; arguments that reach execute and fail the full Valibot schema return
 * the `{error, errorKind: 'validation_error', retryable, requiredAction}` bounce (pi's pre-execute
 * check normally catches these first because the advertisement is the schema verbatim, but the
 * guarantee that a handler never sees unvalidated arguments belongs to the adapter, and callers
 * that invoke execute with no pi in front of them rely on it); an expired deadline returns the
 * `tool_deadline_exceeded` envelope; an oversized result arrives as the truncation envelope; and a
 * thrown handler error is logged with its stack and arrives as `{ error: message }` — the session
 * continues in every case and nothing surfaces as a pi-thrown error. Gate refusal precedes the
 * re-check: for a gated tool the remedy (select the environment, relaunch the browser, stop
 * retrying) is actionable regardless of the arguments.
 *
 * @param inputs - The tools of the session, in advertisement order.
 * @param options - Logger override for thrown-handler diagnostics and the per-tool guidance map.
 * @returns The frozen tool set, in advertisement order.
 * @throws When a tool name appears twice, or a tool has neither an explicit description nor a
 *   guidance-map entry.
 */
export function adaptSessionTools(
    inputs: AdaptedToolInput[],
    options: AdaptSessionToolsOptions = {},
): SessionToolSpec[] {
    const logger = options.logger ?? createLogger();
    const names = new Set<string>();
    for (const input of inputs) {
        if (names.has(input.name)) {
            // `ToolRegistry` overwrites by Map.set and re-registers wrapped lifecycle tools; two
            // inputs under one name would advertise both while pi dispatches the first — the
            // model's view of the tool would split.
            throw new Error(`Duplicate tool name in adapted session set: ${input.name}`);
        }
        names.add(input.name);
    }
    return inputs.map((input): SessionToolSpec => {
        const description = input.description ?? options.guidance?.[input.name];
        if (description === undefined) {
            throw new Error(
                `No usage guidance for ${input.name}: pass a description or extend TOOL_GUIDANCE`,
            );
        }
        return {
            name: input.name,
            description,
            parameters: input.parameters,
            execute: async (args, signal): Promise<SessionToolResult> => {
                const gate = input.gate?.();
                if (gate !== undefined) {
                    const serialized = serializeToolResultForModel(
                        toolGatedRefusal(input.name, gate),
                    );
                    return { content: serialized.content, details: serialized.redacted };
                }
                // The seam hands us `unknown` that already passed PI's check of the converted
                // advertisement (and may be pi-coerced); Valibot re-validation is authoritative
                // for the full schema, and its parsed output is what the handler executes on.
                const parsed = v.safeParse(input.parameters, args);
                if (!parsed.success) {
                    const invalid = {
                        error: `${input.name}: invalid arguments (${formatIssues(parsed.issues)})`,
                        errorKind: ToolErrorKind.ValidationError,
                        retryable: true,
                        requiredAction: ToolRequiredAction.CorrectTheArguments,
                    };
                    const serialized = serializeToolResultForModel(invalid);
                    return { content: serialized.content, details: serialized.redacted };
                }
                const callArgs = parsed.output;
                let result: Record<string, unknown>;
                try {
                    result =
                        input.deadlineMs === undefined
                            ? await input.execute(callArgs, signal)
                            : await withToolDeadline(
                                  input.name,
                                  (deadlineSignal) =>
                                      input.execute(
                                          callArgs,
                                          signal === undefined
                                              ? deadlineSignal
                                              : AbortSignal.any([signal, deadlineSignal]),
                                      ),
                                  input.deadlineMs,
                              );
                } catch (error) {
                    // Never swallow into the bare envelope: the model-facing result carries only
                    // the message, so this line is where the stack survives. The trace records the
                    // call through `SessionToolResult.details`, which has no room for a stack.
                    logger.error({ err: error, tool: input.name }, 'adapted tool threw');
                    // A handler may reject with a non-Error (a string, a plain object): casting
                    // to Error and reading `.message` off it serialized as `{}` and the model was
                    // told nothing at all.
                    const failure = {
                        error: error instanceof Error ? error.message : String(error),
                    };
                    const serialized = serializeToolResultForModel(failure);
                    return { content: serialized.content, details: serialized.redacted };
                }
                const serialized = serializeToolResultForModel(result);
                // The bytes the model got, as an object: untruncated, `content` is exactly
                // `JSON.stringify(redacted)`, so re-parsing would only deep-clone; truncated, the
                // envelope exists nowhere else.
                input.onResult?.(
                    serialized.truncatedFromBytes === undefined
                        ? serialized.redacted
                        : (JSON.parse(serialized.content) as Record<string, unknown>),
                );
                return { content: serialized.content, details: serialized.redacted };
            },
        };
    });
}
