import type { BrowserContext } from 'playwright-core';
import type { AdGuardExtensionStateRead } from '../browser/adguard-extension-state-shapes';
import type { readAdGuardExtensionState as readAdGuardExtensionStateDefault } from '../browser/adguard-extension-state-read';
import type { allowUserScripts as allowUserScriptsDefault } from '../browser/chrome-user-scripts-toggle';
import type { findExtensionRuntime as findExtensionRuntimeDefault } from '../browser/extension-runtime-location';
import type { IBrowserSession } from '../browser/browser-interfaces';
import type { LoopbackTextServer } from '../local/loopback-text-server';
import type { EnvironmentPhaseConfigurationResult } from '../environment/browser-extension-environment';
import { PromptDocumentName, createPromptDocumentLoader } from '../prompts/prompt-documents';
import { ApplicationRoute } from '../knowledge/instruction-application-route';
import type { LoadedInstruction } from '../knowledge/instruction-loader';
import type { LlmConfig } from '../config/config';
import type { PiRuntime } from '../pi/runtime';
import type { RunUsageCollector } from '../pi/usage-collector';
import type { Logger } from '../logger/logger';
import type { BlockerStateRead } from '../validator/blocker-state-readers';
import type { PhaseApplicationRunner } from '../validator/phase-application-contract';
import type { TraceRecorder } from '../tracer/trace-recorder';
import type { PolicySessionRelaunch } from '../browser/prepared-extension-launch';

/**
 * The host and dependency contracts `phase-application-flow.ts`'s `runApplication` acts through:
 * what the caller must supply (the run's leaf options and dependency overrides, narrowed to exactly
 * what the flow needs) and what one application call returns. Declared once here so the flow module
 * stays focused on the procedure itself.
 */

/**
 * Dependencies of one injected `PhaseApplicationModelRunnerFactory` call.
 */
export interface PhaseApplicationModelRunnerDependencies {
    /**
     * The run's pi runtime, when already built.
     */
    runtime?: PiRuntime;

    /**
     * The run's validated LLM configuration, when carried.
     */
    llm?: LlmConfig;

    /**
     * Run trace recorder every application turn lands in.
     */
    recorder: TraceRecorder;

    /**
     * The session whose page the application tools act on.
     */
    session: IBrowserSession;

    /**
     * Canonical reported origin for the read tools' network inventory.
     */
    allowedOrigin: string;

    /**
     * Application logger.
     */
    logger?: Logger;

    /**
     * The run's usage collector, when the caller supplied one: the application session's usage
     * lands in the same summary as every other session of the run.
     */
    usageCollector?: RunUsageCollector;
}

/**
 * Factory for the bounded application-session runner behind a model-driven application.
 *
 * Only the model-driven path builds one: an instruction that writes its own `## Rule application`
 * steps. The built-in AdGuard route performs its application on the host in code and never reaches
 * this factory at all.
 *
 * Defaults to the shared pi mode-session runner, which requires the run's pi runtime and LLM
 * configuration; an injected factory (tests) may close over its own inputs and receives whatever
 * the run carries, so the model-driven application procedure is observable without a model.
 *
 * @param depends - The run's pi runtime, LLM configuration, recorder, lease session, origin, and
 *   usage collector.
 * @returns The bounded application-session runner.
 */
export type PhaseApplicationModelRunnerFactory = (
    depends: PhaseApplicationModelRunnerDependencies,
) => PhaseApplicationRunner;

/**
 * What a launch that runs a list slice needs from the run beyond the application flow: somewhere to
 * serve the slice's text from, and the Chromium toggle without which the build runs no custom
 * filter.
 */
export interface ListSliceLaunchSupport {
    /**
     * The run's loopback text server, created on first use and living for the run: the extension
     * may re-download a custom filter after the launch.
     */
    textServer: () => Promise<LoopbackTextServer>;

    /**
     * Turn Chromium's "Allow User Scripts" on for the prepared extension; tests inject one.
     */
    allowUserScripts: typeof allowUserScriptsDefault;
}

/**
 * The runtime seam the between-phases application flow acts through: the run's leaf options and
 * dependency overrides, narrowed to exactly what this flow needs.
 */
export interface PhaseApplicationFlowHost {
    /**
     * The run's host-state root a declared file-backed verification target resolves against: a
     * run-owned directory outside the repository checkout, so the file the host maintains there is
     * invisible to every walk of the checkout.
     */
    hostStateRoot: string;

    /**
     * Persistent browser contexts registered per lease session for the extension-state read-back.
     * Shared by reference with the runtime's own phase-session bootstrap, so a context registered
     * there is visible here without a getter/setter round trip.
     */
    applicationReadContexts: WeakMap<IBrowserSession, BrowserContext>;

    /**
     * Validated LLM provider configuration the bounded application sessions are launched with.
     */
    llm: LlmConfig;

    /**
     * The run's pi runtime reused for the bounded application sessions.
     */
    piRuntime: PiRuntime;

    /**
     * Run trace recorder every application turn lands in.
     */
    recorder: TraceRecorder;

    /**
     * Run-scoped usage collector shared with every model session of the run, when the run carries
     * one.
     */
    usageCollector?: RunUsageCollector;

    /**
     * Whether verbose lifecycle logging is enabled.
     */
    verbose: boolean;

    /**
     * The run instruction loaded at run start, when this run carries one. A run without one applies
     * the built-in AdGuard instruction.
     */
    instruction?: LoadedInstruction;

    /**
     * Wall-clock budget override for the bounded extension-state readiness waits.
     */
    phaseReadinessBudgetMs?: number;

    /**
     * Relaunch one phase session with rebuilt Firefox enterprise policies.
     *
     * The host-performed file-backed application writes the declared file and then needs a browser
     * that reads the rebuilt policies, which Firefox does only at startup. The runtime implements
     * this over the same session factory every other session of the run uses, so a test drives the
     * relaunch through its own injected factory.
     */
    relaunchPolicySession: PolicySessionRelaunch;

    /**
     * Injected application-session runner factory (tests); defaults to the shared pi mode-session
     * runner when absent. Consulted only on the model-driven path — a run on the built-in AdGuard
     * route performs its application on the host and never builds a session runner.
     */
    createPhaseApplicationModelRunner?: PhaseApplicationModelRunnerFactory;

    /**
     * Injected extension-runtime locator (tests); defaults to the production search.
     */
    findExtensionRuntime?: typeof findExtensionRuntimeDefault;

    /**
     * Injected extension-state reader (tests); defaults to the production message-transport read.
     */
    readAdGuardExtensionState?: typeof readAdGuardExtensionStateDefault;

    /**
     * What a launch with `settings.slice` acts through beyond this flow: the run's text server and
     * the Chromium toggle. Only the launch-time Baseline reads it.
     */
    listSlice: ListSliceLaunchSupport;
}

/**
 * The shipped document each declarable application route applies through.
 *
 * Total over {@link ApplicationRoute}, so adding a route without shipping its document is a compile
 * error rather than a run that silently applies the wrong one.
 */
const APPLICATION_ROUTE_DOCUMENTS: Record<ApplicationRoute, PromptDocumentName> = {
    [ApplicationRoute.AdguardExtension]: PromptDocumentName.InstructionsAdguardExtension,
};

/**
 * The application contract in force for one run: either a built-in route, or the instruction's own
 * hand-written sections.
 */
type ApplicationContractInForce =
    | {
          /**
           * The built-in route whose shipped document the run applies through.
           */
          route: ApplicationRoute;
      }
    | {
          /**
           * The instruction text whose own `## Rule application` and `## State verification`
           * sections the run applies through.
           */
          ownContent: string;
      };

/**
 * Resolve which application contract one run applies through.
 *
 * A run carrying an instruction that writes its own application contract applies exactly that
 * instruction. An instruction that instead declares a built-in route with `application:` — the
 * shape a repository takes when it only wants to link its own guidance documents — applies that
 * route, and so does a run with no instruction at all: the built-in AdGuard route.
 *
 * This is the single resolution behind both {@link applicationInstructionContent} and
 * {@link hostPerformsApplication}, so the document a run applies through and who performs it can
 * never disagree.
 *
 * @param instruction - The run instruction loaded at run start, when this run carries one.
 * @returns The built-in route in force, or the instruction's own contract text.
 */
function resolveApplicationContract(
    instruction: LoadedInstruction | undefined,
): ApplicationContractInForce {
    if (instruction !== undefined && instruction.applicationRoute === undefined) {
        return { ownContent: instruction.content };
    }
    return { route: instruction?.applicationRoute ?? ApplicationRoute.AdguardExtension };
}

/**
 * The application instruction whose contract every between-phases application performs.
 *
 * @param instruction - The run instruction loaded at run start, when this run carries one.
 * @returns The run's application instruction content.
 */
export function applicationInstructionContent(instruction: LoadedInstruction | undefined): string {
    const contract = resolveApplicationContract(instruction);
    return 'ownContent' in contract
        ? contract.ownContent
        : createPromptDocumentLoader().read(APPLICATION_ROUTE_DOCUMENTS[contract.route]);
}

/**
 * Whether the host performs this run's application itself instead of starting a model session.
 *
 * The built-in AdGuard route's steps are a fixed message protocol, not a judgement: the host sends
 * them in code (`host-extension-application.ts`), so an application costs seconds rather than the
 * five to eight minutes a model paced at 20-50 seconds a turn spent on the same enumerated steps.
 * An instruction that writes its own `## Rule application` keeps the model-driven path — other
 * blockers have their own way to add a rule, and the model follows whatever the instruction wrote.
 *
 * @param instruction - The run instruction loaded at run start, when this run carries one.
 * @returns True when the contract in force is the built-in AdGuard route.
 */
export function hostPerformsApplication(instruction: LoadedInstruction | undefined): boolean {
    const contract = resolveApplicationContract(instruction);
    return 'route' in contract && contract.route === ApplicationRoute.AdguardExtension;
}

/**
 * One application run's outcome: the adapter-seam result plus the host's full state read.
 */
export interface RuntimeApplicationOutcome {
    /**
     * The mapped configuration result the adapter seam and the launch gate consume.
     */
    result: EnvironmentPhaseConfigurationResult;

    /**
     * The complete blocker state the host read back itself, when a read ran.
     */
    stateRead?: AdGuardExtensionStateRead;
}

/**
 * One read-back call of a between-phases application: the host's full state read plus the enriched
 * read the procedure compares against.
 */
export interface EnvironmentBlockerStateCapture {
    /**
     * The complete extension state as the state read reported it.
     */
    stateRead: AdGuardExtensionStateRead;

    /**
     * The enriched read mapped onto the phase-credit shape, MV3 counters included.
     */
    enriched: BlockerStateRead;
}
