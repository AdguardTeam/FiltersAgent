/**
 * Whether a phase's `appliedRules` record names exactly the given rules.
 *
 * `appliedRules` is a second, redundant projection of what a phase ran: the ordered truth is the
 * `ruleApplications` ledger, which the verdict checks rule by rule against the trusted input. Both
 * readers of `appliedRules` — the verdict and the rejected-evidence check — ask membership only:
 * demanding an order (network rules first, then the rest, say) refuses a domain whose trusted rules
 * interleave kinds, such as a cosmetic rule between network ones, even when vision verified the
 * candidate. Order is a producer's detail; membership is the provenance fact.
 *
 * @param value - Unknown applied-rule field from the factual payload.
 * @param expected - Exactly the rules the phase must have applied; duplicate-free.
 * @returns Whether `value` is an array holding each expected rule once and nothing else.
 */
export function appliedRulesMatch(value: unknown, expected: readonly string[]): boolean {
    if (!Array.isArray(value) || value.length !== expected.length) {
        return false;
    }
    const applied = new Set<unknown>(value);
    return applied.size === value.length && expected.every((rule) => applied.has(rule));
}
