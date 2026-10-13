/**
 * The one rule about whose pages a candidate may touch: exactly the reported domain, nothing else.
 *
 * Two places ask it. The candidate safety gate asks after the run has sealed, where a refusal can
 * only downgrade the draft. The terminal prerequisite asks when the model submits, where a refusal
 * still returns to a model that can fix it. They read the answer from here so the model is never
 * bounced for something the gate would accept, nor let through for something it would refuse.
 */
import { effectiveRuleScopes, type NormalizedRule } from '../repo/rule-normalizer';

/**
 * Normalize a hostname for exact issue-scope comparison.
 *
 * @param domain - Raw hostname from issue or rule scope.
 * @returns Lowercase hostname without a leading `www.` or trailing root dot.
 */
export function normalizeScopeDomain(domain: string): string {
    return domain
        .trim()
        .toLowerCase()
        .replace(/^www\./, '')
        .replace(/\.$/, '');
}

/**
 * Say why a candidate's positive scopes are not exactly the reported domain, when they are not.
 *
 * `effectiveRuleScopes` never infers a scope for an exception, so a generic `@@||host^` without
 * `$domain=` (or a cosmetic exception without a domain prefix) fails here too.
 *
 * @param rule - Deterministically normalized candidate rule.
 * @param reportedDomain - Reported hostname bound by the runner, never model input.
 * @returns The refusal sentence, or undefined when the candidate is scoped to the reported domain.
 */
export function candidateScopeProblem(
    rule: NormalizedRule,
    reportedDomain: string,
): string | undefined {
    const expectedDomain = normalizeScopeDomain(reportedDomain);
    const scopes = effectiveRuleScopes(rule, expectedDomain).map(normalizeScopeDomain);
    return scopes.length === 1 && scopes[0] === expectedDomain
        ? undefined
        : `Candidate must have exactly one positive scope for reported domain ${expectedDomain}.`;
}
