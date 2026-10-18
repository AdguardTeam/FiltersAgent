/**
 * The `domChecks` argument of `apply_rule`: parsing it at the model boundary and telling a new
 * experiment plan from a repeat.
 *
 * Checks are refused before the call registers a candidate, so a malformed request never spends a
 * candidate attempt or a browser phase. A call that attaches checks the candidate was not yet
 * judged under is a new plan, exactly like new reveal steps: the experiment runs again and measures
 * what the earlier review could only see.
 */
import { createHash } from 'node:crypto';
import * as v from 'valibot';
import { MAX_EVALUATE_JS_EXPRESSION_CHARS } from '../browser/browser-tools';
import { validateExpression } from '../browser/expression-validator';
import type { NormalizedSafeInteractionPlan } from '../environment/safe-interaction';
import { DomChecksRequestSchema, type DomCheck } from '../types/dom-check';

/**
 * Why `apply_rule` refused the checks it was given.
 */
export const DomChecksRefusal = {
    /**
     * The argument is not a list of at most the allowed number of `{ expression, claim }` pairs.
     */
    Invalid: 'dom_checks_invalid',

    /**
     * An expression would not pass the read-only evaluate_js validator.
     */
    ExpressionRejected: 'dom_check_rejected',
} as const;
export type DomChecksRefusal = (typeof DomChecksRefusal)[keyof typeof DomChecksRefusal];

/**
 * Checks one call attached, with the digest that tells them apart from an earlier call's.
 */
export interface DomCheckPlan {
    /**
     * The checks in the agent's order, expressions trimmed.
     */
    checks: DomCheck[];

    /**
     * SHA-256 over the expressions alone: rewording a claim measures nothing new.
     */
    digest: string;
}

/**
 * What the `domChecks` argument resolved to: the plan, none, or the refusal to answer with.
 */
export type DomChecksRequest =
    | {
          /**
           * Checks to run, or undefined when the call attached none.
           */
          plan: DomCheckPlan | undefined;
      }
    | {
          /**
           * The typed tool answer refusing the call.
           */
          refusal: Record<string, unknown>;
      };

/**
 * Parse `apply_rule`'s `domChecks` argument.
 *
 * @param requested - Raw `domChecks` value from the model's call.
 * @returns The plan, `undefined` for none, or the refusal.
 */
export function parseDomChecks(requested: unknown): DomChecksRequest {
    if (requested === undefined || (Array.isArray(requested) && requested.length === 0)) {
        return { plan: undefined };
    }
    const parsed = v.safeParse(DomChecksRequestSchema, requested);
    if (!parsed.success) {
        return {
            refusal: {
                error: 'The domChecks were not accepted.',
                errorKind: DomChecksRefusal.Invalid,
                detail: parsed.issues.map((issue) => issue.message).join('; '),
                retryable: true,
            },
        };
    }
    const checks = parsed.output.map((check) => ({
        expression: check.expression.trim(),
        claim: check.claim.trim(),
    }));
    for (const [index, check] of checks.entries()) {
        const rejection = validateExpression(check.expression, MAX_EVALUATE_JS_EXPRESSION_CHARS);
        if (rejection) {
            return {
                refusal: {
                    error: `domChecks[${index}] would not pass the evaluate_js rules.`,
                    errorKind: DomChecksRefusal.ExpressionRejected,
                    checkIndex: index,
                    rejection: rejection.kind,
                    detail: rejection.message,
                    retryable: true,
                },
            };
        }
    }
    const digest = createHash('sha256')
        .update(JSON.stringify(checks.map((check) => check.expression)))
        .digest('hex');
    return { plan: { checks, digest } };
}

/**
 * Compose the digest a candidate's experiment plan is remembered under.
 *
 * Reveal steps change the page the phases capture; checks change what the phases measure on it.
 * Either one new makes the experiment a different one, while the same pair again cannot change the
 * verdict. A plan without checks keeps the reveal digest alone.
 *
 * @param revealPlan - Reveal steps of the call, if any.
 * @param domChecks - Checks of the call, if any.
 * @returns The plan digest; empty for a call with neither.
 */
export function candidatePlanDigest(
    revealPlan: NormalizedSafeInteractionPlan | undefined,
    domChecks: DomCheckPlan | undefined,
): string {
    const reveal = revealPlan?.digest ?? '';
    return domChecks ? `${reveal}#checks:${domChecks.digest}` : reveal;
}
