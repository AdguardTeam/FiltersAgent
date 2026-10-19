/**
 * The apply_rule answers for a candidate whose filtered baseline did not show the symptom.
 *
 * The phases ran cleanly, so this is diagnosable evidence, not a tool failure: the answer carries
 * no `error` and never spends the apply_rule retry budget that guards against broken tooling. Three
 * causes are told apart. When the candidate's own cosmetic selector matched nothing on the filtered
 * baseline, the page never rendered the element the rule names, and restating the symptom would
 * send the model to fix the one thing that is not broken. When a selector's geometry overruled what
 * vision saw on a breakage report, the selector, not the description, decided. Otherwise the
 * symptom description in force named nothing that differs between the unfiltered page and the
 * baseline.
 */
import type { EnvironmentPhase } from '../environment/environment-proofs';
import {
    revealStepsRepairGuidance,
    type InteractionReplayProjection,
} from '../environment/interaction-replay';
import { SelectorSource, type OverruledSelector } from '../types/overruled-selector';
import {
    ExperimentInconclusiveReason,
    type AdsEnvironmentExperimentVerdict,
} from '../validator/ads-environment-experiment-result';

/**
 * Baselines without the symptom one candidate may meet before `apply_rule` stops running
 * experiments for it: the first buys one corrected call, the second proves the candidate cannot be
 * judged in a controlled experiment.
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
     * How many experiments for this candidate have now ended this way, this one included.
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
     * The candidate's cosmetic selector when it matched nothing on the filtered baseline, else
     * null.
     */
    unmatchedBaselineSelector: string | null;

    /**
     * The selector whose geometry called the baseline healthy while vision saw the symptom, and
     * where it came from.
     */
    overruledSelector: OverruledSelector | null;
}

/**
 * The guidance for a candidate whose selector found nothing on the filtered baseline.
 *
 * The reveal hint is given even when a plan was passed: a plan of one wait does not bring in an
 * element the site renders only after a click, a scroll or a key press.
 *
 * @param selector - The selector that matched nothing.
 * @returns The guidance lines.
 */
function unmatchedSelectorGuidance(selector: string): string[] {
    return [
        `The candidate's selector ${selector} matched no element on the filtered baseline page`,
        'after it loaded and ran any revealSteps, so the candidate had nothing to hide or restyle',
        'and was never judged. The measurement reads the top document only: an element inside',
        'an iframe or a shadow root counts as unmatched.',
        'If the element appears only after a click, a scroll or a key press, rehearse that with',
        'interact_page and pass the sequence as revealSteps to apply_rule. Otherwise choose a',
        'selector that matches the element the filtered page actually renders.',
    ];
}

/**
 * Explain a baseline that showed no symptom by what decided it, when the candidate's selector did
 * match on it.
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
 * The guidance saying what to change before the one retry the limit leaves.
 *
 * @param facts - What the experiment recorded.
 * @returns The guidance lines.
 */
function correctionGuidance(facts: BaselineSymptomAbsentFacts): string[] {
    if (facts.unmatchedBaselineSelector !== null) {
        return unmatchedSelectorGuidance(facts.unmatchedBaselineSelector);
    }
    return [
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
}

/**
 * The guidance once the same candidate under the same plan reached the limit.
 */
const EXHAUSTED_GUIDANCE = [
    'Another experiment for this candidate again ended before phase C, so it cannot be',
    'proven in a controlled experiment. Do not retry it. Finish with an analysis-only',
    'outcome that records the candidate rule and the live evidence you gathered for it.',
];

/**
 * Answer an `apply_rule` call whose filtered baseline did not show the reported symptom.
 *
 * Until the limit it says what to change; at the limit it asks the model to finish analysis-only,
 * and {@link baselineSymptomAbsentRefusal} refuses the next call before any phase opens.
 *
 * @param facts - What the experiment recorded.
 * @returns The model-facing answer.
 */
export function baselineSymptomAbsentAnswer(
    facts: BaselineSymptomAbsentFacts,
): Record<string, unknown> {
    const final = facts.seen >= BASELINE_SYMPTOM_ABSENT_LIMIT;
    const selector = facts.unmatchedBaselineSelector;
    return {
        validationSkipped: true,
        environmentExperiment: facts.verdict,
        phases: facts.phases,
        errorKind: ExperimentInconclusiveReason.BaselineSymptomAbsent,
        retryable: !final,
        ...(final ? { requiredAction: 'finish_fix_analysis_only' } : {}),
        ...(selector === null ? {} : { unmatchedBaselineSelector: selector }),
        ...(facts.revealSteps ? { revealSteps: facts.revealSteps } : {}),
        guidance: [
            ...revealStepsRepairGuidance(facts.revealSteps),
            ...(final ? EXHAUSTED_GUIDANCE : correctionGuidance(facts)),
        ],
    };
}
