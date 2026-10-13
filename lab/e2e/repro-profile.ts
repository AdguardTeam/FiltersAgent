import type { IssueFacts } from '../../src/types/issue-facts';
import { Viewport, ConsentStrategy, type ReproProfile } from '../../src/types/repro-profile';

/**
 * Maps browser substrings (lowercased) to user-agent profile labels.
 */
const BROWSER_PROFILE_MAP: Record<string, string> = {
    chrome: 'Chrome',
    firefox: 'Firefox',
    edge: 'Edge',
    safari: 'Safari',
    opera: 'Opera',
};

/**
 * Locales to try in fallback sequence after the default en-US.
 */
const FALLBACK_LOCALES = ['en-US', 'de-DE', 'ru-RU', 'ja-JP', 'fr-FR'];

/**
 * Derive the initial reproduction profile from issue facts.
 *
 * Mobile viewport is selected when the issue OS is Android or iOS. The user-agent profile is
 * inferred from the browser field via a static map. Locale, timezone, and consent strategy use safe
 * defaults.
 *
 * @param facts - The parsed issue facts.
 * @returns A reproduction profile to configure the browser session.
 */
export function deriveReproProfile(facts: IssueFacts): ReproProfile {
    const osLower = (facts.os ?? '').toLowerCase();
    const viewport =
        osLower.includes('android') || osLower.includes('ios') ? Viewport.Mobile : Viewport.Desktop;

    const browserLower = (facts.browser ?? '').toLowerCase();
    const userAgentProfile =
        Object.entries(BROWSER_PROFILE_MAP).find(([key]) => browserLower.includes(key))?.[1] ??
        'Chrome';

    return {
        viewport,
        locale: 'en-US',
        timezone: 'UTC',
        userAgentProfile,
        consentStrategy: ConsentStrategy.Untouched,
    };
}

/**
 * Generate fallback reproduction profiles in priority order.
 *
 * Sequence: derived profile → opposite viewport → locale variants (with both viewports) →
 * accept-consent variants (with both viewports).
 *
 * @param facts - The parsed issue facts.
 * @yields Progressively more aggressive reproduction profiles.
 */
export function* profileFallbacks(facts: IssueFacts): Generator<ReproProfile, void, void> {
    const base = deriveReproProfile(facts);
    yield base;

    const opposite = base.viewport === Viewport.Desktop ? Viewport.Mobile : Viewport.Desktop;
    yield { ...base, viewport: opposite };

    for (const locale of FALLBACK_LOCALES.slice(1)) {
        yield { ...base, locale };
        yield { ...base, locale, viewport: opposite };
    }

    yield { ...base, consentStrategy: ConsentStrategy.Accept };
    yield { ...base, viewport: opposite, consentStrategy: ConsentStrategy.Accept };
}
