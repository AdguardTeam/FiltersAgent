import { isIncorrectBlockingReport, type ProblemType } from '../types/issue-facts';
import { CandidateNetworkScope } from './candidate-network-scope';

/**
 * Named symptom kinds, so review code never spells one inline.
 */
export const SymptomKind = {
    Ads: 'ads',
    Breakage: 'incorrect_blocking',
} as const;

/**
 * Problem class driving the visual review rubric.
 *
 * Ads-class runs judge whether an advertising footprint disappeared; incorrect-blocking runs judge
 * the inverse — whether functionality that filtering had broken is visibly restored.
 */
export type SymptomKind = (typeof SymptomKind)[keyof typeof SymptomKind];

/**
 * Whether a review judges broken functionality rather than an advertising footprint.
 *
 * @param kind - Problem class driving the review, ads when omitted.
 * @returns True when the reviewed defect is content the filtering removed.
 */
export function isBreakageSymptom(kind?: SymptomKind): boolean {
    return kind === SymptomKind.Breakage;
}

/**
 * Map a parsed issue problem type onto the review rubric class.
 *
 * The single mapping point keeps every runner and tool registry consistent: anything that is not an
 * incorrect-blocking report reviews under ads semantics.
 *
 * @param problemType - Parsed problem type of the issue, when known.
 * @returns The rubric class the run must review under.
 */
export function symptomKindForProblemType(problemType?: ProblemType): SymptomKind {
    return isIncorrectBlockingReport(problemType) ? SymptomKind.Breakage : SymptomKind.Ads;
}

/**
 * Residue rubric lines for the per-image inventory prompts (tiles and overviews).
 *
 * The ads wording is load-bearing verbatim: existing review contracts pin it. The breakage wording
 * inverts the AFTER-state semantics — restored content must not be recorded as a matching
 * instance.
 *
 * @param kind - Problem class driving the review.
 * @returns Prompt lines describing what counts as a matching symptom instance.
 */
export function inventoryResidueRubric(kind: SymptomKind): string[] {
    if (isBreakageSymptom(kind)) {
        return [
            'The reporter-defined defect is broken or missing page functionality caused by',
            'filtering: a missing image or video, an empty region where content should render,',
            'a control that visibly fails, or an on-page error message. In the BEFORE state',
            'record each such breakage instance. In the AFTER state record an instance only',
            'when the same functionality is still visibly broken or missing; restored working',
            'content is not a matching instance. Separately, in BOTH states, record every',
            'visible advertisement as an observation prefixed "AD PRESENCE:" with its location',
            '— including in the BEFORE state, where ad presence must be recorded even though it',
            'is not candidate damage. These observations feed the filtering-regression check.',
        ];
    }
    return [
        'Treat an outer ad wrapper, its REKLAMA label, divider or frame, and reserved',
        'blank space or height as part of the reporter-defined advertising symptom',
        'footprint. In the AFTER state, record any such residual as a matching',
        'instance even when the ad creative itself disappeared.',
        // Without this line the model read an ordinary ~60 px gap between two sections of an AFTER
        // tile as "a blank band consistent with an empty reserved ad-slot placeholder left by the
        // candidate rule", which rejected a correct candidate. The wording above names reserved
        // blank space as residue and gave the model no notion of normal spacing, so any gap
        // qualified; the synthesis rubric draws the same line ("not normal spacing").
        'Ordinary spacing between sections — no larger than the gaps between other sections of',
        'the same page — is not a residual; a residual is a visibly larger reserved gap, or a',
        'visible frame, label or placeholder block.',
    ];
}

/**
 * Prefix a BEFORE inventory puts on a rendering flaw the page has without any candidate.
 *
 * The inventory prompt writes it and the synthesis prompt reads it, so both take it from here.
 */
export const PRE_EXISTING_DAMAGE_PREFIX = 'PRE-EXISTING:';

/**
 * Rubric lines telling an inventory pass how wide the reporter's symptom is.
 *
 * An inventory pass sees the candidate rule beside the symptom scope and can behave as if the rule
 * bounded the search: when the reporter names a header banner among the ad units and the
 * candidate's selectors do not reach it, no pass records it even though it is plainly there in the
 * AFTER capture. The scope handed to the pass is composed from the reporter's own report
 * (`reporter-symptom-scope`), and these lines say that the selector is not the boundary of what to
 * record.
 */
export const REPORTER_SCOPE_RUBRIC = [
    'Record an instance at every location the reporter named, and everywhere on the page that',
    'visually repeats what they described, whether or not the candidate rule would touch it —',
    'the candidate is what someone proposed, never the boundary of what to inventory.',
];

/**
 * Rubric lines telling every review prompt what the symptom is and what resolves it.
 *
 * On a site that gates its videos behind cookie consent, a reporter complains that the video does
 * not play, and the screenshot shows the gray "enable cookies to view videos" placeholder. A
 * candidate that hides the placeholder and describes its own target as "video placeholder overlay"
 * can get verified: the placeholder is gone, while the video is as unavailable as before. The
 * reporter's complaint defines the symptom, and a gating placeholder stands for the content it
 * withholds — so hiding it leaves that symptom in place.
 */
export const SYMPTOM_DEFINITION_RUBRIC = [
    "The reporter's complaint and screenshot define the symptom. A description of what the",
    'candidate targets only helps locate it and never redefines what counts as fixed.',
    'A placeholder or overlay that gates content behind an action — "enable cookies to view',
    'this video", "disable your ad blocker to see this", "accept to load the map or',
    'comments" — is a symptom of broken functionality: the defect is the withheld content.',
    'Hiding such a placeholder does not resolve it; only the gated content appearing or',
    'working does. Where that content is still absent after the candidate, the same symptom',
    'remains, whether the placeholder is still shown or was hidden.',
];

/**
 * Residue rubric lines for the final text-only synthesis prompt.
 *
 * For breakage reviews the `adLayoutResidue` field is repurposed as the filtering-regression guard:
 * it must be `present` exactly when an advertising element that the baseline filters had removed
 * became visible again after the candidate — a too-broad exception then fails closed.
 *
 * For an ads review of a third-party host block the wording separates the two judgments the runner
 * combines: the symptom is the advertising itself, the residue is what the page still reserves for
 * it. A network rule cannot collapse that space, so the runner does not hold the residue against it
 * (`deriveCandidateVisualVerdict`), and the model must therefore not fold the residue into the
 * symptom either.
 *
 * @param kind - Problem class driving the review.
 * @param scope - Runner-computed scope of the candidate; absent means no scope-specific wording.
 * @returns Prompt lines defining residue and the adLayoutResidue contract.
 */
export function synthesisResidueRubric(kind: SymptomKind, scope?: CandidateNetworkScope): string[] {
    if (isBreakageSymptom(kind)) {
        return [
            'The reporter-defined defect is broken or missing page functionality caused by',
            'filtering. An AFTER observation is remaining only when the same functionality is',
            'still visibly broken or missing; restored working content is normal page content,',
            'not residue. For this breakage review, set adLayoutResidue=present ONLY when an',
            'advertisement that was absent in BEFORE became visible in AFTER — that means the',
            'candidate exception also disabled legitimate filtering and the fix is not',
            'acceptable. Ground this strictly in the recorded "AD PRESENCE:" observations:',
            'present when an AFTER inventory records an advertisement with no matching BEFORE',
            'record, absent when no such new advertisement was recorded, and unclear when the',
            'inventories carry no usable ad-presence observations. Page integrity',
            'is independent: a readable intact page whose reported functionality is still',
            'broken is still not fixed.',
        ];
    }
    if (scope === CandidateNetworkScope.ThirdPartyHostBlock) {
        // A block of a third-party host can stop the advertising from loading but cannot collapse
        // space the page itself reserves for it — that takes a cosmetic rule, and a maintainer fix
        // can be the network rule alone. The model still reports the residue; whether it blocks
        // the verdict is the runner's call, exactly like an unclear page integrity under this
        // scope.
        return [
            'An outer ad wrapper, REKLAMA',
            'label, divider or frame, or reserved blank space or height at a removed advertising',
            'region is residue of the advertising footprint, not normal spacing. Set',
            'adLayoutResidue=present when any such residue remains, absent only when the full',
            'advertising footprint is gone, and unclear when the visual evidence cannot',
            'distinguish the two. This candidate is a network block of a third-party host: it can',
            'stop the advertising from loading but cannot collapse space the page itself reserves,',
            'so judge symptom by the advertising alone. An AFTER observation that is only empty',
            'residue, with no advertising creative in it, is not_same_symptom and does not keep',
            'the symptom open; it is exactly what adLayoutResidue=present reports. Whether residue',
            "still passes is the runner's decision, so never hide residue to get a rule through",
            'and never hold the symptom open for it. Page integrity is independent of both.',
        ];
    }
    return [
        'An outer ad wrapper, REKLAMA',
        'label, divider or frame, or reserved blank space or height at a removed advertising',
        'region is reporter-related residue, not normal spacing. Set adLayoutResidue=present',
        'when any such residue remains, absent only when the full advertising footprint is',
        'gone, and unclear when the visual evidence cannot distinguish the two. Page integrity',
        'is independent: a readable intact page with residual ad layout is still not fixed.',
    ];
}
