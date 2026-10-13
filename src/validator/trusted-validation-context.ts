import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { domainScopeCovers } from '../repo/domain-scope';
import { generatePlacementMap } from '../repo/placement-map';
import { RuleKind, normalizeRule } from '../repo/rule-normalizer';

/**
 * Version marker included in deterministic validation-baseline hashes.
 */
const BASELINE_HASH_VERSION = 1;

/**
 * Immutable browser-validation inputs derived outside the model trust boundary.
 */
export interface TrustedValidationContext {
    /**
     * Exact reported URL parsed from the current issue.
     */
    readonly reportedUrl: string;

    /**
     * Canonical repository rules scoped to the reported hostname.
     */
    readonly existingRules: readonly string[];

    /**
     * SHA-256 hash of the hostname-bound canonical rule baseline.
     */
    readonly baselineHash: string;
}

/**
 * Check whether a hostname falls within a positive or excluded AdGuard domain scope.
 *
 * The scope itself and its subdomains match. A uBlock Origin entity scope (`shellshock.*`) matches
 * the same registrable name under any public suffix, so an entity-scoped rule reaches the reported
 * hostname and belongs in the baseline the local applicator measures against.
 *
 * @param hostname - Lowercase hostname parsed from the reported URL.
 * @param rawScope - Normalized AdGuard domain token, optionally prefixed with `~` or `*.`.
 * @returns True when the hostname is covered by the scope.
 */
function hostnameMatchesScope(hostname: string, rawScope: string): boolean {
    const withoutExclusion = rawScope.startsWith('~') ? rawScope.slice(1) : rawScope;
    const scope = withoutExclusion.startsWith('*.') ? withoutExclusion.slice(2) : withoutExclusion;
    return domainScopeCovers(scope, hostname);
}

/**
 * Determine whether a normalized rule's explicit domain scope applies to a hostname.
 *
 * Generic rules are deliberately excluded because the configured AdGuard extension already owns the
 * generic filter baseline. This list supplies deterministic site-scoped rules to the local
 * three-phase applicator.
 *
 * @param hostname - Lowercase hostname parsed from the reported URL.
 * @param domains - Normalized positive and `~`-excluded AdGuard domain tokens.
 * @returns True when at least one positive scope matches and no exclusion matches.
 */
function domainScopeApplies(hostname: string, domains: string[]): boolean {
    const excluded = domains.some(
        (domain) => domain.startsWith('~') && hostnameMatchesScope(hostname, domain),
    );
    if (excluded) {
        return false;
    }
    return domains.some(
        (domain) => !domain.startsWith('~') && hostnameMatchesScope(hostname, domain),
    );
}

/**
 * Sort strings by code-point order without depending on the host locale.
 *
 * @param left - First string.
 * @param right - Second string.
 * @returns Negative, zero, or positive ordering value.
 */
function compareCanonicalRules(left: string, right: string): number {
    if (left < right) {
        return -1;
    }
    if (left > right) {
        return 1;
    }
    return 0;
}

/**
 * Read and canonicalize all explicit repository rules applicable to a reported hostname.
 *
 * @param hostname - Lowercase hostname parsed from the reported URL.
 * @param checkoutPath - Root of the pinned AdguardFilters checkout.
 * @returns Deduplicated canonical rules in deterministic order.
 */
function collectCanonicalDomainRules(hostname: string, checkoutPath: string): string[] {
    const map = generatePlacementMap(checkoutPath);
    const canonicalRules = new Set<string>();

    for (const file of map.files) {
        const lines = readFileSync(join(checkoutPath, file.relativePath), 'utf8').split(/\r?\n/);
        for (const line of lines) {
            const normalized = normalizeRule(line);
            if (
                normalized.kind !== RuleKind.Network &&
                normalized.kind !== RuleKind.Cosmetic &&
                normalized.kind !== RuleKind.Scriptlet
            ) {
                continue;
            }
            if (domainScopeApplies(hostname, normalized.domains)) {
                canonicalRules.add(normalized.canonical);
            }
        }
    }

    const orderedRules: string[] = [];
    for (const rule of canonicalRules) {
        const insertionIndex = orderedRules.findIndex(
            (existingRule) => compareCanonicalRules(rule, existingRule) < 0,
        );
        if (insertionIndex === -1) {
            orderedRules.push(rule);
        } else {
            orderedRules.splice(insertionIndex, 0, rule);
        }
    }
    return orderedRules;
}

/**
 * Hash the canonical hostname-bound baseline used by browser validation.
 *
 * @param hostname - Lowercase hostname parsed from the reported URL.
 * @param existingRules - Deterministically ordered canonical rules.
 * @returns Full lowercase SHA-256 digest.
 */
function hashBaseline(hostname: string, existingRules: string[]): string {
    const payload = JSON.stringify({
        version: BASELINE_HASH_VERSION,
        hostname,
        rules: existingRules,
    });
    return createHash('sha256').update(payload).digest('hex');
}

/**
 * Parse and validate a reported URL used as a browser-validation trust boundary.
 *
 * @param reportedUrl - Exact URL parsed from the current issue.
 * @returns Parsed HTTP(S) URL.
 */
function parseReportedHttpUrl(reportedUrl: string): URL {
    let parsedUrl: URL;
    try {
        parsedUrl = new URL(reportedUrl);
    } catch {
        throw new Error('Trusted validation requires a valid reported URL.');
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        throw new Error('Trusted validation requires an HTTP(S) reported URL.');
    }
    return parsedUrl;
}

/**
 * Calculate the deterministic hash for an exact reported URL's canonical rule baseline.
 *
 * Only the reported hostname and ordered canonical rules affect the digest. Paths may differ while
 * retaining the same site baseline, but the exact URL remains a separately verified field.
 *
 * @param reportedUrl - Exact URL parsed from the current issue.
 * @param existingRules - Ordered canonical repository rules for the hostname.
 * @returns Full lowercase SHA-256 digest.
 */
export function calculateTrustedBaselineHash(
    reportedUrl: string,
    existingRules: readonly string[],
): string {
    const parsedUrl = parseReportedHttpUrl(reportedUrl);
    return hashBaseline(parsedUrl.hostname.toLowerCase(), [...existingRules]);
}

/**
 * Create immutable browser-validation inputs from trusted issue and checkout data.
 *
 * The URL is validated but intentionally not reserialized, so the validator navigates to the exact
 * path, query, and fragment that the reporter supplied.
 *
 * The baseline is recomputed at the verdict, after the between-phases application has applied the
 * candidate, and both computations see the same checkout: the state the host maintains for a
 * file-backed verification lives in the run's own host-state directory, outside the checkout, so
 * nothing the run wrote can move the hash and unbind the very candidate it carries.
 *
 * @param reportedUrl - Exact URL parsed from the current issue.
 * @param checkoutPath - Root of the pinned AdguardFilters checkout.
 * @returns Frozen validation context with canonical rules and a deterministic baseline hash.
 */
export function createTrustedValidationContext(
    reportedUrl: string,
    checkoutPath: string,
): TrustedValidationContext {
    const parsedUrl = parseReportedHttpUrl(reportedUrl);

    const hostname = parsedUrl.hostname.toLowerCase();
    const existingRules = collectCanonicalDomainRules(hostname, checkoutPath);
    const frozenRules = Object.freeze([...existingRules]);
    return Object.freeze({
        reportedUrl,
        existingRules: frozenRules,
        baselineHash: calculateTrustedBaselineHash(reportedUrl, existingRules),
    });
}
