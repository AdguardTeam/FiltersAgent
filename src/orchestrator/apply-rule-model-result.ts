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
import type { EnvironmentPhase } from '../environment/environment-proofs';
import type { EnvironmentAdapterLimitation } from '../environment/filtering-environment';
import {
    revealStepsRepairGuidance,
    type InteractionReplayProjection,
} from '../environment/interaction-replay';
import {
    ExperimentInconclusiveReason,
    type AdsEnvironmentExperimentVerdict,
} from '../validator/ads-environment-experiment-result';
import { SelectorSource, type OverruledSelector } from '../types/overruled-selector';

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

/**
 * Baselines without the symptom one candidate may meet before `apply_rule` stops running
 * experiments for it: the first buys one restated description, the second proves the candidate
 * cannot be judged in a controlled experiment.
 */
export const BASELINE_SYMPTOM_ABSENT_LIMIT = 2;

/**
 * Refuse an `apply_rule` call for a candidate whose baseline already failed to show the symptom up
 * to the limit, before any phase opens.
 *
 * The limit asks the model to stop through `retryable: false`; a model can ignore that ask and pay
 * for two more browser phases with their full-page vision that cannot settle anything. This refusal
 * makes the stop hard instead of advisory. Different reveal steps put the page into another state,
 * so they count separately.
 *
 * @param baselineSymptomAbsences - Experiments for this rule and reveal steps whose baseline showed
 *   no symptom.
 * @returns The refusal, or null when the candidate may run.
 */
export function baselineSymptomAbsentRefusal(
    baselineSymptomAbsences: number,
): Record<string, unknown> | null {
    if (baselineSymptomAbsences < BASELINE_SYMPTOM_ABSENT_LIMIT) {
        return null;
    }
    return {
        validationSkipped: true,
        errorKind: `${ExperimentInconclusiveReason.BaselineSymptomAbsent}_exhausted`,
        retryable: false,
        requiredAction: 'finish_fix_analysis_only',
        guidance: [
            'The baseline never showed the described symptom in the experiments for this rule.',
            'Another experiment will not be run. Finish with an analysis-only outcome that',
            'records the candidate rule and the live evidence you already gathered for it.',
        ],
    };
}

/**
 * What an experiment that found no symptom in its filtered baseline tells the model.
 */
export interface BaselineSymptomAbsentFacts {
    /**
     * Verdict of the inconclusive experiment.
     */
    verdict: AdsEnvironmentExperimentVerdict;

    /**
     * Phases that ran, in order.
     */
    phases: readonly EnvironmentPhase[];

    /**
     * How many experiments for this candidate have now ended this way.
     */
    seen: number;

    /**
     * The third-party host the candidate blocks when the phase network logs can judge it.
     */
    blockedHost: string | undefined;

    /**
     * What the reveal steps did in each phase, or null when the call carried none.
     */
    revealSteps: InteractionReplayProjection | null;

    /**
     * Whether the call carried reveal steps.
     */
    revealStepsRequested: boolean;

    /**
     * The selector whose geometry called the baseline healthy while vision saw the symptom, and
     * where it came from.
     */
    overruledSelector: OverruledSelector | null;
}

/**
 * Explain a baseline that showed no symptom, by what decided it.
 *
 * When a selector's geometry overruled what vision saw, vision did not find the unfiltered page
 * clean either — it called it broken or could not tell — and asking for a new description would
 * send the model after the wrong input: either that page really shows the breakage, or the selector
 * names an element that stays visible while the breakage sits elsewhere — drop the
 * `adElementSelector` it passed, or target another element with the rule's own selector.
 *
 * @param overruled - The overruling selector, or null when the baseline verdict followed vision.
 * @returns The lines saying what failed and what to change.
 */
function baselineAbsenceCause(overruled: OverruledSelector | null): string[] {
    if (overruled === null) {
        return [
            'The phase sessions judge one symptom description. The description in force did not',
            'name anything that differs between the unfiltered page and the filtered baseline, so',
            'the candidate was never judged.',
            'Pass symptomDescription to apply_rule and state the breakage you proved live: name the',
            'element or content that filtering removes and where on the page it sits. Never describe',
            'framing properties of the reporter screenshot such as cropping, window width, or text',
            'cut off at an image edge — no phase session can reproduce those.',
        ];
    }
    const seen = [
        'The review saw the described breakage in the filtered baseline but did not find the',
        'unfiltered page clean, so it could not tell the two apart, and',
        overruled.source === SelectorSource.Rule
            ? `the candidate's own selector (${overruled.selector})`
            : `the element adElementSelector names (${overruled.selector})`,
        'stayed as visible as on the unfiltered page; on a breakage report its visibility then',
        'decides, so the candidate was never judged. If the unfiltered page really shows the',
        'breakage too, no candidate can be judged against it.',
    ];
    return overruled.source === SelectorSource.Rule
        ? [
              ...seen,
              'An exception for an element that stays visible restores nothing: target the element',
              'filtering actually hides or removes.',
          ]
        : [
              ...seen,
              'If the broken state renders inside that element, call again without',
              'adElementSelector, or name the element filtering actually hides or removes.',
          ];
}

/**
 * Answer an `apply_rule` call whose filtered baseline did not show the reported symptom.
 *
 * The phases ran cleanly, so this is diagnosable evidence, not a tool failure: the answer carries
 * no `error`, so it never spends the retry budget that guards against broken tooling. Until the
 * limit it says what to change; at the limit it asks the model to finish analysis-only.
 *
 * @param facts - What the experiment recorded.
 * @returns The model-facing answer.
 */
export function baselineSymptomAbsentAnswer(
    facts: BaselineSymptomAbsentFacts,
): Record<string, unknown> {
    const final = facts.seen >= BASELINE_SYMPTOM_ABSENT_LIMIT;
    const restatement = [
        ...baselineAbsenceCause(facts.overruledSelector),
        ...(facts.blockedHost === undefined
            ? []
            : [
                  `The filtered baseline also made no allowed request to ${facts.blockedHost}, so`,
                  'a block of that host has nothing to stop on this page.',
              ]),
        ...(facts.revealStepsRequested
            ? []
            : [
                  'If the symptom appears only after the page waits or is touched, rehearse',
                  'it with interact_page and pass that sequence as revealSteps.',
              ]),
    ];
    const exhausted = [
        'Another experiment for this candidate again ended before phase C, so it cannot be',
        'proven in a controlled experiment. Do not retry it. Finish with an analysis-only',
        'outcome that records the candidate rule and the live evidence you gathered for it.',
    ];
    return {
        validationSkipped: true,
        environmentExperiment: facts.verdict,
        phases: facts.phases,
        errorKind: ExperimentInconclusiveReason.BaselineSymptomAbsent,
        retryable: !final,
        ...(final ? { requiredAction: 'finish_fix_analysis_only' } : {}),
        ...(facts.revealSteps ? { revealSteps: facts.revealSteps } : {}),
        guidance: [
            ...revealStepsRepairGuidance(facts.revealSteps),
            ...(final ? exhausted : restatement),
        ],
    };
}
