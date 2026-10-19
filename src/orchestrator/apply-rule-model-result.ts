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
import { ToolName } from '../agent/tool-names';
import type { ToolHandler } from '../agent/tool-registry';
import type { EnvironmentAdapterLimitation } from '../environment/filtering-environment';

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
    'domChecks',
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
 * Make every `apply_rule` answer state how many distinct candidates the run may still validate.
 *
 * Stamped once at the handler boundary, after the handler settled: every exit — an experiment, a
 * duplicate, the limit, a refusal — states the same count, already reflecting a slot this call
 * spent or released. A model never told the budget stops before it has spent it. Every other tool
 * keeps its handler unchanged.
 *
 * @param toolName - Name of the tool the handler serves.
 * @param remainingAttempts - Reads the attempts left once the handler settled.
 * @param handler - The tool's handler.
 * @returns The handler, stamping `remainingCandidateAttempts` on every `apply_rule` answer.
 */
export function withRemainingCandidateAttempts(
    toolName: string,
    remainingAttempts: () => number,
    handler: ToolHandler['handler'],
): ToolHandler['handler'] {
    if (toolName !== ToolName.ApplyRule) {
        return handler;
    }
    return async (args) => ({
        ...(await handler(args)),
        remainingCandidateAttempts: remainingAttempts(),
    });
}

/**
 * Answer an `apply_rule` call that the filtering environment's limitation stopped.
 *
 * When the limitation is the one an earlier call already ended on, this call opened no phase, and
 * the answer says so: a repeat that reads like a fresh failure invites the model to try again. A
 * different limitation, or one the environment produced anew, is answered as a fresh failure.
 *
 * @param limitation - The limitation that stopped the call.
 * @param earlier - The limitation an earlier call ended on, or null when none did.
 * @returns The model-facing answer.
 */
export function environmentLimitationAnswer(
    limitation: EnvironmentAdapterLimitation,
    earlier: EnvironmentAdapterLimitation | null,
): Record<string, unknown> {
    const repeated =
        earlier !== null &&
        earlier.code === limitation.code &&
        earlier.detail === limitation.detail;
    return {
        validationSkipped: true,
        errorKind: 'environment_capability_limited',
        retryable: false,
        limitation,
        ...(repeated
            ? {
                  repeatedFailure: true,
                  error:
                      'This call ran no experiment: the limitation an earlier apply_rule call ' +
                      'ended on came back unchanged, and the filtering environment was not ' +
                      'retried.',
              }
            : {}),
    };
}
