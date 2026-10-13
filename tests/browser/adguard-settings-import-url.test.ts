import { describe, expect, it } from 'vitest';
import { canonicalAdGuardSettingsImportUrlSha256 } from '../../src/browser/adguard-settings-import-url';

describe('canonicalAdGuardSettingsImportUrlSha256', () => {
    it('treats equivalent percent-encoding as the same reporter import', () => {
        const encoded =
            'https://reports.adguard.com/settings/import.html?' +
            'scheme_version=4&product_type=ext&product_version=5.4.3.104&' +
            'regular_filters=2%2C3%2C17&filters_last_update=2026-07-21T09%3A00%3A51Z&' +
            'stealth.enabled=0';
        const modelNormalized =
            'https://reports.adguard.com/settings/import.html?' +
            'scheme_version=4&product_type=ext&product_version=5.4.3.104&' +
            'regular_filters=2,3,17&filters_last_update=2026-07-21T09:00:51Z&' +
            'stealth.enabled=0';

        expect(canonicalAdGuardSettingsImportUrlSha256(modelNormalized)).toBe(
            canonicalAdGuardSettingsImportUrlSha256(encoded),
        );
    });

    it('keeps different reporter setting values distinct', () => {
        const original =
            'https://reports.adguard.com/settings/import.html?' +
            'scheme_version=4&product_version=5.4.3.104&regular_filters=2%2C3&' +
            'stealth.enabled=0';
        const changed = original.replace('regular_filters=2%2C3', 'regular_filters=2');

        expect(canonicalAdGuardSettingsImportUrlSha256(changed)).not.toBe(
            canonicalAdGuardSettingsImportUrlSha256(original),
        );
    });

    it('keeps query ordering distinct for duplicate-sensitive legacy aliases', () => {
        const original =
            'https://reports.adguard.com/settings/import.html?' +
            'scheme_version=3&product_version=5.4.3.104&filters=2.3&' +
            'regular_filters=2.10&stealth.enabled=false';
        const reordered =
            'https://reports.adguard.com/settings/import.html?' +
            'scheme_version=3&product_version=5.4.3.104&regular_filters=2.10&' +
            'filters=2.3&stealth.enabled=false';

        expect(canonicalAdGuardSettingsImportUrlSha256(reordered)).not.toBe(
            canonicalAdGuardSettingsImportUrlSha256(original),
        );
    });

    it('binds unknown reporter parameters instead of hashing only core settings', () => {
        const original =
            'https://reports.adguard.com/settings/import.html?' +
            'scheme_version=4&product_version=5.4.3.104&regular_filters=2%2C3&' +
            'stealth.enabled=0&custom_filters=alpha';
        const changed = original.replace('custom_filters=alpha', 'custom_filters=beta');

        expect(canonicalAdGuardSettingsImportUrlSha256(changed)).not.toBe(
            canonicalAdGuardSettingsImportUrlSha256(original),
        );
    });
});
