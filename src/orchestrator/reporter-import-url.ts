/**
 * The reporter's settings import URLs, and the launch check that binds a `reported_on_current`
 * session to one of them.
 *
 * A terminal decision on a report that carries an import URL needs a session launched with that
 * exact URL. The terminal gate compares digests, so a session launched with an edited URL runs,
 * validates candidates, and only fails at `finish_fix` — with nothing saying what differed. A model
 * that drops two third-party filter IDs from the URL in every launch seals the run after three
 * rejected submissions. The launch check refuses such a request before any browser starts, naming
 * the parameters that differ.
 */
import {
    canonicalAdGuardSettingsImportUrlSha256,
    TRUSTED_REPORT_SETTINGS_HOSTS,
} from '../browser/adguard-settings-import-url';
import type { RawIssue } from '../github/fetch-issue';

/**
 * Bounded HTTPS URL candidates extracted only to detect explicit reporter settings provenance.
 */
const REPORT_SETTINGS_URL_PATTERN =
    /https:\/\/reports\.adguard\.(?:com|info|app)\/[^\s<>"'`)\]]+/giu;

/**
 * One query parameter whose value differs between the reporter URL and the requested one.
 */
export interface ImportUrlParameterDifference {
    /**
     * Query parameter name.
     */
    parameter: string;

    /**
     * Value in the reporter URL, or null when the reporter URL lacks it.
     */
    reporter: string | null;

    /**
     * Value in the requested URL, or null when the request dropped it.
     */
    requested: string | null;
}

/**
 * Extract the explicit AdGuard settings import URLs in prompt-safe issue text.
 *
 * This checks trusted URL provenance and required setting field names, then binds terminal browser
 * evidence to the exact canonical URL bytes. It does not parse or select the reporter's extension
 * version, filter IDs, or Stealth value; the typed browser tool still owns those postconditions.
 *
 * @param issue - Prompt-safe issue exposed to the reasoning model.
 * @returns Canonical import URLs keyed by their SHA-256 digest.
 */
export function reporterSettingsImportUrls(issue: RawIssue): ReadonlyMap<string, string> {
    const text = [
        issue.title,
        issue.body ?? '',
        ...issue.comments.map((comment) => comment.body),
    ].join('\n');
    const urls = new Map<string, string>();
    for (const match of text.matchAll(REPORT_SETTINGS_URL_PATTERN)) {
        try {
            const url = new URL(match[0].replace(/&amp;/giu, '&'));
            if (
                url.protocol === 'https:' &&
                TRUSTED_REPORT_SETTINGS_HOSTS.has(url.hostname.toLowerCase()) &&
                url.username.length === 0 &&
                url.password.length === 0 &&
                url.port.length === 0 &&
                url.hash.length === 0 &&
                url.searchParams.has('product_version') &&
                url.searchParams.has('regular_filters') &&
                url.searchParams.has('stealth.enabled')
            ) {
                urls.set(canonicalAdGuardSettingsImportUrlSha256(url.href), url.href);
            }
        } catch {
            // A malformed reporter URL is model-visible evidence, but cannot require exact parity.
        }
    }
    return urls;
}

/**
 * List the query parameters whose values differ between two import URLs.
 *
 * @param reporterUrl - The reporter's import URL.
 * @param requestedUrl - The URL a launch requested.
 * @returns Every differing parameter, in reporter order, then the ones only the request carries.
 */
function parameterDifferences(reporterUrl: URL, requestedUrl: URL): ImportUrlParameterDifference[] {
    const names = [
        ...new Set([...reporterUrl.searchParams.keys(), ...requestedUrl.searchParams.keys()]),
    ];
    return names.flatMap((parameter) => {
        const reporter = reporterUrl.searchParams.getAll(parameter).join('&') || null;
        const requested = requestedUrl.searchParams.getAll(parameter).join('&') || null;
        return reporter === requested ? [] : [{ parameter, reporter, requested }];
    });
}

/**
 * Refuse a `reported_on_current` launch whose import URL is not one the reporter supplied.
 *
 * @param requestedImportUrl - The import URL the launch request carries.
 * @param reporterUrls - The reporter's import URLs, keyed by digest.
 * @returns The refusal naming the nearest reporter URL and what differs from it, or undefined when
 *   the request carries a reporter URL or the report supplies none.
 */
export function reporterImportUrlRefusal(
    requestedImportUrl: string,
    reporterUrls: ReadonlyMap<string, string>,
): Record<string, unknown> | undefined {
    if (reporterUrls.size === 0) {
        return undefined;
    }
    // Compared as sent, exactly as the terminal gate compares it: a URL still carrying Markdown
    // `&amp;` separators passes neither, and the differences name the mangled parameters.
    const requested = new URL(requestedImportUrl);
    if (reporterUrls.has(canonicalAdGuardSettingsImportUrlSha256(requested.href))) {
        return undefined;
    }
    const [nearest] = [...reporterUrls.values()]
        .map((href) => ({ href, differences: parameterDifferences(new URL(href), requested) }))
        .sort((left, right) => left.differences.length - right.differences.length);
    return {
        error:
            'settings.importUrl is not the import URL the reporter supplied. A ' +
            'reported_on_current session proves reporter parity only with that exact URL.',
        errorKind: 'reporter_import_url_mismatch',
        retryable: true,
        requiredAction: 'launch_with_reporter_import_url',
        reporterImportUrl: nearest!.href,
        differences: nearest!.differences,
        guidance: [
            'Pass reporterImportUrl as settings.importUrl unchanged.',
            'Keep every filter ID, including third-party ones: filters the prepared build does not',
            'carry are skipped at launch and recorded as a filter-selection approximation.',
        ],
    };
}
