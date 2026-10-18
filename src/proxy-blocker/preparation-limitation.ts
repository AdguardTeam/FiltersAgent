/**
 * Why a blocker module could not be prepared for a run: the stage the preparation reached and the
 * code that ended it, both path-free. The selection host records them as the executor's preparation
 * limitation, and the run ends capability-limited instead of analyzing.
 */

/**
 * The stage a blocker module preparation was in when it stopped.
 */
export const ProxyBlockerPreparationStage = {
    /**
     * Starting the module and reading its description.
     */
    Module: 'module',

    /**
     * Downloading the lists and configuring the evidence route over the started module.
     */
    Route: 'route',

    /**
     * Starting the blocker's proxy and proving it filters an HTTPS request to the run's target.
     */
    Filtering: 'filtering',
} as const;

/**
 * ProxyBlockerPreparationStage value.
 */
export type ProxyBlockerPreparationStage =
    (typeof ProxyBlockerPreparationStage)[keyof typeof ProxyBlockerPreparationStage];

/**
 * Why a blocker module preparation stopped.
 */
export const ProxyBlockerPreparationLimitationCode = {
    /**
     * The run provided no module for the selected executor.
     */
    ModuleNotProvided: 'module_not_provided',

    /**
     * The module failed to describe itself.
     */
    ModuleFailed: 'module_failed',

    /**
     * The module speaks another contract version.
     */
    ContractVersionMismatch: 'contract_version_mismatch',

    /**
     * The evidence route over the module could not be configured.
     */
    RouteConfigurationFailed: 'route_configuration_failed',

    /**
     * The blocker's proxy did not start.
     */
    BlockerStartFailed: 'blocker_start_failed',

    /**
     * The proxy ran, but an HTTPS request to the run's target did not go through its filter: the
     * run would only see traffic nothing filtered.
     */
    HttpsFilteringUnproven: 'https_filtering_unproven',
} as const;

/**
 * ProxyBlockerPreparationLimitationCode value.
 */
export type ProxyBlockerPreparationLimitationCode =
    (typeof ProxyBlockerPreparationLimitationCode)[keyof typeof ProxyBlockerPreparationLimitationCode];
