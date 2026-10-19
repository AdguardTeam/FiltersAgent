import { RuleKind, normalizeRule } from '../repo/rule-normalizer';

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
 * Resolve the selector whose browser evidence may validate a candidate.
 *
 * Cosmetic candidates are bound to their own selector so a model-supplied selector cannot make one
 * rule appear validated by probing a different element; a CSS injection rule contributes its
 * selector without the declaration block, which `querySelectorAll` would refuse. Network rules have
 * no embedded CSS selector, so they may use the model-supplied selector that identifies the
 * affected page element. A scriptlet names no element, so it has none.
 *
 * @param candidateRule - The candidate rule being validated.
 * @param adElementSelector - Optional model-supplied selector for a network candidate.
 * @returns The selector bound to validation evidence, or an empty string when none is safe.
 */
export function resolveValidatedSelector(
    candidateRule: string,
    adElementSelector?: string,
): string {
    const normalizedCandidate = normalizeRule(candidateRule);
    if (normalizedCandidate.kind === RuleKind.Cosmetic) {
        return extractAdSelector(candidateRule)?.trim() || '';
    }
    if (normalizedCandidate.kind === RuleKind.Network) {
        return adElementSelector?.trim() || '';
    }
    return '';
}
