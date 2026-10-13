/**
 * How completely the reporter settings were applied to the prepared extension.
 */
export const SettingsApplicationStatus = {
    Applied: 'applied',
    Partial: 'partial',
    Failed: 'failed',
    Skipped: 'skipped',
} as const;

/**
 * Every SettingsApplicationStatus value, for schemas and exhaustive listings.
 */
export const SETTINGS_APPLICATION_STATUS_VALUES = Object.values(SettingsApplicationStatus);

/**
 * SettingsApplicationStatus value.
 */
export type SettingsApplicationStatus =
    (typeof SettingsApplicationStatus)[keyof typeof SettingsApplicationStatus];
