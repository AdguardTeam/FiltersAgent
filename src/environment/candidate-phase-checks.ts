/**
 * What decides an Extension candidate phase: the paired before/after review, and the checks the
 * runner makes itself before it lets that review's verdict stand.
 *
 * The candidate phase has no single-image inventory. A lone after image has no before to compare
 * and none of the DOM measurements the paired review weighs, so its own reading once outvoted a
 * review that had reconciled every observation. Every decision about the candidate phase is read
 * from the paired review here, and the runner's checks are named so the model learns which one
 * withdrew a verdict the review would have given.
 */
import {
    CandidateVisualSymptom,
    CandidateVisualSymptomBasis,
    type CandidateVisualReview,
} from '../types/candidate-visual-review';
import { normalizeRule, RuleKind } from '../repo/rule-normalizer';
import { ReporterSymptomPresence } from '../types/reporter-symptom-presence';
import type { StructuralSnapshot } from '../types/validation';
import { isBreakageSymptom, type SymptomKind } from '../validator/symptom-rubric';
import type { ObservedExtensionPhase } from './extension-phase-capture';
import type { PageScrollMeasurement } from './page-scroll-probe';

/**
 * A runner check a candidate experiment must pass on top of a verified paired review.
 */
export const CandidateExperimentCheck = {
    /**
     * The candidate phase navigated to the reported page without a browser error.
     */
    CandidatePhaseNavigation: 'candidate_phase_navigation',

    /**
     * The reporter's symptom is gone from the candidate phase: by the review, by the structural
     * probe for a breakage, and by the requests for a host block.
     */
    CandidatePhaseSymptom: 'candidate_phase_symptom',

    /**
     * The review left the page usable enough for the run to build on it.
     */
    PageUsability: 'page_usability',

    /**
     * The reveal steps put the candidate phase into the same state as the baseline.
     */
    RevealStepsPreparedAlike: 'reveal_steps_prepared_alike',

    /**
     * A page the mouse wheel scrolls without filtering still scrolls with the candidate.
     */
    PageScrollPreserved: 'page_scroll_preserved',
} as const;

/**
 * CandidateExperimentCheck value.
 */
export type CandidateExperimentCheck =
    (typeof CandidateExperimentCheck)[keyof typeof CandidateExperimentCheck];

/**
 * What the runner established about one candidate phase, one fact per check.
 */
export interface CandidatePhaseCheckFacts {
    /**
     * Whether the candidate phase navigated without a browser error.
     */
    navigationVerified: boolean;

    /**
     * Whether the candidate phase still shows the reporter's symptom.
     */
    symptomPresent: boolean;

    /**
     * Whether the review left the page usable.
     */
    pageUsable: boolean;

    /**
     * Whether the reveal steps prepared the candidate phase like the baseline; true without steps.
     */
    preparedAlike: boolean;

    /**
     * Whether the candidate left the page scrolling where the unfiltered page scrolls.
     */
    scrollPreserved: boolean;
}

/**
 * The wheel measurements of the three phases, which the agent reads to find the scroll lock its
 * candidate left behind.
 */
export interface PageScrollComparison {
    /**
     * What the wheel did without filtering; null when the page could not be measured.
     */
    unfiltered: PageScrollMeasurement | null;

    /**
     * What the wheel did with the published lists. It decides nothing: a gate the lists provoke
     * locks this page too, and its lock is still the candidate's to remove. It tells the agent
     * whether the lock was there before the candidate. Null when the page could not be measured.
     */
    baseline: PageScrollMeasurement | null;

    /**
     * What the wheel did with the candidate applied; null when the page could not be measured.
     */
    candidate: PageScrollMeasurement | null;
}

/**
 * Read the reporter symptom's presence in the candidate phase from the paired review.
 *
 * A host block the requests proved stopped is absent whatever the images showed. Otherwise the
 * review's reconciled instances decide: a resolved symptom with nothing left over is absent, an
 * unresolved one or any remaining instance is present, and an unclear review decides nothing.
 *
 * @param review - The paired before/after review of the candidate.
 * @returns The symptom's presence after the candidate applied.
 */
export function reviewedSymptomPresence(review: CandidateVisualReview): ReporterSymptomPresence {
    if (review.symptomBasis === CandidateVisualSymptomBasis.NetworkRequestsBlocked) {
        return ReporterSymptomPresence.Absent;
    }
    if (
        review.symptom === CandidateVisualSymptom.NotResolved ||
        review.remainingInstances.length > 0
    ) {
        return ReporterSymptomPresence.Present;
    }
    return review.symptom === CandidateVisualSymptom.Resolved
        ? ReporterSymptomPresence.Absent
        : ReporterSymptomPresence.Indeterminate;
}

/**
 * Complete the candidate phase with what the paired review saw.
 *
 * The phase is assembled without an inventory, its symptom undecided and its capture unverified;
 * the review's coverage and reconciled symptom fill both, together, so the phase record and the
 * capture it reports cannot disagree.
 *
 * @param observed - The candidate phase as the browser recorded it, before any review.
 * @param review - The paired before/after review of the candidate.
 * @returns The same phase, with the review's coverage and symptom presence.
 */
export function reviewedPhase(
    observed: ObservedExtensionPhase,
    review: CandidateVisualReview,
): ObservedExtensionPhase {
    const symptomPresence = reviewedSymptomPresence(review);
    return {
        ...observed,
        symptomPresence,
        capture: {
            ...observed.capture,
            visionVerified: review.coverageComplete,
            coverageComplete: review.coverageComplete,
            reporterSymptomPresence: symptomPresence,
        },
    };
}

/**
 * Mark a baseline phase as not showing the symptom, in the phase record and its capture alike.
 *
 * @param observed - The baseline phase as its inventory judged it.
 * @returns The same phase, its symptom absent.
 */
export function withoutBaselineSymptom(observed: ObservedExtensionPhase): ObservedExtensionPhase {
    return {
        ...observed,
        symptomPresence: ReporterSymptomPresence.Absent,
        capture: { ...observed.capture, reporterSymptomPresence: ReporterSymptomPresence.Absent },
    };
}

/**
 * Name the runner checks one candidate phase failed.
 *
 * @param facts - What the runner established about the candidate phase.
 * @returns The failed checks in the order the enumeration declares them; empty when all passed.
 */
export function failedCandidateChecks(facts: CandidatePhaseCheckFacts): CandidateExperimentCheck[] {
    const outcomes: Array<[CandidateExperimentCheck, boolean]> = [
        [CandidateExperimentCheck.CandidatePhaseNavigation, facts.navigationVerified],
        [CandidateExperimentCheck.CandidatePhaseSymptom, !facts.symptomPresent],
        [CandidateExperimentCheck.PageUsability, facts.pageUsable],
        [CandidateExperimentCheck.RevealStepsPreparedAlike, facts.preparedAlike],
        [CandidateExperimentCheck.PageScrollPreserved, facts.scrollPreserved],
    ];
    return outcomes.filter(([, passed]) => !passed).map(([check]) => check);
}

/**
 * Decide whether the candidate left the page scrolling where the unfiltered page scrolls.
 *
 * A rule that hides an anti-adblock gate's modal can leave the gate's scroll lock on `body`, and
 * the screenshots of the locked page look clean. The check holds only where it can tell: the
 * unfiltered page must have moved under the wheel, so a page shorter than the viewport, or one that
 * takes the wheel for itself, passes. So does a candidate page with nothing to scroll, whose height
 * came from what filtering removed; a lock keeps the height it clips, so it still counts. A
 * candidate page fails when the wheel moved neither the document nor a container under the pointer;
 * a scrolled container leaves the document's own answer open. A phase that could not be measured
 * decides nothing, and the baseline decides nothing at all.
 *
 * @param scroll - The wheel measurements of the three phases.
 * @returns False only when the unfiltered page scrolled and the candidate page, with content to
 *   scroll, did not.
 */
export function pageScrollPreserved(scroll: PageScrollComparison): boolean {
    const { unfiltered, candidate } = scroll;
    if (
        unfiltered === null ||
        candidate === null ||
        unfiltered.wheelScrolledPx === 0 ||
        candidate.contentHeight <= candidate.viewportHeight
    ) {
        return true;
    }
    return candidate.wheelScrolledPx > 0 || candidate.innerContainerScrolled;
}

/**
 * A pseudo-element in a selector: any `::name`, or the legacy single-colon spellings.
 *
 * `querySelectorAll` returns an empty list for a selector ending in a pseudo-element without
 * throwing, so a correct `::before` rule would read as matching nothing. Such a selector is left
 * out of the gate rather than measured without its pseudo-element, which would probe a different
 * selector than the rule applies.
 */
const PSEUDO_ELEMENT_PATTERN = /::[a-z-]|:(?:before|after|first-line|first-letter)\b/i;

/**
 * The legacy Extended CSS attribute spelling, such as `div[-ext-has=".ad"]`.
 *
 * The page treats it as a plain attribute selector, which never matches and never throws, so an
 * empty match says nothing about the rule.
 */
const LEGACY_EXTENDED_CSS_ATTRIBUTE_PATTERN = /\[-ext-/i;

/**
 * Decide whether a cosmetic candidate's selector matched nothing on the filtered baseline.
 *
 * A cosmetic rule (hiding or CSS injection) whose selector finds no element on the baseline has
 * nothing to hide or restyle, so no review of the candidate phase can show it changed anything,
 * however a single-image inventory read the baseline. Only a measurement that ran and could have
 * matched counts: an extended-CSS selector (`:contains`) makes the probe throw, a pseudo-element or
 * a legacy `[-ext-` attribute matches nothing without throwing, and an exception, a breakage report
 * or a rule that names no element is judged as before. The probe reads the top document only, so an
 * element inside an iframe or a shadow root counts as unmatched.
 *
 * @param candidateRule - The exact candidate rule.
 * @param symptomKind - The problem class the run judges.
 * @param structure - The structural probe of the baseline phase.
 * @param boundToSelector - Whether that probe measured the candidate's own selector.
 * @returns True when the baseline measurement ran and found no element.
 */
export function selectorMatchedNothing(
    candidateRule: string,
    symptomKind: SymptomKind,
    structure: StructuralSnapshot,
    boundToSelector: boolean,
): boolean {
    const rule = normalizeRule(candidateRule);
    const selector = rule.selector ?? '';
    return (
        !isBreakageSymptom(symptomKind) &&
        rule.kind === RuleKind.Cosmetic &&
        !rule.isException &&
        !PSEUDO_ELEMENT_PATTERN.test(selector) &&
        !LEGACY_EXTENDED_CSS_ATTRIBUTE_PATTERN.test(selector) &&
        boundToSelector &&
        structure.probeSucceeded &&
        structure.targetCount === 0
    );
}
