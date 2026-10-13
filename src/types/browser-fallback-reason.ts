/**
 * Why a browser phase could not produce a conclusive observation of the reported page.
 *
 * Every member is attributed in `browser-fallback-origin.ts`, which decides whether it may be
 * stated as a fact about the reporter's site. Adding a member here fails that projection's
 * exhaustive `Record` until the attribution is made.
 */
export const BrowserFallbackReason = {
    /**
     * Chromium could not be started.
     */
    LaunchFailed: 'launch_failed',

    /**
     * Navigation did not complete within the runner's budget.
     */
    NavigationTimeout: 'navigation_timeout',

    /**
     * The host did not resolve or accept a connection.
     */
    TargetUnreachable: 'target_unreachable',

    /**
     * The target answered that the page does not exist.
     */
    NotFound: 'not_found',

    /**
     * The target answered with a status at or above 400. Only a real response from the target
     * carries this: our own refusals are {@link BrowserFallbackReason.NavigationOffOrigin},
     * {@link BrowserFallbackReason.UnsafeTargetUrl} or
     * {@link BrowserFallbackReason.TargetDnsUnresolved}.
     */
    HttpBlocked: 'http_blocked',

    /**
     * The target served an anti-bot challenge instead of the page.
     */
    BotChallenge: 'bot_challenge',

    /**
     * The target withheld the page on regional grounds.
     */
    GeoBlocked: 'geo_blocked',

    /**
     * The target withheld the page behind a sign-in wall this runner cannot pass.
     */
    SignInRequired: 'sign_in_required',

    /**
     * The target served no usable document.
     */
    EmptyDom: 'empty_dom',

    /**
     * We declined to leave the origin configured for this issue.
     */
    NavigationOffOrigin: 'navigation_off_origin',

    /**
     * The URL is not one we open: wrong scheme, embedded credentials, or a non-public host.
     */
    UnsafeTargetUrl: 'unsafe_target_url',

    /**
     * The host produced no usable DNS answer from this runner.
     */
    TargetDnsUnresolved: 'target_dns_unresolved',

    /**
     * A required capture could not be written.
     */
    ArtifactCaptureFailed: 'artifact_capture_failed',

    /**
     * The extension under test could not be configured.
     */
    ExtensionConfigurationFailed: 'extension_configuration_failed',
} as const;

/**
 * Every BrowserFallbackReason value, for schemas and exhaustive listings.
 */
export const BROWSER_FALLBACK_REASON_VALUES = Object.values(BrowserFallbackReason);

/**
 * BrowserFallbackReason value.
 */
export type BrowserFallbackReason =
    (typeof BrowserFallbackReason)[keyof typeof BrowserFallbackReason];
