import { describe, expect, it } from 'vitest';
import {
    classifySafeInteraction,
    compareSafeInteractionRecords,
    normalizeSafeInteractionPlan,
    redactSafeInteractionRecord,
    type SafeInteractionKind,
    type SafeInteractionPlanOutcome,
    type SafeInteractionRecord,
    type SafeInteractionRefusalReason,
    type SafeInteractionStep,
    type SafeInteractionStepEvidence,
    type SafeInteractionTargetFacts,
} from '../../src/environment/safe-interaction';

const SELECTOR_STEPS = [
    { kind: 'scroll', target: { selector: '#promo', textHint: null }, text: null, quietMs: null },
    { kind: 'click', target: { selector: null, textHint: 'Show more' }, text: null, quietMs: null },
    { kind: 'wait', target: null, text: null, quietMs: 750 },
    {
        kind: 'type',
        target: { selector: 'input[name=q]', textHint: null },
        text: 'synthetic_query',
        quietMs: null,
    },
    { kind: 'reload', target: null, text: null, quietMs: null },
];

/**
 * Normalize a plan and fail loudly when it was refused.
 *
 * @param plan - Untrusted proposed sequence.
 * @returns The normalized outcome.
 */
function normalized(plan: unknown): Extract<SafeInteractionPlanOutcome, { kind: 'normalized' }> {
    const outcome = normalizeSafeInteractionPlan(plan);
    if (outcome.kind !== 'normalized') {
        throw new Error(`expected a normalized plan, got ${outcome.reason}`);
    }
    return outcome;
}

describe('normalizeSafeInteractionPlan', () => {
    it('states exactly what the run intends to do', () => {
        const outcome = normalized(SELECTOR_STEPS);

        expect(outcome.plan.steps).toHaveLength(5);
        expect(outcome.plan.steps.map((step) => step.kind)).toEqual([
            'scroll',
            'click',
            'wait',
            'type',
            'reload',
        ]);
        expect(outcome.plan.digest).toMatch(/^[0-9a-f]{64}$/u);
    });

    it('gives two runs that intend the same thing the same digest', () => {
        const reordered = SELECTOR_STEPS.map((step) => ({
            quietMs: step.quietMs,
            text: step.text,
            target: step.target
                ? { textHint: step.target.textHint, selector: step.target.selector }
                : null,
            kind: step.kind,
        }));

        expect(normalized(reordered).plan.digest).toBe(normalized(SELECTOR_STEPS).plan.digest);
    });

    it.each([
        ['kind', 0, { kind: 'hover' }],
        ['selector', 0, { target: { selector: '#other', textHint: null } }],
        ['textHint', 1, { target: { selector: null, textHint: 'Show less' } }],
        ['quietMs', 2, { quietMs: 1_000 }],
        ['token', 3, { text: 'synthetic_comment' }],
    ])('changing the %s changes the digest', (_field, index, patch) => {
        const changed = SELECTOR_STEPS.map((step, position) =>
            position === index ? { ...step, ...patch } : step,
        );

        expect(normalized(changed).plan.digest).not.toBe(normalized(SELECTOR_STEPS).plan.digest);
    });

    it('normalizes a phase that performs no interaction at all', () => {
        const outcome = normalized([]);

        expect(outcome.plan.steps).toEqual([]);
        expect(outcome.plan.digest).toMatch(/^[0-9a-f]{64}$/u);
        expect(normalized([]).plan.digest).toBe(outcome.plan.digest);
    });

    it.each([
        [
            'a targeted step with no target',
            [{ kind: 'click', target: null, text: null, quietMs: null }],
            'malformed_plan',
        ],
        [
            'text entry with no synthetic token',
            [
                {
                    kind: 'type',
                    target: { selector: '#q', textHint: null },
                    text: null,
                    quietMs: null,
                },
            ],
            'malformed_plan',
        ],
        [
            'a wait beyond the bounded quiet period',
            [{ kind: 'wait', target: null, text: null, quietMs: 60_000 }],
            'malformed_plan',
        ],
        [
            'a target that names neither a selector nor a hint',
            [
                {
                    kind: 'click',
                    target: { selector: null, textHint: null },
                    text: null,
                    quietMs: null,
                },
            ],
            'malformed_plan',
        ],
        [
            'agent-authored text instead of a host-owned token',
            [
                {
                    kind: 'type',
                    target: { selector: '#q', textHint: null },
                    text: 'hunter2',
                    quietMs: null,
                },
            ],
            'malformed_plan',
        ],
        [
            'a step kind outside the vocabulary',
            [{ kind: 'submit', target: { selector: 'form', textHint: null } }],
            'unsupported_step',
        ],
        ['a plan that is not a sequence at all', { kind: 'click' }, 'malformed_plan'],
        ['a sequence containing something that is not a step', ['click'], 'malformed_plan'],
    ])('refuses %s', (_name, plan, reason) => {
        const outcome = normalizeSafeInteractionPlan(plan);

        expect(outcome.kind).toBe('rejected');
        if (outcome.kind === 'rejected') {
            expect(outcome.reason).toBe(reason);
            expect(outcome.detail.length).toBeGreaterThan(0);
        }
    });

    it('explains each rejection so the model can correct its next plan', () => {
        // The exact live failure shape of issue 231213 (2026-08-14): a quiet period on a click.
        const quietOnClick = normalizeSafeInteractionPlan([
            {
                kind: 'click',
                target: { selector: '#accept', textHint: null },
                text: null,
                quietMs: 4_000,
            },
        ]);
        if (quietOnClick.kind !== 'rejected') {
            throw new Error('expected a rejection');
        }
        expect(quietOnClick.reason).toBe('malformed_plan');
        expect(quietOnClick.detail).toContain('Step 1');
        expect(quietOnClick.detail).toContain('Only a wait step carries a quiet period');

        // The exact live failure shape of issue 237887: a wait beyond the bounded quiet period.
        const longWait = normalizeSafeInteractionPlan([
            { kind: 'wait', target: null, text: null, quietMs: 6_000 },
        ]);
        if (longWait.kind !== 'rejected') {
            throw new Error('expected a rejection');
        }
        expect(longWait.detail).toContain('5000');

        const unknownKind = normalizeSafeInteractionPlan([
            { kind: 'submit', target: { selector: 'form', textHint: null }, text: null },
        ]);
        if (unknownKind.kind !== 'rejected') {
            throw new Error('expected a rejection');
        }
        expect(unknownKind.detail).toContain('submit');
        expect(unknownKind.detail).toContain('click');
    });

    it('refuses a sequence longer than the configured action bound', () => {
        const plan = Array.from({ length: 25 }, () => ({
            kind: 'scroll',
            target: { selector: '#promo', textHint: null },
            text: null,
            quietMs: null,
        }));

        const outcome = normalizeSafeInteractionPlan(plan);

        expect(outcome.kind).toBe('rejected');
        if (outcome.kind === 'rejected') {
            expect(outcome.reason).toBe('step_limit_exceeded');
        }
    });
});

const ALLOWED_ORIGIN = 'https://site.example';

const PLAIN_BUTTON: SafeInteractionTargetFacts = {
    found: true,
    matchedBy: 'text_hint',
    visible: true,
    disabled: false,
    tagName: 'button',
    inputType: '',
    elementRole: 'button',
    elementId: 'more-articles',
    elementClasses: 'btn btn-secondary',
    elementName: '',
    autocompleteHint: '',
    accessibleLabel: 'Show more',
    destination: '',
    formDestination: '',
    hasMaskedInput: false,
    hasFileInput: false,
    containsMediaElement: false,
    coversMediaElement: false,
};

/**
 * Build a step of the given kind over the standard bounded target.
 *
 * @param kind - Action the step performs.
 * @returns Well-formed step ready for the gate.
 */
function stepOf(kind: SafeInteractionKind): SafeInteractionStep {
    return {
        kind,
        target:
            kind === 'wait' || kind === 'reload' || kind === 'back'
                ? null
                : { selector: '#control', textHint: null },
        text: kind === 'type' ? 'synthetic_query' : null,
        quietMs: kind === 'wait' ? 500 : null,
    };
}

interface GateScenario {
    name: string;
    kind?: SafeInteractionKind;
    facts?: Partial<SafeInteractionTargetFacts>;
    reason: SafeInteractionRefusalReason | null;
}

const gateScenarios: GateScenario[] = [
    { name: 'an ordinary labelled button is operated', reason: null },
    {
        name: 'a control the page never resolved',
        facts: { found: false },
        reason: 'target_unavailable',
    },
    {
        name: 'a control that is not on screen',
        facts: { visible: false },
        reason: 'target_unavailable',
    },
    {
        name: 'a control the page reports disabled',
        facts: { disabled: true },
        reason: 'target_unavailable',
    },
    {
        name: 'a file chooser',
        facts: { tagName: 'input', inputType: 'file', accessibleLabel: 'Attach' },
        reason: 'upload',
    },
    {
        name: 'a control that carries a file input',
        facts: { hasFileInput: true, accessibleLabel: 'Attach' },
        reason: 'upload',
    },
    {
        name: 'a password field',
        facts: { tagName: 'input', inputType: 'password', accessibleLabel: 'Password' },
        reason: 'credentials',
    },
    {
        name: 'a field asking for the current password',
        facts: { tagName: 'input', autocompleteHint: 'current-password' },
        reason: 'credentials',
    },
    {
        name: 'a control inside a form that asks for a password',
        facts: { hasMaskedInput: true, accessibleLabel: 'Continue' },
        reason: 'credentials',
    },
    { name: 'a sign-in button', facts: { accessibleLabel: 'Log in' }, reason: 'credentials' },
    { name: 'a sign-in submit', facts: { elementId: 'signin-submit' }, reason: 'credentials' },
    { name: 'a buy button', facts: { accessibleLabel: 'Buy now' }, reason: 'purchase' },
    {
        name: 'an add-to-cart button',
        facts: { accessibleLabel: 'Add to cart' },
        reason: 'purchase',
    },
    { name: 'a checkout button', facts: { accessibleLabel: 'Checkout' }, reason: 'purchase' },
    { name: 'an order button', facts: { accessibleLabel: 'Place order' }, reason: 'purchase' },
    { name: 'a subscribe button', facts: { accessibleLabel: 'Subscribe' }, reason: 'purchase' },
    {
        name: 'a comment submission',
        facts: { accessibleLabel: 'Post comment' },
        reason: 'publication',
    },
    { name: 'a publish button', facts: { accessibleLabel: 'Publish' }, reason: 'publication' },
    {
        name: 'a form submit control',
        facts: { tagName: 'input', inputType: 'submit', formDestination: `${ALLOWED_ORIGIN}/save` },
        reason: 'publication',
    },
    {
        name: 'a notification permission prompt',
        facts: { accessibleLabel: 'Allow notifications' },
        reason: 'device_permission',
    },
    {
        name: 'a location request',
        facts: { accessibleLabel: 'Share my location' },
        reason: 'device_permission',
    },
    {
        name: 'a microphone request',
        facts: { accessibleLabel: 'Use microphone' },
        reason: 'device_permission',
    },
    {
        name: 'a link that leaves the reported site',
        facts: { tagName: 'a', destination: 'https://other.example/x' },
        reason: 'external_destination',
    },
    {
        name: 'a form that posts to another site',
        facts: { formDestination: 'https://other.example/submit' },
        reason: 'external_destination',
    },
    {
        name: 'a destination that cannot be parsed at all',
        facts: { tagName: 'a', destination: 'not a url' },
        reason: 'external_destination',
    },
    {
        name: 'a control with nothing that establishes what it does',
        facts: {
            elementId: '',
            elementClasses: '',
            elementName: '',
            elementRole: '',
            accessibleLabel: '',
        },
        reason: 'unverifiable_safety',
    },
    {
        name: 'a file chooser that also asks for money',
        facts: { inputType: 'file', accessibleLabel: 'Buy now' },
        reason: 'upload',
    },
    {
        name: 'a purchase control behind a login',
        facts: { accessibleLabel: 'Log in to buy' },
        reason: 'credentials',
    },
    {
        name: 'text entry into a username field',
        kind: 'type',
        facts: { tagName: 'input', autocompleteHint: 'username', accessibleLabel: 'Email' },
        reason: 'credentials',
    },
    {
        name: 'text entry into an ordinary search box',
        kind: 'type',
        facts: { tagName: 'textarea', accessibleLabel: 'Search', elementName: 'q' },
        reason: null,
    },
    {
        name: 'scrolling a commerce control into view',
        kind: 'scroll',
        facts: { accessibleLabel: 'Buy now' },
        reason: null,
    },
    {
        name: 'hovering a commerce control',
        kind: 'hover',
        facts: { accessibleLabel: 'Buy now' },
        reason: null,
    },
];

describe('classifySafeInteraction', () => {
    it.each(gateScenarios)('$name', (scenario) => {
        const decision = classifySafeInteraction(
            stepOf(scenario.kind ?? 'click'),
            { ...PLAIN_BUTTON, ...scenario.facts },
            ALLOWED_ORIGIN,
        );

        expect(decision.allowed).toBe(scenario.reason === null);
        if (!decision.allowed) {
            expect(decision.reason).toBe(scenario.reason);
        }
    });

    it.each(['reload', 'back', 'wait'] as const)(
        'permits %s, which resolves no control to judge',
        (kind) => {
            expect(classifySafeInteraction(stepOf(kind), null, ALLOWED_ORIGIN).allowed).toBe(true);
        },
    );
});

const PLAN_DIGEST = 'd'.repeat(64);

/**
 * Build one step evidence entry over the standard bounded target.
 *
 * @param index - Zero-based position of the step in the sequence.
 * @param overrides - Fields this row states differently.
 * @returns Complete evidence entry.
 */
function evidenceAt(
    index: number,
    overrides: Partial<SafeInteractionStepEvidence> = {},
): SafeInteractionStepEvidence {
    return {
        index,
        step: stepOf('click'),
        resolvedTarget: PLAIN_BUTTON,
        precondition: {
            url: `${ALLOWED_ORIGIN}/article`,
            scrollY: 0,
            documentHeight: 4_000,
            visibleObstructionCount: 0,
            targetFound: true,
            targetVisible: true,
        },
        outcome: 'performed',
        refusalReason: null,
        failureDetail: null,
        result: {
            url: `${ALLOWED_ORIGIN}/article`,
            scrollY: 400,
            documentHeight: 4_000,
            visibleObstructionCount: 0,
            targetFound: true,
            targetVisible: true,
        },
        startedAtMs: 1_000 + index * 100,
        durationMs: 40,
        observation: {
            networkEntryCount: 12,
            networkEntriesAdded: 2,
            consoleErrorCount: 0,
            popupsOpened: 0,
            dialogsDismissed: 0,
            stabilization: 'stable',
        },
        ...overrides,
    };
}

/**
 * Build one complete record over a fixed plan digest.
 *
 * @param steps - Ordered step evidence.
 * @param overrides - Record fields this row states differently.
 * @returns Complete interaction record.
 */
function recordOf(
    steps: SafeInteractionStepEvidence[],
    overrides: Partial<SafeInteractionRecord> = {},
): SafeInteractionRecord {
    return {
        planDigest: PLAN_DIGEST,
        steps,
        status: 'completed',
        refusal: null,
        elapsedMs: 500,
        popupsOpened: 0,
        popups: [],
        dialogs: [],
        ...overrides,
    };
}

describe('compareSafeInteractionRecords', () => {
    it('reports no difference when the replay reproduced every outcome', () => {
        const comparison = compareSafeInteractionRecords(
            recordOf([evidenceAt(0), evidenceAt(1)]),
            recordOf([evidenceAt(0), evidenceAt(1)]),
        );

        expect(comparison).toEqual({ identical: true, differences: [] });
    });

    it('reports the step the replay refused', () => {
        const refused = evidenceAt(1, {
            outcome: 'refused',
            refusalReason: 'credentials',
            result: null,
        });

        const comparison = compareSafeInteractionRecords(
            recordOf([evidenceAt(0), evidenceAt(1)]),
            recordOf([evidenceAt(0), refused], {
                status: 'refused',
                refusal: { index: 1, reason: 'credentials' },
            }),
        );

        expect(comparison.identical).toBe(false);
        expect(comparison.differences).toEqual([{ index: 1, kind: 'refusal' }]);
    });

    it('reports the step whose control the replay never found', () => {
        const missingTarget = evidenceAt(0, {
            resolvedTarget: { ...PLAIN_BUTTON, found: false },
            outcome: 'refused',
            refusalReason: 'target_unavailable',
            result: null,
        });

        const comparison = compareSafeInteractionRecords(
            recordOf([evidenceAt(0)]),
            recordOf([missingTarget], {
                status: 'refused',
                refusal: { index: 0, reason: 'target_unavailable' },
            }),
        );

        expect(comparison.identical).toBe(false);
        expect(comparison.differences).toEqual([{ index: 0, kind: 'target_presence' }]);
    });

    it('reports the point at which the replay stopped short', () => {
        const comparison = compareSafeInteractionRecords(
            recordOf([evidenceAt(0), evidenceAt(1), evidenceAt(2), evidenceAt(3)]),
            recordOf([evidenceAt(0), evidenceAt(1)], { status: 'bounded_out' }),
        );

        expect(comparison.identical).toBe(false);
        expect(comparison.differences).toEqual([{ index: 2, kind: 'missing_step' }]);
    });

    it('refuses to compare two different sequences step by step', () => {
        const comparison = compareSafeInteractionRecords(
            recordOf([evidenceAt(0), evidenceAt(1)]),
            recordOf([evidenceAt(0, { outcome: 'failed', result: null })], {
                planDigest: 'e'.repeat(64),
                status: 'failed',
            }),
        );

        expect(comparison).toEqual({
            identical: false,
            differences: [{ index: -1, kind: 'plan_mismatch' }],
        });
    });
});

describe('redactSafeInteractionRecord', () => {
    const secret = 'SEEKRET-LICENSE';
    const record = recordOf([
        evidenceAt(0, {
            resolvedTarget: {
                ...PLAIN_BUTTON,
                elementId: 'promo-close',
                elementClasses: 'btn promo-dismiss',
                accessibleLabel: `Open ${secret} panel`,
                destination: `${ALLOWED_ORIGIN}/x?token=SEEKRET`,
            },
            precondition: {
                url: `${ALLOWED_ORIGIN}/article?session=sess-9f3`,
                scrollY: 0,
                documentHeight: 4_000,
                visibleObstructionCount: 1,
                targetFound: true,
                targetVisible: true,
            },
        }),
    ]);

    it('removes every sensitive value from what is retained', () => {
        const serialized = JSON.stringify(redactSafeInteractionRecord(record, [secret]));

        expect(serialized).not.toContain('SEEKRET');
        expect(serialized).not.toContain('sess-9f3');
        expect(serialized).toContain('[redacted]');
    });

    it('keeps the evidence the redaction protects', () => {
        const redacted = redactSafeInteractionRecord(record, [secret]);
        const target = redacted.steps[0]!.resolvedTarget!;

        expect(target.elementId).toBe('promo-close');
        expect(target.elementClasses).toBe('btn promo-dismiss');
        expect(target.hasMaskedInput).toBe(false);
        expect(redacted.steps[0]!.outcome).toBe('performed');
        expect(redacted.steps[0]!.index).toBe(0);
        expect(redacted.planDigest).toBe(PLAN_DIGEST);
    });
});
