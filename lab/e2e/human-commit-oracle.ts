import {
    RuleKind,
    COSMETIC_SEPARATORS,
    normalizeRule,
    type NormalizedRule,
    type RuleSyntaxKind,
} from '../../src/repo/rule-normalizer';
import { RepositoryEditKind } from '../../src/types/repository-edit-kind';

/**
 * One actionable rule change extracted from the human fix commit.
 */
export interface HumanFixCandidate {
    /**
     * Domain-delta rule for an extension, or the complete inserted/replacement rule.
     */
    rule: string;

    /**
     * Deterministically parsed AdGuard rule syntax.
     */
    syntaxKind: RuleSyntaxKind;

    /**
     * Repository-relative filter file modified by the human commit.
     */
    filePath: string;

    /**
     * Whether the human inserted, extended, or replaced a repository rule.
     */
    repositoryEdit: Exclude<RepositoryEditKind, typeof RepositoryEditKind.Remove>;

    /**
     * Complete added line retained for audit when rule is a domain delta.
     */
    sourceRule: string;

    /**
     * Exact first-parent rule removed by a replacement edit.
     */
    replacedRule?: string;
}

/**
 * Actionable first-parent rule removed without a paired replacement line.
 */
export interface HumanRemovedRule {
    /**
     * Exact removed filter rule.
     */
    rule: string;

    /**
     * Deterministically parsed AdGuard rule syntax.
     */
    syntaxKind: RuleSyntaxKind;

    /**
     * Repository-relative filter file containing the removal.
     */
    filePath: string;
}

/**
 * First-parent human fix diff converted into filter-rule candidates.
 */
export interface ExtractedHumanFix {
    /**
     * First parent used as the diff base.
     */
    firstParent: string;

    /**
     * Every actionable added rule change across all modified filter files.
     */
    candidates: HumanFixCandidate[];

    /**
     * Actionable deletion-only rules not represented by added candidates.
     */
    removedRules: HumanRemovedRule[];
}

/**
 * One parsed actionable diff line and its deterministic rule representation.
 */
interface ParsedDiffRule {
    /**
     * Original filter line without the unified-diff prefix.
     */
    source: string;

    /**
     * Parsed filter rule used for semantic pairing.
     */
    normalized: NormalizedRule;
}

/**
 * Added and removed actionable rules in one file hunk.
 */
interface ParsedDiffHunk {
    /**
     * Repository-relative path from the added side of the diff.
     */
    filePath: string;

    /**
     * Actionable lines removed by the hunk.
     */
    removed: ParsedDiffRule[];

    /**
     * Actionable lines added by the hunk.
     */
    added: ParsedDiffRule[];
}

/**
 * Complete actionable interpretation of one human first-parent diff.
 */
export interface HumanCommitDiffChanges {
    /**
     * Added, extended, and replaced rules.
     */
    candidates: HumanFixCandidate[];

    /**
     * Removed rules not paired with an added replacement.
     */
    removedRules: HumanRemovedRule[];
}

/**
 * Location and spelling of one cosmetic-rule separator.
 */
interface CosmeticSeparatorMatch {
    /**
     * Zero-based separator offset in the complete rule.
     */
    index: number;

    /**
     * Exact AdGuard cosmetic separator found in the rule.
     */
    separator: string;
}

/**
 * Removed rule matched to domains introduced by an added replacement.
 */
interface DomainExtensionMatch {
    /**
     * Zero-based removed-rule position within the current hunk.
     */
    removedIndex: number;

    /**
     * Domains introduced by the replacement rule.
     */
    domains: string[];
}

/**
 * Decide whether one removed/added pair represents a semantic replacement.
 *
 * This intentionally stays conservative. Network rules must retain their URL pattern, while
 * cosmetic and scriptlet rules must retain their semantic body. A pure domain expansion is handled
 * earlier by {@link addedDomainDelta}; this predicate captures narrowing scopes, modifier changes,
 * and exception changes that cannot be tested by layering the added rule over its parent.
 *
 * @param removed - Candidate source rule before the human commit.
 * @param added - Candidate replacement rule after the human commit.
 * @returns Whether the added line replaces the removed line.
 */
function isSemanticReplacement(removed: ParsedDiffRule, added: ParsedDiffRule): boolean {
    const before = removed.normalized;
    const after = added.normalized;
    if (
        before.kind !== after.kind ||
        before.syntaxKind !== after.syntaxKind ||
        before.canonical === after.canonical
    ) {
        return false;
    }
    if (before.kind === RuleKind.Network) {
        return before.urlPattern === after.urlPattern;
    }
    if (before.kind === RuleKind.Scriptlet) {
        return (
            before.scriptletName === after.scriptletName &&
            before.selector === after.selector &&
            before.modifiers.join('\0') === after.modifiers.join('\0')
        );
    }
    if (before.kind === RuleKind.Cosmetic) {
        return (
            before.selector === after.selector &&
            before.cssInjectionBody === after.cssInjectionBody &&
            before.modifiers.join('\0') === after.modifiers.join('\0')
        );
    }
    return false;
}

/**
 * Return an actionable filter rule or exclude comments, blanks, and unknown syntax.
 *
 * @param source - Raw filter line from one side of a diff.
 * @returns Parsed actionable rule, or null for non-rule content.
 */
function parseActionableRule(source: string): ParsedDiffRule | null {
    const normalized = normalizeRule(source);
    if (
        !normalized.syntaxKind ||
        !([RuleKind.Network, RuleKind.Cosmetic, RuleKind.Scriptlet] as RuleKind[]).includes(
            normalized.kind,
        )
    ) {
        return null;
    }
    return { source, normalized };
}

/**
 * Decide whether an added scoped rule only expands the removed rule's domains.
 *
 * @param removed - Candidate source rule before the human commit.
 * @param added - Candidate replacement rule after the human commit.
 * @returns Newly introduced domains when all non-domain semantics remain equal.
 */
function addedDomainDelta(removed: ParsedDiffRule, added: ParsedDiffRule): string[] | null {
    const before = removed.normalized;
    const after = added.normalized;
    if (
        before.kind !== after.kind ||
        before.syntaxKind !== after.syntaxKind ||
        before.isException !== after.isException ||
        before.domains.length === 0
    ) {
        return null;
    }
    if (before.kind === RuleKind.Network) {
        const beforeModifiers = before.modifiers.filter(
            (modifier) => !modifier.startsWith('domain='),
        );
        const afterModifiers = after.modifiers.filter(
            (modifier) => !modifier.startsWith('domain='),
        );
        if (
            before.urlPattern !== after.urlPattern ||
            beforeModifiers.join('\0') !== afterModifiers.join('\0')
        ) {
            return null;
        }
    } else if (
        !([RuleKind.Cosmetic, RuleKind.Scriptlet] as RuleKind[]).includes(before.kind) ||
        before.selector !== after.selector ||
        before.cssInjectionBody !== after.cssInjectionBody ||
        before.scriptletName !== after.scriptletName ||
        before.modifiers.join('\0') !== after.modifiers.join('\0')
    ) {
        return null;
    }
    const beforePositive = before.domains.filter((domain) => !domain.startsWith('~'));
    const afterPositive = after.domains.filter((domain) => !domain.startsWith('~'));
    const beforeNegative = before.domains.filter((domain) => domain.startsWith('~'));
    const afterNegative = after.domains.filter((domain) => domain.startsWith('~'));
    if ((beforePositive.length === 0) !== (afterPositive.length === 0)) {
        return null;
    }
    const removedPositive = beforePositive.filter((domain) => !afterPositive.includes(domain));
    const addedNegative = afterNegative.filter((domain) => !beforeNegative.includes(domain));
    if (removedPositive.length > 0 || addedNegative.length > 0) {
        return null;
    }
    const addedPositive = afterPositive.filter((domain) => !beforePositive.includes(domain));
    const removedNegative = beforeNegative
        .filter((domain) => !afterNegative.includes(domain))
        .map((domain) => domain.slice(1))
        .filter((domain) => afterPositive.length === 0 || afterPositive.includes(domain));
    const delta = [...new Set([...addedPositive, ...removedNegative])];
    return delta.length > 0 ? delta : null;
}

/**
 * Find the cosmetic separator that divides a rule's domain scope from its body.
 *
 * @param source - Actionable cosmetic or scriptlet filter line.
 * @returns Separator offset and text.
 */
function findCosmeticSeparator(source: string): CosmeticSeparatorMatch {
    const matches = COSMETIC_SEPARATORS.flatMap((separator) => {
        const index = source.indexOf(separator);
        return index < 0 ? [] : [{ index, separator }];
    });
    // oxlint-disable-next-line unicorn/no-array-sort -- ES2023 toSorted is outside this target.
    matches.sort(
        (left, right) => left.index - right.index || right.separator.length - left.separator.length,
    );
    const match = matches[0];
    if (!match) {
        throw new Error(`Unable to locate a cosmetic separator in human rule: ${source}`);
    }
    return match;
}

/**
 * Build the domain-only candidate represented by one multi-domain replacement line.
 *
 * @param added - Complete added replacement rule.
 * @param domains - Domains introduced by the replacement.
 * @returns Rule scoped only to the newly added domains.
 */
function buildDomainDeltaRule(added: ParsedDiffRule, domains: string[]): string {
    if (added.normalized.kind === RuleKind.Network) {
        if (!added.normalized.urlPattern) {
            throw new Error(`Human network rule has no URL pattern: ${added.source}`);
        }
        const hasDomainModifier = added.normalized.modifiers.some((modifier) =>
            modifier.startsWith('domain='),
        );
        const modifiers = added.normalized.modifiers.map((modifier) =>
            modifier.startsWith('domain=') ? `domain=${domains.join('|')}` : modifier,
        );
        if (!hasDomainModifier) {
            modifiers.push(`domain=${domains.join('|')}`);
        }
        return (
            (added.normalized.isException ? '@@' : '') +
            added.normalized.urlPattern +
            `$${modifiers.join(',')}`
        );
    }
    const { index } = findCosmeticSeparator(added.source);
    return `${domains.join(',')}${added.source.slice(index)}`;
}

/**
 * Convert one file hunk into inserted, domain-extension, or replacement candidates.
 *
 * @param hunk - Actionable added and removed lines from one unified-diff hunk.
 * @returns Human candidates in their added-line order.
 */
function candidatesFromHunk(hunk: ParsedDiffHunk): HumanCommitDiffChanges {
    const matchedRemoved = new Set<number>();
    const candidates = hunk.added.map((added) => {
        let extension: DomainExtensionMatch | undefined;
        for (const [removedIndex, removed] of hunk.removed.entries()) {
            if (matchedRemoved.has(removedIndex)) {
                continue;
            }
            const domains = addedDomainDelta(removed, added);
            if (domains) {
                extension = { removedIndex, domains };
                break;
            }
        }
        if (extension) {
            matchedRemoved.add(extension.removedIndex);
            return {
                rule: buildDomainDeltaRule(added, extension.domains),
                syntaxKind: added.normalized.syntaxKind!,
                filePath: hunk.filePath,
                repositoryEdit: RepositoryEditKind.ExtendDomains,
                sourceRule: added.source,
            };
        }
        for (const [removedIndex, removed] of hunk.removed.entries()) {
            if (matchedRemoved.has(removedIndex) || !isSemanticReplacement(removed, added)) {
                continue;
            }
            matchedRemoved.add(removedIndex);
            return {
                rule: added.source,
                syntaxKind: added.normalized.syntaxKind!,
                filePath: hunk.filePath,
                repositoryEdit: RepositoryEditKind.Replace,
                sourceRule: added.source,
                replacedRule: removed.source,
            };
        }
        return {
            rule: added.source,
            syntaxKind: added.normalized.syntaxKind!,
            filePath: hunk.filePath,
            repositoryEdit: RepositoryEditKind.Insert,
            sourceRule: added.source,
        };
    });
    const removedRules = hunk.removed.flatMap((removed, index) =>
        matchedRemoved.has(index)
            ? []
            : [
                  {
                      rule: removed.source,
                      syntaxKind: removed.normalized.syntaxKind!,
                      filePath: hunk.filePath,
                  },
              ],
    );
    return { candidates, removedRules };
}

/**
 * Parse every actionable rule change from a first-parent unified diff.
 *
 * @param diff - Zero-context or regular unified diff generated by git.
 * @returns Added candidates and unpaired deletion-only rules.
 */
export function parseHumanCommitDiffChanges(diff: string): HumanCommitDiffChanges {
    const hunks: ParsedDiffHunk[] = [];
    let currentFile: string | null = null;
    let currentHunk: ParsedDiffHunk | null = null;
    for (const line of diff.split(/\r?\n/u)) {
        if (line.startsWith('+++ b/')) {
            currentFile = line.slice('+++ b/'.length);
            continue;
        }
        if (line.startsWith('@@')) {
            if (!currentFile) {
                continue;
            }
            currentHunk = { filePath: currentFile, removed: [], added: [] };
            hunks.push(currentHunk);
            continue;
        }
        if (!currentHunk) {
            continue;
        }
        if (line.startsWith('+') && !line.startsWith('+++')) {
            const parsed = parseActionableRule(line.slice(1));
            if (parsed) {
                currentHunk.added.push(parsed);
            }
            continue;
        }
        if (line.startsWith('-') && !line.startsWith('---')) {
            const parsed = parseActionableRule(line.slice(1));
            if (parsed) {
                currentHunk.removed.push(parsed);
            }
        }
    }
    const parsed = hunks.map(candidatesFromHunk);
    return {
        candidates: parsed.flatMap((entry) => entry.candidates),
        removedRules: parsed.flatMap((entry) => entry.removedRules),
    };
}

/**
 * Parse every actionable rule addition from a first-parent unified diff.
 *
 * @param diff - Zero-context or regular unified diff generated by git.
 * @returns Ordered inserted, domain-extension, and replacement candidates across all files/hunks.
 */
export function parseHumanCommitDiff(diff: string): HumanFixCandidate[] {
    return parseHumanCommitDiffChanges(diff).candidates;
}

/**
 * Original actionable rule lines on both sides of a human commit's diff.
 */
export interface HumanCommitRuleLines {
    /**
     * Complete added rules, including both domain expansions and replacement lines.
     */
    added: string[];
    /**
     * Complete removed rules, including lines paired with an addition.
     */
    removed: string[];
}

/**
 * Collect original rule lines without the semantic transformations used for replay candidates.
 *
 * @param diff - Unified diff containing the human commit's added and removed lines.
 * @returns Every actionable added and removed line in diff order.
 */
export function parseHumanCommitRuleLines(diff: string): HumanCommitRuleLines {
    const lines: HumanCommitRuleLines = { added: [], removed: [] };
    let inHunk = false;
    for (const line of diff.split(/\r?\n/u)) {
        if (line.startsWith('diff --git ')) {
            inHunk = false;
        } else if (line.startsWith('@@')) {
            inHunk = true;
        }
        if (!inHunk) {
            continue;
        }
        const source = line.slice(1);
        if ((line.startsWith('+') || line.startsWith('-')) && parseActionableRule(source)) {
            (line.startsWith('+') ? lines.added : lines.removed).push(source);
        }
    }
    return lines;
}
