/**
 * The host-performed file-backed application between two environment phases.
 *
 * For a file-backed verification there is nothing for a model session to do. The state the
 * read-back credits is a file in the run's own host-state directory, which no session knows about,
 * so the host maintains it: write the file (empty for the Baseline goal, exactly the candidate line
 * for the Candidate goal), rebuild the Firefox enterprise policies from the instruction's
 * declaration plus what was just written, relaunch the session — Firefox reads policies only at
 * startup, so a running browser can never pick up new managed storage — and read the file back
 * through the same reader every file-backed verification uses.
 *
 * No prompt, no turn, no model. The credit rules are shared with the model-driven path
 * (`blocker-state-credit.ts`): empty content credits the Baseline, the exact candidate content
 * credits the Candidate, and the proof detail names the file the host wrote and the relaunch it
 * performed.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { IBrowserSession } from '../browser/browser-interfaces';
import {
    buildFirefoxPolicies,
    buildManagedStorageWithUserFilters,
} from '../browser/firefox-policies';
import type { FirefoxPolicies } from '../browser/firefox-policies';
import type { PolicySessionRelaunch } from '../browser/prepared-extension-launch';
import type { ActionLogEntry, BlockerVerificationMethod } from '../environment/environment-proofs';
import type { FirefoxExtensionLaunch } from '../environment/extension-launch';
import { HostApplicationStep } from '../environment/host-application-step';
import { normalizeRulesContent } from '../environment/rules-content';
import type { ReproProfile } from '../types/repro-profile';
import type { Logger } from '../logger/logger';
import { creditBlockerStateRead } from '../validator/blocker-state-credit';
import { fileBlockerStateReader, type BlockerStateRead } from '../validator/blocker-state-readers';
import {
    ApplicationGoalKind,
    PhaseApplicationOutcomeKind,
    type ApplicationGoal,
    type PhaseApplicationResult,
} from '../validator/phase-application-contract';

/**
 * Everything one host-performed file-backed application acts on.
 */
export interface FileBackedApplicationInput {
    /**
     * The expected blocker state the read-back is credited against.
     */
    goal: ApplicationGoal;

    /**
     * The declared verification method, named in every detail this application records.
     */
    method: BlockerVerificationMethod;

    /**
     * Absolute path of the declared user-filters file, already resolved inside the run's host-state
     * root and contained there.
     */
    targetPath: string;

    /**
     * The run's Firefox launch declaration the policies are rebuilt from.
     */
    launch: FirefoxExtensionLaunch;

    /**
     * The running phase session the relaunch replaces.
     */
    session: IBrowserSession;

    /**
     * Reproduction profile the relaunched session must carry, so the replacement observes the
     * target exactly as the session it replaces did.
     */
    reproProfile: ReproProfile;

    /**
     * How the phase session is relaunched with the rebuilt policies.
     */
    relaunch: PolicySessionRelaunch;

    /**
     * Run logger receiving every step and every failure with its caught error.
     */
    logger: Logger;
}

/**
 * Outcome of one host-performed file-backed application.
 */
export interface FileBackedApplicationOutcome {
    /**
     * The application result, credited by the shared credit rule.
     */
    result: PhaseApplicationResult;

    /**
     * The session the relaunch produced, when it got that far; the caller observes the phase over
     * this session from now on and the previous one is already closed.
     */
    session?: IBrowserSession;
}

/**
 * The exact content the declared file must hold for one goal.
 *
 * @param goal - The expected blocker state.
 * @returns Empty content for the Baseline goal, the normalized candidate line for the Candidate.
 */
function fileContentFor(goal: ApplicationGoal): string {
    if (goal.kind === ApplicationGoalKind.Candidate) {
        return `${normalizeRulesContent(goal.rule)}\n`;
    }
    return '';
}

/**
 * Describe one caught failure for both the run log and the bounded result detail.
 *
 * @param error - The caught error.
 * @returns Its message, or the stringified value when something other than an Error was thrown.
 */
function failureMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Perform one file-backed application on the host: write, rebuild, relaunch, read back, credit.
 *
 * @param input - The goal, the declared file and method, the Firefox declaration, the running
 *   session, the relaunch seam and the run logger.
 * @returns The credited result plus the relaunched session, when the relaunch ran.
 */
export async function runFileBackedApplication(
    input: FileBackedApplicationInput,
): Promise<FileBackedApplicationOutcome> {
    const { goal, method, targetPath, launch, logger } = input;
    const actionLog: ActionLogEntry[] = [];
    const content = fileContentFor(goal);
    const ruleLineCount = content.trim().length === 0 ? 0 : content.trim().split('\n').length;

    // The run's host-state directory is the host's own workspace: preparation never sees it, so the
    // host both creates the declared file and maintains it from here on.
    try {
        await mkdir(dirname(targetPath), { recursive: true });
        await writeFile(targetPath, content, 'utf8');
        logger.info(
            { goal: goal.kind, targetPath, ruleLineCount },
            'the host wrote the declared user-filters file for this phase',
        );
        actionLog.push({
            tool: HostApplicationStep.WriteUserFilters,
            ok: true,
            summary: `wrote ${targetPath} with ${ruleLineCount} rule line(s)`,
        });
    } catch (error) {
        logger.error(
            { err: error, goal: goal.kind, targetPath },
            'the host could not write the declared user-filters file',
        );
        actionLog.push({
            tool: HostApplicationStep.WriteUserFilters,
            ok: false,
            summary: `could not write ${targetPath}: ${failureMessage(error)}`,
        });
        return {
            result: {
                kind: PhaseApplicationOutcomeKind.Unverified,
                detail:
                    `The host could not write the declared ${method} target ${targetPath}: ` +
                    failureMessage(error),
                actionLog,
            },
        };
    }

    let policies: FirefoxPolicies;
    try {
        policies = buildFirefoxPolicies({
            extensionId: launch.extensionId,
            xpiPath: launch.xpiPath,
            managedStorage: buildManagedStorageWithUserFilters(
                launch.managedStorageTemplate,
                launch.userFiltersKeyPath,
                content,
            ),
        });
        actionLog.push({
            tool: HostApplicationStep.RebuildPolicies,
            ok: true,
            summary:
                `rebuilt the ${launch.extensionId} policies with the file content at ` +
                `[${launch.userFiltersKeyPath.join('.')}]`,
        });
    } catch (error) {
        logger.error(
            {
                err: error,
                extensionId: launch.extensionId,
                userFiltersKeyPath: [...launch.userFiltersKeyPath],
            },
            'the host could not rebuild the Firefox policies from the launch declaration',
        );
        actionLog.push({
            tool: HostApplicationStep.RebuildPolicies,
            ok: false,
            summary: `could not rebuild the policies: ${failureMessage(error)}`,
        });
        return {
            result: {
                kind: PhaseApplicationOutcomeKind.Unverified,
                detail:
                    'The host could not rebuild the Firefox policies from the launch ' +
                    `declaration: ${failureMessage(error)}`,
                actionLog,
            },
        };
    }

    let session: IBrowserSession;
    try {
        session = await input.relaunch({
            previous: input.session,
            firefoxPolicies: policies,
            reproProfile: input.reproProfile,
        });
        logger.info(
            { goal: goal.kind, extensionId: launch.extensionId },
            'the host relaunched the phase session with the rebuilt policies',
        );
        actionLog.push({
            tool: HostApplicationStep.RelaunchSession,
            ok: true,
            summary: 'relaunched the session so the browser reads the rebuilt policies at startup',
        });
    } catch (error) {
        logger.error(
            { err: error, goal: goal.kind, targetPath },
            'the host could not relaunch the phase session with the rebuilt policies',
        );
        actionLog.push({
            tool: HostApplicationStep.RelaunchSession,
            ok: false,
            summary: `could not relaunch the session: ${failureMessage(error)}`,
        });
        return {
            result: {
                kind: PhaseApplicationOutcomeKind.Unverified,
                detail:
                    'The host wrote the declared file but could not relaunch the session for the ' +
                    `rebuilt policies: ${failureMessage(error)}`,
                actionLog,
            },
        };
    }

    const read = fileBlockerStateReader();
    let state: BlockerStateRead;
    try {
        state = await read({ method, target: targetPath });
        actionLog.push({
            tool: HostApplicationStep.ReadUserFilters,
            ok: true,
            summary: `read ${targetPath} back after the relaunch`,
        });
    } catch (error) {
        logger.error(
            { err: error, method, targetPath },
            'the host read-back of the declared user-filters file failed',
        );
        actionLog.push({
            tool: HostApplicationStep.ReadUserFilters,
            ok: false,
            summary: `could not read ${targetPath}: ${failureMessage(error)}`,
        });
        return {
            result: {
                kind: PhaseApplicationOutcomeKind.Unverified,
                detail: `The ${method} read-back failed: ${failureMessage(error)}`,
                actionLog,
            },
            session,
        };
    }

    const credited = creditBlockerStateRead({ read: state, goal, method, actionLog, logger });
    if (credited.kind !== PhaseApplicationOutcomeKind.Applied) {
        return { result: credited, session };
    }
    // The proof detail names the file the host wrote and the relaunch it performed, beside whatever
    // the credit itself could not observe.
    const hostDetail =
        `The host wrote ${targetPath} and relaunched the session with rebuilt ` +
        `${launch.extensionId} policies before the read-back.`;
    return {
        result: {
            ...credited,
            detail: credited.detail === undefined ? hostDetail : `${hostDetail} ${credited.detail}`,
        },
        session,
    };
}
