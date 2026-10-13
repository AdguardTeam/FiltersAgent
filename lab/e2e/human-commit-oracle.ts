import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    RuleKind,
    COSMETIC_SEPARATORS,
    normalizeRule,
    type NormalizedRule,
    type RuleSyntaxKind,
} from '../../src/repo/rule-normalizer';
import { runPreparationSubprocess } from '../../src/local/preparation-subprocess';
import { RepositoryEditKind } from '../../src/types/repository-edit-kind';

const FULL_COMMIT_PATTERN = /^[0-9a-f]{40}$/iu;
const DEFAULT_FILTERS_REMOTE = 'https://github.com/AdguardTeam/AdguardFilters.git';

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
     * Full human fix commit supplied by the closed post-run oracle.
     */
    commit: string;

    /**
     * First parent used as the diff base.
     */
    firstParent: string;

    /**
     * Every actionable added rule change across all modified filter files.
     */
    candidates: HumanFixCandidate[];

    /**
     * Exact zero-context first-parent diff retained for post-lock review.
     */
    rawDiff?: string;

    /**
     * Actionable deletion-only rules not represented by added candidates.
     */
    removedRules?: HumanRemovedRule[];
}

/**
 * Injectable read-only git seam used by human oracle tests and production extraction.
 */
export interface HumanCommitGitReader {
    /**
     * Reads commit parents in the order recorded by git.
     *
     * @param commit - Full commit to inspect.
     * @returns Ordered full parent SHAs.
     */
    readParents(commit: string): Promise<string[]>;

    /**
     * Reads a zero-context text-filter diff between one parent and its child.
     *
     * @param parent - Selected first parent.
     * @param commit - Human fix commit.
     * @returns Unified diff containing modified text filter files.
     */
    readDiff(parent: string, commit: string): Promise<string>;
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
interface ParsedHumanCommitDiff {
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
 * Require one immutable full git object identifier.
 *
 * @param commit - Commit string supplied by trusted post-run metadata or git.
 * @param label - Diagnostic field label.
 */
function assertFullCommit(commit: string, label: string): void {
    if (!FULL_COMMIT_PATTERN.test(commit)) {
        throw new Error(`${label} must be a full 40-character SHA.`);
    }
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
function candidatesFromHunk(hunk: ParsedDiffHunk): ParsedHumanCommitDiff {
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
function parseHumanCommitDiffDetails(diff: string): ParsedHumanCommitDiff {
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
    return parseHumanCommitDiffDetails(diff).candidates;
}

/**
 * Run one read-only git command and surface bounded diagnostics.
 *
 * @param cwd - Disposable repository directory.
 * @param args - Git arguments passed without a shell.
 * @returns Captured stdout.
 */
async function runGit(cwd: string, args: string[]): Promise<string> {
    const result = await runPreparationSubprocess({ executable: 'git', args, cwd });
    if (result.exitCode !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim() || 'no command output';
        throw new Error(
            `git ${args.join(' ')} failed with exit code ${result.exitCode}: ${detail}`,
        );
    }
    return result.stdout;
}

/**
 * Build the shallow fetch used by the disposable human-commit reader.
 *
 * The requested commit and its first parent are small enough to fetch with blobs. Avoiding a
 * partial clone prevents a later `git diff` from making an implicit lazy network request whose
 * transport failure would hide the already-locked fix-agent result.
 *
 * @param commit - Full human fix commit.
 * @returns Git arguments for a complete depth-two fetch.
 */
export function buildHumanCommitFetchArgs(commit: string): string[] {
    return ['fetch', '--quiet', '--depth', '2', '--no-tags', DEFAULT_FILTERS_REMOTE, commit];
}

/**
 * Create a disposable shallow repository containing the human commit and its first parent.
 *
 * @param commit - Full human fix commit.
 * @param callback - Extraction work performed while the repository exists.
 * @returns Callback result.
 */
async function withDisposableGitReader<T>(
    commit: string,
    callback: (reader: HumanCommitGitReader) => Promise<T>,
): Promise<T> {
    const directory = await mkdtemp(join(tmpdir(), 'adguard-human-oracle-'));
    try {
        await runGit(directory, ['init', '--quiet']);
        await runGit(directory, buildHumanCommitFetchArgs(commit));
        const reader: HumanCommitGitReader = {
            async readParents(targetCommit) {
                const output = await runGit(directory, [
                    'show',
                    '--no-patch',
                    '--format=%P',
                    targetCommit,
                ]);
                return output.trim().split(/\s+/u).filter(Boolean);
            },
            async readDiff(parent, targetCommit) {
                return await runGit(directory, [
                    'diff',
                    '--no-ext-diff',
                    '--unified=0',
                    '--no-renames',
                    parent,
                    targetCommit,
                    '--',
                    '*.txt',
                ]);
            },
        };
        return await callback(reader);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

/**
 * Extract actionable candidates from the first-parent diff of one human fix commit.
 *
 * The optional reader is the injectable git seam. Without it, a disposable shallow fetch of the
 * public AdguardFilters repository is used and removed after extraction.
 *
 * @param commit - Full human fix commit loaded only after the agent result is locked.
 * @param reader - Optional test or caller-provided read-only git adapter.
 * @returns Verified first-parent identity and every actionable human candidate.
 */
export async function extractHumanCommitFix(
    commit: string,
    reader?: HumanCommitGitReader,
): Promise<ExtractedHumanFix> {
    assertFullCommit(commit, 'Human fix commit');
    const extract = async (git: HumanCommitGitReader): Promise<ExtractedHumanFix> => {
        const parents = await git.readParents(commit);
        const firstParent = parents[0];
        if (!firstParent) {
            throw new Error(`Human fix commit ${commit} has no first parent.`);
        }
        assertFullCommit(firstParent, 'Human fix first parent');
        const rawDiff = await git.readDiff(firstParent, commit);
        const parsed = parseHumanCommitDiffDetails(rawDiff);
        if (parsed.candidates.length === 0 && parsed.removedRules.length === 0) {
            throw new Error(`Human fix commit ${commit} adds no actionable filter rules.`);
        }
        return {
            commit,
            firstParent,
            candidates: parsed.candidates,
            rawDiff,
            removedRules: parsed.removedRules,
        };
    };
    return reader ? await extract(reader) : await withDisposableGitReader(commit, extract);
}
