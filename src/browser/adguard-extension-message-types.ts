/**
 * The AdGuard Browser Extension app-message vocabulary this run speaks.
 *
 * One declaration for both sides of the boundary: the host's own state read sends these types, and
 * the built-in application instruction names them to the model. A message type spelled twice is a
 * message type that can drift, and the one that drifts silently is the worst kind — the extension
 * answers `undefined` and the step looks like it ran.
 *
 * Every member here was proven against the pinned build, the filtering-log messages by a headless
 * probe of v5.5.2.3; nothing is invented. In particular no _enable_ counterpart to `DisableFilter`
 * is proven, so the convergence the instruction performs only ever turns filters off, and the log
 * has no working open message: `onOpenFilteringLogPage` throws in the pinned build, so recording
 * starts by opening the extension's own log page.
 */
export const AdGuardExtensionMessageType = {
    /**
     * Whether the fresh-install bootstrap has finished. Settings applied before it answers `true`
     * can be overwritten by late bootstrap work.
     */
    GetIsAppInitialized: 'getIsAppInitialized',

    /**
     * The options application's current state: app version, settings values, and the filter
     * metadata carrying each filter's `filterId` and `enabled` flag.
     */
    GetOptionsData: 'getOptionsData',

    /**
     * The installation's complete settings export as a JSON string.
     */
    LoadSettingsJson: 'loadSettingsJson',

    /**
     * Import a complete settings document. The pinned build refuses anything partial.
     */
    ApplySettingsJson: 'applySettingsJson',

    /**
     * Replace the user-rules text with the supplied value.
     */
    SaveUserRules: 'saveUserRules',

    /**
     * Turn one filter off by its `filterId`.
     */
    DisableFilter: 'disableFilter',

    /**
     * The filtering log's own metadata: every filter the build knows, with its `filterId` and
     * `name`.
     */
    GetFilteringLogData: 'getFilteringLogData',

    /**
     * Make the filtering log track every open tab, including tabs created before it opened.
     */
    SynchronizeOpenTabs: 'synchronizeOpenTabs',

    /**
     * One tab's filtering log: the events the engine recorded for the tab's current page load.
     */
    GetFilteringInfoByTabId: 'getFilteringInfoByTabId',
} as const;

/**
 * AdGuardExtensionMessageType value.
 */
export type AdGuardExtensionMessageType =
    (typeof AdGuardExtensionMessageType)[keyof typeof AdGuardExtensionMessageType];
