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
 * Rubric lines telling one inventory pass how to treat a dialog or overlay over the page.
 *
 * A pass sees one page state, so it cannot tell whether an obstruction changed; it records where
 * the obstruction sits and what it covers, and the synthesis compares the two states
 * ({@link COMPARISON_OBSTRUCTION_SYNTHESIS_RUBRIC}). Recorded as an instance of the defect, a
 * site's cookie notice that sits unchanged in both states comes back as a remaining symptom.
 */
export const COMPARISON_OBSTRUCTION_INVENTORY_RUBRIC = [
    'Treat cookie or consent dialogs, modal backdrops, blank overlays, and body scroll locks as',
    'comparison obstructions. Unless the reporter-defined defect is that very element, an',
    'obstruction is not an instance of it: name each one in the rationale with its landmark and',
    'whether it covers a region where the defect appears, so the later comparison can tell one',
    'that both states show unchanged from one that changes between them or hides the defect.',
];

/**
 * Rubric lines telling the final synthesis when an obstruction makes the comparison unreliable.
 *
 * A cookie notice the run left alone sits at the same place in BEFORE and AFTER and hides the same
 * pixels in both: with 18 empty-strip instances before and none after, the review still returned
 * unclear for it, and a correct candidate went unverified. Only an obstruction that changes between
 * the states, or hides where the symptom is, can make the states incomparable.
 */
export const COMPARISON_OBSTRUCTION_SYNTHESIS_RUBRIC = [
    'Apart from the reporter-defined defect itself, a cookie or consent dialog, modal backdrop,',
    'blank overlay, or body scroll lock prevents a reliable comparison of the underlying page',
    'when it changes between the aligned states — appears, disappears, moves, or changes',
    'appearance — or covers a region where the reporter-defined symptom appears in either state.',
    'In that case set symptom=unclear, pageIntegrity=unclear, and coverageComplete=false; never',
    'report the candidate as verified. One that both states show unchanged at the same place,',
    'clear of every symptom region, hides the same pixels in both and leaves the comparison',
    'reliable: judge the rest of the page as usual, and reconcile an observation of it as',
    'not_same_symptom. Do not attribute a modal appearing or disappearing to the candidate unless',
    'the aligned visual evidence itself proves that relationship.',
];

/**
 * Rubric lines telling the final synthesis that blank space the page already had is not residue.
 *
 * A news page shows empty grey video panels in BEFORE and AFTER alike; read as repeats of the
 * empty-ad-slot symptom, they kept a candidate that cleared every slot from verification. Space
 * that BEFORE already shows unchanged was there without the candidate. Space where BEFORE showed
 * the symptom is exactly what the candidate had to clear, so it stays residue, and no record of the
 * BEFORE state ever dismisses visible advertising. Only an ads review states it: in an
 * incorrect-blocking review an empty panel is the defect itself.
 */
export const PRE_EXISTING_BLANK_SPACE_RUBRIC = [
    'Blank space the page already had without the candidate is not residue the candidate left:',
    'an AFTER observation of blank space that the BEFORE inventory records unchanged at the same',
    'landmark — in a BEFORE observation you reconcile as not_same_symptom, or in an',
    `observedDamage entry prefixed "${PRE_EXISTING_DAMAGE_PREFIX}" — is not_same_symptom. This`,
    'never covers space where a BEFORE observation you retain as same_symptom sat, which is what',
    'the candidate had to clear, and never covers visible advertising, an ad label, or an ad frame.',
];

/**
 * The page's own blank panels a BEFORE inventory of an ads review lists as pre-existing flaws.
 *
 * Listed under {@link PRE_EXISTING_DAMAGE_PREFIX}, they let the synthesis tell blank space the page
 * already had from residue ({@link PRE_EXISTING_BLANK_SPACE_RUBRIC}). An incorrect-blocking review
 * never lists them: there an empty media panel is the defect class itself.
 */
export const PRE_EXISTING_BLANK_PANELS =
    'empty or unloaded media and image panels that are not ad slots';

/**
 * Dismissal ground, in every review, for an AFTER observation that is a distinct part of the page.
 */
const DISTINCT_STRUCTURE_GROUND = [
    'strong image-grounded positive visual evidence that the observation is a visually distinct',
    'normal structure or feature',
];

/**
 * Dismissal ground, in every review, for an obstruction that leaves the comparison reliable.
 *
 * It carries the qualifiers of {@link COMPARISON_OBSTRUCTION_SYNTHESIS_RUBRIC}.
 */
const UNCHANGED_OBSTRUCTION_GROUND = [
    'a comparison obstruction, other than the reporter-defined defect itself, that both states',
    'show unchanged at the same place, clear of every symptom region',
];

/**
 * Dismissal ground, in an ads review, for blank space the page already had.
 *
 * It carries the qualifiers of {@link PRE_EXISTING_BLANK_SPACE_RUBRIC}.
 */
export const PRE_EXISTING_BLANK_SPACE_GROUND = [
    'blank space the BEFORE inventory records unchanged at the same landmark, as a BEFORE',
    'observation reconciled not_same_symptom or an observedDamage entry prefixed',
    `"${PRE_EXISTING_DAMAGE_PREFIX}", never where a BEFORE observation retained as same_symptom`,
    'sat, and never visible advertising, an ad label, or an ad frame',
];

/**
 * Dismissal ground, in an ads review, for blank space an agent DOM check proves is layout.
 */
const DOM_CHECK_LAYOUT_GROUND = [
    'blank space an agent DOM check proves is page layout under the residue rubric',
];

/**
 * The only grounds on which the final synthesis may dismiss an AFTER observation.
 *
 * The synthesis rules and the dismissal self-critique both state them, each ground with its own
 * qualifiers, so the audit that backs the synthesis never allows more than the rules do and never
 * overturns a dismissal they allow. The blank-space grounds belong to the ads review: in an
 * incorrect-blocking review an empty panel is the defect itself, and no DOM check is supplied.
 *
 * @param kind - Problem class driving the review.
 * @returns Prompt lines listing every ground, ending the sentence.
 */
export function afterDismissalGrounds(kind: SymptomKind): string[] {
    const grounds = isBreakageSymptom(kind)
        ? [DISTINCT_STRUCTURE_GROUND, UNCHANGED_OBSTRUCTION_GROUND]
        : [
              DISTINCT_STRUCTURE_GROUND,
              UNCHANGED_OBSTRUCTION_GROUND,
              PRE_EXISTING_BLANK_SPACE_GROUND,
              DOM_CHECK_LAYOUT_GROUND,
          ];
    const rendered = grounds.map((ground) => ground.join(' '));
    return [`${rendered.slice(0, -1).join('; ')}; or ${rendered.at(-1)}.`];
}

/**
 * Rubric lines weighing the DOM checks the agent attached to `apply_rule`.
 *
 * Two reviewers looked at the same pixels after a candidate and split on whether a white column
 * where a sidebar had been was ad residue. The page's structure settles it: an empty track of a
 * transparent grid or the page's own margins are layout, while an emptied container that still
 * paints a grey background is residue. The runner measures what the agent asks on the very page
 * loads the images come from; these lines say how much the answers count, and never more than the
 * images for visible advertising.
 */
const DOM_CHECK_RESIDUE_RUBRIC = [
    'When agent DOM checks are supplied, weigh them for blank space at a removed advertising',
    'region. Blank space a check proves is an empty track of a transparent grid or flex',
    "container, or the page's own margins or background, is page layout, not residue: reconcile",
    'it as not_same_symptom and leave it out of adLayoutResidue. Blank space a check shows is an',
    'emptied container that still paints its own background, border or shadow, or a slot that',
    'keeps a reserved height, is residue. A check never dismisses visible advertising. A check',
    'that does not measure the region of the observation, or whose result does not support its',
    'claim, weighs nothing, and the images decide.',
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
            ...DOM_CHECK_RESIDUE_RUBRIC,
        ];
    }
    return [
        'An outer ad wrapper, REKLAMA',
        'label, divider or frame, or reserved blank space or height at a removed advertising',
        'region is reporter-related residue, not normal spacing. Set adLayoutResidue=present',
        'when any such residue remains, absent only when the full advertising footprint is',
        'gone, and unclear when the visual evidence cannot distinguish the two. Page integrity',
        'is independent: a readable intact page with residual ad layout is still not fixed.',
        ...DOM_CHECK_RESIDUE_RUBRIC,
    ];
}
