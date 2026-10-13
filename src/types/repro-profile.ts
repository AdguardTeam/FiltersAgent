import * as v from 'valibot';

/**
 * Browser viewport classes a reproduction can run with.
 */
export const Viewport = {
    Desktop: 'desktop',
    Mobile: 'mobile',
} as const;

/**
 * Viewport value.
 */
export type Viewport = (typeof Viewport)[keyof typeof Viewport];

/**
 * Every viewport value, for schemas and exhaustive listings.
 */
export const VIEWPORT_VALUES = Object.values(Viewport);

export const ViewportSchema = v.picklist(VIEWPORT_VALUES);
/**
 * What a reproduction does with a consent dialog before collecting evidence.
 */
export const ConsentStrategy = {
    Untouched: 'untouched',
    Accept: 'accept',
    Reject: 'reject',
} as const;

/**
 * ConsentStrategy value.
 */
export type ConsentStrategy = (typeof ConsentStrategy)[keyof typeof ConsentStrategy];

/**
 * Every consent strategy value, for schemas and exhaustive listings.
 */
export const CONSENT_STRATEGY_VALUES = Object.values(ConsentStrategy);

export const ConsentStrategySchema = v.picklist(CONSENT_STRATEGY_VALUES);

export const ReproProfileSchema = v.object({
    viewport: ViewportSchema,
    locale: v.string(),
    timezone: v.string(),
    geolocation: v.optional(v.object({ latitude: v.number(), longitude: v.number() })),
    proxyRegion: v.optional(v.string()),
    userAgentProfile: v.string(),
    consentStrategy: ConsentStrategySchema,
});

export type ReproProfile = v.InferOutput<typeof ReproProfileSchema>;

/**
 * Canonicalize one browser target URL for exact environment comparison.
 *
 * @param value - Browser target URL supplied to a session.
 * @returns Canonical absolute URL, or undefined when the value is invalid.
 */
export function canonicalReproTargetUrl(value: string): string | undefined {
    try {
        return new URL(value).href;
    } catch {
        return undefined;
    }
}

/**
 * Compare every browser-profile field that can affect page reproduction.
 *
 * @param left - First browser reproduction profile.
 * @param right - Second browser reproduction profile.
 * @returns Whether both profiles describe the exact same browser environment.
 */
export function reproProfilesEqual(left: ReproProfile, right: ReproProfile): boolean {
    return (
        left.viewport === right.viewport &&
        left.locale === right.locale &&
        left.timezone === right.timezone &&
        left.userAgentProfile === right.userAgentProfile &&
        left.consentStrategy === right.consentStrategy &&
        left.proxyRegion === right.proxyRegion &&
        left.geolocation?.latitude === right.geolocation?.latitude &&
        left.geolocation?.longitude === right.geolocation?.longitude
    );
}

/**
 * Compare target URL and browser profile while deliberately ignoring extension settings.
 *
 * @param leftTargetUrl - First browser session target URL.
 * @param leftProfile - First browser session reproduction profile.
 * @param rightTargetUrl - Second browser session target URL.
 * @param rightProfile - Second browser session reproduction profile.
 * @returns Whether the sessions differ only in extension settings.
 */
export function reproEnvironmentsEqual(
    leftTargetUrl: string,
    leftProfile: ReproProfile,
    rightTargetUrl: string,
    rightProfile: ReproProfile,
): boolean {
    const leftCanonicalUrl = canonicalReproTargetUrl(leftTargetUrl);
    const rightCanonicalUrl = canonicalReproTargetUrl(rightTargetUrl);
    return (
        leftCanonicalUrl !== undefined &&
        leftCanonicalUrl === rightCanonicalUrl &&
        reproProfilesEqual(leftProfile, rightProfile)
    );
}
