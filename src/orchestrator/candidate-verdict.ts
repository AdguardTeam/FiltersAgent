/**
 * The candidate verdict: everything between a submitted terminal outcome and the patch a run is
 * allowed to publish — extracting the proposal, deciding whether the runner-bound proof selected in
 * `candidate-validation-selection.ts` is complete, and gating the patch on browser evidence.
 *
 * It lives beside the fix core rather than inside it so the verdict depends only on the evidence
 * handed to it.
 */
import { createHash } from 'node:crypto';
import * as v from 'valibot';
import { FixOutcomeKind, ReproductionStatus, type FixOutcome } from '../types/fix-outcome';
import { planRepositoryEdit } from '../repo/repository-edit';
import { normalizeRule } from '../repo/rule-normalizer';
import { isSameSiteUrl } from '../browser/site-identity';
import { appliedRulesMatch } from './applied-rules-match';
import type { DeclaredPlacementSet } from '../types/declared-placement';
import { RepositoryEditKind } from '../types/repository-edit-kind';
import { parseCandidateValidationArtifactId } from '../types/candidate-artifact-identity';
import type { CandidateVisualReview } from '../types/candidate-visual-review';
import { CandidateVisualReviewSchema } from '../types/candidate-visual-review';
import {
    FixRunStatus,
    type CandidatePatch,
    type VerifiedCandidateScreenshotPaths,
} from '../types/fix-run-result';
import type { ArtifactRef, RunTrace } from '../types/trace';
import {
    hasPersistedCandidateValidation,
    verifiedCandidateScreenshotPaths,
    type CandidateValidationSelection,
} from './candidate-validation-selection';
import {
    RuleApplicationFactSchema,
    type PhaseResult,
    type RuleApplicationFact,
} from '../types/validation';
import { phaseCapturedPageState } from '../validator/tile-coverage-proof';
import {
    calculateTrustedBaselineHash,
    type TrustedValidationContext,
} from '../validator/trusted-validation-context';
import { PolicyDecisionKind } from '../types/policy';

/**
 * Convert the rich internal rule proposal to the minimal deterministic publisher payload.
 *
 * The model-echoed placement carries no in-file position by schema; the exact insertion point is
 * host-planned here from the pinned checkout and travels on `repositoryEdit`.
 *
 * A run whose instruction declares a placement for this candidate's kind plans against that
 * declaration: the patch keeps the declared file and takes the position the declaration implies —
 * the end behind the declared comment, or the inferred position when it declares none. Without a
 * declaration the patch stays in the file the agent chose.
 *
 * @param outcome - Parsed LLM fix outcome.
 * @param checkoutPath - Optional pinned checkout used to plan a domain-list extension.
 * @param declaredPlacement - The run's declared placements, rendered once at run start, when its
 *   instruction declares any.
 * @returns A candidate patch for propose-rule outcomes, otherwise null.
 */
export function candidatePatchFromOutcome(
    outcome: FixOutcome,
    checkoutPath?: string,
    declaredPlacement?: DeclaredPlacementSet,
): CandidatePatch | null {
    if (outcome.outcome !== FixOutcomeKind.ProposeRule) {
        return null;
    }
    const rule = outcome.ruleProposal.rule;
    const filePath = outcome.ruleProposal.placement.filePath;
    const normalized = normalizeRule(rule);
    if (!normalized.syntaxKind) {
        throw new Error(`Candidate has no actionable AdGuard syntax: ${rule}`);
    }
    const repositoryPlan = checkoutPath
        ? planRepositoryEdit(checkoutPath, filePath, rule, declaredPlacement)
        : { filePath, edit: { kind: RepositoryEditKind.Insert } };
    return {
        rule,
        ruleType: outcome.ruleProposal.ruleType,
        syntaxKind: normalized.syntaxKind,
        filePath: repositoryPlan.filePath,
        repositoryEdit: repositoryPlan.edit,
    };
}

/**
 * Parse the complete rule-accounting ledger emitted for one validation phase.
 *
 * @param phase - Untrusted factual phase record.
 * @returns Schema-valid ledger, or undefined when the phase predates or violates the contract.
 */
function parseRuleApplications(phase: Record<string, unknown>): RuleApplicationFact[] | undefined {
    const parsed = v.safeParse(v.array(RuleApplicationFactSchema), phase.ruleApplications);
    return parsed.success ? parsed.output : undefined;
}

/**
 * Check that one phase ledger is an exact, duplicate-free partition of trusted input rules.
 *
 * `ruleApplications` retains the exact input order; `appliedRules` must name exactly its applied
 * entries, in whatever order the producing route ran them (`appliedRulesMatch`).
 *
 * @param phase - Untrusted factual phase record.
 * @param expectedRules - Exact trusted rules supplied to the phase.
 * @returns Parsed complete ledger, or undefined when membership or execution facts diverge.
 */
function verifiedRuleApplicationPartition(
    phase: Record<string, unknown>,
    expectedRules: readonly string[],
): RuleApplicationFact[] | undefined {
    if (new Set(expectedRules).size !== expectedRules.length) {
        return undefined;
    }
    const facts = parseRuleApplications(phase);
    if (
        !facts ||
        facts.length !== expectedRules.length ||
        new Set(facts.map((fact) => fact.rule)).size !== facts.length ||
        !facts.every((fact, index) => fact.rule === expectedRules[index])
    ) {
        return undefined;
    }
    const appliedFacts = facts.filter((fact) => fact.status === 'applied').map((fact) => fact.rule);
    return appliedRulesMatch(phase.appliedRules, appliedFacts) ? facts : undefined;
}

/**
 * Apply the runner-bound visual-review gate to a model-proposed patch.
 *
 * A candidate remains eligible for the browser-unverified path only when no candidate validation
 * was attempted. Once the runner has any factual result, the final candidate must be the matching
 * verified rule. This prevents a model from bypassing a failed validation by rewriting the rule in
 * its final response without applying the rewritten form.
 *
 * @param candidatePatch - Candidate extracted from the model outcome.
 * @param hasMatchingValidation - Whether apply_rule produced evidence for this exact rule.
 * @param candidateVerified - Whether the matching runner-bound vision review verified the rule.
 * @param hasAnyValidation - Whether apply_rule attempted any candidate during this run.
 * @returns The publishable candidate, or null when factual evidence did not verify the final rule.
 */
export function candidatePatchAfterFactualValidation(
    candidatePatch: CandidatePatch | null,
    hasMatchingValidation: boolean,
    candidateVerified: boolean,
    hasAnyValidation = hasMatchingValidation,
): CandidatePatch | null {
    if (candidatePatch && hasAnyValidation && (!hasMatchingValidation || !candidateVerified)) {
        return null;
    }
    return candidatePatch;
}

/**
 * Determine whether the sealed agent trace contains an apply-rule attempt.
 *
 * Tool dispatch is recorded even when validation returns early or throws before it can persist a
 * factual artifact. Treating that call as an attempt keeps the publication gate fail-closed.
 *
 * @param trace - Sealed runner trace returned by the agent loop.
 * @returns Whether the runner dispatched the apply_rule tool at least once.
 */
export function traceHasApplyRuleAttempt(trace: RunTrace): boolean {
    return trace.events.some(
        (event) => event.type === 'tool_call' && event.payload.tool === 'apply_rule',
    );
}

/**
 * Prevent reasoning-only fallback from publishing a model-proposed filter mutation.
 *
 * A screenshot and repository search can support a useful report, but without a usable live browser
 * they cannot prove that the guessed selector exists or that the page remains intact.
 *
 * @param candidatePatch - Candidate remaining after runner-bound visual review.
 * @param browserUsable - Whether the configured live browser produced usable evidence.
 * @returns The candidate only when usable browser evidence was available, otherwise null.
 */
export function candidatePatchAfterBrowserEvidence(
    candidatePatch: CandidatePatch | null,
    browserUsable: boolean,
): CandidatePatch | null {
    return browserUsable ? candidatePatch : null;
}

/**
 * Derive the product outcome without conflating missing tool evidence with non-reproduction.
 *
 * A no-patch claim is taken as the model made it. Whether full-page vision agrees with it is
 * `finish_fix`'s question, asked while the model can still answer it: the terminal judgement
 * rejects a `not_reproduced` or `already_fixed_current` the session-bound symptom presence does not
 * support, with the reason. A second copy of that comparison here only turned a claim the gate had
 * accepted into `analysis_only` without telling anyone why.
 *
 * @param outcome - Explicit structured outcome returned by the agent.
 * @param candidatePatch - Candidate patch extracted from the outcome, when present.
 * @param browserUsable - Whether browser preflight produced usable evidence.
 * @returns The product status for the serialized result.
 */
export function deriveFixRunStatus(
    outcome: FixOutcome,
    candidatePatch: CandidatePatch | null,
    browserUsable: boolean,
): FixRunStatus {
    if (candidatePatch) {
        return FixRunStatus.PatchProposed;
    }
    if (outcome.outcome === FixOutcomeKind.ResolveWithoutPatch && browserUsable) {
        return outcome.runStatus;
    }
    if (
        outcome.outcome === FixOutcomeKind.ProposeClose &&
        outcome.reproductionStatus === ReproductionStatus.NotReproduced &&
        outcome.policyDecision.decision === PolicyDecisionKind.AllowRuleGeneration &&
        browserUsable
    ) {
        return FixRunStatus.NotReproduced;
    }
    return FixRunStatus.AnalysisOnly;
}

/**
 * Name why a runner-bound experiment does not carry a verified visual-agent review, or nothing when
 * it does.
 *
 * Browser measurements remain evidence only. This function checks mechanical provenance and
 * evidence binding; it never interprets whether page content is semantically correct. Every refusal
 * is named: without the name, a run that loses a verified candidate here cannot say which of a
 * dozen bindings slipped.
 *
 * @param factual - Parsed collect-only candidate experiment artifact.
 * @param candidatePatch - Candidate patch expected in Phase C.
 * @param expectedContext - Runner-owned issue URL and pinned repository baseline.
 * @param visualReview - Typed semantic review of the experiment's screenshots: both viewports and
 *   the full-page overviews the browser captured.
 * @returns The refusal, or undefined when mechanical experiment provenance is complete and vision
 *   verified it.
 */
export function candidatePatchVerificationRefusal(
    factual: unknown,
    candidatePatch: CandidatePatch,
    expectedContext?: TrustedValidationContext,
    visualReview?: CandidateVisualReview,
): string | undefined {
    if (factual === null || typeof factual !== 'object') {
        return 'the factual validation record is missing';
    }
    if (!expectedContext) {
        return 'the trusted validation context is missing';
    }
    if (!visualReview) {
        return 'the visual review is missing';
    }
    const parsedReview = v.safeParse(CandidateVisualReviewSchema, visualReview);
    if (!parsedReview.success) {
        return 'the visual review does not parse';
    }
    if (parsedReview.output.verdict !== 'verified') {
        return `the visual review verdict is ${parsedReview.output.verdict}`;
    }
    const review = parsedReview.output;
    const record = factual as Record<string, unknown>;
    let recomputedBaselineHash: string;
    try {
        recomputedBaselineHash = calculateTrustedBaselineHash(
            expectedContext.reportedUrl,
            expectedContext.existingRules,
        );
    } catch (error) {
        return `the trusted baseline hash could not be recomputed: ${(error as Error).message}`;
    }
    const recordedContext = record.trustedValidationContext as Record<string, unknown> | undefined;
    if (expectedContext.baselineHash !== recomputedBaselineHash) {
        return 'the trusted context does not hash to its own rules';
    }
    if (recordedContext?.reportedUrl !== expectedContext.reportedUrl) {
        return (
            `the recorded validation URL ${String(recordedContext?.reportedUrl)} differs from ` +
            `the trusted ${expectedContext.reportedUrl}`
        );
    }
    if (
        recordedContext.baselineHash !== recomputedBaselineHash ||
        recordedContext.existingRuleCount !== expectedContext.existingRules.length
    ) {
        return (
            `the recorded baseline (${String(recordedContext.existingRuleCount)} rules, hash ` +
            `${String(recordedContext.baselineHash).slice(0, 12)}) differs from the verdict-time ` +
            `baseline (${expectedContext.existingRules.length} rules, hash ` +
            `${recomputedBaselineHash.slice(0, 12)})`
        );
    }

    const candidateRuleHash = createHash('sha256').update(candidatePatch.rule).digest('hex');
    // A candidate validated more than once carries an execution suffix, so the identity is
    // compared through the parser rather than against the bare unsuffixed form.
    const reviewIdentity = parseCandidateValidationArtifactId(review.validationArtifactId);
    if (
        review.candidateRuleHash !== candidateRuleHash ||
        reviewIdentity === null ||
        reviewIdentity.candidateShortHash !== candidateRuleHash.slice(0, 12)
    ) {
        return 'the visual review identity does not match the candidate rule';
    }

    const phaseA = record.phaseA as Record<string, unknown> | undefined;
    const phaseB = record.phaseB as Record<string, unknown> | undefined;
    const phaseC = record.phaseC as Record<string, unknown> | undefined;
    if (!phaseA || !phaseB || !phaseC) {
        return 'a phase record is missing from the factual validation';
    }
    // A phase opens the reported URL and records where the browser landed. The site's own redirect
    // (`www` to the bare domain, `http` to `https`) keeps the reported page; another site does not.
    const strayPhase = [phaseA, phaseB, phaseC].find(
        (phase) => !isSameSiteUrl(String(phase.url), expectedContext.reportedUrl),
    );
    if (strayPhase) {
        return (
            `phase ${String(strayPhase.phase)} landed on ${String(strayPhase.url)}, outside the ` +
            `site of the trusted ${expectedContext.reportedUrl}`
        );
    }
    if (phaseA.error || phaseB.error || phaseC.error) {
        return 'a phase recorded an error';
    }
    if (![phaseA, phaseB, phaseC].every((phase) => phaseCapturedPageState(phase as PhaseResult))) {
        return 'a phase lacks its viewport screenshot, or both its full-page screenshot and tiles';
    }

    const phaseARuleApplications = verifiedRuleApplicationPartition(phaseA, []);
    const phaseBRuleApplications = verifiedRuleApplicationPartition(
        phaseB,
        expectedContext.existingRules,
    );
    const phaseCExpectedRules = [...expectedContext.existingRules, candidatePatch.rule];
    const phaseCRuleApplications = verifiedRuleApplicationPartition(phaseC, phaseCExpectedRules);
    const candidateApplication = phaseCRuleApplications?.at(-1);
    if (!phaseARuleApplications || !phaseBRuleApplications || !phaseCRuleApplications) {
        return 'a phase rule-application ledger does not partition the trusted rules';
    }
    if (
        candidateApplication?.rule !== candidatePatch.rule ||
        candidateApplication?.status !== 'applied'
    ) {
        return `phase C did not apply the candidate (status ${String(candidateApplication?.status)})`;
    }
    if (
        !phaseBRuleApplications.every((fact, index) => {
            const phaseCFact = phaseCRuleApplications[index];
            return phaseCFact?.rule === fact.rule && phaseCFact.status === fact.status;
        })
    ) {
        return 'phase C changed the baseline rule applications of phase B';
    }

    if (
        review.beforeViewportArtifactId !== phaseB.screenshotArtifactId ||
        review.afterViewportArtifactId !== phaseC.screenshotArtifactId ||
        review.beforeFullPageArtifactId !== (phaseB.fullPageScreenshotArtifactId ?? null) ||
        review.afterFullPageArtifactId !== (phaseC.fullPageScreenshotArtifactId ?? null)
    ) {
        return 'the visual review screenshots are not the phase artifacts';
    }
    return undefined;
}

/**
 * One fix path's inputs to the shared candidate verdict.
 *
 * The three defaulted fields are the path-specific gates; every other step of the verdict is fixed.
 */
export interface CandidateVerdictRequest {
    /**
     * Candidate the safety-enforced terminal outcome proposes, or null when it proposes none.
     */
    proposedCandidate: CandidatePatch | null;

    /**
     * Runner-bound validation selected for that exact candidate, when the run produced one.
     */
    selectedValidation: CandidateValidationSelection | undefined;

    /**
     * Sealed run trace, read for whether any candidate validation was ever dispatched.
     */
    trace: RunTrace;

    /**
     * Every artifact the recorder registered during the run.
     */
    artifacts: ArtifactRef[];

    /**
     * Trusted baseline context the verified candidate is checked against, when one exists.
     */
    trustedValidationContext?: TrustedValidationContext;

    /**
     * Whether the live browser produced usable evidence for this run.
     */
    browserUsable: boolean;

    /**
     * Extra precondition on semantic verification, defaulting to satisfied.
     *
     * The agentic path binds a verified candidate to the exact browser session that proved it, and
     * a candidate with no such environment is not verified however good its review reads. The
     * default suits a path with no per-session binding to check.
     */
    boundToVerifiedEnvironment?: boolean;

    /**
     * What counts as complete visual evidence behind a semantically verified candidate.
     *
     * Defaults to the verified screenshot set being present. The agentic path demands more: the
     * whole serialized candidate binding, of which the screenshots are one part.
     *
     * @param verifiedScreenshots - Screenshot set backing the verified candidate, when complete.
     * @returns Whether the evidence behind the candidate is complete.
     */
    completeCandidateEvidence?: (
        verifiedScreenshots: VerifiedCandidateScreenshotPaths | undefined,
    ) => boolean;

    /**
     * Whether a candidate may publish when the run validated nothing at all, defaulting to no.
     *
     * Allowing it lets a run that never reached apply_rule publish the model's proposal as a draft
     * for a human to judge. The local fix core refuses: its whole purpose is the runner-bound
     * proof, so an unproven candidate is downgraded to analysis-only.
     */
    publishableWithoutValidation?: boolean;
}

/**
 * The verdict every fix path reaches from the same candidate evidence.
 */
export interface CandidateVerdict {
    /**
     * Whether the run dispatched, or produced an artifact for, any candidate validation.
     */
    hasAnyValidation: boolean;

    /**
     * Whether the runner-bound review semantically verified the exact proposed candidate.
     */
    semanticallyVerified: boolean;

    /**
     * Why the runner-bound review did not verify the candidate, when it did not.
     */
    semanticRefusal?: string;

    /**
     * Screenshot set backing a semantically verified candidate, or undefined when incomplete.
     */
    verifiedScreenshots: VerifiedCandidateScreenshotPaths | undefined;

    /**
     * Whether the candidate is verified with complete evidence behind it.
     */
    candidateVerified: boolean;

    /**
     * The candidate remaining after the factual-validation gate, before the browser-evidence gate.
     *
     * Null here means the run had validation evidence that did not back this exact rule, which is
     * the rejection a fix path reports differently from an unusable browser.
     */
    candidateAfterValidation: CandidatePatch | null;

    /**
     * The candidate this run may publish, or null once a gate refused it.
     */
    candidatePatch: CandidatePatch | null;
}

/**
 * Reach the candidate verdict: what the evidence proves, and what the run may publish because of
 * it.
 *
 * The sequence is the same everywhere — semantic review, complete visual evidence, the
 * factual-validation gate, then the browser-evidence gate — so it lives here once instead of being
 * restated by each fix path.
 *
 * `hasAnyValidation` deliberately takes the widest definition: a traced apply_rule dispatch _or_ a
 * persisted validation artifact. A run whose trace was truncated after the artifact landed reports
 * a validation rejection rather than no validation at all. That is the fail-closed direction — the
 * artifact is proof the runner did judge this exact candidate, and forgiving it would let a
 * truncated trace publish an unproven rule as if nothing had ever been tried.
 *
 * @param request - The run's candidate evidence and the three path-specific gates.
 * @returns The verdict and the publishable candidate it leaves.
 */
export function resolveCandidateVerdict(request: CandidateVerdictRequest): CandidateVerdict {
    const {
        proposedCandidate,
        selectedValidation,
        artifacts,
        browserUsable,
        boundToVerifiedEnvironment = true,
        publishableWithoutValidation = false,
    } = request;
    // A validation artifact without a traced apply_rule call cannot happen from a complete trace,
    // but counting it keeps the publication gate fail-closed if one is ever truncated.
    const hasAnyValidation =
        traceHasApplyRuleAttempt(request.trace) || hasPersistedCandidateValidation(artifacts);
    const semanticRefusal =
        proposedCandidate === null
            ? 'no candidate was proposed'
            : !boundToVerifiedEnvironment
              ? 'the candidate is not bound to a verified browser environment'
              : candidatePatchVerificationRefusal(
                    selectedValidation?.factualValidation,
                    proposedCandidate,
                    request.trustedValidationContext,
                    selectedValidation?.visualReview,
                );
    const semanticallyVerified = semanticRefusal === undefined;
    const verifiedScreenshots = verifiedCandidateScreenshotPaths(
        selectedValidation,
        artifacts,
        semanticallyVerified,
    );
    const completeEvidence =
        request.completeCandidateEvidence ?? ((screenshots) => screenshots !== undefined);
    const candidateVerified = semanticallyVerified && completeEvidence(verifiedScreenshots);
    const candidateAfterValidation = candidatePatchAfterFactualValidation(
        proposedCandidate,
        selectedValidation !== undefined,
        candidateVerified,
        hasAnyValidation,
    );
    const candidatePatch = candidatePatchAfterBrowserEvidence(
        candidateVerified || publishableWithoutValidation ? candidateAfterValidation : null,
        browserUsable,
    );
    return {
        hasAnyValidation,
        semanticallyVerified,
        ...(semanticRefusal === undefined ? {} : { semanticRefusal }),
        verifiedScreenshots,
        candidateVerified,
        candidateAfterValidation,
        candidatePatch,
    };
}
