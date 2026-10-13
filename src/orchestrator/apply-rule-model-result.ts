/**
 * The model-facing shape of one `apply_rule` result.
 *
 * The experiment's record is evidence first: three phases with their measurements, the structure
 * facts, and the vision review. On a long page that record outgrows the tool-result limit, and the
 * generic envelope then hands the model the first kilobytes of JSON — which is where the phases
 * live, while the verdict sits at the very end. A result of 84,098 bytes against the 65,536-byte
 * limit leaves the model writing "apply_rule returned no readable verdict" and giving up on a
 * candidate it could have corrected.
 *
 * So the decision travels first and always: the review, its artifact ids and the summary lead the
 * object, and when the whole still exceeds the budget the bulky evidence is replaced, largest
 * first, by a pointer to the persisted record. Nothing is lost — the full record is an artifact
 * `get_detail` reads — and the run's own bookkeeping keeps reading the unprojected result.
 */

/**
 * Budget of the projected result, below the tool-result limit so the envelope never replaces it.
 */
const APPLY_RULE_MODEL_RESULT_BUDGET_BYTES = 48 * 1024;

/**
 * Keys that carry the decision, in the order the model should meet them.
 */
const DECISION_KEYS = [
    'visualReview',
    'visualReviewArtifactId',
    'validationArtifactId',
    'validationAttempt',
    'revealSteps',
    'summary',
    'adElementStatus',
    'validatedSelector',
] as const;

/**
 * Evidence keys replaced by a pointer when the result is over budget, largest first.
 */
const EVIDENCE_KEYS_IN_DROP_ORDER = ['structureFacts', 'phaseC', 'phaseB', 'phaseA'] as const;

/**
 * Measure one value the way the tool-result envelope does.
 *
 * @param value - The value to measure.
 * @returns Its serialized size in UTF-8 bytes.
 */
function serializedBytes(value: unknown): number {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/**
 * Project one `apply_rule` result for the model: decision first, evidence bounded.
 *
 * A refusal or a skipped validation carries no evidence and passes through unchanged but for the
 * key order.
 *
 * @param result - The complete result the experiment produced.
 * @returns The same result with the decision leading it and, when it exceeded the budget, its
 *   bulkiest evidence replaced by a pointer to the persisted record.
 */
export function applyRuleResultForModel(result: Record<string, unknown>): Record<string, unknown> {
    const projected: Record<string, unknown> = {};
    for (const key of DECISION_KEYS) {
        if (key in result) {
            projected[key] = result[key];
        }
    }
    for (const [key, value] of Object.entries(result)) {
        if (!(key in projected)) {
            projected[key] = value;
        }
    }
    const omitted: string[] = [];
    for (const key of EVIDENCE_KEYS_IN_DROP_ORDER) {
        if (serializedBytes(projected) <= APPLY_RULE_MODEL_RESULT_BUDGET_BYTES) {
            break;
        }
        if (key in projected) {
            omitted.push(key);
            delete projected[key];
        }
    }
    if (omitted.length === 0) {
        return projected;
    }
    const recordId = result.validationArtifactId;
    return {
        ...projected,
        omittedEvidence: {
            keys: omitted,
            note:
                'Left out of this tool result to keep the verdict readable; nothing was lost. ' +
                (typeof recordId === 'string'
                    ? `The complete experiment record is artifact ${recordId}: read it with ` +
                      `get_detail("${recordId}").`
                    : 'The complete experiment record is preserved in the run evidence.'),
        },
    };
}

/**
 * The typed refusal `apply_rule` answers with when the environment cannot perform the requested
 * candidate operation (an `edit` or `remove` of a baseline rule where only an added rule can run).
 *
 * A type alias rather than an interface: tool results are `Record<string, unknown>`, which an
 * interface, having no index signature, is not assignable to.
 */
export type UnsupportedCandidateOperationRefusal = {
    /**
     * No experiment ran.
     */
    validationSkipped: true;

    /**
     * What was refused and what to submit instead.
     */
    error: string;

    /**
     * Finite refusal class.
     */
    errorKind: 'candidate_operation_unsupported';

    /**
     * The same call can never succeed in this environment.
     */
    retryable: false;
};

/**
 * Refuse a candidate operation the environment cannot perform, and say what does work.
 *
 * The earlier wording ended in "propose an added exception or replacement rule instead". A model
 * that had just been shown an extension plan read "replacement rule" as that plan's merged line and
 * validated the merged multi-domain rule as an added one, which the candidate safety gate then
 * refused. The recovery is therefore spelled out for the case that leads here most often: to extend
 * an existing rule's domain list, the rule to validate is the one scoped to the reported domain.
 *
 * @param operation - The candidate operation the model asked for.
 * @param environment - How the refusing environment is named to the model.
 * @returns The refusal returned to the model.
 */
export function unsupportedCandidateOperationRefusal(
    operation: string,
    environment: string,
): UnsupportedCandidateOperationRefusal {
    return {
        validationSkipped: true,
        error:
            `Candidate operation '${operation}' is not supported ${environment}: only a rule added ` +
            "on top of the baseline can be validated (operation 'add'). To extend an existing " +
            "rule's domain list, validate the rule scoped to the reported domain alone — the host " +
            'merges it into the existing rule when it builds the patch.',
        errorKind: 'candidate_operation_unsupported',
        retryable: false,
    };
}
