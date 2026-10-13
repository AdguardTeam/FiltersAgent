import { RuleSyntaxKind } from '../types/rule-syntax-kind';
import {
    isAdGuardScriptletBody,
    isUboScriptletBody,
    scriptletNameFromBody,
} from './scriptlet-syntax';

/**
 * The kind of an AdGuard filter rule, inferred from its syntax.
 */
/**
 * Inferred rule kinds; the single source for the union type and every kind comparison.
 */
export const RuleKind = {
    Network: 'network',
    Cosmetic: 'cosmetic',
    Scriptlet: 'scriptlet',
    Comment: 'comment',
    Empty: 'empty',
    Unknown: 'unknown',
} as const;

/**
 * Inferred rule kind of one filter line.
 */
export type RuleKind = (typeof RuleKind)[keyof typeof RuleKind];

/**
 * The concrete AdGuard syntax used by an actionable filter rule.
 */
export type { RuleSyntaxKind } from '../types/rule-syntax-kind';

/**
 * The normalized form of a single AdGuard filter rule, used for equivalence comparison.
 *
 * Two semantically-equivalent rules (differing only in modifier/domain order) produce identical
 * {@link NormalizedRule.canonical} strings.
 */
export interface NormalizedRule {
    /**
     * Canonical string form used for equality comparison.
     */
    canonical: string;

    /**
     * Inferred rule kind.
     */
    kind: RuleKind;

    /**
     * Concrete syntax inferred from the rule text, when the line is an actionable rule.
     */
    syntaxKind?: RuleSyntaxKind;

    /**
     * Whether the rule is an exception (allowlist / unhide).
     */
    isException: boolean;

    /**
     * For network rules: the normalized URL pattern. Undefined otherwise.
     */
    urlPattern?: string;

    /**
     * Sorted, lowercased modifiers for network rules (e.g. "domain=a|b", "script").
     */
    modifiers: string[];

    /**
     * For cosmetic/scriptlet rules: the normalized selector or scriptlet body.
     */
    selector?: string;

    /**
     * Sorted, lowercased, deduped domain list the rule applies to. Empty = generic.
     */
    domains: string[];

    /**
     * For scriptlet rules: the extracted scriptlet name. Absent when the rule injects no named
     * scriptlet, as uBlock Origin's argument-less `#@#+js()` exception does.
     */
    scriptletName?: string;

    /**
     * For `#$#` CSS injection rules: the complete CSS body to inject into the page.
     */
    cssInjectionBody?: string;
}

/**
 * Normalize a trusted reported hostname for conservative first-party scope comparison.
 *
 * The value must be a bare hostname rather than a URL, credential-bearing authority, port, or path.
 * A leading `www.` and trailing root dot are ignored to match issue-domain normalization.
 *
 * @param value - Runner-provided reported hostname.
 * @returns The normalized hostname, or undefined when the value is not a bare hostname.
 */
function normalizeTrustedReportedHostname(value: string): string | undefined {
    const input = value.trim().toLowerCase();
    if (input.length === 0) {
        return undefined;
    }
    try {
        const parsed = new URL(`http://${input}`);
        if (
            parsed.username.length > 0 ||
            parsed.password.length > 0 ||
            parsed.port.length > 0 ||
            parsed.pathname !== '/' ||
            parsed.search.length > 0 ||
            parsed.hash.length > 0
        ) {
            return undefined;
        }
        return parsed.hostname.replace(/^www\./u, '').replace(/\.$/u, '');
    } catch {
        return undefined;
    }
}

/**
 * Characters that would split one rule across two lines of a filter file.
 *
 * A rule is written verbatim as a single line, so an embedded CR or LF does not produce a longer
 * rule — it produces a second, unreviewed one, and whatever follows the break is applied without
 * ever having passed lint, risk scoring, or the scope gate.
 */
const RULE_LINE_BREAK_PATTERN = /[\r\n]/u;

/**
 * Whether a rule can be written verbatim as exactly one filter-file line.
 *
 * @param rule - Untrusted candidate or replacement rule text.
 * @returns Whether the text is non-empty and carries no line break.
 */
export function isSingleLineRule(rule: string): boolean {
    return rule.length > 0 && !RULE_LINE_BREAK_PATTERN.test(rule);
}

/**
 * Rejection stated when a candidate rule is not a single non-empty line.
 *
 * The safety gate that downgrades the run and the applier that writes the line both refuse on the
 * same condition, so they refuse in the same words: a reader comparing the two rejections should
 * see one invariant, not two that happen to agree today.
 */
export const SINGLE_LINE_RULE_MESSAGE = 'Candidate rule must be a non-empty single line.';

/**
 * Resolve scopes that are safe to use for deterministic candidate-risk and publication checks.
 *
 * Explicit cosmetic prefixes and `$domain=` modifiers remain the primary scopes. A bare network
 * rule receives one inferred scope only when it is a non-exception, host-anchored, wildcard-free
 * path on the exact trusted reported hostname. One optional trailing `^` separator anchor and the
 * sole narrowing `$script` resource-type modifier are safe; host-only patterns, foreign hosts,
 * wildcard paths, internal separators, and all other modifier sets remain generic because their
 * effective blast radius is broader or ambiguous.
 *
 * @param rule - Deterministically normalized filter rule.
 * @param trustedReportedDomain - Reported hostname bound by the runner, never model input.
 * @returns Explicit scopes or one conservatively inferred first-party scope.
 */
export function effectiveRuleScopes(
    rule: NormalizedRule,
    trustedReportedDomain?: string,
): string[] {
    if (rule.domains.length > 0) {
        return [...rule.domains];
    }
    if (
        rule.kind !== RuleKind.Network ||
        rule.isException ||
        (rule.modifiers.length > 0 &&
            !(rule.modifiers.length === 1 && rule.modifiers[0] === 'script')) ||
        !rule.urlPattern ||
        !trustedReportedDomain
    ) {
        return [];
    }

    const match = /^\|\|([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)\/([^*|^]+)(?:\^)?$/iu.exec(
        rule.urlPattern,
    );
    if (!match) {
        return [];
    }

    const targetHostname = normalizeTrustedReportedHostname(match[1]);
    const reportedHostname = normalizeTrustedReportedHostname(trustedReportedDomain);
    return targetHostname && targetHostname === reportedHostname ? [reportedHostname] : [];
}

/**
 * Cosmetic/scriptlet separator markers in AdGuard filter rule syntax.
 *
 * Order matters: longer separators must appear before shorter ones that are substrings or prefixes
 * of them, because {@link findCosmeticSeparator} returns the first `indexOf` hit. Placing `#@?#`
 * before `#@#` and `#$#` before the network `$`/`##` checks ensures procedural and scriptlet forms
 * are matched before their shorter look-alikes. Exported so downstream callers (e.g. rule-type
 * detection in the evidence pack, and the lint_rule tool in `src/agent/tool-factory.ts`) reuse the
 * same classification — there is exactly one source of truth.
 */
export const COSMETIC_SEPARATORS = [
    '#@$?#',
    '#$?#',
    '#@?#',
    '#@%#',
    '#@$#',
    '#@#',
    '#%#',
    '#$#',
    '#?#',
    '##',
] as const;

/**
 * Infer the concrete syntax represented by a cosmetic separator.
 *
 * Scriptlet injection is spelled two ways: AdGuard's dedicated `#%#` / `#@%#` separators plus a
 * `//scriptlet(...)` body behind `#$#` / `#@$#`, and uBO's `+js(...)` body behind the plain
 * element-hiding `##` / `#@#`. Both are the scriptlet syntax; the body decides wherever the
 * separator alone cannot.
 *
 * @param separator - The matched cosmetic separator.
 * @param body - The normalized rule body after the separator.
 * @returns The actionable syntax kind.
 */
function syntaxKindForCosmeticSeparator(
    separator: (typeof COSMETIC_SEPARATORS)[number],
    body: string,
): RuleSyntaxKind {
    if (
        separator === '#%#' ||
        separator === '#@%#' ||
        ((separator === '#$#' || separator === '#@$#') && isAdGuardScriptletBody(body)) ||
        ((separator === '##' || separator === '#@#') && isUboScriptletBody(body))
    ) {
        return RuleSyntaxKind.Scriptlet;
    }
    if (separator === '#$?#' || separator === '#@$?#') {
        return RuleSyntaxKind.ExtendedCss;
    }
    if (separator === '#?#' || separator === '#@?#') {
        return RuleSyntaxKind.ExtendedElementHiding;
    }
    if (separator === '#$#' || separator === '#@$#') {
        return RuleSyntaxKind.CssInjection;
    }
    return RuleSyntaxKind.ElementHiding;
}

/**
 * Collapse internal whitespace runs to single spaces and trim.
 *
 * @param s - The string to collapse.
 * @returns The whitespace-normalized string.
 */
function collapseWhitespace(s: string): string {
    return s.trim().replace(/\s+/g, ' ');
}

/**
 * Sort, lowercase, and dedupe a comma- or pipe-separated domain list.
 *
 * @param raw - The raw delimited string.
 * @param sep - The delimiter ("," or "|").
 * @returns The normalized domain list.
 */
function normalizeDomainList(raw: string, sep: string): string[] {
    return Array.from(
        new Set(
            raw
                .split(sep)
                .map((d) => d.trim().toLowerCase())
                .filter((d) => d.length > 0),
        ),
    ).sort();
}

/**
 * Normalize a single modifier (e.g. "domain=a|b" → "domain=a|b" sorted; "script" → "script").
 *
 * @param mod - A single modifier token from the `$`-separated list.
 * @returns The normalized modifier string.
 */
function normalizeModifier(mod: string): string {
    const trimmed = mod.trim().toLowerCase();
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
        return trimmed;
    }
    const key = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1);
    if (key === 'domain') {
        return `${key}=${normalizeDomainList(value, '|').join('|')}`;
    }
    return `${key}=${value}`;
}

/**
 * A located cosmetic separator within a rule line.
 */
export interface CosmeticSeparatorMatch {
    /**
     * The matched separator string (e.g. "##", "#@#", "#%#").
     */
    sep: (typeof COSMETIC_SEPARATORS)[number];

    /**
     * The 0-based character index where the separator begins.
     */
    index: number;
}

/**
 * Find the first cosmetic separator occurrence in a line.
 *
 * @param line - The raw rule line.
 * @returns The separator and its index, or undefined if none found.
 */
export function findCosmeticSeparator(line: string): CosmeticSeparatorMatch | undefined {
    for (const sep of COSMETIC_SEPARATORS) {
        const index = line.indexOf(sep);
        if (index !== -1) {
            return { sep, index };
        }
    }
    return undefined;
}

/**
 * Normalize an AdGuard filter rule line into a canonical form for comparison.
 *
 * @param line - A single raw line from a filter file.
 * @returns The normalized rule descriptor.
 */
export function normalizeRule(line: string): NormalizedRule {
    const raw = line.trim();
    const base: NormalizedRule = {
        canonical: raw,
        kind: RuleKind.Unknown,
        isException: false,
        modifiers: [],
        domains: [],
    };
    if (raw.length === 0) {
        return { ...base, kind: RuleKind.Empty, canonical: '' };
    }
    if (raw.startsWith('!')) {
        return { ...base, kind: RuleKind.Comment };
    }

    const cosmetic = findCosmeticSeparator(raw);
    if (cosmetic) {
        const { sep, index } = cosmetic;
        const domainsPart = raw.slice(0, index);
        const rawBody = raw.slice(index + sep.length).trim();
        const body = collapseWhitespace(rawBody);
        const domains = normalizeDomainList(domainsPart, ',');
        const isException = sep.startsWith('#@');
        const syntaxKind = syntaxKindForCosmeticSeparator(sep, body);
        const isScriptlet = syntaxKind === RuleSyntaxKind.Scriptlet;
        if (isScriptlet) {
            // A uBO rule stays in uBO spelling: the canonical string is what search results,
            // placement and edits show a uAssets maintainer, so respelling `##+js(...)` as `#%#`
            // would hand them a rule their own repository does not write. AdGuard's `#$#`
            // scriptlet spelling still collapses onto `#%#`, as it always has.
            const adGuardSeparator = isException ? '#@%#' : '#%#';
            const canonicalSeparator = isUboScriptletBody(body) ? sep : adGuardSeparator;
            return {
                canonical: `${domains.join(',')}${canonicalSeparator}${body}`,
                kind: RuleKind.Scriptlet,
                syntaxKind,
                isException,
                modifiers: [],
                domains,
                selector: body,
                scriptletName: scriptletNameFromBody(body),
            };
        }
        if (
            syntaxKind === RuleSyntaxKind.CssInjection ||
            syntaxKind === RuleSyntaxKind.ExtendedCss
        ) {
            const declarationIndex = body.indexOf('{');
            const selector = collapseWhitespace(
                declarationIndex === -1 ? body : body.slice(0, declarationIndex),
            );
            return {
                canonical: `${domains.join(',')}${sep}${body}`,
                kind: RuleKind.Cosmetic,
                syntaxKind,
                isException,
                modifiers: [],
                domains,
                selector,
                cssInjectionBody: rawBody,
            };
        }
        return {
            canonical: `${domains.join(',')}${sep}${body}`,
            kind: RuleKind.Cosmetic,
            syntaxKind,
            isException,
            modifiers: [],
            domains,
            selector: body,
        };
    }

    // Network rule: split on first $.
    const dollar = raw.indexOf('$');
    let pattern = raw;
    let modifiersRaw = '';
    if (dollar !== -1) {
        pattern = raw.slice(0, dollar);
        modifiersRaw = raw.slice(dollar + 1);
    }
    const isException = pattern.startsWith('@@');
    if (isException) {
        pattern = pattern.slice(2);
    }
    const urlPattern = pattern.trim().toLowerCase();
    const modifiers = modifiersRaw
        .split(',')
        .map(normalizeModifier)
        .filter((m) => m.length > 0)
        .sort();
    // Every `domain=` modifier counts: the blocker applies the rule on the union of them, so
    // reading only the first would let `$domain=a,domain=a|b` pass a scope check for `a` alone.
    const domains = normalizeDomainList(
        modifiers
            .filter((m) => m.startsWith('domain='))
            .map((m) => m.slice('domain='.length))
            .join('|'),
        '|',
    );
    const canonical =
        (isException ? '@@' : '') +
        urlPattern +
        (modifiers.length > 0 ? `$${modifiers.join(',')}` : '');
    return {
        canonical,
        kind: RuleKind.Network,
        syntaxKind: RuleSyntaxKind.Network,
        isException,
        urlPattern,
        modifiers,
        domains,
    };
}
