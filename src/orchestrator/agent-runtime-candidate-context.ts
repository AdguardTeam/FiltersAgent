/**
 * The path-free candidate vocabulary the {@link AgentRuntime} shares with the modules split out of
 * it: the per-run budgets, the candidate ledger key, the candidate held across the browser
 * dispatch, and prompt-safe target-URL binding.
 *
 * It holds no runtime state and imports nothing from the runtime, so the split modules never import
 * the runtime back.
 */
import { CandidateOperation } from '../environment/filtering-environment';
import type { NormalizedSafeInteractionPlan } from '../environment/safe-interaction';
import { decodeIssueTextUrl } from '../github/issue-text-url';
import type { NormalizedRule } from '../repo/rule-normalizer';
import { FixOutcomeKind, type FixOutcome } from '../types/fix-outcome';
import type { DomCheckPlan } from './apply-rule-dom-checks';

/**
 * Maximum distinct candidates one run may validate with `apply_rule`.
 *
 * Each candidate is a full A/B/C browser experiment plus a vision review, so the cap bounds the
 * run's cost; three leaves room for a first rule and two corrections after its review.
 */
export const MAX_CANDIDATE_ATTEMPTS = 3;

/**
 * How many more distinct candidates a run may still validate.
 *
 * @param spentAttempts - Distinct candidates the run's ledger holds.
 * @returns The unspent attempts, never below zero.
 */
export function remainingCandidateAttempts(spentAttempts: number): number {
    return Math.max(0, MAX_CANDIDATE_ATTEMPTS - spentAttempts);
}

/**
 * Maximum technical browser failures allowed for one prompt-safe target during a run.
 */
export const MAX_TECHNICAL_BROWSER_FAILURES_PER_TARGET = 3;

/**
 * Compose the candidate-ledger key shared by the attempt, outcome, and retry bookkeeping.
 *
 * The operation participates so an add, edit, and remove of the same rule text stay distinct
 * attempts instead of colliding as duplicates.
 *
 * @param operation - Candidate operation against the published baseline.
 * @param canonical - Canonical normalized rule text.
 * @returns Stable composed ledger key.
 */
export function candidateLedgerKey(operation: CandidateOperation, canonical: string): string {
    return `${operation}:${canonical}`;
}

/**
 * Candidate metadata retained across the browser dispatch boundary.
 */
export interface PendingCandidateAttempt {
    /**
     * The model-proposed rule exactly as it would be published, outer whitespace trimmed.
     *
     * The experiment applies these bytes, not the normalized form: the verdict and the published
     * evidence bind the validation to the rule text the run publishes, and the normalized form
     * reorders and lowercases a network rule's modifiers.
     */
    rule: string;

    /**
     * Shared normalized representation of the model-proposed rule.
     */
    normalized: NormalizedRule;

    /**
     * One-based runtime candidate attempt number.
     */
    attemptNumber: number;

    /**
     * Candidate operation against the published baseline; add when omitted by the model.
     */
    operation: CandidateOperation;

    /**
     * Exact published baseline line targeted by an edit or remove operation, verbatim.
     *
     * Never normalized: baseline mutation receipts compare the exact published bytes.
     */
    originalRule?: string;

    /**
     * Reveal steps this call passed, replayed in every phase; absent when it passed none.
     */
    revealPlan?: NormalizedSafeInteractionPlan;

    /**
     * DOM checks this call attached, measured in the baseline and the candidate phase; absent when
     * it attached none.
     */
    domChecks?: DomCheckPlan;
}

/**
 * Discriminator used to narrow a terminal outcome to its draft variant.
 */
interface ProposeRuleOutcomeDiscriminator {
    /**
     * Draft terminal variant.
     */
    outcome: typeof FixOutcomeKind.ProposeRule;
}

/**
 * Draft outcome narrowed from the terminal decision union.
 */
export type ProposeRuleOutcome = Extract<FixOutcome, ProposeRuleOutcomeDiscriminator>;

/**
 * Normalize one HTTP(S) URL for exact prompt-safe target binding.
 *
 * The fragment is preserved: single-page players keep the video identity there, so a check session
 * that navigates without it loads a different page than the reporter described and reports the
 * resulting emptiness as breakage.
 *
 * The issue text's `&amp;` query separators are decoded: the extraction copies the reported URL
 * verbatim, and the model may echo either spelling. Both bind to the same decoded allow-list entry,
 * so validation opens the page the reporter visited, never one whose parameters are named
 * `amp;<name>`. A URL the browser landed on is decoded the same way, one level per call.
 *
 * @param value - Untrusted URL from issue parsing, model arguments, or a browser landing.
 * @returns Canonical URL including its fragment, or undefined for unsupported input.
 */
export function canonicalTargetUrl(value: string): string | undefined {
    try {
        const url = new URL(decodeIssueTextUrl(value));
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
            return undefined;
        }
        return url.href;
    } catch {
        return undefined;
    }
}

/**
 * Reduce one target URL to its fragment-insensitive identity.
 *
 * Fragments never reach the network, so fragment variants address the same document: they match the
 * same prompt-safe allow-list entry and share one failed-environment identity.
 *
 * @param value - Untrusted URL from issue parsing or model arguments.
 * @returns Canonical URL without its fragment, or undefined for unsupported input.
 */
export function targetUrlMatchKey(value: string): string | undefined {
    const canonical = canonicalTargetUrl(value);
    if (canonical === undefined) {
        return undefined;
    }
    const url = new URL(canonical);
    url.hash = '';
    return url.href;
}

/**
 * Bind one model-supplied target URL to the exact prompt-safe URL it addresses.
 *
 * The bound value always comes from the allow-list rather than from the model echo, so a model that
 * drops or rewrites the fragment still navigates to the URL the reporter supplied. An echo whose
 * document matches several allow-list fragments stays unbound instead of guessing between them.
 *
 * @param requested - Untrusted target URL echoed by the model.
 * @param allowedTargetUrls - Exact prompt-safe URLs extracted outside the model loop.
 * @returns Canonical allow-list URL, or undefined when unmatched or ambiguous.
 */
export function bindAllowedTargetUrl(
    requested: string,
    allowedTargetUrls: readonly string[],
): string | undefined {
    const canonical = canonicalTargetUrl(requested);
    if (canonical === undefined) {
        return undefined;
    }
    const allowed = allowedTargetUrls
        .map(canonicalTargetUrl)
        .filter((url): url is string => url !== undefined);
    if (allowed.includes(canonical)) {
        return canonical;
    }
    const requestedKey = targetUrlMatchKey(canonical);
    const documentVariants = allowed.filter((url) => targetUrlMatchKey(url) === requestedKey);
    return documentVariants.length === 1 ? documentVariants[0] : undefined;
}

/**
 * Derive the runner-bound reported hostname from the first valid prompt-safe target URL.
 *
 * @param values - Exact browser targets extracted outside the model loop.
 * @returns Canonical hostname used only to rank repository search results.
 */
export function reportedDomainFromAllowedTargets(values: readonly string[]): string | undefined {
    for (const value of values) {
        const canonical = canonicalTargetUrl(value);
        if (canonical) {
            return new URL(canonical).hostname.toLowerCase().replace(/\.$/u, '');
        }
    }
    return undefined;
}

/**
 * Bounded validation bookkeeping retained for one canonical candidate across browser executions.
 */
export interface CandidateValidationOutcome {
    /**
     * One-based runtime candidate attempt number.
     */
    attemptNumber: number;

    /**
     * Vision verdict returned by the attempt, when available.
     */
    visualVerdict?: string;

    /**
     * Bounded vision rationale used only to distinguish technical unavailability from a verdict.
     */
    visualRationale?: string;

    /**
     * Latest runner-owned validation artifact emitted for this canonical candidate.
     */
    validationArtifactId?: string;

    /**
     * Number of browser-bound executions of this semantic candidate.
     */
    validationAttemptCount: number;
}
