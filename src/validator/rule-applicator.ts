import type { Page, Route } from 'playwright-core';
import { RuleKind, normalizeRule } from '../repo/rule-normalizer';
import { isSafeCosmeticSelector, parseSafeCssInjectionRule } from '../rules/safe-css-injection';

/**
 * One network route installed by the validator for later phase cleanup.
 */
interface AppliedNetworkRoute {
    /**
     * Playwright glob registered for the filter rule.
     */
    pattern: string;

    /**
     * Exact route handler reference required by `page.unroute`.
     */
    handler: (route: Route) => Promise<void>;
}

/**
 * Validator-owned network routes, isolated from the persistent public-network safety route.
 */
const appliedNetworkRoutes = new WeakMap<Page, AppliedNetworkRoute[]>();

/**
 * Abort one request matched by a validator-owned network rule.
 *
 * @param route - Matched Playwright route.
 * @returns Nothing after the route is aborted.
 */
async function abortRoute(route: Route): Promise<void> {
    await route.abort();
}

/**
 * Safe result of attempting to apply one rule in the validation browser.
 */
export interface RuleApplicationResult {
    /**
     * Whether the rule was applied to the page.
     */
    applied: boolean;

    /**
     * Removes the exact injected cosmetic style when reversible validation is available.
     */
    cleanup?: () => Promise<void>;

    /**
     * Explanation when the rule was skipped or unsupported.
     */
    error?: string;
}

/**
 * Extract the URL pattern from a network filter rule.
 *
 * Strips the leading `||`, `|`, `@@||`, `@@|` prefix and trailing `^` suffix, as well as modifiers
 * after `$`. Returns the bare hostname/path pattern suitable for `page.route()` matching
 * (glob-style).
 *
 * @param rule - The raw filter rule line.
 * @returns The URL pattern, or null if the rule is not a network rule.
 */
export function extractNetworkPattern(rule: string): string | null {
    const trimmed = rule.trim();
    if (trimmed.length === 0 || trimmed.startsWith('!')) {
        return null;
    }

    // Only process network rules (those without cosmetic/scriptlet separators).
    const normalized = normalizeRule(trimmed);
    if (normalized.kind !== RuleKind.Network) {
        return null;
    }

    let pattern = trimmed;

    // Strip exception prefix
    if (pattern.startsWith('@@')) {
        pattern = pattern.slice(2);
    }

    // Strip modifiers after $
    const dollarIdx = pattern.indexOf('$');
    if (dollarIdx !== -1) {
        pattern = pattern.slice(0, dollarIdx);
    }

    // Strip URL-prefix markers
    if (pattern.startsWith('||')) {
        pattern = pattern.slice(2);
    } else if (pattern.startsWith('|')) {
        pattern = pattern.slice(1);
    }

    // Strip trailing ^ (separator character) but preserve * wildcards
    if (pattern.endsWith('^')) {
        pattern = pattern.slice(0, -1);
    }

    return pattern.trim() || null;
}

/**
 * Extract a CSS selector from a cosmetic filter rule.
 *
 * Handles `##`, `#@#`, `#?#`, `#@?#`, and `#$#` CSS injection. Does not match scriptlet rules. For
 * CSS injection, returns only the selector before the declaration block. Searches for the LAST
 * occurrence of any regular cosmetic separator to handle rules like
 * `domain.com#@#.ads#?#.override`.
 *
 * @param rule - The raw filter rule line.
 * @returns The CSS selector portion, or null if no cosmetic CSS separator found.
 */
export function extractAdSelector(rule: string): string | null {
    const trimmed = rule.trim();
    if (trimmed.length === 0) {
        return null;
    }

    const normalized = normalizeRule(trimmed);
    if (normalized.kind !== RuleKind.Cosmetic) {
        return null;
    }
    if (normalized.cssInjectionBody !== undefined) {
        return normalized.selector?.trim() || null;
    }

    const separators = ['#@?#', '#@#', '#?#', '##'] as const;
    let bestSep = '';
    let bestIndex = -1;

    for (const sep of separators) {
        const idx = trimmed.lastIndexOf(sep);
        if (idx > bestIndex) {
            bestIndex = idx;
            bestSep = sep;
        }
    }

    if (bestIndex === -1 || bestSep === '') {
        return null;
    }
    return trimmed.slice(bestIndex + bestSep.length);
}

/**
 * Build a glob pattern from a URL pattern for `page.route()`.
 *
 * Wraps the pattern in Playwright double-star wildcards so it matches anywhere in a full URL,
 * including across protocol and path separators. Leading and trailing AdGuard wildcards are
 * redundant once the pattern is unanchored, so they are normalized before wrapping.
 *
 * @param urlPattern - The extracted URL pattern.
 * @returns A glob pattern suitable for `page.route()`.
 */
function toGlobPattern(urlPattern: string): string {
    const unanchoredPattern = urlPattern.replace(/^\*+/, '').replace(/\*+$/, '');
    return `**${unanchoredPattern}**`;
}

/**
 * Remove only network filter routes installed by previous validation phases.
 *
 * @param page - Page whose validator-owned routes should be cleared.
 */
export async function clearAppliedNetworkRules(page: Page): Promise<void> {
    const registrations = appliedNetworkRoutes.get(page) ?? [];
    for (const registration of registrations) {
        await page.unroute(registration.pattern, registration.handler);
    }
    appliedNetworkRoutes.delete(page);
}

/**
 * Apply a single filter rule in the browser page.
 *
 * Uses `normalizeRule` to classify the rule kind, then dispatches:
 *
 * - **Network**: registers a `page.route()` handler that aborts matching requests.
 * - **Cosmetic**: injects a `<style>` element via `page.addStyleTag()`.
 * - **Scriptlet**: rejected because raw scriptlet text cannot be evaluated safely.
 * - **Comment / empty / unknown**: silently skipped.
 * - **Exception rules**: silently skipped (no route/style applied).
 *
 * @param page - The Playwright Page to apply the rule to.
 * @param rule - The raw filter rule line.
 * @returns Whether the rule was applied, with an error for skipped or unsupported input.
 */
export async function applyRule(page: Page, rule: string): Promise<RuleApplicationResult> {
    const trimmed = rule.trim();
    if (trimmed.length === 0) {
        return { applied: false, error: 'Rule is empty.' };
    }

    const normalized = normalizeRule(trimmed);

    switch (normalized.kind) {
        case RuleKind.Network: {
            if (normalized.isException) {
                // Exception network rules are silently skipped.
                return { applied: false, error: 'Exception network rules are not applied.' };
            }
            const pattern = extractNetworkPattern(trimmed);
            if (!pattern) {
                return { applied: false, error: 'Network pattern is empty.' };
            }
            const glob = toGlobPattern(pattern);
            await page.route(glob, abortRoute);
            const registrations = appliedNetworkRoutes.get(page) ?? [];
            registrations.push({ pattern: glob, handler: abortRoute });
            appliedNetworkRoutes.set(page, registrations);
            return { applied: true };
        }
        case RuleKind.Cosmetic: {
            if (normalized.isException) {
                // Exception cosmetic rules are silently skipped.
                return { applied: false, error: 'Exception cosmetic rules are not applied.' };
            }
            if (normalized.cssInjectionBody !== undefined) {
                const parsed = parseSafeCssInjectionRule(trimmed);
                if (!parsed.value) {
                    return {
                        applied: false,
                        error: `Unsafe CSS injection: ${parsed.error ?? 'rejected'}`,
                    };
                }
                const styleHandle = await page.addStyleTag({ content: parsed.value.css });
                const cleanup = styleHandle
                    ? async (): Promise<void> => {
                          await styleHandle.evaluate((element) => element.remove());
                      }
                    : undefined;
                return { applied: true, cleanup };
            }
            const selector = extractAdSelector(trimmed);
            if (!selector) {
                return { applied: false, error: 'Cosmetic selector is empty.' };
            }
            if (!isSafeCosmeticSelector(selector)) {
                return { applied: false, error: 'Unsafe cosmetic selector.' };
            }
            // Escape the selector for safe CSS injection.
            // The selector may contain characters that need escaping in a style tag,
            // but for a CSS rule the selector is used as-is since it's valid CSS.
            const css = `${selector} { display: none !important; }`;
            const styleHandle = await page.addStyleTag({ content: css });
            const cleanup = styleHandle
                ? async (): Promise<void> => {
                      await styleHandle.evaluate((element) => element.remove());
                  }
                : undefined;
            return { applied: true, cleanup };
        }
        case RuleKind.Scriptlet: {
            return {
                applied: false,
                error: 'Scriptlet validation is unsupported; raw scriptlet text was not evaluated.',
            };
        }
        case RuleKind.Comment:
        case RuleKind.Empty:
        case RuleKind.Unknown:
        default:
            // Silently skip.
            return { applied: false, error: `Rule kind '${normalized.kind}' is not applicable.` };
    }
}
