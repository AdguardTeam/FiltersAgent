/**
 * The file-backed arm of the between-phases application flow, and the projection both arms map
 * their result through.
 *
 * When the run's prepared build is a Firefox-family one, the application is the host's own work —
 * it writes the declared file, rebuilds the enterprise policies, relaunches the session and reads
 * the file back (`file-backed-application.ts`). No model session runs, so none of the AdGuard
 * route's session pieces (the options-page surface, the settings payload, the live-extension read)
 * are built for it. This module is that arm plus the one mapping from an application result onto
 * the environment's configuration seam, shared with the model-driven arm in
 * `phase-application-flow.ts`.
 */
import type { IBrowserSession } from '../browser/browser-interfaces';
import {
    EnvironmentPhaseConfigurationOutcome,
    type EnvironmentPhaseConfigurationRequest,
    type EnvironmentPhaseConfigurationResult,
} from '../environment/browser-extension-environment';
import type { BlockerVerificationMethod } from '../environment/environment-proofs';
import { ExtensionLaunchFamily } from '../environment/extension-launch';
import { ApplicationInstructionGap } from '../environment/application-instruction-gap';
import { createLogger } from '../logger/logger';
import {
    PhaseApplicationOutcomeKind,
    type ApplicationGoal,
    type PhaseApplicationResult,
} from '../validator/phase-application-contract';
import type { AgentRuntimeSessionState } from './agent-runtime-session-evidence';
import { runFileBackedApplication } from './file-backed-application';
import type {
    PhaseApplicationFlowHost,
    RuntimeApplicationOutcome,
} from './phase-application-flow-host';

/**
 * Project one application result onto the environment's between-phases configuration seam.
 *
 * @param result - The application result as the procedure credited it.
 * @param method - The verification method whose read-back produced it.
 * @param session - The session that is live now, when the application replaced the one it was
 *   handed; the environment observes the phase over it and closes it.
 * @returns The configuration result the adapter and the launch gate consume.
 */
export function projectApplicationResult(
    result: PhaseApplicationResult,
    method: BlockerVerificationMethod,
    session?: IBrowserSession,
): EnvironmentPhaseConfigurationResult {
    if (result.kind === PhaseApplicationOutcomeKind.Applied) {
        return {
            kind: EnvironmentPhaseConfigurationOutcome.Applied,
            method,
            readBack: result.readBack,
            actionLog: result.actionLog,
            ...(result.detail === undefined ? {} : { detail: result.detail }),
            ...(session === undefined ? {} : { session }),
        };
    }
    if (result.kind === PhaseApplicationOutcomeKind.Refused) {
        return {
            kind: EnvironmentPhaseConfigurationOutcome.Refused,
            gap: result.gap,
            detail: result.detail,
        };
    }
    return {
        kind: EnvironmentPhaseConfigurationOutcome.Unverified,
        detail: result.detail,
        ...(result.settingsLimitation === undefined
            ? {}
            : { settingsLimitation: result.settingsLimitation }),
        ...(session === undefined ? {} : { session }),
    };
}

/**
 * Run one phase's application on the host, for a Firefox-family prepared build.
 *
 * The Firefox family has exactly one state channel: the file the instruction declares, whose
 * content the enterprise policies carry into the extension's managed storage. A Firefox run that
 * declares any other verification method is refused here rather than answered with a guess —
 * `moz-extension://` pages cannot be driven, so the live-extension read has no Firefox equivalent.
 *
 * @param host - The runtime seam this flow acts through, supplying the relaunch.
 * @param state - Prepared active session naming this run's Firefox launch declaration.
 * @param request - Application inputs: phase, target, instruction, and the caller's cancellation.
 * @param goal - The expected blocker state the host read-back is credited against.
 * @param session - The established phase session the relaunch replaces.
 * @param method - The declared verification method.
 * @param targetPath - Absolute declared file path, already resolved and contained, or null when the
 *   instruction declared no file-backed target at all.
 * @returns The mapped configuration result; no extension state read exists on this route.
 */
export async function runFirefoxFileBackedApplication(
    host: PhaseApplicationFlowHost,
    state: AgentRuntimeSessionState,
    request: EnvironmentPhaseConfigurationRequest,
    goal: ApplicationGoal,
    session: IBrowserSession,
    method: BlockerVerificationMethod,
    targetPath: string | null,
): Promise<RuntimeApplicationOutcome> {
    const logger = createLogger({ verbose: host.verbose });
    const launch = state.extension;
    if (launch === undefined || launch.launchFamily !== ExtensionLaunchFamily.Firefox) {
        throw new Error(
            'The Firefox file-backed application arm was entered without a Firefox-family ' +
                'prepared extension; the launch wiring and this arm disagree.',
        );
    }
    if (targetPath === null) {
        const detail =
            `The state verification declares method "${method}", which the Firefox family ` +
            'supplies no reader for: moz-extension pages cannot be driven, so the declared ' +
            'user-filters file is the only state this run can read back.';
        logger.warn({ method, phase: request.phase }, 'the Firefox route cannot read this method');
        return {
            result: {
                kind: EnvironmentPhaseConfigurationOutcome.Refused,
                gap: ApplicationInstructionGap.VerificationMethodUnsupported,
                detail,
            },
        };
    }
    if (request.signal?.aborted ?? false) {
        // The launch tool already answered the model with its deadline result; a late write and
        // relaunch must not run behind it.
        return {
            result: {
                kind: EnvironmentPhaseConfigurationOutcome.Unverified,
                detail:
                    'The phase deadline aborted before the host could apply the declared ' +
                    'file-backed state.',
            },
        };
    }
    logger.info(
        {
            phase: request.phase,
            goal: goal.kind,
            method,
            targetPath,
            extensionId: launch.extensionId,
        },
        'the host performs this phase application itself: write, rebuild policies, relaunch, read',
    );
    const outcome = await runFileBackedApplication({
        goal,
        method,
        targetPath,
        launch,
        session,
        reproProfile: state.profile,
        relaunch: host.relaunchPolicySession,
        logger,
    });
    return { result: projectApplicationResult(outcome.result, method, outcome.session) };
}
