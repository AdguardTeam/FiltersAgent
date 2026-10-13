import { RuleKind, normalizeRule } from '../repo/rule-normalizer';

/**
 * Maximum pixel length accepted by the isolated browser validator.
 */
const MAX_SAFE_PIXEL_LENGTH = 4096;

/**
 * Layout-only properties that may be applied by an automatically validated CSS injection rule.
 */
const SAFE_LAYOUT_PROPERTIES = new Set(['height', 'min-height', 'max-height']);

/**
 * Conservative length grammar supported by the automatic CSS injection validator.
 */
const SAFE_LENGTH_VALUE = /^(?:0|(?:\d+(?:\.\d+)?px))(?:\s*!important)?$/i;

/**
 * A CSS injection that is safe to insert into the isolated validation page.
 */
export interface SafeCssInjection {
    /**
     * Exact single selector affected by the declaration block.
     */
    selector: string;

    /**
     * Canonical single-ruleset CSS to inject.
     */
    css: string;
}

/**
 * Result of parsing a CSS injection rule against the fail-closed validator grammar.
 */
export interface SafeCssInjectionParseResult {
    /**
     * Parsed safe CSS when the rule satisfies every restriction.
     */
    value?: SafeCssInjection;

    /**
     * Human-readable rejection reason when the rule is outside the safe subset.
     */
    error?: string;
}

/**
 * Collapse selector whitespace in the same way as the rule normalizer.
 *
 * @param value - Selector text to normalize.
 * @returns Trimmed selector with internal whitespace collapsed.
 */
function collapseWhitespace(value: string): string {
    return value.trim().replace(/\s+/g, ' ');
}

/**
 * Extract the numeric portion of a safe pixel value.
 *
 * @param value - Validated CSS declaration value.
 * @returns Numeric pixel value, or zero for the unitless zero form.
 */
function extractPixelLength(value: string): number {
    const withoutImportant = value.replace(/\s*!important$/i, '').trim();
    return withoutImportant === '0' ? 0 : Number.parseFloat(withoutImportant);
}

/**
 * Check that a cosmetic selector cannot terminate the validator-owned declaration block.
 *
 * @param selector - Selector extracted from a plain cosmetic rule.
 * @returns True when the selector cannot escape into an additional CSS ruleset.
 */
export function isSafeCosmeticSelector(selector: string): boolean {
    const trimmed = selector.trim();
    return (
        trimmed.length > 0 &&
        !/[;@\r\n\f]/.test(trimmed) &&
        !trimmed.includes('{') &&
        !trimmed.includes('}') &&
        !trimmed.includes('/*') &&
        !trimmed.includes('*/') &&
        !trimmed.includes('\0')
    );
}

/**
 * Parse one AdGuard `#$#` rule into a deliberately narrow, layout-only CSS subset.
 *
 * The validator accepts exactly one selector and one declaration block. It rejects selector lists,
 * additional rulesets, at-rules, comments, functions, non-pixel lengths, duplicate properties, and
 * every property except height bounds. The returned CSS is reconstructed from parsed declarations
 * so untrusted source text is never inserted verbatim.
 *
 * @param rule - Raw AdGuard filter rule.
 * @returns Parsed canonical CSS, or a deterministic rejection reason.
 */
export function parseSafeCssInjectionRule(rule: string): SafeCssInjectionParseResult {
    const normalized = normalizeRule(rule);
    const rawBody = normalized.cssInjectionBody?.trim();
    if (normalized.kind !== RuleKind.Cosmetic || rawBody === undefined) {
        return { error: 'Rule is not a CSS injection.' };
    }
    if (rawBody.includes('/*') || rawBody.includes('*/') || rawBody.includes('@')) {
        return { error: 'Comments and at-rules are not allowed.' };
    }

    const openingBrace = rawBody.indexOf('{');
    const closingBrace = rawBody.lastIndexOf('}');
    if (
        openingBrace <= 0 ||
        closingBrace !== rawBody.length - 1 ||
        openingBrace !== rawBody.lastIndexOf('{') ||
        closingBrace !== rawBody.indexOf('}')
    ) {
        return { error: 'Exactly one complete CSS ruleset is required.' };
    }

    const selector = collapseWhitespace(rawBody.slice(0, openingBrace));
    if (
        selector.length === 0 ||
        selector.includes(',') ||
        !isSafeCosmeticSelector(selector) ||
        selector !== collapseWhitespace(normalized.selector ?? '')
    ) {
        return { error: 'Exactly one normalized selector is required.' };
    }

    const declarationBody = rawBody.slice(openingBrace + 1, closingBrace).trim();
    const fragments = declarationBody.split(';');
    if (fragments.at(-1)?.trim() === '') {
        fragments.pop();
    }
    if (fragments.length === 0 || fragments.some((fragment) => fragment.trim().length === 0)) {
        return { error: 'At least one complete declaration is required.' };
    }

    const seenProperties = new Set<string>();
    const declarations: string[] = [];
    for (const fragment of fragments) {
        const colon = fragment.indexOf(':');
        if (colon <= 0 || colon !== fragment.lastIndexOf(':')) {
            return { error: 'Every declaration must contain exactly one colon.' };
        }
        const property = fragment.slice(0, colon).trim().toLowerCase();
        const value = collapseWhitespace(fragment.slice(colon + 1));
        if (!SAFE_LAYOUT_PROPERTIES.has(property)) {
            return { error: `Property '${property}' is not allowed.` };
        }
        if (seenProperties.has(property)) {
            return { error: `Property '${property}' may only appear once.` };
        }
        if (!SAFE_LENGTH_VALUE.test(value) || extractPixelLength(value) > MAX_SAFE_PIXEL_LENGTH) {
            return { error: `Value '${value}' is outside the safe pixel-length subset.` };
        }
        seenProperties.add(property);
        declarations.push(`${property}: ${value};`);
    }

    return {
        value: {
            selector,
            css: `${selector} { ${declarations.join(' ')} }`,
        },
    };
}
