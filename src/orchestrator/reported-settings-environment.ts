/**
 * Which browser session's extension settings a finished run reports as its reproduction settings.
 *
 * The result's settings evidence and extension provenance say what the agent reproduced the issue
 * with, and the benchmark compares them with the reporter's own settings. A run may launch several
 * prepared sessions — the fix task asks for a controlled `defaults_plus_required` comparison after
 * the reporter profile reproduces — so "the last launch" is not that answer.
 */
import {
    sessionBaselineCredited,
    type AgentRuntimeEnvironmentEvidence,
} from './agent-runtime-session-evidence';

/**
 * The finished runtime's session lookups the choice reads.
 */
export interface ReportedSettingsSessions {
    /**
     * The latest prepared session that can carry a terminal decision: with a reporter settings
     * import, the latest reporter-profile session.
     *
     * @returns That session's evidence, when one ran.
     */
    getLatestVerifiedSettingsEnvironment(): AgentRuntimeEnvironmentEvidence | undefined;

    /**
     * The most recently launched session of any kind.
     *
     * @returns That session's evidence, when one launched.
     */
    getLatestEnvironment(): AgentRuntimeEnvironmentEvidence | undefined;
}

/**
 * Return the environment when it ran the prepared extension with a credited launch baseline.
 *
 * @param environment - Candidate environment.
 * @returns The environment, or undefined when it carries no settings proof.
 */
function creditedPrepared(
    environment: AgentRuntimeEnvironmentEvidence | undefined,
): AgentRuntimeEnvironmentEvidence | undefined {
    return environment?.extension !== undefined && sessionBaselineCredited(environment)
        ? environment
        : undefined;
}

/**
 * Pick the session whose settings the run result reports.
 *
 * The session the verdict is bound to — the verified candidate's or the no-patch evidence's — wins
 * when it carries a settings proof. Without a bound session, the latest session that can carry a
 * terminal decision speaks for the run, so a controlled comparison launched after the reporter
 * profile never stands in for the reporter's settings. Only a run that never ran such a session
 * falls back to its last launch, when that launch proved its settings.
 *
 * @param bound - The validation or no-patch environment the verdict is bound to, if any.
 * @param sessions - The finished runtime's session lookups.
 * @returns The session whose settings the result reports, or undefined when none proved any.
 */
export function reportedSettingsEnvironment(
    bound: AgentRuntimeEnvironmentEvidence | undefined,
    sessions: ReportedSettingsSessions,
): AgentRuntimeEnvironmentEvidence | undefined {
    const terminal = sessions.getLatestVerifiedSettingsEnvironment();
    if (bound !== undefined) {
        return creditedPrepared(bound) ?? terminal;
    }
    return terminal ?? creditedPrepared(sessions.getLatestEnvironment());
}
