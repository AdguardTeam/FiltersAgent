import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
    normalizeSafeInteractionPlan,
    type NormalizedSafeInteractionPlan,
    type SafeInteractionRecord,
    type SafeInteractionTargetFacts,
} from '../../src/environment/safe-interaction';
import type { TraceRecorder } from '../../src/tracer/trace-recorder';
import { ConsoleCoverage, type IBrowserSession } from '../../src/browser/browser-interfaces';
import {
    persistSafeInteractionRecord,
    runSafeInteractionSequence,
} from '../../src/browser/safe-interaction-runner';
import { evaluatePageScript, fakeElement, type FakeElement } from './fixtures/page-script-sandbox';

const ALLOWED_ORIGIN = 'https://site.example';

const PLAIN_BUTTON: SafeInteractionTargetFacts = {
    found: true,
    matchedBy: 'selector',
    visible: true,
    disabled: false,
    tagName: 'button',
    inputType: '',
    elementRole: 'button',
    elementId: 'more-articles',
    elementClasses: 'btn',
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

interface FakePage {
    /**
     * Recorded Playwright element actions, in call order.
     */
    actions: string[];

    /**
     * Every expression the runner evaluated in the isolated world, in call order.
     */
    probes: string[];

    /**
     * Current main-frame URL the fake page reports.
     */
    url: ReturnType<typeof vi.fn>;

    /**
     * Recorded top-level page navigations.
     */
    reload: ReturnType<typeof vi.fn>;

    /**
     * Recorded history navigations.
     */
    goBack: ReturnType<typeof vi.fn>;

    /**
     * Pages the site opened that the runner has not closed again.
     */
    openPopups: () => number;

    /**
     * Dialogs the site raised that were answered rather than left pending.
     */
    dismissedDialogs: () => number;
}

interface FakeSessionScript {
    /**
     * Facts the resolve probe reports, by zero-based step index.
     */
    facts?: Record<number, Partial<SafeInteractionTargetFacts>>;

    /**
     * Elements the test target selector matches. When set, the resolve probe runs as page script
     * against them instead of reporting fixed facts.
     */
    page?: FakeElement[];

    /**
     * URL the page reports after the step at this index has been performed.
     */
    urlAfter?: Record<number, string>;

    /**
     * Element action that rejects, by zero-based step index.
     */
    actionFails?: number;

    /**
     * Error the failing element action throws, replacing the default detachment.
     */
    actionError?: Error;

    /**
     * URL of the page the site opens when the step at this index is performed.
     */
    popupOnStep?: Record<number, string>;

    /**
     * Number of tabs the site opens per popup-producing step, defaulting to one.
     */
    popupsPerStep?: number;

    /**
     * Native dialog kind the site raises when the step at this index is performed.
     */
    dialogOnStep?: Record<number, string>;
}

type FakeListeners = Map<string, Array<(value: unknown) => void>>;

/**
 * Register one listener on a fake emitter, mirroring Playwright's own event surface.
 *
 * @param listeners - Emitter the listener belongs to.
 * @param event - Event name the listener answers.
 * @param handler - Listener to add.
 */
function addListener(
    listeners: FakeListeners,
    event: string,
    handler: (value: unknown) => void,
): void {
    listeners.set(event, [...(listeners.get(event) ?? []), handler]);
}

/**
 * Remove one listener from a fake emitter.
 *
 * @param listeners - Emitter the listener belongs to.
 * @param event - Event name the listener answered.
 * @param handler - Listener to remove.
 */
function removeListener(
    listeners: FakeListeners,
    event: string,
    handler: (value: unknown) => void,
): void {
    listeners.set(
        event,
        (listeners.get(event) ?? []).filter((entry) => entry !== handler),
    );
}

/**
 * Deliver one event to every listener currently registered for it.
 *
 * @param listeners - Emitter the event belongs to.
 * @param event - Event name being emitted.
 * @param value - Payload every listener receives.
 */
function emit(listeners: FakeListeners, event: string, value: unknown): void {
    for (const handler of listeners.get(event) ?? []) {
        handler(value);
    }
}

/**
 * Build a browser session whose page records every action and answers every fixed probe.
 *
 * @param script - Per-step probe facts, post-step URLs, and injected failures.
 * @returns The fake session plus the page recorder the assertions read.
 */
function fakeSession(script: FakeSessionScript = {}): {
    session: IBrowserSession;
    page: FakePage;
} {
    const actions: string[] = [];
    const probes: string[] = [];
    let currentUrl = `${ALLOWED_ORIGIN}/article`;
    let resolveCount = 0;

    const contextListeners: FakeListeners = new Map();
    const pageListeners: FakeListeners = new Map();
    let openPopups = 0;
    let dismissedDialogs = 0;

    /**
     * Open one fake popup page the site would have opened, tracking whether it is closed again.
     *
     * @param url - URL the popup settles on.
     */
    const openPopup = (url: string): void => {
        openPopups += 1;
        emit(contextListeners, 'page', {
            url: () => url,
            mainFrame: () => ({ url: () => url }),
            on: () => undefined,
            close: async () => {
                openPopups -= 1;
            },
        });
    };

    const locatorHandle = {
        scrollIntoViewIfNeeded: vi.fn(),
        hover: vi.fn(),
        click: vi.fn(),
        fill: vi.fn(),
    };
    for (const [name, handle] of Object.entries(locatorHandle)) {
        handle.mockImplementation(async (...args: unknown[]) => {
            const stepIndex = resolveCount - 1;
            actions.push(typeof args[0] === 'string' ? `${name}(${args[0]})` : name);
            const popup = script.popupOnStep?.[stepIndex];
            if (popup) {
                for (let count = 0; count < (script.popupsPerStep ?? 1); count += 1) {
                    openPopup(popup);
                }
            }
            const dialog = script.dialogOnStep?.[stepIndex];
            if (dialog) {
                emit(pageListeners, 'dialog', {
                    type: () => dialog,
                    dismiss: async () => {
                        dismissedDialogs += 1;
                    },
                });
            }
            if (script.actionFails === stepIndex) {
                throw script.actionError ?? new Error('element detached');
            }
            const next = script.urlAfter?.[stepIndex];
            if (next) {
                currentUrl = next;
            }
        });
    }

    const cdpSession = {
        send: vi
            .fn()
            .mockImplementation(async (method: string, params?: Record<string, unknown>) => {
                if (method === 'Page.getFrameTree') {
                    return { frameTree: { frame: { id: 'main' } } };
                }
                if (method === 'Page.createIsolatedWorld') {
                    return { executionContextId: 1 };
                }
                if (method !== 'Runtime.evaluate') {
                    return {};
                }
                const expression = String(params?.expression ?? '');
                probes.push(expression);
                if (script.page && expression.includes('__adguard_interaction_resolve_probe__')) {
                    return {
                        result: { value: evaluatePageScript(expression, '#control', script.page) },
                    };
                }
                if (expression.includes('__adguard_interaction_resolve_probe__')) {
                    const stepIndex = resolveCount;
                    resolveCount += 1;
                    return {
                        result: { value: { ...PLAIN_BUTTON, ...script.facts?.[stepIndex] } },
                    };
                }
                if (expression.includes('__adguard_interaction_release_probe__')) {
                    return { result: { value: { released: true } } };
                }
                if (expression.includes('__adguard_interaction_state_probe__')) {
                    return {
                        result: {
                            value: {
                                url: currentUrl,
                                scrollY: 0,
                                documentHeight: 3_000,
                                visibleObstructionCount: 0,
                                targetFound: true,
                                targetVisible: true,
                            },
                        },
                    };
                }
                return { result: { value: null } };
            }),
        detach: vi.fn().mockResolvedValue(undefined),
    };

    const page = {
        evaluate: vi.fn().mockImplementation(async (expression: unknown) => {
            if (
                typeof expression === 'string' &&
                expression.includes('__adguard_page_stability_probe__')
            ) {
                return {
                    readyState: 'complete',
                    htmlLength: 1_024,
                    nodeCount: 20,
                    textLength: 100,
                    scrollHeight: 1_080,
                    scrollY: 0,
                    resourceCount: 4,
                    domFingerprint: 'stable-dom',
                };
            }
            return undefined;
        }),
        waitForTimeout: vi.fn().mockResolvedValue(undefined),
        url: vi.fn().mockImplementation(() => currentUrl),
        locator: vi.fn().mockReturnValue(locatorHandle),
        reload: vi.fn().mockImplementation(async () => {
            actions.push('reload');
        }),
        goBack: vi.fn().mockImplementation(async () => {
            actions.push('goBack');
        }),
        on: vi.fn().mockImplementation((event: string, handler: (value: unknown) => void) => {
            addListener(pageListeners, event, handler);
        }),
        off: vi.fn().mockImplementation((event: string, handler: (value: unknown) => void) => {
            removeListener(pageListeners, event, handler);
        }),
        context: vi.fn().mockReturnValue({
            newCDPSession: vi.fn().mockResolvedValue(cdpSession),
            on: vi.fn().mockImplementation((event: string, handler: (value: unknown) => void) => {
                addListener(contextListeners, event, handler);
            }),
            off: vi.fn().mockImplementation((event: string, handler: (value: unknown) => void) => {
                removeListener(contextListeners, event, handler);
            }),
        }),
    };

    const session = {
        getPage: () => page,
        close: async () => undefined,
        getNetworkLog: () => [],
        resetNetworkLog: () => undefined,
        getConsoleLog: () => [],
        consoleCoverage: ConsoleCoverage.BrowserLogOnly,
        artifactsDir: '/tmp/artifacts',
        isClosed: false,
    } as unknown as IBrowserSession;

    return {
        session,
        page: {
            actions,
            probes,
            url: page.url,
            reload: page.reload,
            goBack: page.goBack,
            openPopups: () => openPopups,
            dismissedDialogs: () => dismissedDialogs,
        },
    };
}

/**
 * Normalize a plan the test states inline.
 *
 * @param steps - Proposed sequence.
 * @returns The normalized plan.
 */
function planOf(steps: unknown[]): NormalizedSafeInteractionPlan {
    const outcome = normalizeSafeInteractionPlan(steps);
    if (outcome.kind !== 'normalized') {
        throw new Error(`plan refused: ${outcome.reason}`);
    }
    return outcome.plan;
}

/**
 * Build one well-formed step for the fixed test target.
 *
 * @param kind - Action the step performs.
 * @returns Proposed step.
 */
function step(kind: string): Record<string, unknown> {
    const targeted = ['scroll', 'hover', 'click', 'type'].includes(kind);
    return {
        kind,
        target: targeted ? { selector: '#control', textHint: null } : null,
        text: kind === 'type' ? 'synthetic_query' : null,
        quietMs: kind === 'wait' ? 300 : null,
    };
}

/**
 * Count how many times a fixed probe was evaluated.
 *
 * @param page - Fake page recorder.
 * @param marker - Probe marker to count.
 * @returns Number of evaluations.
 */
function probeCount(page: FakePage, marker: string): number {
    return page.probes.filter((expression) => expression.includes(marker)).length;
}

describe('runSafeInteractionSequence', () => {
    it('performs the planned sequence in order and records every step', async () => {
        const { session, page } = fakeSession();

        const record = await runSafeInteractionSequence({
            session,
            plan: planOf([step('scroll'), step('hover'), step('click'), step('type')]),
            allowedOrigin: ALLOWED_ORIGIN,
        });

        expect(page.actions).toEqual([
            'scrollIntoViewIfNeeded',
            'hover',
            'click',
            'fill(test query)',
        ]);
        expect(record.status).toBe('completed');
        expect(record.steps).toHaveLength(4);
        record.steps.forEach((evidence, index) => {
            expect(evidence.index).toBe(index);
            expect(evidence.outcome).toBe('performed');
            expect(evidence.precondition).not.toBeNull();
            expect(evidence.result).not.toBeNull();
            expect(evidence.durationMs).toBeGreaterThanOrEqual(0);
        });
    });

    it('resolves a control the page itself finds by selector', async () => {
        // The resolve script once named `TargetMatchedBy` from this module; the page has no
        // such binding, so every targeted step threw inside the page.
        const control = fakeElement('BUTTON', 'Show more', { id: 'more-articles' });
        const { session, page } = fakeSession({ page: [control] });

        const record = await runSafeInteractionSequence({
            session,
            plan: planOf([step('click')]),
            allowedOrigin: ALLOWED_ORIGIN,
        });

        expect(record.steps[0]).toMatchObject({
            outcome: 'performed',
            resolvedTarget: { found: true, matchedBy: 'selector', tagName: 'button' },
        });
        expect(page.actions).toEqual(['click']);
    });

    it('refuses a control that asks for a credential without touching the page', async () => {
        const { session, page } = fakeSession({ facts: { 1: { hasMaskedInput: true } } });

        const record = await runSafeInteractionSequence({
            session,
            plan: planOf([step('click'), step('click'), step('click')]),
            allowedOrigin: ALLOWED_ORIGIN,
        });

        expect(record.status).toBe('refused');
        expect(record.refusal).toEqual({ index: 1, reason: 'credentials' });
        expect(record.steps).toHaveLength(2);
        expect(record.steps[1]!.outcome).toBe('refused');
        expect(record.steps[1]!.result).toBeNull();
        expect(page.actions).toEqual(['click']);
    });

    it('refuses a control that leads off the reported site without following it', async () => {
        const { session, page } = fakeSession({
            facts: { 0: { tagName: 'a', destination: 'https://other.example/deal' } },
        });

        const record = await runSafeInteractionSequence({
            session,
            plan: planOf([step('click')]),
            allowedOrigin: ALLOWED_ORIGIN,
        });

        expect(record.status).toBe('refused');
        expect(record.refusal).toEqual({ index: 0, reason: 'external_destination' });
        expect(page.actions).toEqual([]);
    });

    it('stops when a performed step left the reported site after all', async () => {
        const { session } = fakeSession({ urlAfter: { 0: 'https://other.example/landing' } });

        const record = await runSafeInteractionSequence({
            session,
            plan: planOf([step('click'), step('click')]),
            allowedOrigin: ALLOWED_ORIGIN,
        });

        expect(record.status).toBe('failed');
        expect(record.steps).toHaveLength(1);
        expect(record.steps[0]!.outcome).toBe('failed');
        expect(record.steps[0]!.refusalReason).toBe('external_destination');
    });

    it("keeps working on the page the reported site's own redirect landed on", async () => {
        // The page sits on the bare domain the reported `www` URL redirected to; following its
        // own links and a path that changes as the page scrolls stay on the reported site.
        const { session, page } = fakeSession({
            facts: { 1: { tagName: 'a', destination: `${ALLOWED_ORIGIN}/news` } },
            urlAfter: { 1: `${ALLOWED_ORIGIN}/news?page=2` },
        });

        const record = await runSafeInteractionSequence({
            session,
            plan: planOf([step('wait'), step('click'), step('scroll')]),
            allowedOrigin: 'https://www.site.example',
        });

        expect(record.status).toBe('completed');
        expect(record.steps.map((evidence) => evidence.outcome)).toEqual([
            'performed',
            'performed',
            'performed',
        ]);
        expect(page.actions).toEqual(['click', 'scrollIntoViewIfNeeded']);
    });

    it('names the page a step landed on when that step left the reported site', async () => {
        const landing = 'https://other.example/landing';
        const { session } = fakeSession({ urlAfter: { 0: landing } });

        const record = await runSafeInteractionSequence({
            session,
            plan: planOf([step('click')]),
            allowedOrigin: ALLOWED_ORIGIN,
        });

        expect(record.steps[0]!.result?.url).toBe(landing);
    });

    it('never dresses a browser failure up as a policy refusal', async () => {
        const { session, page } = fakeSession({ actionFails: 0 });

        const record = await runSafeInteractionSequence({
            session,
            plan: planOf([step('click'), step('click')]),
            allowedOrigin: ALLOWED_ORIGIN,
        });

        expect(record.status).toBe('failed');
        expect(record.refusal).toBeNull();
        expect(record.steps).toHaveLength(1);
        expect(record.steps[0]!.outcome).toBe('failed');
        expect(record.steps[0]!.refusalReason).toBeNull();
        expect(probeCount(page, '__adguard_interaction_release_probe__')).toBe(1);
    });

    it('stops at the time bound and leaves the remaining steps unattempted', async () => {
        const { session, page } = fakeSession();
        let clock = 0;

        const record = await runSafeInteractionSequence({
            session,
            plan: planOf([step('click'), step('click'), step('click')]),
            allowedOrigin: ALLOWED_ORIGIN,
            bounds: { totalBudgetMs: 1_000 },
            now: () => {
                clock += 600;
                return clock;
            },
        });

        expect(record.status).toBe('bounded_out');
        expect(record.steps.length).toBeLessThan(3);
        expect(page.actions.length).toBe(record.steps.length);
    });

    it('releases the page marker for every attempted control, refused or failed', async () => {
        const { session, page } = fakeSession({ facts: { 1: { hasMaskedInput: true } } });

        await runSafeInteractionSequence({
            session,
            plan: planOf([step('click'), step('click')]),
            allowedOrigin: ALLOWED_ORIGIN,
        });

        expect(probeCount(page, '__adguard_interaction_resolve_probe__')).toBe(2);
        expect(probeCount(page, '__adguard_interaction_release_probe__')).toBe(2);
    });

    it('resolves no control for a step that has none', async () => {
        const { session, page } = fakeSession();

        const record = await runSafeInteractionSequence({
            session,
            plan: planOf([step('reload'), step('back'), step('wait')]),
            allowedOrigin: ALLOWED_ORIGIN,
        });

        expect(record.status).toBe('completed');
        expect(page.actions).toEqual(['reload', 'goBack']);
        expect(probeCount(page, '__adguard_interaction_resolve_probe__')).toBe(0);
        expect(record.steps.every((evidence) => evidence.resolvedTarget === null)).toBe(true);
    });

    it('records the tab a click opened and leaves none of them behind', async () => {
        const { session, page } = fakeSession({
            popupOnStep: { 0: 'https://effectivecpmnetwork.com/landing' },
        });

        const record = await runSafeInteractionSequence({
            session,
            plan: planOf([step('click'), step('click')]),
            allowedOrigin: ALLOWED_ORIGIN,
        });

        expect(record.status).toBe('completed');
        expect(record.popups).toEqual([
            { url: 'https://effectivecpmnetwork.com/landing', openedAtMs: expect.any(Number) },
        ]);
        expect(record.steps[0]!.observation.popupsOpened).toBe(1);
        expect(record.steps[1]!.observation.popupsOpened).toBe(0);
        expect(page.openPopups()).toBe(0);
    });

    it('counts every tab a click opened even past the bound on describing them', async () => {
        const { session, page } = fakeSession({
            popupOnStep: { 0: 'https://effectivecpmnetwork.com/landing' },
            popupsPerStep: 12,
        });

        const record = await runSafeInteractionSequence({
            session,
            plan: planOf([step('click')]),
            allowedOrigin: ALLOWED_ORIGIN,
        });

        // The count is the evidence a popup rule is judged by: saturating it would make a phase
        // that opens twelve tabs indistinguishable from one the candidate cut down to five.
        expect(record.popupsOpened).toBe(12);
        expect(record.steps[0]!.observation.popupsOpened).toBe(12);
        expect(record.popups.length).toBeLessThan(12);
        expect(page.openPopups()).toBe(0);
    });

    it('observes no popup at all when the click opens none', async () => {
        const { session, page } = fakeSession();

        const record = await runSafeInteractionSequence({
            session,
            plan: planOf([step('click')]),
            allowedOrigin: ALLOWED_ORIGIN,
        });

        expect(record.popups).toEqual([]);
        expect(record.steps[0]!.observation.popupsOpened).toBe(0);
        expect(page.openPopups()).toBe(0);
    });

    it('answers a native dialog instead of letting it stall the step', async () => {
        const { session, page } = fakeSession({ dialogOnStep: { 0: 'beforeunload' } });

        const record = await runSafeInteractionSequence({
            session,
            plan: planOf([step('click')]),
            allowedOrigin: ALLOWED_ORIGIN,
        });

        expect(record.status).toBe('completed');
        expect(record.dialogs).toEqual([{ type: 'beforeunload', atMs: expect.any(Number) }]);
        expect(record.steps[0]!.observation.dialogsDismissed).toBe(1);
        expect(page.dismissedDialogs()).toBe(1);
    });

    it('names the overlay that swallowed a click instead of the timeout it presented as', async () => {
        const { session } = fakeSession({
            actionFails: 0,
            actionError: new Error(
                'locator.click: Timeout 5000ms exceeded.\nCall log:\n' +
                    '  - <div class="adblock-wall">…</div> intercepts pointer events',
            ),
        });

        const record = await runSafeInteractionSequence({
            session,
            plan: planOf([step('click')]),
            allowedOrigin: ALLOWED_ORIGIN,
        });

        expect(record.steps[0]!.outcome).toBe('failed');
        expect(record.steps[0]!.refusalReason).toBeNull();
        expect(record.steps[0]!.failureDetail).toBe('click_intercepted');
    });

    it('starts an unnamed play overlay but still refuses an unnamed bare control', async () => {
        const overlay = {
            elementId: '',
            elementClasses: '',
            elementName: '',
            elementRole: '',
            accessibleLabel: '',
            destination: '',
            formDestination: '',
        };
        const { session, page } = fakeSession({
            facts: {
                0: { ...overlay, coversMediaElement: true },
                1: overlay,
            },
        });

        const record = await runSafeInteractionSequence({
            session,
            plan: planOf([step('click'), step('click')]),
            allowedOrigin: ALLOWED_ORIGIN,
        });

        expect(page.actions).toEqual(['click']);
        expect(record.steps[0]!.outcome).toBe('performed');
        expect(record.steps[1]!.outcome).toBe('refused');
        expect(record.refusal).toEqual({ index: 1, reason: 'unverifiable_safety' });
    });
});

describe('persistSafeInteractionRecord', () => {
    const artifactsDir = mkdtempSync(join(tmpdir(), 'safe-interaction-'));

    afterAll(() => rmSync(artifactsDir, { recursive: true, force: true }));

    /**
     * Run one sequence and persist its record.
     *
     * @param baseline - Record this phase replays, or null.
     * @returns The artifact reference, the written payload, and the recorder spy.
     */
    async function persist(baseline: SafeInteractionRecord | null): Promise<{
        payload: Record<string, unknown>;
        artifact: { artifactId: string; kind: string; path: string };
        added: ReturnType<typeof vi.fn>;
    }> {
        const { session } = fakeSession();
        const record = await runSafeInteractionSequence({
            session,
            plan: planOf([step('click')]),
            allowedOrigin: ALLOWED_ORIGIN,
        });
        const added = vi.fn();
        const artifact = persistSafeInteractionRecord({
            record,
            baseline,
            configuredSecrets: [],
            artifactsDir,
            recorder: { addArtifact: added } as unknown as TraceRecorder,
            artifactIdSuffix: baseline ? 'phase-c' : 'phase-b',
        });
        return {
            payload: JSON.parse(readFileSync(artifact.path, 'utf8')),
            artifact,
            added,
        };
    }

    it('retains the record as a registered interaction artifact', async () => {
        const { payload, artifact, added } = await persist(null);

        expect(artifact.kind).toBe('interaction');
        expect(added).toHaveBeenCalledTimes(1);
        expect(payload.record).toMatchObject({ status: 'completed' });
        expect(payload.replay).toBeNull();
    });

    it('makes the difference between a sequence and its replay explicit', async () => {
        const { session } = fakeSession({ facts: { 0: { hasMaskedInput: true } } });
        const baseline = await runSafeInteractionSequence({
            session,
            plan: planOf([step('click')]),
            allowedOrigin: ALLOWED_ORIGIN,
        });

        const { payload } = await persist(baseline);

        expect(payload.replay).toEqual({
            identical: false,
            differences: [{ index: 0, kind: 'refusal' }],
        });
    });
});
