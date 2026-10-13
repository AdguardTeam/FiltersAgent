/**
 * Concrete AdGuard syntax families an actionable filter rule can use.
 */
export const RuleSyntaxKind = {
    ElementHiding: 'element_hiding',
    CssInjection: 'css_injection',
    ExtendedElementHiding: 'extended_element_hiding',
    ExtendedCss: 'extended_css',
    Network: 'network',
    Scriptlet: 'scriptlet',
} as const;

export const RULE_SYNTAX_KIND_VALUES = Object.values(RuleSyntaxKind);

/**
 * One concrete AdGuard rule syntax kind.
 */
export type RuleSyntaxKind = (typeof RuleSyntaxKind)[keyof typeof RuleSyntaxKind];
