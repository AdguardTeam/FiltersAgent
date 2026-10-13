import { BrowserFallbackReason } from './browser-fallback-reason';

/**
 * Who or what prevented a conclusive browser run.
 *
 * The distinction exists because a published comment states a fact about the reporter's site. A
 * refusal that came from our own guard, our own machinery, or a cause we cannot attribute must
 * never be rendered as one, and the only way to keep that true as the taxonomy grows is to make
 * every fallback reason carry an attribution the compiler insists on.
 */
export const BrowserFallbackOrigin = {
    /**
     * The target itself refused or could not serve the page, proven by its own response.
     */
    Site: 'site',

    /**
     * We declined to proceed: the URL is not one we open, or the navigation left the issue origin.
     */
    Agent: 'agent',

    /**
     * Our own machinery failed before the target was ever exercised.
     */
    Infrastructure: 'infrastructure',

    /**
     * The cause cannot be attributed from what was recorded, so nothing may be claimed about it.
     */
    Indeterminate: 'indeterminate',
} as const;

/**
 * BrowserFallbackOrigin value.
 */
export type BrowserFallbackOrigin =
    (typeof BrowserFallbackOrigin)[keyof typeof BrowserFallbackOrigin];

/**
 * Attribution of every fallback reason the browser runtime can report.
 *
 * Exhaustive by type on purpose: this `Record` is the one place a new fallback reason fails to
 * compile until somebody decides whether it may be published as a statement about the target.
 * Before it existed the same seven-member list was hand-copied into four modules, and a value
 * missing from one of them silently became "the browser could not start" — an infrastructure
 * verdict that is retried and paid for three times.
 *
 * `navigation_timeout` and `target_unreachable` are deliberately
 * {@link
 * BrowserFallbackOrigin.Indeterminate} rather than `Site`: both are also produced by our own
 * request interception and by a failure of the loopback proxy a strict route runs behind, and
 * nothing recorded at the point of failure separates those from a target that really did not
 * answer.
 */
const ORIGIN_BY_REASON: Readonly<Record<BrowserFallbackReason, BrowserFallbackOrigin>> =
    Object.freeze({
        [BrowserFallbackReason.LaunchFailed]: BrowserFallbackOrigin.Infrastructure,
        [BrowserFallbackReason.ArtifactCaptureFailed]: BrowserFallbackOrigin.Infrastructure,
        [BrowserFallbackReason.ExtensionConfigurationFailed]: BrowserFallbackOrigin.Infrastructure,

        [BrowserFallbackReason.NotFound]: BrowserFallbackOrigin.Site,
        [BrowserFallbackReason.HttpBlocked]: BrowserFallbackOrigin.Site,
        [BrowserFallbackReason.BotChallenge]: BrowserFallbackOrigin.Site,
        [BrowserFallbackReason.GeoBlocked]: BrowserFallbackOrigin.Site,
        [BrowserFallbackReason.SignInRequired]: BrowserFallbackOrigin.Site,
        [BrowserFallbackReason.EmptyDom]: BrowserFallbackOrigin.Site,

        [BrowserFallbackReason.NavigationOffOrigin]: BrowserFallbackOrigin.Agent,
        [BrowserFallbackReason.UnsafeTargetUrl]: BrowserFallbackOrigin.Agent,

        [BrowserFallbackReason.NavigationTimeout]: BrowserFallbackOrigin.Indeterminate,
        [BrowserFallbackReason.TargetUnreachable]: BrowserFallbackOrigin.Indeterminate,
        [BrowserFallbackReason.TargetDnsUnresolved]: BrowserFallbackOrigin.Indeterminate,
    });

/**
 * Attribute one fallback reason.
 *
 * @param reason - Exact fallback emitted by the browser runtime.
 * @returns Who prevented the conclusive run.
 */
export function browserFallbackOrigin(reason: BrowserFallbackReason): BrowserFallbackOrigin {
    return ORIGIN_BY_REASON[reason];
}

/**
 * Decide whether a fallback records our own refusal to proceed.
 *
 * @param reason - Exact fallback emitted by the browser runtime, or null when none was recorded.
 * @returns True when we declined the navigation rather than the target refusing it.
 */
export function isAgentRefusalFallback(reason: BrowserFallbackReason | null): boolean {
    return reason !== null && browserFallbackOrigin(reason) === BrowserFallbackOrigin.Agent;
}

/**
 * Decide whether a fallback means our own machinery failed rather than the navigation.
 *
 * @param reason - Exact fallback emitted by the browser runtime, or null when none was recorded.
 * @returns True only for a failure of our own browser machinery.
 */
export function isInfrastructureFallbackReason(reason: BrowserFallbackReason | null): boolean {
    return (
        reason !== null && browserFallbackOrigin(reason) === BrowserFallbackOrigin.Infrastructure
    );
}

/**
 * Decide whether a fallback describes the navigation rather than our machinery.
 *
 * This is the complement of {@link isInfrastructureFallbackReason}, and it is what four modules
 * previously spelled out as the same hand-copied seven-member list. Keeping it derived means a new
 * reason joins it by default, which is the safe side: a navigation outcome misfiled as machinery
 * failure is retried and paid for up to three times.
 *
 * @param reason - Exact fallback emitted by the browser runtime, or null when none was recorded.
 * @returns True when the fallback describes the attempt to reach the target.
 */
export function isTargetEnvironmentFallbackReason(reason: BrowserFallbackReason | null): boolean {
    return reason !== null && !isInfrastructureFallbackReason(reason);
}
