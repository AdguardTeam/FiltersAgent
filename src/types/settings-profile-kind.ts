/**
 * Extension settings profiles a run can apply before reproducing an issue.
 */
export const SettingsProfileKind = {
    DefaultsPlusRequired: 'defaults_plus_required',
    ReportedOnCurrent: 'reported_on_current',
    ReportExact: 'report_exact',
    AgentSelected: 'agent_selected',
} as const;

export const SETTINGS_PROFILE_KIND_VALUES = Object.values(SettingsProfileKind);

/**
 * One extension settings profile kind.
 */
export type SettingsProfileKind = (typeof SettingsProfileKind)[keyof typeof SettingsProfileKind];
