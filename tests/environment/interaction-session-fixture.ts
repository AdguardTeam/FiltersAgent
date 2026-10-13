import type { Page } from 'playwright-core';
import { ConsoleCoverage, type IBrowserSession } from '../../src/browser/browser-interfaces';
import {
    normalizeSafeInteractionPlan,
    type NormalizedSafeInteractionPlan,
} from '../../src/environment/safe-interaction';

/**
 * Origin every fixture page reports itself on.
 */
export const INTERACTION_FIXTURE_ORIGIN = 'https://example.test';

/**
 * How one phase's page answers the reveal steps.
 */
export interface InteractionPhaseScript {
    /**
     * URL of the tab the site opens when the click is performed.
     */
    popup?: string;

    /**
     * Whether the control the plan names is missing from this phase's page.
     */
    targetMissing?: boolean;

    /**
     * Whether this phase's page died before the sequence could observe anything.
     */
    pageLost?: boolean;
}

/**
 * Build a session whose page answers every fixed interaction probe and follows one phase script.
 *
 * Only the browser leaves are fake: the isolated-world probes, the stability probe, the clicked
 * locator and the popup subscription. The safe-interaction runner drives them as it drives a real
 * page.
 *
 * @param script - Popup and control availability for this phase.
 * @param origin - Origin the page reports itself on, which the runner holds every step to.
 * @returns Session the safe-interaction runner can drive.
 */
export function fakeInteractionSession(
    script: InteractionPhaseScript = {},
    origin: string = INTERACTION_FIXTURE_ORIGIN,
): IBrowserSession {
    const contextListeners = new Map<string, Array<(value: unknown) => void>>();

    /**
     * Answer one isolated-world probe expression.
     *
     * @param expression - Probe source the runner evaluated.
     * @returns Probe result value, or null for an unknown probe.
     */
    const probeResult = (expression: string): unknown => {
        if (expression.includes('__adguard_interaction_resolve_probe__')) {
            return {
                found: !script.targetMissing,
                matchedBy: 'text_hint',
                visible: !script.targetMissing,
                disabled: false,
                tagName: 'button',
                inputType: 'button',
                elementRole: '',
                elementId: '',
                elementClasses: '',
                elementName: '',
                autocompleteHint: '',
                accessibleLabel: 'I am 18+',
                destination: '',
                formDestination: '',
                hasMaskedInput: false,
                hasFileInput: false,
                containsMediaElement: false,
                coversMediaElement: false,
            };
        }
        if (expression.includes('__adguard_interaction_state_probe__')) {
            return {
                url: `${origin}/video`,
                scrollY: 0,
                documentHeight: 2_000,
                visibleObstructionCount: 0,
                targetFound: !script.targetMissing,
                targetVisible: !script.targetMissing,
            };
        }
        if (expression.includes('__adguard_interaction_release_probe__')) {
            return { released: 1 };
        }
        return null;
    };

    /**
     * Build the context surface the runner attaches its recorders and evaluator to.
     *
     * @returns Context stub answering CDP probes and popup subscriptions.
     */
    const contextStub = (): unknown => ({
        newCDPSession: async () => ({
            send: async (method: string, params?: Record<string, unknown>) => {
                if (method === 'Page.getFrameTree') {
                    return { frameTree: { frame: { id: 'main' } } };
                }
                if (method === 'Page.createIsolatedWorld') {
                    return { executionContextId: 1 };
                }
                if (method !== 'Runtime.evaluate') {
                    return {};
                }
                return { result: { value: probeResult(String(params?.expression ?? '')) } };
            },
            detach: async () => undefined,
        }),
        on: (event: string, handler: (value: unknown) => void) => {
            contextListeners.set(event, [...(contextListeners.get(event) ?? []), handler]);
        },
        off: (event: string, handler: (value: unknown) => void) => {
            contextListeners.set(
                event,
                (contextListeners.get(event) ?? []).filter((entry) => entry !== handler),
            );
        },
    });

    const page = {
        evaluate: async (expression: unknown) =>
            typeof expression === 'string' &&
            expression.includes('__adguard_page_stability_probe__')
                ? {
                      readyState: 'complete',
                      htmlLength: 1_024,
                      nodeCount: 20,
                      textLength: 100,
                      scrollHeight: 1_080,
                      scrollY: 0,
                      resourceCount: 4,
                      domFingerprint: 'stable-dom',
                  }
                : undefined,
        waitForTimeout: async () => undefined,
        url: () => `${origin}/video`,
        locator: () => ({
            click: async () => {
                if (!script.popup) {
                    return;
                }
                for (const handler of contextListeners.get('page') ?? []) {
                    handler({
                        url: () => script.popup,
                        mainFrame: () => ({ url: () => script.popup }),
                        on: () => undefined,
                        close: async () => undefined,
                    });
                }
            },
        }),
        on: () => undefined,
        off: () => undefined,
        context: () => {
            if (script.pageLost) {
                throw new Error('Target page, context or browser has been closed');
            }
            return contextStub();
        },
    };

    return {
        getPage: () => page as unknown as Page,
        close: async () => undefined,
        getNetworkLog: () => [],
        resetNetworkLog: () => undefined,
        getConsoleLog: () => [],
        consoleCoverage: ConsoleCoverage.BrowserLogOnly,
        artifactsDir: '/tmp/artifacts',
        isClosed: false,
    } as unknown as IBrowserSession;
}

/**
 * Normalize the reveal steps these fixtures replay: dismiss the age dialog, then wait.
 *
 * @returns Normalized plan.
 */
export function ageDialogRevealPlan(): NormalizedSafeInteractionPlan {
    const outcome = normalizeSafeInteractionPlan([
        {
            kind: 'click',
            target: { selector: null, textHint: 'I am 18+' },
            text: null,
            quietMs: null,
        },
        { kind: 'wait', target: null, text: null, quietMs: 250 },
    ]);
    if (outcome.kind !== 'normalized') {
        throw new Error('fixture plan must normalize');
    }
    return outcome.plan;
}
