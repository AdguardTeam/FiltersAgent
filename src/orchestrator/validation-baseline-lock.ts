/**
 * The one validation baseline every `apply_rule` experiment of a run executes on.
 *
 * The filtering environment is built once, from the session whose `apply_rule` call ran the run's
 * first experiment, and every phase of every later experiment replays that session: its filter
 * lists, its Stealth Mode state and its browser profile. A session launched afterwards with other
 * settings cannot move that baseline. An experiment started from it would still run on the locked
 * one, while the model reads the verdict as one for the session it is looking at. This module names
 * what a session hands the environment, locks the first session that runs an experiment, and
 * answers a later session that differs with what is locked and why instead of running it.
 *
 * When the issue carries the reporter's settings import, only a session launched with it can bind a
 * verdict at `finish_fix`. A first experiment from any other session would lock a baseline no
 * verdict can come from, so such a session is refused before the environment is built, and the lock
 * is always held by a session that can verify a rule.
 */
import { isDeepStrictEqual } from 'node:util';
import type { ExtensionBaselineSettings } from '../environment/browser-extension-environment';
import { adguardListKey, sortListKeys } from '../environment/filter-list-ref';
import { createPromptDocumentLoader, PromptDocumentName } from '../prompts/prompt-documents';
import { reproProfilesEqual, type ReproProfile } from '../types/repro-profile';
import type { SettingsProfileKind } from '../types/settings-profile-kind';
import type { AgentRuntimeSessionState } from './agent-runtime-session-evidence';
import { isCandidateRefusal } from './candidate-refusals';
import {
    expectedStealthEnabledFor,
    extensionBaselineSettingsFromStateRead,
} from './phase-application-wiring';

/**
 * Error kind of an `apply_rule` call refused because its session differs from the locked baseline.
 */
export const VALIDATION_BASELINE_LOCKED = 'validation_baseline_locked';

/**
 * Error kind of an `apply_rule` call refused because its session lacks the reporter's settings
 * import that every verdict on the issue needs.
 */
export const REPORTER_SETTINGS_SESSION_REQUIRED = 'reporter_settings_session_required';

/**
 * The next step a reporter-settings refusal asks for: a session the reporter's import configures.
 */
const LAUNCH_REPORTED_ON_CURRENT = 'launch_reported_on_current';

/**
 * Loader of the refusal guidance documents.
 */
const prompts = createPromptDocumentLoader();

/**
 * What one prepared session hands the filtering environment to replay in every experiment phase.
 */
export interface ValidationBaseline {
    /**
     * The session the baseline comes from.
     */
    sessionId: string;

    /**
     * Settings profile the session launched with; reported, not compared, since two profiles that
     * enable the same lists and Stealth Mode state run the same baseline.
     */
    settingsProfileKind: SettingsProfileKind | null;

    /**
     * Filter lists the session's blocker ran, in canonical order.
     */
    enabledListKeys: string[];

    /**
     * Stealth Mode state the phases restore, or null when the session's settings fix none.
     */
    stealthEnabled: boolean | null;

    /**
     * Browser profile the phase sessions launch with.
     */
    profile: ReproProfile;
}

/**
 * The answer to an `apply_rule` call whose session differs from the locked baseline.
 *
 * A type alias rather than an interface: tool results are `Record<string, unknown>`, which an
 * interface, having no index signature, is not assignable to.
 */
export type ValidationBaselineRefusal = {
    /**
     * No experiment ran.
     */
    validationSkipped: true;

    /**
     * What is locked, why, and how this session differs from it.
     */
    error: string;

    /**
     * Finite refusal class.
     */
    errorKind: typeof VALIDATION_BASELINE_LOCKED;

    /**
     * The same call from this session can never run.
     */
    retryable: false;

    /**
     * The baseline every experiment of the run replays.
     */
    lockedBaseline: ValidationBaseline;

    /**
     * The baseline of the session the call came from.
     */
    sessionBaseline: ValidationBaseline;
};

/**
 * The answer to an `apply_rule` call from a session that cannot verify a rule on this issue.
 *
 * A type alias rather than an interface: tool results are `Record<string, unknown>`.
 */
export type ReporterSettingsSessionRefusal = {
    /**
     * No experiment ran.
     */
    validationSkipped: true;

    /**
     * Why this session cannot run the experiment.
     */
    error: string;

    /**
     * Finite refusal class.
     */
    errorKind: typeof REPORTER_SETTINGS_SESSION_REQUIRED;

    /**
     * The same call succeeds from a session with the reporter's settings import.
     */
    retryable: true;

    /**
     * The launch the call needs first.
     */
    requiredAction: typeof LAUNCH_REPORTED_ON_CURRENT;

    /**
     * Settings profile of the refused session.
     */
    sessionSettingsProfileKind: SettingsProfileKind | null;

    /**
     * How to reach a session that can verify a rule, one step per line.
     */
    guidance: string[];
};

/**
 * Refuse an experiment from a session that cannot bind a verdict while the issue's reporter
 * settings import is required.
 *
 * Called before the filtering environment is built, so the refused session neither builds it nor
 * takes the lock. The caller reads both facts at call time: a launch that proves the reporter's set
 * cannot run lifts the requirement mid-run.
 *
 * @param state - The prepared session the experiment would start from.
 * @param reporterSettingsRequired - Whether every verdict needs the reporter's settings import.
 * @param sessionBindsVerdict - Whether this session can bind a verdict at `finish_fix`.
 * @returns The refusal, or null when the session may run the experiment.
 */
export function reporterSettingsSessionRefusal(
    state: AgentRuntimeSessionState,
    reporterSettingsRequired: boolean,
    sessionBindsVerdict: boolean,
): ReporterSettingsSessionRefusal | null {
    if (!reporterSettingsRequired || sessionBindsVerdict) {
        return null;
    }
    return {
        validationSkipped: true,
        error:
            "This issue carries the reporter's settings import, so apply_rule runs only in a " +
            'prepared session launched with settings.kind=reported_on_current and that importUrl.',
        errorKind: REPORTER_SETTINGS_SESSION_REQUIRED,
        retryable: true,
        requiredAction: LAUNCH_REPORTED_ON_CURRENT,
        sessionSettingsProfileKind: state.selectedSettingsProfileKind ?? null,
        guidance: prompts
            .render(PromptDocumentName.RejectionReporterSettingsExperiment)
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0),
    };
}

/**
 * The browser-observed settings the adapter locks and rechecks its baseline with.
 *
 * The host read-back taken at launch is the source of truth.
 *
 * @param state - Active prepared Extension session with its read-back record.
 * @returns The observed filter identity sets.
 * @throws When the session never recorded a launch read-back.
 */
export function extensionBaselineSettingsFor(
    state: AgentRuntimeSessionState,
): ExtensionBaselineSettings {
    if (state.extensionBaselineReadBack) {
        return extensionBaselineSettingsFromStateRead(state.extensionBaselineReadBack);
    }
    throw new Error('A verified prepared Extension session requires the launch read-back record.');
}

/**
 * Read what one prepared session hands the filtering environment.
 *
 * The lists are the launch read-back's enabled set, or the declared selection of a blocker that
 * exposes no readable state; the Stealth Mode state is the one the phase application restores.
 *
 * @param state - The prepared session.
 * @returns The session's baseline.
 */
function validationBaselineOf(state: AgentRuntimeSessionState): ValidationBaseline {
    const readBack = state.extensionBaselineReadBack;
    return {
        sessionId: state.sessionId,
        settingsProfileKind: state.selectedSettingsProfileKind ?? null,
        enabledListKeys: sortListKeys(
            readBack
                ? readBack.optionsEnabledFilterIds.map(adguardListKey)
                : (state.declaredBaselineListKeys ?? []),
        ),
        stealthEnabled: expectedStealthEnabledFor(state.settingsProfile, readBack) ?? null,
        profile: structuredClone(state.profile),
    };
}

/**
 * Name the parts of a session's baseline that differ from the locked one.
 *
 * @param locked - The baseline every experiment replays.
 * @param session - The baseline of the session asking to run one.
 * @returns The differing parts, empty when the session hands over the locked baseline exactly.
 */
function baselineDifferences(locked: ValidationBaseline, session: ValidationBaseline): string[] {
    return [
        ...(isDeepStrictEqual(locked.enabledListKeys, session.enabledListKeys)
            ? []
            : ['filter lists']),
        ...(locked.stealthEnabled === session.stealthEnabled ? [] : ['Stealth Mode state']),
        ...(reproProfilesEqual(locked.profile, session.profile) ? [] : ['browser profile']),
    ];
}

/**
 * Tell whether an `apply_rule` refusal leaves the candidate's attempt unspent.
 *
 * Such a refusal judged the request — its operation, the published line it names, or the session it
 * came from — and not the candidate.
 *
 * @param errorKind - The result's error kind.
 * @returns Whether the call spends no candidate attempt.
 */
export function refusalSparesCandidateAttempt(errorKind: unknown): boolean {
    return (
        isCandidateRefusal(errorKind) ||
        errorKind === VALIDATION_BASELINE_LOCKED ||
        errorKind === REPORTER_SETTINGS_SESSION_REQUIRED
    );
}

/**
 * The run's validation baseline, locked by the first session that runs an experiment.
 */
export class ValidationBaselineLock {
    /**
     * The baseline every experiment replays, once one ran.
     */
    private locked: ValidationBaseline | undefined;

    /**
     * Admit one session's experiment.
     *
     * The caller admits right after the filtering environment answered ready for `state`, so the
     * first admitted session is the one the environment was built from: it locks the baseline, and
     * every later session must hand the environment the same one. The reporter-settings refusal
     * runs before the build, so the locked session can always bind a verdict and the refusal may
     * send the model back to it.
     *
     * @param state - The prepared session the experiment would start from.
     * @returns Null when the experiment may run, otherwise the refusal naming both baselines.
     */
    admit(state: AgentRuntimeSessionState): ValidationBaselineRefusal | null {
        const session = validationBaselineOf(state);
        if (this.locked === undefined) {
            this.locked = session;
            return null;
        }
        const differences = baselineDifferences(this.locked, session);
        if (differences.length === 0) {
            return null;
        }
        return {
            validationSkipped: true,
            error:
                `The run's validation baseline is locked to session ${this.locked.sessionId}: ` +
                "its apply_rule ran the run's first experiment, and every experiment replays that " +
                "session's filter lists, Stealth Mode state and browser profile. This session " +
                `differs in its ${differences.join(', ')}, so an experiment started here would ` +
                'run on the locked baseline, not on this session. To validate a rule, launch a ' +
                'prepared browser with the settings and profile of lockedBaseline and call ' +
                'apply_rule there. Verdicts already given hold for the locked baseline only.',
            errorKind: VALIDATION_BASELINE_LOCKED,
            retryable: false,
            lockedBaseline: structuredClone(this.locked),
            sessionBaseline: session,
        };
    }
}
