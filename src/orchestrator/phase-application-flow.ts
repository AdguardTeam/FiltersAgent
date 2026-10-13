import type {
    AdGuardExtensionOptionsData,
    AdGuardExtensionStateRead,
} from '../browser/adguard-extension-state-shapes';
import type { IBrowserSession } from '../browser/browser-interfaces';
import {
    EnvironmentPhaseConfigurationOutcome,
    type EnvironmentPhaseConfigurationRequest,
} from '../environment/browser-extension-environment';
import { BlockerVerificationMethod } from '../environment/environment-proofs';
import { ExtensionLaunchFamily } from '../environment/extension-launch';
import { parseAdguardListKey } from '../environment/filter-list-ref';
import { createLogger } from '../logger/logger';
import { parseRuleApplication } from '../knowledge/instruction-application';
import { createPhaseApplicationModelRunner as buildPhaseApplicationModelRunner } from './application-session';
import { createHostExtensionApplicationRunner } from './host-extension-application';
import type {
    ApplicationGoal,
    PhaseApplicationRunner,
} from '../validator/phase-application-contract';
import { runPhaseApplication } from '../validator/phase-application-procedure';
import {
    fileBlockerStateReader,
    type BlockerStateReader,
} from '../validator/blocker-state-readers';
import type { AgentRuntimeSessionState } from './agent-runtime-session-evidence';
import { resolveBlockerFileTarget } from './blocker-file-target';
import {
    projectApplicationResult,
    runFirefoxFileBackedApplication,
} from './phase-application-file-backed';
import {
    applicationFiltersMetadata,
    buildExtensionSettingsPayloadOverDedicatedPage,
    preparedBlockerSurfaceUrl,
    readExtensionBlockerState,
} from './phase-application-extension-surface';
import {
    canonicalPhaseApplicationOrigin,
    expectedStealthEnabledFor,
    requiredExtensionGroupIds,
} from './phase-application-wiring';
import { PhaseLabel } from '../types/validation';
import {
    hostPerformsApplication,
    type PhaseApplicationFlowHost,
    type PhaseApplicationModelRunnerDependencies,
    type RuntimeApplicationOutcome,
} from './phase-application-flow-host';

/**
 * The between-phases application procedure: bring the blocker to the prepared state over a lease
 * session, then read the blocker state back and map the result onto the adapter's configuration
 * seam.
 *
 * Who performs the steps follows the run's application route, never the blocker's name: the
 * built-in AdGuard route (a run with no instruction, or one declaring `application:
 * adguard-extension`) is performed by the host itself in code (`host-extension-application.ts`),
 * while an instruction that writes its own `## Rule application` gets the bounded model session
 * (`application-session.ts`) — other blockers have their own simple way to add a rule and the model
 * uses the one the instruction wrote. Both decisions come out of one resolution,
 * `phase-application-flow-host.ts`'s `hostPerformsApplication`, which the document fill
 * `applicationInstructionContent` is derived from too, so the contract in force and its performer
 * can never disagree.
 *
 * This module owns the application flow (`runApplication` through the runner and read-back helpers
 * it composes), taking its runtime dependencies as an explicit host object instead of `this`, so
 * the flow is callable — and testable — without the whole runtime class.
 * `phase-application-flow-host.ts` declares the host and dependency contracts this flow acts
 * through and the shape one application call returns; `phase-application-extension-surface.ts` owns
 * the host's own dealings with the prepared extension's management surface.
 * `phase-application-launch.ts` builds on this module for the launch-time Baseline application;
 * none of these modules imports `agent-runtime.ts`, so the dependency runs one way only.
 */

/**
 * Refuse a blocker read-back whose application was already aborted.
 *
 * The abort means the launch tool already answered the model with its deadline result; the late
 * read-back must not run, and the application procedure logs the thrown error and seals the
 * application unverified instead of crediting a state the model was told had failed.
 *
 * @param request - The phase-configuration request carrying the caller's cancellation.
 * @throws Error naming the aborted read-back.
 */
function assertApplicationNotAborted(request: EnvironmentPhaseConfigurationRequest): void {
    if (request.signal?.aborted) {
        throw new Error(
            'The application session was aborted before the blocker state read-back; the ' +
                'late read-back is discarded.',
        );
    }
}

/**
 * Build the bounded application-session runner for one configuration call, or undefined when the
 * request's deadline already aborted.
 *
 * Reached only on the model-driven path: a run on the built-in AdGuard route performs its
 * application on the host and never constructs a session runner, so an injected factory is never
 * called for it either.
 *
 * @param host - The runtime seam this flow acts through.
 * @param session - The lease session the runner acts on.
 * @param request - The phase-configuration request carrying cancellation.
 * @returns The model runner, or undefined when the request was already aborted (a test's injected
 *   factory may still decline for its own reason).
 */
function phaseApplicationModelRunner(
    host: PhaseApplicationFlowHost,
    session: IBrowserSession,
    request: EnvironmentPhaseConfigurationRequest,
): PhaseApplicationRunner | undefined {
    const { llm, piRuntime } = host;
    const logger = createLogger({ verbose: host.verbose });
    const depends: PhaseApplicationModelRunnerDependencies = {
        runtime: piRuntime,
        llm,
        recorder: host.recorder,
        session,
        allowedOrigin: canonicalPhaseApplicationOrigin(request.targetUrl),
        logger,
        usageCollector: host.usageCollector,
    };
    if (host.createPhaseApplicationModelRunner) {
        return host.createPhaseApplicationModelRunner(depends);
    }
    if (request.signal?.aborted ?? false) {
        return undefined;
    }
    return buildPhaseApplicationModelRunner({
        runtime: piRuntime,
        llm,
        recorder: host.recorder,
        session,
        allowedOrigin: canonicalPhaseApplicationOrigin(request.targetUrl),
        logger,
        usageCollector: host.usageCollector,
    });
}

/**
 * Render the session-notes fill one application session performs toward.
 *
 * The notes state the boundary truthfully: the launch applies nothing, so this application session
 * is what brings the blocker to the prepared state. Only a model-driven session reads them; the
 * host-performed runner follows the protocol in code.
 *
 * @param request - The phase-configuration request naming the phase and the prepared set.
 * @returns Bounded caller notes naming the prepared filter set and the application boundary.
 */
function phaseApplicationNotes(request: EnvironmentPhaseConfigurationRequest): string {
    const prepared = `Prepared filter lists: ${[...request.baselineEnabledFilterIds].join(', ')}`;
    if (request.phase === PhaseLabel.C) {
        return (
            `${prepared}. The candidate rule is the only user rule allowed in the credited ` +
            'state: add it exactly as written and keep the prepared filter set enabled.'
        );
    }
    return (
        `${prepared}. This application session brings the blocker to the prepared state: the ` +
        'launch applies nothing, so plug the prepared baseline back exactly, changing nothing ' +
        'else, and keep no user rule.'
    );
}

/**
 * Settle one application call before any step runs, with the bounded reason.
 *
 * @param detail - Why nothing could be applied.
 * @returns The unverified configuration outcome.
 */
function unverifiedBeforeApplication(detail: string): RuntimeApplicationOutcome {
    return { result: { kind: EnvironmentPhaseConfigurationOutcome.Unverified, detail } };
}

/**
 * Run one application pass: the route's runner over a session, then the host read-back.
 *
 * @param host - The runtime seam this flow acts through.
 * @param state - Prepared active session supplying the run's settings context.
 * @param request - Application inputs: phase, target, instruction, and the prepared set.
 * @param goal - The expected blocker state the host read-back is credited against.
 * @param session - The session the application acts over.
 * @param expectedStealthEnabledOverride - Exact Tracking-protection state the prepared expectation
 *   requires; the launch pre-read supplies it for a defaults-plus-required launch.
 * @param filtersMetadataOverride - The filter catalog (with groups) the settings payload's required
 *   groups are computed from; the launch pre-read supplies it for the very first Baseline
 *   application, before `state.extensionBaselineReadBack` exists to fall back on.
 * @returns The mapped configuration result plus the complete state read, when one ran.
 */
export async function runApplication(
    host: PhaseApplicationFlowHost,
    state: AgentRuntimeSessionState,
    request: EnvironmentPhaseConfigurationRequest,
    goal: ApplicationGoal,
    session: IBrowserSession,
    expectedStealthEnabledOverride?: boolean,
    filtersMetadataOverride?: AdGuardExtensionOptionsData['filtersMetadata'],
): Promise<RuntimeApplicationOutcome> {
    const contract = parseRuleApplication(request.application);
    if ('gap' in contract) {
        return {
            result: {
                kind: EnvironmentPhaseConfigurationOutcome.Refused,
                gap: contract.gap,
                detail: contract.detail,
            },
        };
    }
    // The declared file-backed target resolves once, before any step runs: a relative target that
    // escapes the run's host-state root is a typed refusal here — the target is never read and no
    // application runs — while an absolute target is honored as-is, as part of the instruction's
    // trusted content.
    const declaredFileTarget = contract.verification.target;
    const fileTargetResolution =
        declaredFileTarget === undefined
            ? undefined
            : resolveBlockerFileTarget(host.hostStateRoot, declaredFileTarget);
    if (fileTargetResolution !== undefined && 'gap' in fileTargetResolution) {
        return {
            result: {
                kind: EnvironmentPhaseConfigurationOutcome.Refused,
                gap: fileTargetResolution.gap,
                detail: fileTargetResolution.detail,
            },
        };
    }
    const admittedFileTargetPath: string | null =
        fileTargetResolution !== undefined && 'path' in fileTargetResolution
            ? fileTargetResolution.path
            : null;
    // A Firefox-family build has no unpacked extension to drive and no live state to query: the
    // declared file is its one state channel, and the host maintains it itself.
    // That arm runs before any of the AdGuard route's session pieces are built.
    if (state.extension?.launchFamily === ExtensionLaunchFamily.Firefox) {
        return await runFirefoxFileBackedApplication(
            host,
            state,
            request,
            goal,
            session,
            contract.verification.method,
            admittedFileTargetPath,
        );
    }
    const logger = createLogger({ verbose: host.verbose });
    const readContext = host.applicationReadContexts.get(session);
    if (readContext === undefined) {
        return unverifiedBeforeApplication(
            'The lease session carries no persistent extension context to read the blocker state over.',
        );
    }
    // The route decides the performer, never the blocker's name. On the built-in AdGuard route the
    // steps are a fixed message protocol the host sends itself, so no model runner is constructed at
    // all; an instruction that writes its own steps keeps the bounded session.
    const hostPerformed = hostPerformsApplication(host.instruction);
    if (hostPerformed && (request.signal?.aborted ?? false)) {
        logger.warn(
            { phase: request.phase, goal: goal.kind },
            'the phase deadline aborted before the host could apply the prepared extension state',
        );
        return unverifiedBeforeApplication(
            'The phase deadline aborted before the host could apply the prepared extension state.',
        );
    }
    const modelRunner = hostPerformed
        ? undefined
        : phaseApplicationModelRunner(host, session, request);
    if (!hostPerformed && modelRunner === undefined) {
        // llm/piRuntime are required run options, so a missing model runner here means the
        // request's deadline already aborted before any turn could start.
        return unverifiedBeforeApplication(
            'The application session was aborted before any model turn could start.',
        );
    }
    const expectedStealthEnabled =
        expectedStealthEnabledOverride ??
        expectedStealthEnabledFor(state.settingsProfile, state.extensionBaselineReadBack);
    const blockerSurfaceUrl = await preparedBlockerSurfaceUrl(host, state, readContext);
    let stateRead: AdGuardExtensionStateRead | undefined;
    // The read-back registry lists every method this executor knows how to read, and the
    // application procedure refuses any declared method with no reader before any step runs. The
    // live extension state is the AdGuard route; the file-backed methods read the exact state the
    // instruction's preparation and application steps maintain, with a relative target resolved
    // inside the run's own host-state directory.
    const declaredFileStateReader = fileBlockerStateReader();
    /**
     * Read one declared file-backed blocker state back over the resolved target.
     *
     * A declared file-backed method always carries a target — the parser refuses a declaration
     * without one — and that target was already resolved to `admittedFileTargetPath` before any
     * step ran, with a containment gap refusing the application long before this reader could run.
     * Both are certainties by the time this reader is ever called; a null path here would mean one
     * of those guarantees broke, so it fails loudly instead of guessing a fallback.
     *
     * @param declaration - The parsed verification declaration carrying the method exactly as the
     *   instruction wrote it.
     * @returns The read-back state the phase credit compares against.
     */
    const readResolvedFileState: BlockerStateReader = async (declaration) => {
        assertApplicationNotAborted(request);
        if (admittedFileTargetPath === null) {
            throw new Error(
                `The "${declaration.method}" verification reached its read-back with no ` +
                    'resolved target path; the parser and the containment check both guarantee one.',
            );
        }
        return declaredFileStateReader({
            method: declaration.method,
            target: admittedFileTargetPath,
        });
    };
    // The settings payload is the Extension's own configuration document, whose
    // `filters.enabled-filters` key speaks registry numbers, while the prepared request set speaks
    // list keys. The keys the request carries were built by `adguardListKey`, so a key this runtime
    // cannot name is a wiring fault rather than a state to guess at.
    const preparedRegistryIds = request.baselineEnabledFilterIds.map((key) => {
        const registryId = parseAdguardListKey(key);
        if (registryId === null) {
            throw new Error(
                `The prepared baseline list key "${key}" is not an AdGuard registry key, so the ` +
                    'Extension settings payload cannot be built.',
            );
        }
        return registryId;
    });
    const requiredGroupIds = requiredExtensionGroupIds(
        preparedRegistryIds,
        applicationFiltersMetadata(state, filtersMetadataOverride),
    );
    // Nothing has driven the session's own page yet, so this pre-read cannot depend on where it is.
    // It loads and mutates the export over a dedicated page instead, exactly like every other host
    // read-back of the blocker state (readAdGuardExtensionState/openOptionsPage).
    const settingsPayload =
        blockerSurfaceUrl === undefined
            ? undefined
            : await buildExtensionSettingsPayloadOverDedicatedPage(
                  host,
                  readContext,
                  blockerSurfaceUrl,
                  {
                      enabledFilterIds: preparedRegistryIds,
                      requiredGroupIds,
                      ...(expectedStealthEnabled === undefined
                          ? {}
                          : { stealthEnabled: expectedStealthEnabled }),
                  },
              );
    const runner: PhaseApplicationRunner =
        modelRunner ??
        createHostExtensionApplicationRunner({
            goal,
            expectedFilterIds: preparedRegistryIds,
            context: readContext,
            ...(host.phaseReadinessBudgetMs === undefined
                ? {}
                : { readinessBudgetMs: host.phaseReadinessBudgetMs }),
            logger,
        });
    const result = await runPhaseApplication({
        application: request.application,
        goal,
        session: {
            targetUrl: request.targetUrl,
            ...(blockerSurfaceUrl === undefined ? {} : { blockerSurfaceUrl }),
            baselineEnabledFilterIds: [...request.baselineEnabledFilterIds],
            ...(expectedStealthEnabled === undefined
                ? {}
                : { expectStealthEnabled: expectedStealthEnabled }),
            settingsPayload,
            notes: phaseApplicationNotes(request),
        },
        runner,
        readBack: {
            [BlockerVerificationMethod.ExtensionState]: async () => {
                assertApplicationNotAborted(request);
                const captured = await readExtensionBlockerState(host, state, readContext);
                stateRead = captured.stateRead;
                return captured.enriched;
            },
            [BlockerVerificationMethod.UserRulesFile]: readResolvedFileState,
            [BlockerVerificationMethod.ManagedStorageFile]: readResolvedFileState,
        },
        signal: request.signal,
    });
    return {
        result: projectApplicationResult(result, contract.verification.method),
        ...(stateRead ? { stateRead } : {}),
    };
}
