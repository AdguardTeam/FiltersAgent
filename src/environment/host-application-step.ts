/**
 * The action-log vocabulary of the host's own application steps.
 *
 * Two application paths are performed by the host rather than by a model session — the file-backed
 * one and the built-in AdGuard extension one — and both record what they did into the same
 * `ActionLogEntry` trace a model-driven session records its tool calls into. The action log is
 * evidence of what was done, so for these paths the doer is the host and the steps are named after
 * the operations themselves rather than after a model tool. One declaration for both paths, so a
 * step name can never mean two things.
 */

/**
 * Every host-performed application step, as the action log names it.
 */
export const HostApplicationStep = {
    /**
     * The host wrote the declared user-filters file.
     */
    WriteUserFilters: 'host_write_user_filters_file',

    /**
     * The host rebuilt the Firefox enterprise policies from the declaration plus the file content.
     */
    RebuildPolicies: 'host_rebuild_firefox_policies',

    /**
     * The host closed the running session and launched a new one with the rebuilt policies.
     */
    RelaunchSession: 'host_relaunch_browser_session',

    /**
     * The host read the declared file back.
     */
    ReadUserFilters: 'host_read_user_filters_file',

    /**
     * The host waited for the extension to report its fresh-install bootstrap finished.
     */
    AwaitExtensionReady: 'host_await_extension_ready',

    /**
     * The host imported the prepared settings document through the extension's own options
     * application.
     */
    ApplyExtensionSettings: 'host_apply_extension_settings',

    /**
     * The host reconciled the enabled filter set against the prepared expectation, turning off
     * whatever the import left on.
     */
    ReconcileEnabledFilters: 'host_reconcile_enabled_filters',

    /**
     * The host saved the candidate rule as the extension's only user rule.
     */
    SaveExtensionUserRules: 'host_save_extension_user_rules',
} as const;

/**
 * HostApplicationStep value.
 */
export type HostApplicationStep = (typeof HostApplicationStep)[keyof typeof HostApplicationStep];
