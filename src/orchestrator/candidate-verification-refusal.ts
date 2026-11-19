/**
 * The refusal a runner-bound candidate experiment earns when its mechanical provenance is
 * incomplete: every binding checked between a parsed factual record, the trusted baseline context,
 * and the typed visual review, named one by one so a run that loses a verified candidate can say
 * which binding slipped.
 *
 * It lives apart from `candidate-verdict.ts` so that module stays a thin gate over the evidence it
 * is handed.
 */
import { createHash } from 'node:crypto';
import * as v from 'valibot';
import { isSameSiteUrl } from '../browser/site-identity';
import { appliedRulesMatch } from './applied-rules-match';
import { parseCandidateValidationArtifactId } from '../types/candidate-artifact-identity';
import type { CandidateVisualReview } from '../types/candidate-visual-review';
import { CandidateVisualReviewSchema } from '../types/candidate-visual-review';
import type { CandidatePatch } from '../types/fix-run-result';
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
