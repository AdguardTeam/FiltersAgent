import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { afterEach, describe, expect, it } from 'vitest';
import { registerInteractPageTool } from '../../src/agent/interact-page-tool';
import { ToolRegistry } from '../../src/agent/tool-registry';
import {
    ConsoleCoverage,
    type IBrowserSession,
    type NetworkRequestEntry,
} from '../../src/browser/browser-interfaces';
import type { TraceRecorder } from '../../src/tracer/trace-recorder';

const ALLOWED_ORIGIN = 'https://vidzen.fun';

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) {
        rmSync(root, { force: true, recursive: true });
    }
});

interface PageScript {
    /**
     * Whether the control the step names exists on the page.
     */
    targetFound?: boolean;

    /**
     * Whether the resolved control names nothing and leads nowhere.
     */
    unnamedTarget?: boolean;

    /**
     * URL of the tab the site opens when a click is performed.
     */
    popup?: string;

    /**
     * Request URLs the page issues when a click is performed.
     */
    requests?: string[];
}

/**
 * Build a session whose page answers every probe and follows one script.
 *
 * @param script - Control availability, popup, and request behaviour.
 * @returns Session the rehearsal tool can drive.
 */
function fakeSession(script: PageScript = {}): IBrowserSession {
    const found = script.targetFound !== false;
    const contextListeners = new Map<string, Array<(value: unknown) => void>>();
    const networkLog: NetworkRequestEntry[] = [];

    /**
     * Answer one isolated-world probe expression.
     *
     * @param expression - Probe source the runner evaluated.
     * @returns Probe result value, or null for an unknown probe.
     */
    const probeResult = (expression: string): unknown => {
        if (expression.includes('__adguard_interaction_resolve_probe__')) {
            return {
                found,
                matchedBy: 'selector',
                visible: found,
                disabled: false,
                tagName: 'div',
                inputType: '',
                elementRole: script.unnamedTarget ? '' : 'button',
                elementId: script.unnamedTarget ? '' : 'play',
                elementClasses: '',
                elementName: '',
                autocompleteHint: '',
                accessibleLabel: script.unnamedTarget ? '' : 'Play',
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
                url: `${ALLOWED_ORIGIN}/watch`,
                scrollY: 0,
                documentHeight: 2_000,
                visibleObstructionCount: 0,
                targetFound: found,
                targetVisible: found,
            };
        }
        if (expression.includes('__adguard_interaction_release_probe__')) {
            return { released: 1 };
        }
        return null;
    };

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
        url: () => `${ALLOWED_ORIGIN}/watch`,
        locator: () => ({
            click: async () => {
                for (const url of script.requests ?? []) {
                    networkLog.push({ url } as NetworkRequestEntry);
                }
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
        context: () => ({
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
        }),
    };

    return {
        getPage: () => page as unknown as Page,
        close: async () => undefined,
        getNetworkLog: () => [...networkLog],
        resetNetworkLog: () => undefined,
        getConsoleLog: () => [],
        consoleCoverage: ConsoleCoverage.BrowserLogOnly,
        artifactsDir: '/tmp/artifacts',
        isClosed: false,
    } as unknown as IBrowserSession;
}

/**
 * Build a registry holding only the rehearsal tool.
 *
 * @param script - Page behaviour for the rehearsal.
 * @returns The registry plus the artifacts directory the record is written to.
 */
function registryWith(script: PageScript = {}): {
    registry: ToolRegistry;
    artifactsDir: string;
} {
    const artifactsDir = mkdtempSync(join(tmpdir(), 'interact-page-'));
    roots.push(artifactsDir);
    const artifacts: Array<{ id: string; path: string; type: string; bytes: number }> = [];
    const registry = new ToolRegistry();
    registerInteractPageTool(registry, {
        session: fakeSession(script),
        recorder: {
            addArtifact: (artifact: { id: string; path: string; type: string; bytes: number }) => {
                artifacts.push(artifact);
            },
            getArtifacts: () => artifacts,
        } as unknown as TraceRecorder,
        artifactsDir,
        allowedOrigin: ALLOWED_ORIGIN,
    });
    return { registry, artifactsDir };
}

const CLICK_STEP = { kind: 'click', selector: '#play' };

describe('interact_page', () => {
    it('reports what the click provoked so the symptom can be recognized', async () => {
        const { registry } = registryWith({
            popup: 'https://effectivecpmnetwork.com/landing',
            requests: [`${ALLOWED_ORIGIN}/beacon`, 'https://ads.example/tag.js'],
        });

        const result = await registry.dispatch('interact_page', { steps: [CLICK_STEP] });

        expect(result).toMatchObject({
            status: 'completed',
            executedSteps: 1,
            popupsOpened: 1,
            popupHosts: ['effectivecpmnetwork.com'],
            dialogsDismissed: 0,
            newRequestHosts: ['ads.example'],
        });
        expect(result.planDigest).toMatch(/^[0-9a-f]{64}$/u);
        expect(result.artifactId).toBe('interaction-rehearsal-1');
        expect((result.steps as unknown[])[0]).toMatchObject({
            index: 0,
            kind: 'click',
            outcome: 'performed',
            refusalReason: null,
            failureDetail: null,
            targetFound: true,
            popupsOpened: 1,
        });
    });

    it('returns the concrete rejection detail so the model can correct the plan', async () => {
        const { registry } = registryWith();

        const result = await registry.dispatch('interact_page', {
            steps: [{ kind: 'click', selector: '#play', quietMs: 4_000 }],
        });

        expect(result).toMatchObject({ errorKind: 'malformed_plan', retryable: true });
        expect(String(result.detail)).toContain('Only a wait step carries a quiet period');
    });

    it('states that a control was refused rather than inventing what it would have done', async () => {
        const { registry } = registryWith({ unnamedTarget: true });

        const result = await registry.dispatch('interact_page', { steps: [CLICK_STEP] });

        expect(result).toMatchObject({ status: 'refused', executedSteps: 0, popupsOpened: 0 });
        expect((result.steps as unknown[])[0]).toMatchObject({
            outcome: 'refused',
            refusalReason: 'unverifiable_safety',
        });
    });

    it('states that the page never resolved the control the step named', async () => {
        const { registry } = registryWith({ targetFound: false });

        const result = await registry.dispatch('interact_page', { steps: [CLICK_STEP] });

        expect((result.steps as unknown[])[0]).toMatchObject({
            outcome: 'refused',
            refusalReason: 'target_unavailable',
            targetFound: false,
        });
    });

    it.each([
        ['a step kind outside the vocabulary', [{ kind: 'submit', selector: 'form' }]],
        [
            'agent-authored text instead of a host-owned token',
            [{ kind: 'type', selector: '#q', text: 'hunter2' }],
        ],
        ['a targeted action naming no control', [{ kind: 'click' }]],
    ])('refuses %s without touching the page', async (_name, steps) => {
        const { registry } = registryWith();

        const result = await registry.dispatch('interact_page', { steps });

        expect(result.retryable).toBe(true);
        expect(typeof result.errorKind).toBe('string');
        expect(result).not.toHaveProperty('planDigest');
    });

    it('numbers each retained rehearsal so evidence is never overwritten', async () => {
        const { registry } = registryWith();

        const first = await registry.dispatch('interact_page', { steps: [CLICK_STEP] });
        const second = await registry.dispatch('interact_page', { steps: [CLICK_STEP] });

        expect(first.artifactId).toBe('interaction-rehearsal-1');
        expect(second.artifactId).toBe('interaction-rehearsal-2');
    });
});
