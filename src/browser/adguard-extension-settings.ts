import {
    canonicalAdGuardSettingsImportUrlSha256,
    TRUSTED_REPORT_SETTINGS_HOSTS,
} from './adguard-settings-import-url';
import type { ListSlice } from '../environment/list-slice';
import { SettingsProfileKind } from '../types/settings-profile-kind';

/**
 * The settings-request vocabulary the extension state is produced from: the durable settings
 * profiles a session can request, the trusted reporter import URL those profiles perform, and the
 * filter-ID normalization every exact-set comparison agrees on.
 *
 * The observed state shapes these requests are verified against live in
 * `adguard-extension-state-shapes.ts`.
 */

/**
 * Setting key used by AdGuard to persist the inverse of `stealth.enabled`.
 */
export const DISABLE_STEALTH_SETTING = 'stealth-disable-stealth-mode';

/**
 * Supported syntax for an extension version supplied by a report URL.
 */
const APP_VERSION_PATTERN = /^\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * Supported deterministic extension settings profiles.
 */
export type AdGuardExtensionSettingsProfile =
    | {
          /**
           * Preserve fresh-install defaults and add only explicitly required filters.
           */
          kind: typeof SettingsProfileKind.DefaultsPlusRequired;

          /**
           * Filter IDs that must be enabled in addition to fresh-install defaults.
           */
          requiredFilterIds: number[];

          /**
           * Trusted reporter settings used only to select one relevant recommended filter.
           */
          reporterImportUrl?: string;

          /**
           * Reported site hostname used to rank regional reporter filters.
           */
          siteHostname?: string;

          /**
           * Reporter-visible filter names used to resolve runtime metadata without an import URL.
           */
          reportedFilterNames?: string[];

          /**
           * Issue labels used to prevent Ads-filter inference for unrelated problem types.
           */
          issueLabels?: string[];
      }
    | {
          /**
           * Reapply reporter IDs and stealth state on the installed current version.
           */
          kind: typeof SettingsProfileKind.ReportedOnCurrent;

          /**
           * Trusted reporter settings URL used as the settings source.
           */
          importUrl: string;
      }
    | {
          /**
           * Reproduce the reporter settings and extension version exactly.
           */
          kind: typeof SettingsProfileKind.ReportExact;

          /**
           * Trusted reporter settings URL used as the exact source.
           */
          importUrl: string;
      }
    | {
          /**
           * Apply exact filter IDs and stealth state selected by the reasoning model.
           */
          kind: typeof SettingsProfileKind.AgentSelected;

          /**
           * Exact positive filter IDs requested by the model from the issue body.
           */
          filterIds: number[];

          /**
           * Exact Tracking-protection state requested by the model.
           */
          stealthEnabled: boolean;

          /**
           * In-list bisection: the list named is replaced by lines `firstLine..lastLine` of the
           * build's own text of it, run as a trusted custom filter while the built-in list stays
           * off. The list must be one of `filterIds`.
           */
          slice?: ListSlice;
      };

/**
 * Parsed expectations carried by a trusted report URL.
 */
export interface ImportExpectations {
    /**
     * Trusted report hostname.
     */
    reportHost: string;

    /**
     * Raw query forwarded to the extension import API.
     */
    queryString: string;

    /**
     * Exact extension version reported by the user.
     */
    productVersion: string;

    /**
     * Exact set of regular filter IDs requested by the user.
     */
    enabledFilterIds: number[];

    /**
     * Whether Tracking protection was enabled in the reported configuration.
     */
    stealthEnabled: boolean;

    /**
     * SHA-256 digest of the complete trusted import URL.
     */
    importUrlSha256: string;
}

/**
 * Parse a strict trusted report URL into the settings postconditions to prove.
 *
 * The parsed expectations are the run's own settings-request record: after the options-page
 * driver's retirement the import URL is performed by the instruction's steps, and this parse is
 * what the host compares the read-back state against.
 *
 * @param importUrl - Reporter-provided AdGuard configuration URL.
 * @returns Parsed exact settings expectations.
 */
export function parseImportExpectations(importUrl: string): ImportExpectations {
    let url: URL;
    try {
        url = new URL(importUrl);
    } catch {
        throw new Error('AdGuard settings import URL is malformed.');
    }

    if (
        url.protocol !== 'https:' ||
        !TRUSTED_REPORT_SETTINGS_HOSTS.has(url.hostname) ||
        url.username.length > 0 ||
        url.password.length > 0 ||
        url.port.length > 0 ||
        url.hash.length > 0
    ) {
        throw new Error('AdGuard settings import URL is not a trusted HTTPS report URL.');
    }

    const schemeValues = url.searchParams.getAll('scheme_version');
    if (schemeValues.length > 1) {
        throw new Error('Expected at most one scheme_version parameter.');
    }
    const schemeVersion = schemeValues[0] ?? '3';
    if (schemeVersion !== '3' && schemeVersion !== '4') {
        throw new Error('Unsupported AdGuard settings import scheme version.');
    }

    const productVersion = getRequiredParameter(url, 'product_version');
    if (!APP_VERSION_PATTERN.test(productVersion)) {
        throw new Error('Reported AdGuard product_version is malformed.');
    }

    const regularFilterValues = url.searchParams.getAll('regular_filters');
    const legacyFilterValues = url.searchParams.getAll('filters');
    if (regularFilterValues.length > 0 && legacyFilterValues.length > 0) {
        throw new Error(
            'AdGuard settings import URL mixes regular_filters and legacy filters parameters.',
        );
    }
    // The extension's configuration import maps the legacy `filters` parameter onto
    // `regular_filters`; current reporter URLs emit only the legacy name with dot separators.
    const filterParameter = regularFilterValues.length > 0 ? 'regular_filters' : 'filters';
    const separator = filterParameter === 'regular_filters' && schemeVersion === '4' ? ',' : '.';
    const rawFilterIds = getRequiredParameter(url, filterParameter).split(separator);
    const enabledFilterIds = rawFilterIds.map((rawId) => {
        const trimmed = rawId.trim();
        const filterId = Number(trimmed);
        if (trimmed.length === 0 || !Number.isInteger(filterId) || filterId <= 0) {
            throw new Error('Reported regular_filters contains a malformed filter ID.');
        }
        return filterId;
    });

    const rawStealthEnabled = getRequiredParameter(url, 'stealth.enabled');
    const expectedTrue = schemeVersion === '4' ? '1' : 'true';
    const expectedFalse = schemeVersion === '4' ? '0' : 'false';
    if (rawStealthEnabled !== expectedTrue && rawStealthEnabled !== expectedFalse) {
        throw new Error('Reported stealth.enabled value is malformed.');
    }

    return {
        reportHost: url.hostname,
        queryString: url.search.slice(1),
        productVersion,
        enabledFilterIds: normalizeFilterIds(enabledFilterIds),
        stealthEnabled: rawStealthEnabled === expectedTrue,
        importUrlSha256: canonicalAdGuardSettingsImportUrlSha256(url.href),
    };
}

/**
 * Parse and validate a single required query parameter.
 *
 * @param url - Trusted report URL being parsed.
 * @param name - Required query parameter name.
 * @returns The unique non-empty parameter value.
 */
function getRequiredParameter(url: URL, name: string): string {
    const values = url.searchParams.getAll(name);
    if (values.length !== 1 || values[0].length === 0) {
        throw new Error(`Expected exactly one non-empty ${name} parameter.`);
    }

    return values[0];
}

/**
 * Normalize filter IDs for order-independent exact-set comparison.
 *
 * @param filterIds - Filter IDs to normalize.
 * @returns Deduplicated ascending filter IDs.
 */
export function normalizeFilterIds(filterIds: number[]): number[] {
    const normalized: number[] = [];
    for (const filterId of new Set(filterIds)) {
        const insertionPoint = normalized.findIndex((current) => current > filterId);
        if (insertionPoint === -1) {
            normalized.push(filterId);
        } else {
            normalized.splice(insertionPoint, 0, filterId);
        }
    }
    return normalized;
}
