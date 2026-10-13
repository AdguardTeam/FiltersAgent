import { createHash } from 'node:crypto';
import * as v from 'valibot';
import { STORAGE_SENSITIVE_KEY_PATTERNS } from '../browser/har-redactor';
import type {
    InteractionDialogObservation,
    InteractionPopupObservation,
} from '../browser/interaction-page-events';
import { canonicalHttpOrigin } from '../browser/network-safety';
import { redactPayload } from '../tracer/redactor';

/**
 * How a rehearsal or stabilization step located its target element.
 */
export const TargetMatchedBy = {
    Selector: 'selector',
    TextHint: 'text_hint',
} as const;

/**
 * Target match source value.
 */
export type TargetMatchedBy = (typeof TargetMatchedBy)[keyof typeof TargetMatchedBy];

/**
 * Rehearsal step kinds the interaction grammar accepts.
 */
export const SafeInteractionKind = {
    Scroll: 'scroll',
    Hover: 'hover',
    Click: 'click',
    Type: 'type',
    Wait: 'wait',
    Reload: 'reload',
    Back: 'back',
} as const;

/**
 * Every rehearsal step kind value, for schemas and exhaustive listings.
 */
export const SAFE_INTERACTION_KIND_VALUES = Object.values(SafeInteractionKind);

export const SafeInteractionKindSchema = v.picklist(SAFE_INTERACTION_KIND_VALUES);

/**
 * One bounded action the host is able to perform inside the reported site.
 */
export type SafeInteractionKind = v.InferOutput<typeof SafeInteractionKindSchema>;

/**
 * Name of one host-owned non-sensitive value a text-entry step may enter.
 */
export const SyntheticTextToken = {
    /**
     * A synthetic person name for a name field.
     */
    SyntheticName: 'synthetic_name',

    /**
     * A synthetic search query for a query field.
     */
    SyntheticQuery: 'synthetic_query',

    /**
     * A synthetic message for a comment or free-text field.
     */
    SyntheticComment: 'synthetic_comment',

    /**
     * A synthetic digit string for a numeric-looking field.
     */
    SyntheticNumber: 'synthetic_number',
} as const;

/**
 * Every SyntheticTextToken value, for schemas and exhaustive listings.
 */
export const SYNTHETIC_TEXT_TOKEN_VALUES = Object.values(SyntheticTextToken);

export const SyntheticTextTokenSchema = v.picklist(SYNTHETIC_TEXT_TOKEN_VALUES);

/**
 * SyntheticTextToken value.
 */
export type SyntheticTextToken = (typeof SyntheticTextToken)[keyof typeof SyntheticTextToken];

/**
 * Fixed non-sensitive values the host substitutes for a synthetic text token.
 *
 * The agent never supplies text. A credential can therefore not be typed by construction, and a
 * replayed sequence enters byte-identical input.
 */
export const SYNTHETIC_TEXT_CATALOG: Readonly<Record<SyntheticTextToken, string>> = Object.freeze({
    [SyntheticTextToken.SyntheticName]: 'Test User',
    [SyntheticTextToken.SyntheticQuery]: 'test query',
    [SyntheticTextToken.SyntheticComment]: 'test comment',
    [SyntheticTextToken.SyntheticNumber]: '12345',
});

/**
 * Longest CSS selector one step may carry into the page.
 */
const MAX_STEP_SELECTOR_LENGTH = 500;

/**
 * Longest human-readable target hint one step may carry into the page.
 */
const MAX_STEP_TEXT_HINT_LENGTH = 200;

/**
 * Shortest bounded quiet period a wait step may request.
 */
const MIN_STEP_QUIET_MS = 250;

/**
 * Longest bounded quiet period a wait step may request.
 */
const MAX_STEP_QUIET_MS = 5_000;

export const SafeInteractionTargetSchema = v.pipe(
    v.strictObject({
        selector: v.nullable(
            v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_STEP_SELECTOR_LENGTH)),
        ),
        textHint: v.nullable(
            v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_STEP_TEXT_HINT_LENGTH)),
        ),
    }),
    v.check(
        (target) => target.selector !== null || target.textHint !== null,
        'An interaction target must name a selector, a text hint, or both.',
    ),
);

/**
 * Step kinds that resolve exactly one element before they are performed.
 */
const TARGETED_STEP_KINDS: readonly SafeInteractionKind[] = [
    SafeInteractionKind.Scroll,
    SafeInteractionKind.Hover,
    SafeInteractionKind.Click,
    SafeInteractionKind.Type,
];

export const SafeInteractionStepSchema = v.pipe(
    v.strictObject({
        kind: SafeInteractionKindSchema,
        target: v.nullable(SafeInteractionTargetSchema),
        text: v.nullable(SyntheticTextTokenSchema),
        quietMs: v.nullable(
            v.pipe(
                v.number(),
                v.integer(),
                v.minValue(MIN_STEP_QUIET_MS),
                v.maxValue(MAX_STEP_QUIET_MS),
            ),
        ),
    }),
    v.check(
        (step) => TARGETED_STEP_KINDS.includes(step.kind) === (step.target !== null),
        'Only a scroll, hover, click, or type step resolves a target, and each one requires it.',
    ),
    v.check(
        (step) => (step.kind === SafeInteractionKind.Type) === (step.text !== null),
        'Only a type step enters synthetic text, and it always names exactly one token.',
    ),
    v.check(
        (step) => (step.kind === SafeInteractionKind.Wait) === (step.quietMs !== null),
        'Only a wait step carries a quiet period, and it always carries one.',
    ),
);

/**
 * One canonical bounded action inside a normalized sequence.
 */
export type SafeInteractionStep = v.InferOutput<typeof SafeInteractionStepSchema>;

/**
 * Configured action and time bounds one interaction sequence may not exceed.
 */
export interface SafeInteractionBounds {
    /**
     * Maximum number of planned steps.
     */
    maxSteps: number;

    /**
     * Maximum wall-clock budget for one step, including its stabilization.
     */
    stepTimeoutMs: number;

    /**
     * Maximum wall-clock budget for the whole sequence.
     */
    totalBudgetMs: number;
}

export const DEFAULT_SAFE_INTERACTION_BOUNDS: SafeInteractionBounds = Object.freeze({
    maxSteps: 12,
    stepTimeoutMs: 5_000,
    totalBudgetMs: 45_000,
});

/**
 * Clamp one numeric bound into its hard range.
 *
 * @param value - Requested bound, or undefined to keep the default.
 * @param fallback - Default bound used when none was requested.
 * @param minimum - Hard lower limit.
 * @param maximum - Hard upper limit.
 * @returns Bound guaranteed to lie inside the hard range.
 */
function clampBound(
    value: number | undefined,
    fallback: number,
    minimum: number,
    maximum: number,
): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fallback;
    }
    return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

/**
 * Resolve the effective action and time bounds for one sequence.
 *
 * A caller may narrow the bounds but never widen them past the hard caps, so no request can buy
 * itself more actions or more wall-clock time than the host allows.
 *
 * @param partial - Optional narrowed bounds.
 * @returns Complete bounds inside the hard caps.
 */
export function resolveSafeInteractionBounds(
    partial?: Partial<SafeInteractionBounds>,
): SafeInteractionBounds {
    return {
        maxSteps: clampBound(partial?.maxSteps, DEFAULT_SAFE_INTERACTION_BOUNDS.maxSteps, 1, 24),
        stepTimeoutMs: clampBound(
            partial?.stepTimeoutMs,
            DEFAULT_SAFE_INTERACTION_BOUNDS.stepTimeoutMs,
            250,
            15_000,
        ),
        totalBudgetMs: clampBound(
            partial?.totalBudgetMs,
            DEFAULT_SAFE_INTERACTION_BOUNDS.totalBudgetMs,
            1_000,
            90_000,
        ),
    };
}

/**
 * Bounded sequence in its canonical form, with the digest two phases must agree on.
 */
export interface NormalizedSafeInteractionPlan {
    /**
     * Exact ordered steps, canonicalized so a re-stated plan is byte-identical.
     */
    steps: SafeInteractionStep[];

    /**
     * SHA-256 over the canonical positional form of every step.
     */
    digest: string;
}

/**
 * Reshape one model-authored step into the canonical form the normalizer validates.
 *
 * The model states a selector and a hint as flat fields because a nested object is a reliable
 * source of malformed tool arguments. This only fills the canonical nullable fields and validates
 * nothing, so `normalizeSafeInteractionPlan` remains the sole agent-request boundary.
 *
 * @param step - Untrusted step object as the model wrote it.
 * @returns Canonically shaped step, or the input unchanged when it is not an object at all.
 */
export function canonicalInteractionStep(step: unknown): unknown {
    if (typeof step !== 'object' || step === null || Array.isArray(step)) {
        return step;
    }
    const { kind, selector, textHint, text, quietMs } = step as Record<string, unknown>;
    return {
        kind,
        target:
            selector === undefined && textHint === undefined
                ? null
                : { selector: selector ?? null, textHint: textHint ?? null },
        text: text ?? null,
        quietMs: quietMs ?? null,
    };
}

export const SafeInteractionPlanRejectionSchema = v.picklist([
    'unsupported_step',
    'step_limit_exceeded',
    'malformed_plan',
]);

/**
 * Finite reason a proposed sequence was refused before anything was performed.
 */
export type SafeInteractionPlanRejection = v.InferOutput<typeof SafeInteractionPlanRejectionSchema>;

/**
 * The normalized sequence, or the finite reason the proposal was refused.
 */
export type SafeInteractionPlanOutcome =
    | {
          /**
           * Discriminator for an accepted sequence.
           */
          kind: 'normalized';

          /**
           * Canonical sequence and the digest both phases replay against.
           */
          plan: NormalizedSafeInteractionPlan;
      }
    | {
          /**
           * Discriminator for a refused proposal.
           */
          kind: 'rejected';

          /**
           * Exact reason the proposal was refused.
           */
          reason: SafeInteractionPlanRejection;

          /**
           * Bounded model-facing explanation naming the failing step and constraint.
           *
           * Without it a rejection is uncorrectable: a model told only "not accepted" burns whole
           * interaction retry budgets re-sending the same invalid shape.
           */
          detail: string;
      };

/**
 * Hash the canonical positional form of one bounded sequence.
 *
 * The form is positional rather than keyed so that no serialization detail — key order, key
 * spelling, or an absent optional field — can reach the digest.
 *
 * @param steps - Canonical ordered steps.
 * @returns Hex SHA-256 over the canonical form.
 */
function digestOfSteps(steps: readonly SafeInteractionStep[]): string {
    const canonical = JSON.stringify(
        steps.map((step) => [
            step.kind,
            step.target?.selector ?? '',
            step.target?.textHint ?? '',
            step.text ?? '',
            step.quietMs ?? 0,
        ]),
    );
    return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Upper bound for one model-facing plan rejection explanation.
 */
const MAX_REJECTION_DETAIL_LENGTH = 300;

/**
 * Refuse a proposal with a bounded explanation the model can act on.
 *
 * @param reason - Finite rejection category.
 * @param detail - Explanation naming the failing step and constraint.
 * @returns The rejected plan outcome.
 */
function rejectedPlan(
    reason: SafeInteractionPlanRejection,
    detail: string,
): SafeInteractionPlanOutcome {
    const bounded =
        detail.length > MAX_REJECTION_DETAIL_LENGTH
            ? `${detail.slice(0, MAX_REJECTION_DETAIL_LENGTH - 1)}…`
            : detail;
    return { kind: 'rejected', reason, detail: bounded };
}

/**
 * Normalize an untrusted interaction plan into its canonical bounded form.
 *
 * This is the sole agent-request boundary and the sole producer of the preparation digest that
 * phases B and C are required to agree on.
 *
 * @param plan - Untrusted proposed sequence.
 * @param bounds - Optional narrowed action and time bounds.
 * @returns Normalized plan with its digest, or the finite reason it was refused.
 */
export function normalizeSafeInteractionPlan(
    plan: unknown,
    bounds?: Partial<SafeInteractionBounds>,
): SafeInteractionPlanOutcome {
    if (!Array.isArray(plan)) {
        return rejectedPlan('malformed_plan', 'The plan must be an array of step objects.');
    }

    const steps: SafeInteractionStep[] = [];
    for (const [index, candidate] of plan.entries()) {
        const stepLabel = `Step ${String(index + 1)}`;
        if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
            return rejectedPlan(
                'malformed_plan',
                `${stepLabel} must be an object with a "kind" field.`,
            );
        }
        // A misspelled action is reported as an unsupported step; anything else about the step is
        // malformed. Only a named-but-unknown action can be reported as unsupported.
        const kind = (candidate as Record<string, unknown>).kind;
        if (typeof kind === 'string' && !v.is(SafeInteractionKindSchema, kind)) {
            return rejectedPlan(
                'unsupported_step',
                `${stepLabel} names unknown action "${kind}"; supported actions: ` +
                    `${SafeInteractionKindSchema.options.join(', ')}.`,
            );
        }
        const parsed = v.safeParse(SafeInteractionStepSchema, candidate);
        if (!parsed.success) {
            const issue = parsed.issues[0];
            const path = v.getDotPath(issue);
            return rejectedPlan(
                'malformed_plan',
                `${stepLabel}${path ? ` (${path})` : ''}: ${issue.message}`,
            );
        }
        steps.push(parsed.output);
    }

    const maxSteps = resolveSafeInteractionBounds(bounds).maxSteps;
    if (steps.length > maxSteps) {
        return rejectedPlan(
            'step_limit_exceeded',
            `The plan has ${String(steps.length)} steps; at most ${String(maxSteps)} are allowed.`,
        );
    }
    return { kind: 'normalized', plan: { steps, digest: digestOfSteps(steps) } };
}

/**
 * Bounded structural facts one fixed page probe returns about the resolved target.
 */
export interface SafeInteractionTargetFacts {
    /**
     * Whether exactly one element matched the bounded target.
     */
    found: boolean;

    /**
     * Signal that matched the element.
     */
    matchedBy: TargetMatchedBy | null;

    /**
     * Whether the element occupies space and is not hidden.
     */
    visible: boolean;

    /**
     * Whether the element reports itself disabled.
     */
    disabled: boolean;

    /**
     * Lowercase element tag.
     */
    tagName: string;

    /**
     * Lowercase `type` attribute for form controls, else the empty string.
     */
    inputType: string;

    /**
     * ARIA role attribute, else the empty string.
     */
    elementRole: string;

    /**
     * `id` attribute, bounded.
     */
    elementId: string;

    /**
     * `class` attribute, bounded.
     */
    elementClasses: string;

    /**
     * `name` attribute, bounded.
     */
    elementName: string;

    /**
     * `autocomplete` attribute, bounded.
     */
    autocompleteHint: string;

    /**
     * Normalized visible or ARIA label, bounded.
     */
    accessibleLabel: string;

    /**
     * Absolute destination of the element or its nearest anchor, else the empty string.
     */
    destination: string;

    /**
     * Absolute action of the enclosing form, else the empty string.
     */
    formDestination: string;

    /**
     * Whether the enclosing form contains a masked password input.
     *
     * Named for the masking rather than for the secret so the retention redactor, which deletes any
     * field whose key names a credential, keeps this structural fact.
     */
    hasMaskedInput: boolean;

    /**
     * Whether the element is or contains a file input.
     */
    hasFileInput: boolean;

    /**
     * Whether the element is, or contains, a media element.
     */
    containsMediaElement: boolean;

    /**
     * Whether a media element on the page covers most of the element's own box.
     *
     * A play overlay is typically an unnamed box stacked on top of the video rather than inside it,
     * so containment alone would not recognize it.
     */
    coversMediaElement: boolean;
}

/**
 * Finite category that stopped one planned step before it was performed.
 */
export const SafeInteractionRefusalReason = {
    /**
     * The resolved target was not found, not visible, or reported itself disabled.
     */
    TargetUnavailable: 'target_unavailable',

    /**
     * The control chooses or sends a file.
     */
    Upload: 'upload',

    /**
     * The control authenticates a person or handles a secret.
     */
    Credentials: 'credentials',

    /**
     * The control spends money or starts a paid commitment.
     */
    Purchase: 'purchase',

    /**
     * The control publishes content or submits a form.
     */
    Publication: 'publication',

    /**
     * The control requests a device or browser permission.
     */
    DevicePermission: 'device_permission',

    /**
     * The control's destination leaves the reported site's origin.
     */
    ExternalDestination: 'external_destination',

    /**
     * Nothing names the control or says where it leads, so its safety could not be established.
     */
    UnverifiableSafety: 'unverifiable_safety',
} as const;

/**
 * SafeInteractionRefusalReason value.
 */
export type SafeInteractionRefusalReason =
    (typeof SafeInteractionRefusalReason)[keyof typeof SafeInteractionRefusalReason];

/**
 * Permission to perform one step, or the finite reason the host refuses it.
 */
export type SafeInteractionDecision =
    | {
          /**
           * Discriminator for a permitted step.
           */
          allowed: true;
      }
    | {
          /**
           * Discriminator for a refused step.
           */
          allowed: false;

          /**
           * Exact category that refused it.
           */
          reason: SafeInteractionRefusalReason;
      };

/**
 * Signature words naming a control that chooses or sends a file.
 */
const UPLOAD_SIGNATURE_RE = /\b(?:upload|attach files?|attach|choose files?|browse files?)\b/u;

/**
 * Signature words naming a control that authenticates a person or handles a secret.
 */
const CREDENTIAL_SIGNATURE_RE =
    /\b(?:log ?in|login|log ?on|sign ?in|signin|sign ?up|signup|register|password|passphrase|passcode|credential|authenticate|username|my account|create account|one-?time code|verification code|two-?factor|2fa|otp)\b/u;

/**
 * Signature words naming a control that spends money or starts a paid commitment.
 */
const PURCHASE_SIGNATURE_RE =
    /\b(?:buy|purchase|checkout|check out|add to (?:cart|bag|basket)|place order|order now|pay|pay now|payment|billing|subscribe|subscription|upgrade|donate)\b/u;

/**
 * Signature words naming a control that publishes content or submits a form.
 */
const PUBLICATION_SIGNATURE_RE =
    /\b(?:post|publish|submit|comment|reply|send|share|tweet|save changes|apply changes)\b/u;

/**
 * Signature words naming a control that asks for a device or browser permission.
 */
const DEVICE_PERMISSION_SIGNATURE_RE =
    /\b(?:notifications?|location|geolocation|microphone|camera|webcam|screen ?share|push alerts?)\b/u;

/**
 * Autocomplete tokens that name a credential field.
 */
const CREDENTIAL_AUTOCOMPLETE_RE =
    /^(?:username|email|current-password|new-password|one-time-code)$/u;

/**
 * Step kinds that activate a control rather than merely observing it.
 */
const ACTIVATING_STEP_KINDS: readonly SafeInteractionKind[] = [
    SafeInteractionKind.Click,
    SafeInteractionKind.Type,
];

/**
 * Build the single lowercase text the lexical categories are matched against.
 *
 * Every naming attribute is folded into one string so a control cannot escape a category by moving
 * its intent from the label to the id, the class list, the name, or the role.
 *
 * @param facts - Bounded probe facts about the resolved element.
 * @returns Lowercase signature of everything that names the control.
 */
function targetSignature(facts: SafeInteractionTargetFacts): string {
    return [
        facts.elementId,
        facts.elementClasses,
        facts.elementName,
        facts.elementRole,
        facts.accessibleLabel,
    ]
        .join(' ')
        .toLocaleLowerCase();
}

/**
 * Decide whether one absolute destination leaves the reported site.
 *
 * A destination that cannot be parsed is treated as leaving: an origin that cannot be established
 * has not been established.
 *
 * @param destination - Absolute destination, or the empty string when the element has none.
 * @param allowedOrigin - Canonical origin of the reported site.
 * @returns Whether the destination is off-origin or unestablishable.
 */
function leavesAllowedOrigin(destination: string, allowedOrigin: string): boolean {
    if (destination.length === 0) {
        return false;
    }
    try {
        return canonicalHttpOrigin(destination) !== canonicalHttpOrigin(allowedOrigin);
    } catch {
        return true;
    }
}

/**
 * Refuse one step with a single finite category.
 *
 * @param reason - Category that refused it.
 * @returns Refusal decision.
 */
function refuse(reason: SafeInteractionRefusalReason): SafeInteractionDecision {
    return { allowed: false, reason };
}

/**
 * Decide whether one step merely starts playback on an unnamed player control.
 *
 * Players routinely stack a bare, unlabelled box over the video to catch the first click, and a
 * pre-roll ad only exists once that click happens. Such a control names nothing and leads nowhere,
 * so the generic unverifiable-safety refusal would reject exactly the class of symptom the run is
 * there to reproduce. Media adjacency is the one thing that does establish what the control is, and
 * it is checked last, so every named forbidden category still refuses first.
 *
 * @param step - Exact normalized step the run wants to perform.
 * @param facts - Bounded probe facts about the resolved element.
 * @returns Whether the step is a pointer interaction with a media control.
 */
function startsMedia(step: SafeInteractionStep, facts: SafeInteractionTargetFacts): boolean {
    if (step.kind !== SafeInteractionKind.Click && step.kind !== SafeInteractionKind.Hover) {
        return false;
    }
    return facts.containsMediaElement || facts.coversMediaElement;
}

/**
 * Decide whether one planned step may be performed on the resolved target.
 *
 * Reasons are evaluated in a fixed order and the first match wins, so a control matching several
 * forbidden categories always reports the same one.
 *
 * @param step - Exact normalized step the run wants to perform.
 * @param facts - Bounded probe facts, or null for a step that resolves no target.
 * @param allowedOrigin - Canonical origin of the reported site.
 * @returns Permission, or the finite reason the host refuses.
 */
export function classifySafeInteraction(
    step: SafeInteractionStep,
    facts: SafeInteractionTargetFacts | null,
    allowedOrigin: string,
): SafeInteractionDecision {
    if (facts === null) {
        return { allowed: true };
    }

    if (!facts.found || !facts.visible || facts.disabled) {
        return refuse(SafeInteractionRefusalReason.TargetUnavailable);
    }

    const signature = targetSignature(facts);
    const activating = ACTIVATING_STEP_KINDS.includes(step.kind);

    if (
        activating &&
        (facts.inputType === 'file' || facts.hasFileInput || UPLOAD_SIGNATURE_RE.test(signature))
    ) {
        return refuse(SafeInteractionRefusalReason.Upload);
    }
    if (
        activating &&
        (facts.inputType === 'password' ||
            facts.hasMaskedInput ||
            CREDENTIAL_AUTOCOMPLETE_RE.test(facts.autocompleteHint.toLocaleLowerCase()) ||
            CREDENTIAL_SIGNATURE_RE.test(signature))
    ) {
        return refuse(SafeInteractionRefusalReason.Credentials);
    }
    if (activating && PURCHASE_SIGNATURE_RE.test(signature)) {
        return refuse(SafeInteractionRefusalReason.Purchase);
    }
    // Both lexicons refuse a control such as "Share my location"; naming a device capability
    // decides which of the two reports it, so the reason stays the more accurate one.
    const devicePermission = activating && DEVICE_PERMISSION_SIGNATURE_RE.test(signature);
    if (
        activating &&
        !devicePermission &&
        (PUBLICATION_SIGNATURE_RE.test(signature) ||
            (facts.inputType === 'submit' && facts.formDestination.length > 0))
    ) {
        return refuse(SafeInteractionRefusalReason.Publication);
    }
    if (devicePermission) {
        return refuse(SafeInteractionRefusalReason.DevicePermission);
    }
    if (
        step.kind === SafeInteractionKind.Click &&
        (leavesAllowedOrigin(facts.destination, allowedOrigin) ||
            leavesAllowedOrigin(facts.formDestination, allowedOrigin))
    ) {
        return refuse(SafeInteractionRefusalReason.ExternalDestination);
    }
    // Nothing names this control and nothing says where it leads, so its safety was never
    // established. Refusing is the only honest answer; guessing it safe is not.
    if (
        signature.trim().length === 0 &&
        facts.destination.length === 0 &&
        facts.formDestination.length === 0 &&
        !startsMedia(step, facts)
    ) {
        return refuse(SafeInteractionRefusalReason.UnverifiableSafety);
    }
    return { allowed: true };
}

/**
 * Bounded page facts sampled immediately before and immediately after one step.
 */
export interface SafeInteractionPageState {
    /**
     * Current main-frame URL.
     */
    url: string;

    /**
     * Vertical scroll offset in CSS pixels.
     */
    scrollY: number;

    /**
     * Full scrollable document height in CSS pixels.
     */
    documentHeight: number;

    /**
     * Number of visible fixed overlays covering a meaningful share of the viewport.
     */
    visibleObstructionCount: number;

    /**
     * Whether the step's bounded target resolved at this moment.
     */
    targetFound: boolean;

    /**
     * Whether the step's bounded target was visible at this moment.
     */
    targetVisible: boolean;
}

/**
 * Whether the page settled after a step, or was never stabilized at all.
 */
export const StepStabilizationOutcome = {
    /**
     * The page settled within the stabilization budget.
     */
    Stable: 'stable',

    /**
     * The stabilization budget elapsed before the page settled.
     */
    TimedOut: 'timed_out',

    /**
     * Stabilization was never attempted for the step.
     */
    NotAttempted: 'not_attempted',
} as const;

/**
 * StepStabilizationOutcome value.
 */
export type StepStabilizationOutcome =
    (typeof StepStabilizationOutcome)[keyof typeof StepStabilizationOutcome];

/**
 * Browser activity observed around one step.
 */
export interface SafeInteractionStepObservation {
    /**
     * Completed network entries present after the step.
     */
    networkEntryCount: number;

    /**
     * Completed network entries the step added.
     */
    networkEntriesAdded: number;

    /**
     * Console errors present after the step.
     */
    consoleErrorCount: number;

    /**
     * Pages the site opened during the step.
     */
    popupsOpened: number;

    /**
     * Native dialogs the site raised and the host dismissed during the step.
     */
    dialogsDismissed: number;

    /**
     * Whether the page settled after the step, or was never stabilized at all.
     */
    stabilization: StepStabilizationOutcome;
}

/**
 * Finite reason one performed step stopped with a browser error rather than a policy refusal.
 */
export const SafeInteractionFailureDetail = {
    /**
     * An intervening element intercepted the click.
     */
    ClickIntercepted: 'click_intercepted',

    /**
     * The step did not complete within its bounded timeout.
     */
    StepTimeout: 'step_timeout',

    /**
     * Navigation destroyed the execution context mid-step.
     */
    NavigationDestroyed: 'navigation_destroyed',

    /**
     * The browser error does not match a more specific detail.
     */
    Unknown: 'unknown',
} as const;

/**
 * SafeInteractionFailureDetail value.
 */
export type SafeInteractionFailureDetail =
    (typeof SafeInteractionFailureDetail)[keyof typeof SafeInteractionFailureDetail];

/**
 * Whether a step ran, was refused by the gate, or stopped with an error.
 */
export const SafeInteractionStepOutcome = {
    /**
     * The step ran to completion.
     */
    Performed: 'performed',

    /**
     * The safety gate refused the step before it ran.
     */
    Refused: 'refused',

    /**
     * The step ran but stopped with a browser error.
     */
    Failed: 'failed',
} as const;

/**
 * SafeInteractionStepOutcome value.
 */
export type SafeInteractionStepOutcome =
    (typeof SafeInteractionStepOutcome)[keyof typeof SafeInteractionStepOutcome];

/**
 * Ordered evidence for exactly one attempted step.
 */
export interface SafeInteractionStepEvidence {
    /**
     * Zero-based position of the step in the normalized sequence.
     */
    index: number;

    /**
     * Exact normalized step that was attempted.
     */
    step: SafeInteractionStep;

    /**
     * Bounded probe facts about the element the step resolved, or null when it resolves none.
     */
    resolvedTarget: SafeInteractionTargetFacts | null;

    /**
     * Bounded page state sampled before the step was gated.
     */
    precondition: SafeInteractionPageState;

    /**
     * Whether the step ran, was refused by the gate, or stopped with an error.
     */
    outcome: SafeInteractionStepOutcome;

    /**
     * Policy category that stopped the step, or null when no policy stopped it.
     */
    refusalReason: SafeInteractionRefusalReason | null;

    /**
     * Finite browser-side cause of a failed step, or null when the step did not fail.
     *
     * An overlay that swallows the click is reported rather than worked around: on an anti-adblock
     * page the intercepting element is usually the very thing the candidate rule must remove.
     */
    failureDetail: SafeInteractionFailureDetail | null;

    /**
     * Bounded page state sampled after the step, or null when the step was refused or stopped
     * before its result could be sampled.
     */
    result: SafeInteractionPageState | null;

    /**
     * Milliseconds on the sequence clock at which the step began.
     */
    startedAtMs: number;

    /**
     * Wall-clock milliseconds the step consumed, including its stabilization.
     */
    durationMs: number;

    /**
     * Browser activity observed around the step.
     */
    observation: SafeInteractionStepObservation;
}

/**
 * Finite terminal status of one bounded interaction sequence.
 */
export const SafeInteractionRecordStatus = {
    /**
     * Every step in the sequence ran to completion.
     */
    Completed: 'completed',

    /**
     * The safety gate refused a step, stopping the sequence.
     */
    Refused: 'refused',

    /**
     * A step stopped the sequence with a browser error.
     */
    Failed: 'failed',

    /**
     * The sequence stopped after exhausting its bounded step or time budget.
     */
    BoundedOut: 'bounded_out',
} as const;

/**
 * SafeInteractionRecordStatus value.
 */
export type SafeInteractionRecordStatus =
    (typeof SafeInteractionRecordStatus)[keyof typeof SafeInteractionRecordStatus];

/**
 * Complete ordered record of one bounded interaction sequence.
 */
export interface SafeInteractionRecord {
    /**
     * Digest of the normalized plan this sequence executed.
     */
    planDigest: string;

    /**
     * Evidence for every attempted step, in attempt order.
     */
    steps: SafeInteractionStepEvidence[];

    /**
     * Finite terminal status of the sequence.
     */
    status: SafeInteractionRecordStatus;

    /**
     * Step and category of the refusal that stopped the sequence, else null.
     */
    refusal: {
        /**
         * Zero-based index of the refused step.
         */
        index: number;

        /**
         * Exact category that refused it.
         */
        reason: SafeInteractionRefusalReason;
    } | null;

    /**
     * Wall-clock milliseconds the whole sequence consumed.
     */
    elapsedMs: number;

    /**
     * Number of pages the site opened during the sequence.
     *
     * Counted in full even when only the first few are described below, because the count is what
     * the phases are compared on.
     */
    popupsOpened: number;

    /**
     * Bounded description of the pages the site opened, in arrival order.
     */
    popups: InteractionPopupObservation[];

    /**
     * Native dialogs the host dismissed during the sequence, in arrival order.
     */
    dialogs: InteractionDialogObservation[];
}

export const SafeInteractionDifferenceKindSchema = v.picklist([
    'plan_mismatch',
    'outcome',
    'refusal',
    'target_presence',
    'missing_step',
]);

/**
 * Finite kind of divergence between a sequence and its replay.
 */
export type SafeInteractionDifferenceKind = v.InferOutput<
    typeof SafeInteractionDifferenceKindSchema
>;

/**
 * Result of comparing a replayed sequence with the one it replays.
 */
export interface SafeInteractionComparison {
    /**
     * Whether the replay reproduced every outcome of the baseline sequence.
     */
    identical: boolean;

    /**
     * Every finite difference, in step order; `index` is -1 for a whole-plan mismatch.
     */
    differences: Array<{
        /**
         * Zero-based step index, or -1 when the plans themselves differ.
         */
        index: number;

        /**
         * Finite kind of difference observed at that index.
         */
        kind: SafeInteractionDifferenceKind;
    }>;
}

/**
 * Read whether one step resolved its control, for steps that resolve one at all.
 *
 * @param evidence - Evidence for one attempted step.
 * @returns Whether the control was found, or null when the step resolves none.
 */
function targetPresence(evidence: SafeInteractionStepEvidence): boolean | null {
    return evidence.resolvedTarget === null ? null : evidence.resolvedTarget.found;
}

/**
 * Read whether one step was stopped by the policy gate.
 *
 * @param evidence - Evidence for one attempted step.
 * @returns Whether the gate refused it.
 */
function wasRefused(evidence: SafeInteractionStepEvidence): boolean {
    return evidence.outcome === SafeInteractionStepOutcome.Refused;
}

/**
 * Classify how two evidence entries for the same step index diverge.
 *
 * The most specific cause wins, so a step the replay could not resolve is reported as a missing
 * control rather than as the refusal that missing control caused.
 *
 * Only preparation diverges here: whether the control existed, whether policy allowed it, and
 * whether the step ran. What the click then provoked — popups, requests, console errors — is
 * deliberately excluded, because that is the measurement itself. A candidate rule proves itself
 * exactly by the unfiltered phase opening a spam tab where the candidate phase opens none, and
 * calling that difference a replay divergence would reject every successful verification.
 *
 * @param baseline - Evidence from the sequence being replayed.
 * @param replay - Evidence from the replay.
 * @returns The finite difference kind, or null when the two agree.
 */
function stepDifference(
    baseline: SafeInteractionStepEvidence,
    replay: SafeInteractionStepEvidence,
): SafeInteractionDifferenceKind | null {
    if (targetPresence(baseline) !== targetPresence(replay)) {
        return 'target_presence';
    }
    if (wasRefused(baseline) !== wasRefused(replay)) {
        return 'refusal';
    }
    if (wasRefused(baseline) && baseline.refusalReason !== replay.refusalReason) {
        return 'refusal';
    }
    if (baseline.outcome !== replay.outcome) {
        return 'outcome';
    }
    return null;
}

/**
 * Compare a replayed sequence against the sequence that established the baseline.
 *
 * @param baseline - Record produced by the phase that established the reproduction.
 * @param replay - Record produced by replaying the same normalized plan.
 * @returns Whether the two agree, plus every finite difference between them.
 */
export function compareSafeInteractionRecords(
    baseline: SafeInteractionRecord,
    replay: SafeInteractionRecord,
): SafeInteractionComparison {
    // Two different sequences have no per-step relationship, so listing their steps side by side
    // would report differences that mean nothing.
    if (baseline.planDigest !== replay.planDigest) {
        return { identical: false, differences: [{ index: -1, kind: 'plan_mismatch' }] };
    }

    const differences: SafeInteractionComparison['differences'] = [];
    const shared = Math.min(baseline.steps.length, replay.steps.length);
    for (let index = 0; index < shared; index += 1) {
        const kind = stepDifference(baseline.steps[index]!, replay.steps[index]!);
        if (kind) {
            differences.push({ index, kind });
        }
    }
    if (baseline.steps.length !== replay.steps.length) {
        differences.push({ index: shared, kind: 'missing_step' });
    }
    return { identical: differences.length === 0, differences };
}

/**
 * Redact one record before it is retained and integrity-locked.
 *
 * Delegates to the single retention redactor the rest of the run uses, so URLs, header-shaped
 * lines, tokens, and configured secrets are removed by exactly one implementation. The record is
 * page-derived evidence, so the browser layer's PII key table joins the generic credential rules
 * for this walk.
 *
 * @param record - Complete interaction record.
 * @param configuredSecrets - Exact Host-configured secrets.
 * @returns Deep sanitized copy safe to persist.
 */
export function redactSafeInteractionRecord(
    record: SafeInteractionRecord,
    configuredSecrets: readonly string[] = [],
): SafeInteractionRecord {
    return redactPayload(record, configuredSecrets, {
        sensitiveKeyPatterns: STORAGE_SENSITIVE_KEY_PATTERNS,
    }) as SafeInteractionRecord;
}
