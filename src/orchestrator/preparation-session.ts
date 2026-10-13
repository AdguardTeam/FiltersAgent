/**
 * The preparation stage as a short-lived mode session.
 *
 * When the run instruction carries a `## Preparation` section, the host performs nothing — the
 * model performs the blocker steps in this one session, bounded to the two step tools of
 * `preparation-tools.ts` and sealed by the `finish_preparation` terminal. The session reuses the
 * shared launch procedure (`launchModeSession`) with the same recorder and usage collector the fix
 * run already owns, so every preparation turn lands in the run trace; the trace is deliberately
 * left unsealed, because the fix run that follows owns the seal.
 *
 * The step-failure latch is the phase's verdict mechanism: a first non-zero (or timed-out) step
 * latches the shared gate, the two step tools refuse everything afterwards, a `done` payload is
 * rejected with user-shaped guidance while the latch holds, and the only accepted payload is
 * `status: failed`. The wall-clock budget `PREPARATION_PHASE_BUDGET_MS` bounds the whole phase; a
 * budget that expires seals the phase as the typed failed status with the guard's detail.
 */
import * as v from 'valibot';
import { resolve } from 'node:path';
import { TOOL_GUIDANCE } from '../agent/tool-catalog';
import {
    ExtensionLaunchFamily,
    FIREFOX_USER_FILTERS_KEY_PATH_MAX,
    type FirefoxExtensionLaunch,
} from '../environment/extension-launch';
import { ToolName } from '../agent/tool-names';
import type { LlmConfig } from '../config/config';
import { createLogger, type Logger } from '../logger/logger';
import type { PiRuntime } from '../pi/runtime';
import { SealKind, type TerminalOutcome } from '../pi/seal-types';
import type { SessionToolSpec } from '../pi/session-tool-types';
import { buildTerminalTool, type TerminalToolController } from '../pi/terminal-tool';
import { adaptSessionTools } from '../pi/session-tools';
import type { RunUsageCollector } from '../pi/usage-collector';
import { launchModeSession } from '../session/mode-session';
import { PromptDocumentName } from '../prompts/prompt-documents';
import { recordTerminalTool, sealDetail, withExecutionRecording } from '../tracer/session-trace';
import type { TraceRecorder } from '../tracer/trace-recorder';
import {
    PREPARATION_MANAGED_STORAGE_MAX_LENGTH,
    readPreparationLaunchDeclaration,
} from './preparation-launch-declaration';
import {
    buildPreparationStepFailureGate,
    buildPreparationTools,
    type PreparationStepFailureGate,
} from './preparation-tools';

/**
 * Terminal payload kinds of the preparation session.
 */
export const PreparationTerminalStatus = {
    /**
     * Every step exited 0 and the extension directory is named in the payload.
     */
    Done: 'done',

    /**
     * A step failed; nothing further was attempted.
     */
    Failed: 'failed',
} as const;

/**
 * PreparationTerminalStatus value.
 */
export type PreparationTerminalStatus =
    (typeof PreparationTerminalStatus)[keyof typeof PreparationTerminalStatus];

/**
 * Every PreparationTerminalStatus value, for the schema.
 */
export const PREPARATION_TERMINAL_STATUS_VALUES = Object.values(PreparationTerminalStatus);

/**
 * Wall-clock budget of the whole preparation phase in milliseconds.
 *
 * Why this value: preparation is a prefix of the run, not an investigation — the instruction's
 * blocker steps are short. Fifteen minutes stays far under the run's one-hour investigation budget,
 * so a preparation loop that cannot converge loses its share, not the run's; it must remain
 * comfortably above the per-command bound so a slow-but-real build (one clone, one install, one
 * zip) fits without a cascade of per-command timeouts. Overridable by the caller, which is what
 * tests exercise; production never passes the override.
 */
export const PREPARATION_PHASE_BUDGET_MS = 15 * 60_000;

/**
 * Turn cap of the preparation session.
 *
 * Why this value: the section's steps are enumerated in the instruction itself, so a well-formed
 * session spends roughly one turn per step plus the terminal; twelve doubles that, which is enough
 * headroom for multi-command builds, while an unbounded turn loop would wait for the wall-clock
 * budget instead of failing named here.
 */
export const PREPARATION_MAX_TURNS = 12;

/**
 * Length ceiling of the terminal payload's relative-path and text fields.
 *
 * Why this value: the payload carries working-directory-relative names and short arrow text, not
 * artifacts; 1024 covers any real relative path many times over while keeping a hallucinated inline
 * build dump out of a terminal field.
 */
const PREPARATION_TERMINAL_FIELD_MAX_LENGTH = 1_024;

/**
 * Length ceiling of the failing-command text field, which may name one argv line.
 */
const PREPARATION_TERMINAL_COMMAND_MAX_LENGTH = 2_000;

/**
 * The preparation session's terminal payload: the done/failed seal over the section's steps.
 *
 * `extensionDir` is required in effect for a `done` payload of the Chromium family — the core's
 * wiring rejects a done payload without a resolvable, existing directory — but stays optional in
 * the schema so a missing directory is the core's typed run failure naming it, not a schema bounce
 * the model retries. The Firefox-family fields are optional for the same reason and for one more:
 * the terminal's own host validation refuses an incomplete Firefox declaration by name, with
 * guidance the model can act on inside its session.
 */
export const PreparationTerminalSchema = v.strictObject({
    status: v.picklist(PREPARATION_TERMINAL_STATUS_VALUES),
    extensionDir: v.optional(
        v.pipe(v.string(), v.minLength(1), v.maxLength(PREPARATION_TERMINAL_FIELD_MAX_LENGTH)),
    ),
    launchFamily: v.optional(
        v.pipe(v.string(), v.minLength(1), v.maxLength(PREPARATION_TERMINAL_FIELD_MAX_LENGTH)),
    ),
    extensionId: v.optional(
        v.pipe(v.string(), v.minLength(1), v.maxLength(PREPARATION_TERMINAL_FIELD_MAX_LENGTH)),
    ),
    xpiPath: v.optional(
        v.pipe(v.string(), v.minLength(1), v.maxLength(PREPARATION_TERMINAL_FIELD_MAX_LENGTH)),
    ),
    managedStorage: v.optional(
        v.pipe(v.string(), v.minLength(1), v.maxLength(PREPARATION_MANAGED_STORAGE_MAX_LENGTH)),
    ),
    userFiltersKeyPath: v.optional(
        v.pipe(
            v.array(
                v.pipe(
                    v.string(),
                    v.minLength(1),
                    v.maxLength(PREPARATION_TERMINAL_FIELD_MAX_LENGTH),
                ),
            ),
            v.maxLength(FIREFOX_USER_FILTERS_KEY_PATH_MAX),
        ),
    ),
    failedCommand: v.optional(
        v.pipe(v.string(), v.minLength(1), v.maxLength(PREPARATION_TERMINAL_COMMAND_MAX_LENGTH)),
    ),
    failedOutputSha: v.optional(
        v.pipe(v.string(), v.minLength(1), v.maxLength(PREPARATION_TERMINAL_COMMAND_MAX_LENGTH)),
    ),
});

/**
 * PreparationTerminal — the validated terminal payload as the session sees it.
 */
export type PreparationTerminal = v.InferOutput<typeof PreparationTerminalSchema>;

/**
 * What one preparation session needs, beyond the mode-session invariants it shares.
 */
export interface PreparationSessionOptions {
    /**
     * The run's already-built pi runtime.
     */
    runtime: PiRuntime;

    /**
     * The validated LLM provider configuration the request bounds and retries map from.
     */
    llm: LlmConfig;

    /**
     * The run's trace recorder, shared with the fix session.
     */
    recorder: TraceRecorder;

    /**
     * Directory the two step tools run and write inside; already created by the caller.
     */
    workDir: string;

    /**
     * The run instruction's `## Preparation` section body, verbatim.
     */
    preparationSection: string;

    /**
     * Wall-clock budget override; defaults to {@link PREPARATION_PHASE_BUDGET_MS}. Production
     * passes nothing; tests exercise the bound with a small value.
     */
    wallClockMs?: number;

    /**
     * Turn-cap override; defaults to {@link PREPARATION_MAX_TURNS}.
     */
    maxTurns?: number;

    /**
     * Caller cancellation.
     */
    signal?: AbortSignal;

    /**
     * Application logger, forwarded into the launch procedure.
     */
    logger?: Logger;

    /**
     * Run-scoped usage collector, shared with the fix session.
     */
    usageCollector?: RunUsageCollector;

    /**
     * Parent environment the filtered subprocess environment is built from. Defaults to
     * `process.env`; hermetic tests pass a deliberately secret-bearing environment to prove the
     * filtering.
     */
    sourceEnvironment?: NodeJS.ProcessEnv;
}

/**
 * How one preparation phase ended.
 */
export interface PreparationSessionResult {
    /**
     * Typed end status: `done` with a resolvable extension directory, or the typed failure.
     */
    status: PreparationTerminalStatus;

    /**
     * The absolute workdir the two step tools ran and wrote inside.
     */
    workDir: string;

    /**
     * Absolute path of the payload-named extension directory, resolved inside this result's
     * {@link PreparationSessionResult.workDir}; present only for accepted done payloads of the
     * Chromium family.
     */
    extensionDir?: string;

    /**
     * The validated Firefox launch declaration with its XPI path resolved absolute, for an accepted
     * done payload that declared the Firefox family; absent for the Chromium family.
     */
    firefoxLaunch?: FirefoxExtensionLaunch;

    /**
     * The failing command of the latched first failure, or the payload's own record.
     */
    failedCommand?: string;

    /**
     * The payload's failed-output digest, when the model supplied one.
     */
    failedOutputSha?: string;

    /**
     * Why the phase ended without an accepted payload, when it did.
     */
    detail?: string;
}

/**
 * Build the preparation terminal tool with the shared step-failure latch as its host hook.
 *
 * @param gate - The latch the two step tools and this terminal share.
 * @param recorder - The run trace recorder.
 * @param workDir - Absolute workdir a declared relative XPI path resolves against.
 * @returns The trace-wrapped terminal controller.
 */
function buildPreparationTerminal(
    gate: PreparationStepFailureGate,
    recorder: TraceRecorder,
    workDir: string,
): TerminalToolController<PreparationTerminal> {
    return recordTerminalTool(
        buildTerminalTool<PreparationTerminal>({
            name: ToolName.FinishPreparation,
            description: TOOL_GUIDANCE[ToolName.FinishPreparation]!,
            schema: PreparationTerminalSchema,
            validateHost: (payload) => {
                const latched = gate.refusalFor();
                if (payload.status === PreparationTerminalStatus.Done && latched !== undefined) {
                    return {
                        reason:
                            `A failed preparation step is latched (${
                                gate.failedCommand() ?? 'the failing step'
                            }); the only accepted payload is status failed naming the failing ` +
                            'command. Do not submit a done payload.',
                        fingerprint: 'preparation-step-failed-latched',
                    };
                }
                if (payload.status !== PreparationTerminalStatus.Done) {
                    return undefined;
                }
                // The launch declaration is validated inside the session, so a malformed one is a
                // refusal the model can act on rather than a typed run failure after the seal.
                const declaration = readPreparationLaunchDeclaration(payload, workDir);
                if ('reason' in declaration) {
                    return {
                        reason: declaration.reason,
                        fingerprint: 'preparation-launch-declaration-unusable',
                    };
                }
                return undefined;
            },
        }),
        recorder,
    );
}

/**
 * Map one sealed outcome onto the preparation result.
 *
 * @param outcome - The sealed pi outcome of the preparation session.
 * @param gate - The shared step-failure latch.
 * @param workDir - Absolute workdir the session ran in.
 * @returns A done payload becomes `done` with the resolved absolute extension directory, or with
 *   the validated Firefox launch declaration when it named that family; anything else is the typed
 *   failed status carrying the failing command from payload or latch plus the seal detail.
 */
function preparationResultFrom(
    outcome: TerminalOutcome<PreparationTerminal>,
    gate: PreparationStepFailureGate,
    workDir: string,
): PreparationSessionResult {
    if (outcome.kind === SealKind.Terminal) {
        const payload = outcome.payload;
        if (payload.status === PreparationTerminalStatus.Done) {
            // One rule for the declaration: the terminal accepted this payload through exactly
            // this read, so a refusal here can only mean the two disagreed — which is a wiring
            // fault the failed status names rather than a shape to guess at.
            const declaration = readPreparationLaunchDeclaration(payload, workDir);
            if ('reason' in declaration) {
                return {
                    status: PreparationTerminalStatus.Failed,
                    workDir,
                    detail:
                        'The accepted preparation payload carries a launch declaration the host ' +
                        `cannot read: ${declaration.reason}`,
                };
            }
            if (declaration.family === ExtensionLaunchFamily.Firefox) {
                return {
                    status: PreparationTerminalStatus.Done,
                    workDir,
                    firefoxLaunch: declaration.launch,
                };
            }
            if (payload.extensionDir) {
                return {
                    status: PreparationTerminalStatus.Done,
                    workDir,
                    extensionDir: resolve(workDir, payload.extensionDir),
                };
            }
        }
        return {
            status: PreparationTerminalStatus.Failed,
            workDir,
            ...(payload.failedCommand === undefined
                ? { failedCommand: gate.failedCommand() }
                : { failedCommand: payload.failedCommand }),
            ...(payload.failedOutputSha === undefined
                ? {}
                : { failedOutputSha: payload.failedOutputSha }),
        };
    }
    return {
        status: PreparationTerminalStatus.Failed,
        workDir,
        failedCommand: gate.failedCommand(),
        detail:
            `Preparation phase ended without an accepted terminal payload ` +
            `(${outcome.kind}): ${sealDetail(outcome)}`,
    };
}

/**
 * Run the preparation stage for one instruction section and leave the run trace unsealed.
 *
 * @param options - Runtime, provider config, recorder, workdir, section body, and bounds.
 * @returns The session result with the typed end status.
 */
export async function runPreparationSession(
    options: PreparationSessionOptions,
): Promise<PreparationSessionResult> {
    const { recorder } = options;
    const logger: Logger = options.logger ?? createLogger();
    const workDir = resolve(options.workDir);
    const gate = buildPreparationStepFailureGate();
    const inputs = buildPreparationTools({
        workDir,
        gate,
        sourceEnvironment: options.sourceEnvironment ?? process.env,
        logger,
    });
    const tools: SessionToolSpec[] = adaptSessionTools(inputs, { guidance: TOOL_GUIDANCE }).map(
        (spec) => withExecutionRecording(spec, recorder),
    );
    const terminal = buildPreparationTerminal(gate, recorder, workDir);
    const { outcome } = await launchModeSession<PreparationTerminal>({
        runtime: options.runtime,
        llm: options.llm,
        recorder,
        terminalToolName: ToolName.FinishPreparation,
        renderTask: (prompts, terminalToolName) =>
            prompts.render(PromptDocumentName.PreparationTask, {
                workDir,
                preparationSection: options.preparationSection,
                terminalToolName,
            }),
        terminal,
        tools,
        maxTurns: options.maxTurns ?? PREPARATION_MAX_TURNS,
        wallClockMs: options.wallClockMs ?? PREPARATION_PHASE_BUDGET_MS,
        workDir,
        logger,
        signal: options.signal,
        usageCollector: options.usageCollector,
    });
    return preparationResultFrom(outcome, gate, workDir);
}
