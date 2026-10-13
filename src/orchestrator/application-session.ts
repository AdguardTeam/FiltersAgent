/**
 * The rule-application session runner: `PhaseApplicationRunner` implemented over the shared pi
 * mode-session procedure with the page-tool subset of the phase lease.
 *
 * The session is short, narrow, and heavily observed: it renders the prompt the application
 * procedure already built, hands the model exactly the read tools plus one `open_page` that admits
 * precisely the prepared blocker's own management surface, and ends through the
 * `finish_application` terminal. The host, not the model, owns the verdict: the runner returns only
 * how the session sealed and the host-recorded tool trace — the application procedure reads the
 * blocker state back itself and never consumes the model's self-report as credit.
 *
 * This is the runner of one application shape only: an instruction that writes its own `## Rule
 * application` steps, for a blocker with its own way to add a rule. The built-in AdGuard route's
 * steps are a fixed message protocol the host sends itself (`host-extension-application.ts`) and
 * never reach this module.
 */
import * as v from 'valibot';
import { BrowserFallbackReason } from '../types/browser-fallback-reason';
import { TOOL_GUIDANCE, TOOL_PARAMETER_SCHEMAS } from '../agent/tool-catalog';
import { ToolName } from '../agent/tool-names';
import type { LlmConfig } from '../config/config';
import { canonicalHttpOrigin } from '../browser/network-safety';
import { createBrowserToolHandlers } from '../browser/browser-tools';
import type { IBrowserSession } from '../browser/browser-interfaces';
import { createLogger, type Logger } from '../logger/logger';
import type { PiRuntime } from '../pi/runtime';
import { SealKind } from '../pi/seal-types';
import { adaptSessionTools, type AdaptedToolInput } from '../pi/session-tools';
import { buildTerminalTool } from '../pi/terminal-tool';
import type { RunUsageCollector } from '../pi/usage-collector';
import { launchModeSession } from '../session/mode-session';
import {
    PROOF_ACTION_LOG_MAX_ENTRIES,
    PROOF_ACTION_LOG_SUMMARY_MAX,
    type ActionLogEntry,
} from '../environment/environment-proofs';
import { withExecutionRecording, recordTerminalTool } from '../tracer/session-trace';
import type { TraceRecorder } from '../tracer/trace-recorder';
import type {
    PhaseApplicationRunner,
    PhaseApplicationRunnerResult,
} from '../validator/phase-application-contract';
import {
    buildSendExtensionMessageTool,
    protocolHostOf,
    sameProtocolHost,
} from './application-write-channel';

/**
 * Terminal payload statuses of the application session.
 */
export const ApplicationTerminalStatus = {
    /**
     * The instruction's application steps were performed exactly as written.
     */
    Done: 'done',

    /**
     * A step failed or could not be completed; the state left behind is what the host reads back.
     */
    Failed: 'failed',
} as const;

/**
 * ApplicationTerminalStatus value.
 */
export type ApplicationTerminalStatus =
    (typeof ApplicationTerminalStatus)[keyof typeof ApplicationTerminalStatus];

/**
 * Every ApplicationTerminalStatus value, for the terminal schema.
 */
export const APPLICATION_TERMINAL_STATUS_VALUES = Object.values(ApplicationTerminalStatus);

/**
 * Bounded length of the failed-step detail the terminal payload may name.
 *
 * A detail names one step and what happened to it; the bound keeps that diagnostic-sized without
 * letting a page dump ride a terminal payload into the run record. It is generous on purpose: pi
 * validates the advertised schema before the terminal tool runs, so an over-long detail is a
 * rejected call rather than a trimmed one, and an application session can spend its last turn on
 * exactly that rejection and end without any terminal payload.
 */
export const APPLICATION_FAILURE_DETAIL_MAX = 2000;

/**
 * The application session's terminal payload: the model's own end-of-session status.
 *
 * The application verdict never consumes this payload (the host read-back decides); it exists so
 * the session has the one terminal seal every mode session ends through and the run trace records
 * how the model believed it ended.
 */
export const ApplicationTerminalSchema = v.strictObject({
    status: v.picklist(APPLICATION_TERMINAL_STATUS_VALUES),
    detail: v.optional(v.pipe(v.string(), v.maxLength(APPLICATION_FAILURE_DETAIL_MAX))),
});

/**
 * ApplicationTerminalSchema output.
 */
export type ApplicationTerminal = v.InferOutput<typeof ApplicationTerminalSchema>;

/**
 * Bounded wall-clock allowance for one navigation to the prepared blocker's management surface.
 *
 * The surface is a local extension page — no network — so the navigation itself is fast; the
 * ceiling absorbs a page still busy with the fresh-install bootstrap the instruction's own steps
 * then wait out.
 */
const APPLICATION_SURFACE_OPEN_TIMEOUT_MS = 15_000;

/**
 * What one application-session runner needs: the run's pi runtime and trace recorder, the phase
 * lease session, and the run's LLM configuration.
 */
export interface PhaseApplicationRunnerDependencies {
    /**
     * The run's already-built pi runtime.
     */
    runtime: PiRuntime;

    /**
     * The validated LLM provider configuration the request bounds map from.
     */
    llm: LlmConfig;

    /**
     * The run trace recorder; every application turn lands in the run trace.
     */
    recorder: TraceRecorder;

    /**
     * The phase lease session whose page the application tools act on.
     */
    session: IBrowserSession;

    /**
     * Canonical origin of the reported site, for the read tools' network inventory.
     */
    allowedOrigin: string;

    /**
     * Application logger; one default logger otherwise.
     */
    logger?: Logger;

    /**
     * Run-scoped usage collector threaded into the session like every other mode session.
     */
    usageCollector?: RunUsageCollector;
}

/**
 * Whether the shared page-tool navigation guard can admit the prepared blocker surface.
 *
 * The shared `open_page` validates targets through the public http(s) network-safety gate and
 * installs a route guard with the same admission rule; `canonicalHttpOrigin` is that gate's origin
 * step, so a `chrome-extension://` surface never passes it. When this returns false the application
 * session ships its own `open_page` scoped to exactly the prepared surface's protocol and host —
 * the instruction's own surface, not a second navigation mechanism — and keeps the shared read
 * tools unchanged.
 *
 * @param blockerSurfaceUrl - The prepared blocker's management surface URL.
 * @returns True when the shared guard would admit the surface (never true today for extension
 *   origins; the check keeps this module honest if the shared guard ever widens).
 */
export function sharedPageToolsAdmitBlockerSurface(blockerSurfaceUrl: string): boolean {
    try {
        canonicalHttpOrigin(blockerSurfaceUrl);
        return true;
    } catch {
        return false;
    }
}

/**
 * Build the bounded one-line summary an action-log entry records for one tool result.
 *
 * @param result - The model-facing tool result record.
 * @returns A summary bounded to the proof action-log ceiling.
 */
function actionLogSummary(result: Record<string, unknown>): string {
    const serialized = JSON.stringify(result) ?? '';
    return serialized.length > PROOF_ACTION_LOG_SUMMARY_MAX
        ? serialized.slice(0, PROOF_ACTION_LOG_SUMMARY_MAX)
        : serialized;
}

/**
 * Dependencies of the application page-tool subset builder.
 */
interface ApplicationToolSetDependencies {
    /**
     * The phase lease session whose page the tools act on.
     */
    session: IBrowserSession;

    /**
     * The run trace recorder for the read tools' artifacts.
     */
    recorder: TraceRecorder;

    /**
     * Canonical reported origin for the network inventory.
     */
    allowedOrigin: string;

    /**
     * The prepared blocker's management surface URL, when known.
     */
    blockerSurfaceUrl?: string;
}

/**
 * The application page-tool subset with the host-side tool-trace collector.
 */
interface ApplicationToolSet {
    /**
     * The session tool inputs, in advertisement order.
     */
    inputs: AdaptedToolInput[];

    /**
     * Snapshot of the host-recorded tool trace collected so far.
     */
    recordedActionLog: () => ActionLogEntry[];
}

/**
 * Build the application session's page-tool subset with a host-side tool-trace collector.
 *
 * Exactly one navigation tool exists and it admits only the prepared blocker surface's protocol and
 * host; the remaining tools are the shared read-only page evidence tools. Every executed call —
 * result or throw — is recorded by the host into the returned collector; that trace is the
 * application proof's action log, never the model's report of what it did.
 *
 * @param depends - The tool set's dependencies.
 * @param logger - The application logger for the admission and route diagnostics.
 * @returns The session tool inputs and the host-recorded action-log collector.
 */
export function buildApplicationToolSet(
    depends: ApplicationToolSetDependencies,
    logger: Logger,
): ApplicationToolSet {
    const { session, recorder, allowedOrigin, blockerSurfaceUrl } = depends;
    const handlers = createBrowserToolHandlers({
        session,
        recorder,
        artifactsDir: session.artifactsDir,
        allowedOrigin,
    });

    const entries: ActionLogEntry[] = [];
    const recordedActionLog = (): ActionLogEntry[] => [...entries];

    const record = (
        name: string,
        execute: AdaptedToolInput['execute'],
    ): AdaptedToolInput['execute'] => {
        return async (args, signal) => {
            try {
                const result = await execute(args, signal);
                if (entries.length < PROOF_ACTION_LOG_MAX_ENTRIES) {
                    entries.push({
                        tool: name,
                        ok: !('error' in result),
                        summary: actionLogSummary(result),
                    });
                }
                return result;
            } catch (error) {
                if (entries.length < PROOF_ACTION_LOG_MAX_ENTRIES) {
                    entries.push({
                        tool: name,
                        ok: false,
                        summary: actionLogSummary({
                            error: error instanceof Error ? error.message : String(error),
                        }),
                    });
                }
                throw error;
            }
        };
    };

    const readTools: [name: ToolName, handler: AdaptedToolInput['execute']][] = [
        [ToolName.StabilizePage, async (args) => ({ ...(await handlers.stabilize_page!(args)) })],
        [ToolName.Screenshot, handlers.screenshot],
        [ToolName.GetDom, handlers.get_dom],
        [
            ToolName.InspectPageState,
            async (args) => ({ ...(await handlers.inspect_page_state(args)) }),
        ],
        [ToolName.GetConsoleLog, handlers.get_console_log],
        [ToolName.GetNetworkLog, handlers.get_network_log],
    ];

    const inputs: AdaptedToolInput[] = readTools.map(([name, handler]) => ({
        name,
        parameters: TOOL_PARAMETER_SCHEMAS[name],
        description: TOOL_GUIDANCE[name]!,
        execute: record(name, handler),
    }));

    if (blockerSurfaceUrl === undefined) {
        return { inputs, recordedActionLog };
    }

    const surfaceProtocolHost = protocolHostOf(blockerSurfaceUrl);
    if (surfaceProtocolHost === null) {
        throw new Error(
            `The prepared blocker management surface URL does not parse: ${blockerSurfaceUrl}`,
        );
    }
    const surfaceAuthority = `${surfaceProtocolHost.protocol}//${surfaceProtocolHost.host}`;
    // Playwright's URL predicate receives the parsed URL, so the continuation route decides
    // membership through the same protocol-and-host comparison the open_page guard applies.
    const admitsSurfaceUrl = (url: URL): boolean => {
        const requested = protocolHostOf(url);
        return requested !== null && sameProtocolHost(requested, surfaceProtocolHost);
    };
    const sharedGuardAdmits = sharedPageToolsAdmitBlockerSurface(blockerSurfaceUrl);
    if (!sharedGuardAdmits) {
        logger.info(
            {
                blockerSurfaceAuthority: surfaceAuthority,
                note: 'shared_page_tools_refuse_extension_origin',
            },
            'application sessions admit the prepared blocker surface through the scoped open_page',
        );
    } else {
        logger.info(
            {
                blockerSurfaceAuthority: surfaceAuthority,
                note: 'shared_page_tools_admit_extension_origin',
            },
            'the shared page-tool guard admits the prepared blocker surface; no scoped bypass added',
        );
    }

    const sendMessage = buildSendExtensionMessageTool(session, surfaceProtocolHost);
    inputs.push({
        ...sendMessage,
        execute: record(ToolName.SendExtensionMessage, sendMessage.execute),
    });

    const openPage: AdaptedToolInput = {
        name: ToolName.OpenPage,
        parameters: TOOL_PARAMETER_SCHEMAS[ToolName.OpenPage],
        description:
            `Navigates the page to the prepared blocker's own management surface ` +
            `(${surfaceAuthority}) — the only protocol and host an application session may open. ` +
            'Every other target is refused.',
        execute: record(ToolName.OpenPage, async (args) => {
            const url = typeof args.url === 'string' ? args.url : '';
            const requested = protocolHostOf(url);
            if (!url || requested === null || !sameProtocolHost(requested, surfaceProtocolHost)) {
                return {
                    error:
                        'navigation blocked: an application session may open only the prepared ' +
                        `blocker management surface ${surfaceAuthority}`,
                    fallbackReason: BrowserFallbackReason.UnsafeTargetUrl,
                };
            }
            if (!sharedGuardAdmits) {
                // Keep a scoped continuation ahead of any pre-existing public-web route guard so
                // the extension origin's own document and assets survive a guard installed
                // earlier on this page. The predicate matches only this one applied authority.
                await session
                    .getPage()
                    .route(admitsSurfaceUrl, (route) => route.continue())
                    .catch((error: unknown) => {
                        logger.warn(
                            {
                                err: error,
                                blockerSurfaceAuthority: surfaceAuthority,
                            },
                            'the scoped route continuation for the blocker surface was not installed',
                        );
                    });
            }
            try {
                const page = session.getPage();
                const response = await page.goto(url, {
                    waitUntil: 'domcontentloaded',
                    timeout: APPLICATION_SURFACE_OPEN_TIMEOUT_MS,
                });
                return {
                    url: page.url(),
                    title: await page.title(),
                    statusCode: response?.status() ?? 200,
                };
            } catch (error) {
                logger.error(
                    { err: error, targetAuthority: surfaceAuthority },
                    'navigation to the prepared blocker management surface failed',
                );
                return {
                    error:
                        'navigation failed: ' +
                        (error instanceof Error ? error.message : String(error)),
                    fallbackReason: BrowserFallbackReason.UnsafeTargetUrl,
                };
            }
        }),
    };
    inputs.push(openPage);

    return { inputs, recordedActionLog };
}

/**
 * Create the phase-application model runner over the shared pi mode-session procedure.
 *
 * The runner bends no verdict: a session that seals without a payload still ends in whatever
 * blocker state the steps left, and the application procedure reads that state back itself.
 *
 * @param dependencies - Runtime, provider configuration, recorder, lease session, and origin.
 * @returns The model-driven PhaseApplicationRunner implementation.
 */
export function createPhaseApplicationModelRunner(
    dependencies: PhaseApplicationRunnerDependencies,
): PhaseApplicationRunner {
    return {
        run: async (request): Promise<PhaseApplicationRunnerResult> => {
            const logger = dependencies.logger ?? createLogger();
            const { inputs, recordedActionLog } = buildApplicationToolSet(
                {
                    session: dependencies.session,
                    recorder: dependencies.recorder,
                    allowedOrigin: dependencies.allowedOrigin,
                    blockerSurfaceUrl: request.session.blockerSurfaceUrl,
                },
                logger,
            );
            const tools = adaptSessionTools(inputs, {
                logger,
                guidance: TOOL_GUIDANCE,
            }).map((spec) => withExecutionRecording(spec, dependencies.recorder));
            const terminal = recordTerminalTool(
                buildTerminalTool<ApplicationTerminal>({
                    name: ToolName.FinishApplication,
                    description: TOOL_GUIDANCE[ToolName.FinishApplication]!,
                    schema: ApplicationTerminalSchema,
                }),
                dependencies.recorder,
            );

            const { outcome } = await launchModeSession<ApplicationTerminal>({
                runtime: dependencies.runtime,
                llm: dependencies.llm,
                recorder: dependencies.recorder,
                terminalToolName: ToolName.FinishApplication,
                // The application procedure owns the task rendering; the runner only hands the
                // prepared prompt through to the shared launch procedure.
                renderTask: () => request.prompt,
                terminal,
                tools,
                maxTurns: request.budget.turns,
                wallClockMs: request.budget.budgetMs,
                workDir: dependencies.session.artifactsDir,
                logger,
                signal: request.signal,
                usageCollector: dependencies.usageCollector,
            });

            const completed = outcome.kind === SealKind.Terminal;
            const failedDetail =
                completed && outcome.payload.status === ApplicationTerminalStatus.Failed
                    ? outcome.payload.detail
                    : undefined;
            return {
                completed,
                ...(failedDetail === undefined ? {} : { detail: failedDetail }),
                actionLog: recordedActionLog(),
            };
        },
    };
}
