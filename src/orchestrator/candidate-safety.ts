import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { FixOutcomeKind, type FixOutcome } from '../types/fix-outcome';
import { isIncorrectBlockingReport, ProblemType } from '../types/issue-facts';
import {
    RuleKind,
    SINGLE_LINE_RULE_MESSAGE,
    isSingleLineRule,
    normalizeRule,
} from '../repo/rule-normalizer';
import { RuleType, type RuleProposal } from '../types/rule-proposal';
import {
    MAX_CANDIDATE_FOR_REVIEW_RULE_CHARACTERS,
    MAX_UNVERIFIED_REASON_CHARACTERS,
    type CandidateForReview,
} from '../types/candidate-for-review';
import { candidateScopeProblem, normalizeScopeDomain } from './candidate-scope';
import type { DeclaredPlacementSet } from '../types/declared-placement';
import { planRepositoryEdit } from '../repo/repository-edit';
import type { Logger } from '../logger/logger';
import { PolicyDecisionKind } from '../types/policy';

/**
 * Repository and issue context needed for deterministic candidate validation.
 */
export interface CandidateSafetyOptions {
    /**
     * Canonical hostname reported by the issue.
     */
    reportedDomain: string;

    /**
     * Local AdguardFilters checkout used to verify the target file and duplicates.
     */
    checkoutPath?: string;

    /**
     * Parsed problem class of the report driving this run.
     *
     * Exception rules are eligible only for incorrect-blocking and anti-adblock reports, where a
     * domain-scoped exception is a common human remedy; for every other class they stay rejected.
     * Either way the exception must be scoped to the reported site.
     */
    problemType?: ProblemType;

    /**
     * The run's declared placements, rendered once at run start, when its instruction declares any.
     *
     * The gate re-plans the edit to verify the target, so it must plan the same edit the patch
     * will: against the file the declaration names for this candidate's kind. Planning the routed
     * way instead would reject a declared placement for an ambiguity — a shared-rule owner
     * elsewhere — that the declaration has already settled.
     */
    declaredPlacement?: DeclaredPlacementSet;
}

/**
 * A rule-type label the gate replaced with the type parsed from the rule text.
 */
export interface RuleTypeCorrection {
    /**
     * The label the model wrote on its proposal.
     */
    from: RuleType;

    /**
     * The type the rule text parses to, which the accepted outcome now carries.
     */
    to: RuleType;
}

/**
 * Safe outcome after deterministic candidate validation.
 */
export interface CandidateSafetyDecision {
    /**
     * The safe outcome with its rule type taken from the rule text, or an analysis-only downgrade.
     */
    outcome: FixOutcome;

    /**
     * Explicit rejection reason, or null when no candidate was rejected.
     */
    rejectionReason: string | null;

    /**
     * The model's rule-type label the gate replaced, when it disagreed with the parsed rule.
     */
    ruleTypeCorrection?: RuleTypeCorrection;
}

/**
 * Error used internally to turn every unsafe candidate into an analysis-only result.
 */
class CandidateSafetyError extends Error {
    /**
     * Create a deterministic candidate rejection.
     *
     * @param message - Human-readable rejection reason.
     */
    constructor(message: string) {
        super(message);
        this.name = 'CandidateSafetyError';
    }
}

/**
 * Map a parsed syntax kind to the proposal schema's intentionally broad rule type.
 *
 * Scriptlets use cosmetic-rule separators and remain part of the general `cosmetic` category; their
 * concrete `scriptlet` syntax is preserved separately by the runner.
 *
 * @param kind - Parsed rule kind returned by the normalizer.
 * @returns The compatible proposal rule type, or null for non-actionable input.
 */
function generalRuleTypeForKind(kind: RuleKind): RuleType | null {
    if (kind === RuleKind.Network) {
        return RuleType.Network;
    }
    if (kind === RuleKind.Cosmetic || kind === RuleKind.Scriptlet) {
        return RuleType.Cosmetic;
    }
    return null;
}

/**
 * Search repository filter files for an exact canonical duplicate without trusting model output.
 *
 * Hidden directories, dependency trees, and symbolic links are excluded so the scan remains inside
 * the checked-out filter corpus.
 *
 * @param checkoutPath - Verified local AdguardFilters checkout.
 * @param candidateCanonical - Canonical candidate rule to locate.
 * @returns Whether any regular `.txt` filter file already contains the exact candidate.
 */
function hasExactDuplicate(checkoutPath: string, candidateCanonical: string): boolean {
    const checkoutRoot = realpathSync(checkoutPath);
    const directories = [checkoutRoot];

    while (directories.length > 0) {
        const directory = directories.pop();
        if (!directory) {
            continue;
        }
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            if (entry.isSymbolicLink()) {
                continue;
            }
            const entryPath = resolve(directory, entry.name);
            if (entry.isDirectory()) {
                if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
                    directories.push(entryPath);
                }
                continue;
            }
            if (
                entry.isFile() &&
                entry.name.endsWith('.txt') &&
                readFileSync(entryPath, 'utf8')
                    .split(/\r?\n/)
                    .some((line) => normalizeRule(line).canonical === candidateCanonical)
            ) {
                return true;
            }
        }
    }

    return false;
}

/**
 * Reject a candidate and keep both its reasoning and the rule itself for the report.
 *
 * The downgraded outcome carries the rule as its candidate for review, with the gate's reason as
 * why it stays unverified: a rule the browser may well have verified must reach the maintainer as a
 * rule, not as a sentence buried in the reasoning. A rule that is not one filter line cannot be
 * carried that way — it would be a second, unreviewed rule — so it stays in the reasoning only.
 *
 * @param draftReasoning - Reasoning of the unsafe propose-rule outcome.
 * @param proposal - Rule proposal of that draft.
 * @param reason - Deterministic rejection reason.
 * @returns Analysis-only safety decision.
 */
function rejectCandidate(
    draftReasoning: string,
    proposal: RuleProposal,
    reason: string,
): CandidateSafetyDecision {
    const reasoning =
        draftReasoning.length > 0
            ? `${draftReasoning} Candidate rejected: ${reason}`
            : `Candidate rejected: ${reason}`;
    const candidateForReview = candidateForReviewOf(proposal, reason);
    return {
        outcome: {
            outcome: FixOutcomeKind.AnalysisOnly,
            reasoning,
            ...(candidateForReview === undefined ? {} : { candidateForReview }),
        },
        rejectionReason: reason,
    };
}

/**
 * Carry a draft's rule to the report as a candidate for review, with why it stays unverified.
 *
 * A rule that is not one filter line cannot be carried that way — it would be a second, unreviewed
 * rule — so it stays in the reasoning only.
 *
 * @param proposal - Rule proposal of the draft that will not be published.
 * @param reason - Why the run does not publish it.
 * @returns The candidate for review, or undefined when the rule is not one filter line.
 */
export function candidateForReviewOf(
    proposal: RuleProposal,
    reason: string,
): CandidateForReview | undefined {
    const { rule, placement } = proposal;
    if (!isSingleLineRule(rule) || rule.length > MAX_CANDIDATE_FOR_REVIEW_RULE_CHARACTERS) {
        return undefined;
    }
    return {
        rule,
        placement: { filePath: placement.filePath },
        unverifiedReason: reason.slice(0, MAX_UNVERIFIED_REASON_CHARACTERS),
    };
}

/**
 * Whether a report class may be fixed with an exception rule.
 *
 * Incorrect blocking is fixed by unblocking what a list blocked. An anti-adblock wall is often
 * fixed the same way: the detector probes an ad resource, and a domain-scoped exception lets that
 * probe succeed so the wall never shows. The scope gate below still requires that exception to name
 * the reported site.
 *
 * @param problemType - The report's problem class.
 * @returns Whether an exception rule may be the candidate.
 */
function isExceptionEligibleReport(problemType: ProblemType | undefined): boolean {
    return isIncorrectBlockingReport(problemType) || problemType === ProblemType.AntiAdblock;
}

/**
 * Enforce deterministic publication invariants before a runtime candidate reaches the publisher.
 *
 * The rule's type is a fact of its text, not a claim the model makes: the accepted outcome carries
 * the type the rule parses to, whatever the proposal labelled it, so placement, patch and report
 * all read the parsed type. A wrong label alone never costs a verified rule.
 *
 * Unsafe drafts are downgraded to analysis-only so the publisher can still create its single
 * report-only comment. The risk assessment is the agent's: what the rule may touch beyond the
 * reported symptom is judged from the evidence the run collected, not from keywords in the rule
 * text, and the only structural limit it answers to — a rule scoped to the reported domain alone —
 * is the scope check below.
 *
 * @param outcome - Parsed agent outcome.
 * @param options - Reported domain and checkout context.
 * @returns Safe outcome plus an explicit rejection reason when downgraded.
 */
export function enforceCandidateSafety(
    outcome: FixOutcome,
    options: CandidateSafetyOptions,
): CandidateSafetyDecision {
    if (outcome.outcome !== FixOutcomeKind.ProposeRule) {
        return { outcome, rejectionReason: null };
    }

    try {
        const proposal = outcome.ruleProposal;
        if (outcome.policyDecision.decision !== PolicyDecisionKind.AllowRuleGeneration) {
            throw new CandidateSafetyError('Policy does not allow rule generation.');
        }
        if (!proposal.productCompatibility.extension) {
            throw new CandidateSafetyError(
                'Candidate is not compatible with the browser extension.',
            );
        }
        if (!isSingleLineRule(proposal.rule)) {
            throw new CandidateSafetyError(SINGLE_LINE_RULE_MESSAGE);
        }

        // No syntax lint gates here: the in-browser phases already proved the blocker accepts and
        // applies the rule, and the repository's own lint command, when the run has one, only
        // annotates the report. That holds for a CSS injection too: the blocker applies its
        // declarations in phase C and the visual review judges what they changed, so a `#$#` rule
        // answers to the same checks as a `##` one.
        const normalized = normalizeRule(proposal.rule);
        const parsedRuleType = generalRuleTypeForKind(normalized.kind);
        if (parsedRuleType === null) {
            throw new CandidateSafetyError(
                `Candidate is not an actionable rule: it parses as ${normalized.kind}.`,
            );
        }
        if (normalized.isException && !isExceptionEligibleReport(options.problemType)) {
            throw new CandidateSafetyError(
                'Exception rules are only eligible for incorrect-blocking and anti-adblock reports.',
            );
        }
        // The scope gate below carries the rest of the exception policy: effectiveRuleScopes
        // never infers a scope for an exception, so a generic `@@||host^` without $domain=
        // (or a cosmetic exception without a domain prefix) fails closed here.
        const expectedDomain = normalizeScopeDomain(options.reportedDomain);
        const scopeProblem = candidateScopeProblem(normalized, expectedDomain);
        if (scopeProblem !== undefined) {
            throw new CandidateSafetyError(scopeProblem);
        }

        if (!options.checkoutPath) {
            throw new CandidateSafetyError(
                'Candidate target cannot be verified without a checkout.',
            );
        }
        // Planned for its refusals only: an unsafe or ambiguous target throws here, and the edit
        // it would produce is the patch builder's to read, not this gate's.
        try {
            planRepositoryEdit(
                options.checkoutPath,
                proposal.placement.filePath,
                proposal.rule,
                options.declaredPlacement,
            );
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new CandidateSafetyError(
                `Candidate target or repository placement is unsafe: ${detail}`,
            );
        }
        // The duplicate check in the proposal is the agent's reading of the rules search showed
        // it, written for the reviewer; it refuses nothing. The one duplicate code settles is the
        // mechanical one: an exact copy of the candidate already in the checkout. Refusing on the
        // class the model chose costs verified fixes: a `div[class^="sc-"]:has(…)` rule noted
        // `semantic` against an `aside > …` rule sibling sites carry, or one noted `cross-filter`
        // against EasyList's own vendor rule.
        const candidateCanonical = normalized.canonical;
        if (hasExactDuplicate(options.checkoutPath!, candidateCanonical)) {
            throw new CandidateSafetyError('Candidate rule already exists in the checkout.');
        }

        if (parsedRuleType === proposal.ruleType) {
            return { outcome, rejectionReason: null };
        }
        return {
            outcome: { ...outcome, ruleProposal: { ...proposal, ruleType: parsedRuleType } },
            rejectionReason: null,
            ruleTypeCorrection: { from: proposal.ruleType, to: parsedRuleType },
        };
    } catch (error) {
        const reason =
            error instanceof CandidateSafetyError
                ? error.message
                : `Candidate safety validation failed: ${(error as Error).message}`;
        return rejectCandidate(outcome.reasoning, outcome.ruleProposal, reason);
    }
}

/**
 * Log what the gate changed about the accepted terminal: a corrected rule-type label, a downgrade.
 *
 * Both are silent to the model, so the run log is the one place a reader can learn that the gate
 * relabelled a rule or why a draft the session accepted ended analysis-only.
 *
 * @param logger - Run logger.
 * @param terminal - The terminal outcome the session accepted, before the gate.
 * @param decision - The gate's decision on it.
 */
export function logCandidateSafetyDecision(
    logger: Logger,
    terminal: FixOutcome,
    decision: CandidateSafetyDecision,
): void {
    const rule =
        terminal.outcome === FixOutcomeKind.ProposeRule ? terminal.ruleProposal.rule : undefined;
    if (decision.ruleTypeCorrection !== undefined) {
        logger.info(
            { rule, ...decision.ruleTypeCorrection },
            'candidate rule type label corrected to the type parsed from the rule',
        );
    }
    if (decision.rejectionReason !== null) {
        logger.warn(
            { rule, rejectionReason: decision.rejectionReason },
            'candidate safety gate downgraded the accepted draft to analysis-only',
        );
    }
}
