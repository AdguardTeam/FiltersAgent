/**
 * Why a requested settings profile could not run as a whole, when the cause is a browser limit
 * rather than a mismatch the application could have avoided.
 *
 * The between-phases credit (`validator/blocker-state-credit.ts`) names the limitation on its
 * unverified outcome, the environment carries it through its configuration result, and the launch
 * result surfaces it to the model beside `settingsVerified: false`. A marker, not prose: the
 * runtime decides from it whether reporter parity is still achievable
 * (`reporter-settings-limits.ts`).
 */
export const SettingsLimitation = {
    /**
     * The requested filter set does not fit Chrome's MV3 limits (the static ruleset count or the
     * static rule budget): the extension enabled what Chrome accepted and disabled the rest, so no
     * application can bring the read-back set to the requested one: a request of 52 filters can
     * leave Chrome keeping 2.
     */
    Mv3LimitsExceeded: 'mv3_limits_exceeded',
} as const;

/**
 * SettingsLimitation value.
 */
export type SettingsLimitation = (typeof SettingsLimitation)[keyof typeof SettingsLimitation];
