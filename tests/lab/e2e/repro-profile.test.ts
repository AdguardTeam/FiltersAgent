import { describe, it, expect } from 'vitest';
import { deriveReproProfile, profileFallbacks } from '../../../lab/e2e/repro-profile';
import type { IssueFacts } from '../../../src/types/issue-facts';

const baseFacts: IssueFacts = {
    issueNumber: 12345,
    issueUrl: 'https://github.com/AdguardTeam/AdguardFilters/issues/12345',
    reportedSiteUrls: ['https://example.com'],
    labels: ['T: Ads'],
    problemType: 'ads',
    product: 'Extensions: AdGuard',
    enabledFilters: [{ name: 'English filter' }],
    screenshots: [],
};

describe('deriveReproProfile', () => {
    it('defaults to desktop when OS is not mobile', () => {
        const profile = deriveReproProfile(baseFacts);
        expect(profile.viewport).toBe('desktop');
    });

    it('selects mobile viewport for Android', () => {
        const profile = deriveReproProfile({ ...baseFacts, os: 'Android' });
        expect(profile.viewport).toBe('mobile');
    });

    it('selects mobile viewport for iOS', () => {
        const profile = deriveReproProfile({ ...baseFacts, os: 'iOS' });
        expect(profile.viewport).toBe('mobile');
    });

    it('maps browser to userAgentProfile', () => {
        const profile = deriveReproProfile({ ...baseFacts, browser: 'Chrome' });
        expect(profile.userAgentProfile).toContain('Chrome');
    });

    it('defaults locale and timezone', () => {
        const profile = deriveReproProfile(baseFacts);
        expect(profile.locale).toBe('en-US');
        expect(profile.timezone).toBe('UTC');
    });

    it('uses untouched consent strategy', () => {
        const profile = deriveReproProfile(baseFacts);
        expect(profile.consentStrategy).toBe('untouched');
    });
});

describe('profileFallbacks', () => {
    it('yields issue-derived profile first', () => {
        const gen = profileFallbacks(baseFacts);
        const first = gen.next();
        expect(first.done).toBe(false);
        if (!first.done) {
            expect(first.value.viewport).toBe('desktop');
        }
    });

    it('yields opposite viewport second', () => {
        const gen = profileFallbacks(baseFacts);
        gen.next();
        const second = gen.next();
        expect(second.done).toBe(false);
        if (!second.done) {
            expect(second.value.viewport).toBe('mobile');
        }
    });

    it('yields locale variants after viewport fallbacks', () => {
        const profiles: string[] = [];
        for (const p of profileFallbacks(baseFacts)) {
            profiles.push(`${p.viewport}:${p.locale}`);
        }
        expect(profiles).toContain('desktop:de-DE');
    });

    it('yields accept consent after locale fallbacks', () => {
        const profiles = [...profileFallbacks(baseFacts)];
        const acceptProfiles = profiles.filter((p) => p.consentStrategy === 'accept');
        expect(acceptProfiles.length).toBeGreaterThan(0);
    });

    it('terminates after finite iterations', () => {
        const gen = profileFallbacks(baseFacts);
        let count = 0;
        while (!gen.next().done) {
            count++;
        }
        expect(count).toBeGreaterThanOrEqual(3);
        expect(count).toBeLessThanOrEqual(20);
    });
});
