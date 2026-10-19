import * as vitest from 'vitest';
import * as phaseOrchestrator from '../../src/validator/phase-orchestrator';
import type { BrowserToolHandlers } from '../../src/browser/browser-tools';
import type { PageStateInspection } from '../../src/types/page-state-inspection';
import type { TraceRecorder } from '../../src/tracer/trace-recorder';
import type { Page } from 'playwright-core';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
import { installPreflightDiagnosticLog } from '../../src/local/preflight-diagnostic-log';
import { calculateTrustedBaselineHash } from '../../src/validator/trusted-validation-context';
import { BlockerVerificationMethod } from '../../src/environment/environment-proofs';
import type { TrustedPageEvaluator } from '../../src/browser/trusted-page-evaluator';
import { ConsoleCoverage, type IBrowserSession } from '../../src/browser/browser-interfaces';
import { captureFullPageTiles } from '../../src/browser/full-page-tiles';
import type { FullPageTileWindow } from '../../src/types/validation';
import type {
    AdapterPhaseLease,
    BoundEnvironmentPhaseHandle,
    EnvironmentPhaseEvidence,
    EnvironmentPhaseToken,
    FilteringEnvironmentAdapter,
    FilteringEnvironmentAdapterState,
    ValidatorPhaseCompletion,
} from '../../src/environment/filtering-environment';

const { describe, expect, it, vi } = vitest;
const { createValidationViewportAnchor, materializePage, restoreValidationViewportAnchor } =
    phaseOrchestrator;
const { probeAdElement, probeElementGeometry, probeStructuralSnapshot } = phaseOrchestrator;
const { runAdsEnvironmentExperiment, runPhase, runValidation } = phaseOrchestrator;

/**
 * Create a minimal mock TraceRecorder.
 */
function mockRecorder(): TraceRecorder {
    return {
        record: vi.fn(),
        addArtifact: vi.fn(),
        recordToolCall: vi.fn(),
        recordLlmTurn: vi.fn(),
    } as unknown as TraceRecorder;
}

/**
 * Create a minimal mock Page.
 */
function mockPage(): Page {
    const styleElement = { remove: vi.fn() };
    const styleHandle = {
        evaluate: vi
            .fn()
            .mockImplementation(async (callback: (element: { remove: () => void }) => unknown) =>
                callback(styleElement),
            ),
    };
    return {
        route: vi.fn().mockResolvedValue(undefined),
        unroute: vi.fn().mockResolvedValue(undefined),
        addStyleTag: vi.fn().mockResolvedValue(styleHandle),
        evaluate: vi.fn().mockResolvedValue({
            probeSucceeded: true,
            targetCount: 1,
            targetVisibleCount: 1,
            targetTotalHeight: 320,
            targetTotalArea: 409_600,
            targetMaximumHeight: 320,
            targetFamilyClass: 'ad-slot',
            familyProbeTruncated: false,
            familyTargetCount: 1,
            familyTargetVisibleCount: 1,
            familyTargetTotalHeight: 320,
            familyTargetMaximumHeight: 320,
            targetMeasurements: [{ key: 'id:slot', width: 1280, height: 320 }],
            familyTargetMeasurements: [{ key: 'id:slot', width: 1280, height: 320 }],
            documentTimeOrigin: 1_000,
            documentHeight: 1600,
            fixedTopOverlayBottom: 80,
            visibleHeadingCount: 1,
            visibleBreadcrumbCount: 1,
            overlappedHeadingCount: 0,
            overlappedBreadcrumbCount: 0,
            minimumOverlappedLandmarkTop: null,
            meaningfulTextLength: 4000,
            textGeometry: {
                totalCount: 20,
                visibleCount: 20,
                visibleArea: 600_000,
                clippedCount: 0,
                occludedCount: 0,
            },
            mediaGeometry: {
                totalCount: 3,
                visibleCount: 3,
                visibleArea: 300_000,
                clippedCount: 0,
                occludedCount: 0,
            },
            controlGeometry: {
                totalCount: 4,
                visibleCount: 4,
                visibleArea: 24_000,
                clippedCount: 0,
                occludedCount: 0,
            },
        }),
    } as unknown as Page;
}

/**
 * Create an explicit trusted-evaluator test double.
 */
function mockTrustedEvaluator(result: unknown): TrustedPageEvaluator {
    return { evaluate: vi.fn().mockResolvedValue(result) };
}

/**
 * Adapt legacy browser-tool test responses to the trusted evaluator interface.
 */
function trustedEvaluatorFromHandlers(handlers: BrowserToolHandlers): TrustedPageEvaluator {
    return {
        evaluate: async (expression: string): Promise<unknown> => {
            const response = await handlers.evaluate_js({ expression });
            if (
                response === null ||
                typeof response !== 'object' ||
                !Object.prototype.hasOwnProperty.call(response, 'result')
            ) {
                throw new Error('Malformed explicit test evaluator response.');
            }
            return (response as Record<string, unknown>).result;
        },
    };
}

/**
 * Adapt an explicit Playwright page test double to the trusted evaluator interface.
 */
function trustedEvaluatorFromPage(page: Page): TrustedPageEvaluator {
    return { evaluate: async (expression: string) => page.evaluate(expression) };
}

/**
 * The empty page-state snapshot the inspect_page_state handler stub returns; this suite never
 * exercises the probe itself.
 */
const EMPTY_PAGE_STATE: PageStateInspection = {
    cookies: [],
    localStorage: {},
    sessionStorage: {},
    frames: [],
    counts: {
        cookies: { total: 0, returned: 0 },
        localStorage: { total: 0, returned: 0 },
        sessionStorage: { total: 0, returned: 0 },
        frames: { total: 0, returned: 0 },
    },
    truncated: false,
};

/**
 * Create mock BrowserToolHandlers with controllable return values.
 */
function mockHandlers(
    overrides: Partial<{
        openPageResult: Record<string, unknown>;
        screenshotResult: Record<string, unknown>;
        getDomResult: Record<string, unknown>;
        getNetworkLogResult: Record<string, unknown>;
        evaluateJsResult: Record<string, unknown>;
        evaluateJsImpl: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    }> = {},
): BrowserToolHandlers {
    const evaluate_js =
        overrides.evaluateJsImpl ??
        vi.fn().mockResolvedValue(overrides.evaluateJsResult ?? { result: false });

    return {
        open_page: vi.fn().mockResolvedValue(
            overrides.openPageResult ?? {
                url: 'https://example.com',
                title: 'Example',
                statusCode: 200,
            },
        ),
        screenshot: vi.fn().mockResolvedValue(
            overrides.screenshotResult ?? {
                artifactId: 'screenshot-uuid',
                fullPageArtifactId: 'screenshot-full-page-uuid',
                format: 'png',
                viewport: { width: 1920, height: 1080 },
                viewportPosition: { x: 0, y: 0 },
            },
        ),
        get_dom: vi.fn().mockResolvedValue(
            overrides.getDomResult ?? {
                artifactId: 'dom-uuid',
                htmlLength: 5000,
                textPreview: 'Example page content',
            },
        ),
        inspect_ad_slots: vi.fn().mockResolvedValue({
            scope: 'main_frame_light_dom',
            candidateCount: 0,
            returnedCount: 0,
            truncated: false,
            slots: [],
            artifactId: 'slots-uuid',
        }),
        get_network_log: vi.fn().mockResolvedValue(
            overrides.getNetworkLogResult ?? {
                artifactId: 'har-uuid',
                requestCount: 42,
                summary: '42 requests',
            },
        ),
        reset_network_log: vi.fn().mockResolvedValue({ reset: true }),
        get_console_log: vi.fn().mockResolvedValue({ messages: [] }),
        inspect_page_state: vi.fn().mockResolvedValue(EMPTY_PAGE_STATE),
        evaluate_js,
    };
}

/**
 * Create a deterministic DOM element for structural-probe VM tests.
 */
function makeStructuralProbeElement(id: string, classList: string[], tagName = 'DIV') {
    return {
        id,
        nodeType: 1,
        tagName,
        classList,
        hidden: false,
        parentElement: null,
        innerText: '',
        getAttribute: () => null,
        getBoundingClientRect: () => ({
            left: 0,
            right: 1920,
            top: 100,
            bottom: 500,
            width: 1920,
            height: 400,
        }),
        contains: () => false,
        closest: () => null,
    };
}

/**
 * Execute structural-probe JavaScript against a controlled semantic family.
 */
function structuralFamilyEvaluator(
    primary: ReturnType<typeof makeStructuralProbeElement>,
    family: unknown[] | Record<string, unknown[]>,
    targetSelector = '#article-primary',
    targetElements: unknown[] = [primary],
): TrustedPageEvaluator {
    return {
        evaluate: async (expression: string): Promise<unknown> =>
            runInNewContext(expression, {
                document: {
                    body: { innerText: '', scrollHeight: 2400 },
                    documentElement: { scrollHeight: 2400 },
                    elementFromPoint: () => null,
                    getElementsByClassName: (className: string) => {
                        if (className === 'unique-ad') {
                            return [primary];
                        }
                        return Array.isArray(family) ? family : (family[className] ?? []);
                    },
                    querySelectorAll: (selector: string) =>
                        selector === targetSelector ? targetElements : [],
                },
                window: {
                    innerHeight: 1080,
                    innerWidth: 1920,
                    getComputedStyle: () => ({
                        contentVisibility: 'visible',
                        display: 'block',
                        opacity: '1',
                        overflowX: 'visible',
                        overflowY: 'visible',
                        position: 'static',
                        visibility: 'visible',
                    }),
                },
                performance: { timeOrigin: 1_000 },
            }),
    };
}

interface StructuralProbeRect {
    left: number;
    right: number;
    top: number;
    bottom: number;
    width: number;
    height: number;
}

interface StructuralProbeElement {
    id: string;
    nodeType: number;
    tagName: string;
    classList: string[];
    hidden: boolean;
    parentElement: StructuralProbeElement | null;
    children: StructuralProbeElement[];
    innerText: string;
    getAttribute: (name: string) => string | null;
    getBoundingClientRect: () => StructuralProbeRect;
    contains: (candidate: StructuralProbeElement) => boolean;
    closest: () => null;
}

function makeGeometryProbeElement(
    id: string,
    tagName: string,
    rect: StructuralProbeRect,
    parentElement: StructuralProbeElement | null = null,
): StructuralProbeElement {
    const element: StructuralProbeElement = {
        id,
        nodeType: 1,
        tagName,
        classList: [],
        hidden: false,
        parentElement,
        children: [],
        innerText: tagName === 'P' ? 'Meaningful article copy used by the structural probe.' : '',
        getAttribute: () => null,
        getBoundingClientRect: () => rect,
        contains: (candidate) => {
            let current: StructuralProbeElement | null = candidate;
            while (current) {
                if (current === element) {
                    return true;
                }
                current = current.parentElement;
            }
            return false;
        },
        closest: () => null,
    };
    if (parentElement) {
        parentElement.children.push(element);
    }
    return element;
}

function structuralGeometryEvaluator(
    target: StructuralProbeElement,
    meaningful: StructuralProbeElement,
    blocker: StructuralProbeElement,
    elementFromPoint: (x: number, y: number) => StructuralProbeElement | null,
): TrustedPageEvaluator {
    return {
        evaluate: async (expression: string): Promise<unknown> =>
            runInNewContext(expression, {
                document: {
                    body: {
                        innerText: meaningful.innerText,
                        scrollHeight: 2400,
                    },
                    documentElement: { scrollHeight: 2400 },
                    elementFromPoint,
                    getElementsByClassName: () => [],
                    querySelectorAll: (selector: string) => {
                        if (selector === '#ad-target') {
                            return [target];
                        }
                        if (selector === 'body *') {
                            return [target, meaningful, blocker];
                        }
                        if (selector === 'h1, h2, h3, p, li, blockquote, figcaption') {
                            return [meaningful];
                        }
                        return [];
                    },
                },
                window: {
                    innerHeight: 100,
                    innerWidth: 100,
                    getComputedStyle: (element: StructuralProbeElement) => ({
                        backgroundColor:
                            element.id === 'modal-overlay'
                                ? 'rgba(0, 0, 0, 0.6)'
                                : 'rgba(0, 0, 0, 0)',
                        backgroundImage: 'none',
                        backdropFilter: 'none',
                        contentVisibility: 'visible',
                        display: 'block',
                        opacity: '1',
                        overflowX: 'visible',
                        overflowY: 'visible',
                        position: 'static',
                        visibility: 'visible',
                    }),
                },
                performance: { timeOrigin: 1_000 },
            }),
    };
}

/**
 * Queue the six trusted page evaluations used by one deferred cosmetic validation.
 *
 * @param page - Playwright page test double.
 * @param independentBaseline - Structure captured in independently navigated Phase B.
 * @param control - Materialized same-document control before candidate injection.
 * @param candidate - Immediate structure after candidate injection.
 * @param postArtifacts - Candidate structure after visual artifacts are captured.
 * @param restored - Control structure after the exact injected style is removed.
 */
function mockDeferredStructuralSnapshots(
    page: Page,
    independentBaseline: unknown,
    control: unknown,
    candidate: unknown,
    postArtifacts: unknown = candidate,
    restored: unknown = control,
): void {
    vi.mocked(page.evaluate)
        .mockReset()
        .mockResolvedValueOnce(independentBaseline)
        .mockResolvedValueOnce({ materialized: true, stable: true, height: 2400 })
        .mockResolvedValueOnce({ x: 0, y: 0 })
        .mockResolvedValueOnce({ x: 0, y: 0 })
        .mockResolvedValueOnce(control)
        .mockResolvedValueOnce(candidate)
        .mockResolvedValueOnce({ x: 0, y: 0 })
        .mockResolvedValueOnce(postArtifacts)
        .mockResolvedValueOnce(restored);
}

describe('probeAdElement', () => {
    it("returns 'visible' when trusted evaluation returns 'visible'", async () => {
        const result = await probeAdElement(mockTrustedEvaluator('visible'), '.ad-banner');
        expect(result).toBe('visible');
    });

    it("returns 'hidden' when trusted evaluation returns 'hidden'", async () => {
        const result = await probeAdElement(mockTrustedEvaluator('hidden'), '.ad-banner');
        expect(result).toBe('hidden');
    });

    it("returns 'not_found' when trusted evaluation returns 'not_found'", async () => {
        const result = await probeAdElement(mockTrustedEvaluator('not_found'), '.ad-banner');
        expect(result).toBe('not_found');
    });

    it("returns 'not_probed' on trusted evaluation error", async () => {
        const evaluator = mockTrustedEvaluator('not_found');
        evaluator.evaluate = vi.fn().mockRejectedValue(new Error('timeout'));
        const result = await probeAdElement(evaluator, '.ad-banner');
        expect(result).toBe('not_probed');
    });

    it("returns 'not_probed' on malformed trusted output", async () => {
        const result = await probeAdElement(mockTrustedEvaluator('forged'), '.ad-banner');
        expect(result).toBe('not_probed');
    });

    it('treats an element with width but zero height as hidden', async () => {
        const evaluator: TrustedPageEvaluator = {
            evaluate: async (expression: string): Promise<unknown> =>
                runInNewContext(expression, {
                    document: {
                        querySelector: () => ({
                            getBoundingClientRect: () => ({ width: 100, height: 0 }),
                        }),
                    },
                    window: {
                        getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
                    },
                }),
        };

        await expect(probeAdElement(evaluator, '.flat-ad')).resolves.toBe('hidden');
    });
});

describe('runAdsEnvironmentExperiment', () => {
    /**
     * Drive the ordered-boundary experiment fixture through every adapter and recorder hook.
     *
     * @param options - Scenario switches applied while observing phases.
     * @returns The experiment result together with the ordered boundary call log.
     */
    async function runOrderedExperiment(
        options: { baselineSymptomPresent?: boolean } = {},
    ): Promise<{
        result: Awaited<ReturnType<typeof runAdsEnvironmentExperiment>>;
        calls: string[];
    }> {
        const calls: string[] = [];
        const actualContext = {
            kind: 'browser_extension' as const,
            product: 'AdGuard Browser Extension',
            browser: 'CloakBrowser Chromium',
            productVersion: '5.0.0',
        };
        const state: FilteringEnvironmentAdapterState = {
            kind: 'browser_extension',
            lifecycle: 'ready',
            stateDigest: 'a'.repeat(64),
            actualContext,
            capabilities: ['browser_navigation', 'filtering_control', 'phase_proof'],
            preparation: null,
            baseline: null,
            openLeaseIds: [],
            cleanup: null,
        };
        const session = {
            artifactsDir: '/tmp/artifacts',
            isClosed: false,
            getPage: () => mockPage(),
            close: async () => {
                calls.push('close');
            },
            getNetworkLog: () => [],
            resetNetworkLog: () => undefined,
            getConsoleLog: () => [],
            consoleCoverage: ConsoleCoverage.BrowserLogOnly,
        } as IBrowserSession;
        // oxlint-disable-next-line unicorn/consistent-function-scoping -- Scenario-local fixture.
        const filteringStateFor = (phase: 'A' | 'B' | 'C') => {
            if (phase === 'A') {
                return 'disabled' as const;
            }
            if (phase === 'B') {
                return 'published_baseline' as const;
            }
            return 'published_baseline_plus_candidate' as const;
        };
        /**
         * Exact single-line candidate rule this experiment fixture applies in C, with its digest.
         */
        const candidateRule = 'example.test##.ad';
        const candidateDigest = createHash('sha256').update(candidateRule, 'utf8').digest('hex');
        const adapter: FilteringEnvironmentAdapter = {
            kind: 'browser_extension',
            capabilities: () => state.capabilities,
            prepare: async () => ({ ready: true, state }),
            openPhase: async (request) => {
                calls.push(`open:${request.phase}`);
                const extensionProof = {
                    packageVersion: '5.0.0',
                    manifestVersion: '5.0.0',
                    profileKind: 'agent_selected' as const,
                    enabledListKeys: ['adguard:2'],
                    activeRulesetListKeys: ['adguard:2'],
                    stealthEnabled: false,
                    userRulesDigest: request.phase === 'C' ? candidateDigest : null,
                    application: {
                        method: BlockerVerificationMethod.ExtensionState,
                        appliedRules: request.phase === 'C' ? [candidateRule] : [],
                        actionLog: [],
                    },
                };
                return {
                    ready: true,
                    handle: {
                        session,
                        adapterProof: {
                            leaseId: `lease-${request.phase}`,
                            adapterStateDigest: state.stateDigest,
                            phase: request.phase,
                            filteringState: filteringStateFor(request.phase),
                            sessionId: `session-${request.phase}`,
                            actualContext,
                            baselineDigest: request.phase === 'A' ? null : 'b'.repeat(64),
                            candidateDigest: request.phase === 'C' ? candidateDigest : null,
                            extension: request.phase === 'A' ? null : extensionProof,
                        },
                        close: async () => {
                            calls.push(`close:${request.phase}`);
                        },
                    },
                };
            },
            drainOpenHandles: async () => ({ attempted: 0, closed: 0, failed: 0, failures: [] }),
            snapshot: () => structuredClone(state),
            cleanup: async () => ({
                attempted: true,
                completed: true,
                finalizerAttempts: 0,
                finalizerCompleted: 0,
                finalizerFailed: 0,
                failures: [],
            }),
        };
        const recorder = {
            beginPhase: (request: { phase: string }) => {
                calls.push(`begin:${request.phase}`);
                return {
                    tokenId: `token-${request.phase}`,
                    runId: 'run-6',
                    experimentId: 'experiment-1',
                    phase: request.phase as 'A' | 'B' | 'C',
                };
            },
            bindPhaseLease: (
                token: EnvironmentPhaseToken,
                lease: AdapterPhaseLease,
                _state: FilteringEnvironmentAdapterState,
            ): BoundEnvironmentPhaseHandle => {
                calls.push(`bind:${token.phase}`);
                return { token, lease };
            },
            completePhase: (
                token: EnvironmentPhaseToken,
                completion: ValidatorPhaseCompletion,
            ): EnvironmentPhaseEvidence => {
                calls.push(`complete:${token.phase}`);
                return {
                    runId: 'run-6',
                    experimentId: 'experiment-1',
                    phase: token.phase as 'A' | 'B' | 'C',
                    proof: {
                        leaseId: `lease-${token.phase}`,
                        adapterStateDigest: state.stateDigest,
                        phase: token.phase as 'A' | 'B' | 'C',
                        filteringState: filteringStateFor(token.phase),
                        sessionId: `session-${token.phase}`,
                        actualContext,
                        baselineDigest: token.phase === 'A' ? null : 'b'.repeat(64),
                        candidateDigest: token.phase === 'C' ? candidateDigest : null,
                        extension: null,
                    },
                    completion,
                };
            },
        };

        const result = await runAdsEnvironmentExperiment({
            runId: 'run-6',
            experimentId: 'experiment-1',
            adapter,
            recorder,
            targetUrl: 'https://example.test/',
            candidate: { operation: 'add', rule: 'example.test##.ad' },
            observe: async ({ phase, proof }) => {
                let candidateValidation: Extract<
                    ValidatorPhaseCompletion,
                    { kind: 'observed' }
                >['candidateValidation'] = null;
                if (phase === 'C') {
                    candidateValidation = {
                        validationArtifactId: 'validation-candidate',
                        candidateDigest: proof.candidateDigest!,
                        verified: true,
                        screenshotArtifactIds: ['before', 'after', 'before-full', 'after-full'],
                    };
                }
                return {
                    kind: 'observed',
                    sessionId: proof.sessionId,
                    targetUrl: 'https://example.test/',
                    targetObservation: {
                        symptomPresent:
                            phase === 'B'
                                ? (options.baselineSymptomPresent ?? true)
                                : phase !== 'C',
                        pageUsable: true,
                    },
                    navigationVerified: true,
                    artifacts: [],
                    vision: null,
                    candidateValidation,
                    rejectedCandidates: [],
                };
            },
        });

        return { result, calls };
    }

    it('uses ordered recorder/adapter boundaries and verifies the same Ads target in B/C', async () => {
        const { result, calls } = await runOrderedExperiment();

        expect(result.verdict).toBe('verified');
        expect(result.inconclusiveReason).toBeUndefined();
        expect(calls).toEqual([
            'begin:A',
            'open:A',
            'bind:A',
            'complete:A',
            'close:A',
            'begin:B',
            'open:B',
            'bind:B',
            'complete:B',
            'close:B',
            'begin:C',
            'open:C',
            'bind:C',
            'complete:C',
            'close:C',
        ]);
    });

    it('names the absent baseline symptom instead of returning a bare inconclusive verdict', async () => {
        const { result, calls } = await runOrderedExperiment({ baselineSymptomPresent: false });

        expect(result.verdict).toBe('inconclusive');
        expect(result.inconclusiveReason).toBe('baseline_symptom_absent');
        expect(result.limitation).toBeNull();
        expect(calls).not.toContain('open:C');
    });

    it('settles the bound phase as failed when the validation deadline aborts mid-observation', async () => {
        const calls: string[] = [];
        const completions: ValidatorPhaseCompletion[] = [];
        const controller = new AbortController();
        const actualContext = {
            kind: 'browser_extension' as const,
            product: 'AdGuard Browser Extension',
            browser: 'CloakBrowser Chromium',
            productVersion: '5.0.0',
        };
        const state: FilteringEnvironmentAdapterState = {
            kind: 'browser_extension',
            lifecycle: 'ready',
            stateDigest: 'a'.repeat(64),
            actualContext,
            capabilities: ['browser_navigation', 'filtering_control', 'phase_proof'],
            preparation: null,
            baseline: null,
            openLeaseIds: [],
            cleanup: null,
        };
        const session = {
            artifactsDir: '/tmp/artifacts',
            isClosed: false,
            getPage: () => mockPage(),
            close: async () => {},
            getNetworkLog: () => [],
            resetNetworkLog: () => undefined,
            getConsoleLog: () => [],
            consoleCoverage: ConsoleCoverage.BrowserLogOnly,
        } as IBrowserSession;
        const adapter: FilteringEnvironmentAdapter = {
            kind: 'browser_extension',
            capabilities: () => state.capabilities,
            prepare: async () => ({ ready: true, state }),
            openPhase: async (request) => ({
                ready: true,
                handle: {
                    session,
                    adapterProof: {
                        leaseId: `lease-${request.phase}`,
                        adapterStateDigest: state.stateDigest,
                        phase: request.phase,
                        filteringState: 'disabled' as const,
                        sessionId: `session-${request.phase}`,
                        actualContext,
                        baselineDigest: null,
                        candidateDigest: null,
                        extension: null,
                    },
                    close: async () => {
                        calls.push(`close:${request.phase}`);
                    },
                },
            }),
            drainOpenHandles: async () => ({ attempted: 0, closed: 0, failed: 0, failures: [] }),
            snapshot: () => structuredClone(state),
            cleanup: async () => ({
                attempted: true,
                completed: true,
                finalizerAttempts: 0,
                finalizerCompleted: 0,
                finalizerFailed: 0,
                failures: [],
            }),
        };
        const recorder = {
            beginPhase: (request: { phase: string }) => ({
                tokenId: `token-${request.phase}`,
                runId: 'run-6',
                experimentId: 'experiment-1',
                phase: request.phase as 'A' | 'B' | 'C',
            }),
            bindPhaseLease: (
                token: EnvironmentPhaseToken,
                lease: AdapterPhaseLease,
                _state: FilteringEnvironmentAdapterState,
            ): BoundEnvironmentPhaseHandle => {
                calls.push(`bind:${token.phase}`);
                return { token, lease };
            },
            completePhase: (
                token: EnvironmentPhaseToken,
                completion: ValidatorPhaseCompletion,
            ): EnvironmentPhaseEvidence => {
                calls.push(`complete:${token.phase}`);
                completions.push(completion);
                return {
                    runId: 'run-6',
                    experimentId: 'experiment-1',
                    phase: token.phase as 'A' | 'B' | 'C',
                    proof: {
                        leaseId: `lease-${token.phase}`,
                        adapterStateDigest: state.stateDigest,
                        phase: token.phase as 'A' | 'B' | 'C',
                        filteringState: 'disabled' as const,
                        sessionId: `session-${token.phase}`,
                        actualContext,
                        baselineDigest: null,
                        candidateDigest: null,
                        extension: null,
                    },
                    completion,
                };
            },
        };

        const result = await runAdsEnvironmentExperiment({
            runId: 'run-6',
            experimentId: 'experiment-1',
            adapter,
            recorder,
            targetUrl: 'https://example.test/',
            candidate: { operation: 'add', rule: 'example.test##.ad' },
            signal: controller.signal,
            observe: () => {
                // The observation never settles on its own: only the deadline abort may end it.
                setTimeout(() => controller.abort(), 10);
                return new Promise<ValidatorPhaseCompletion>(() => {});
            },
        });

        expect(result.verdict).toBe('capability_limited');
        expect(result.limitation?.code).toBe('phase_proof_unavailable');
        expect(calls).toEqual(['bind:A', 'complete:A', 'close:A']);
        expect(completions).toHaveLength(1);
        expect(completions[0]!.kind).toBe('failed');
    });

    it('records the underlying observation failure in the run diagnostics', async () => {
        const recorded: Array<{ channel: string; detail: unknown }> = [];
        installPreflightDiagnosticLog({
            path: '(memory)',
            record: (channel, detail) => {
                recorded.push({ channel, detail });
            },
            close: () => undefined,
        });
        const actualContext = {
            kind: 'browser_extension' as const,
            product: 'AdGuard Browser Extension',
            browser: 'CloakBrowser Chromium',
            productVersion: '5.0.0',
        };
        const state: FilteringEnvironmentAdapterState = {
            kind: 'browser_extension',
            lifecycle: 'ready',
            stateDigest: 'a'.repeat(64),
            actualContext,
            capabilities: ['browser_navigation', 'filtering_control', 'phase_proof'],
            preparation: null,
            baseline: null,
            openLeaseIds: [],
            cleanup: null,
        };
        const session = {
            artifactsDir: '/tmp/artifacts',
            isClosed: false,
            getPage: () => mockPage(),
            close: async () => undefined,
            getNetworkLog: () => [],
            resetNetworkLog: () => undefined,
            getConsoleLog: () => [],
            consoleCoverage: ConsoleCoverage.BrowserLogOnly,
        } as IBrowserSession;
        const adapter: FilteringEnvironmentAdapter = {
            kind: 'browser_extension',
            capabilities: () => state.capabilities,
            prepare: async () => ({ ready: true, state }),
            openPhase: async (request) => ({
                ready: true,
                handle: {
                    session,
                    adapterProof: {
                        leaseId: `lease-${request.phase}`,
                        adapterStateDigest: state.stateDigest,
                        phase: request.phase,
                        filteringState: 'disabled',
                        sessionId: `session-${request.phase}`,
                        actualContext,
                        baselineDigest: null,
                        candidateDigest: null,
                        extension: null,
                    },
                    close: async () => undefined,
                },
            }),
            drainOpenHandles: async () => ({ attempted: 0, closed: 0, failed: 0, failures: [] }),
            snapshot: () => structuredClone(state),
            cleanup: async () => ({
                attempted: true,
                completed: true,
                finalizerAttempts: 0,
                finalizerCompleted: 0,
                finalizerFailed: 0,
                failures: [],
            }),
        };
        const recorder = {
            beginPhase: (request: { phase: string }) => ({
                tokenId: `token-${request.phase}`,
                runId: 'run-7',
                experimentId: 'experiment-2',
                phase: request.phase as 'A' | 'B' | 'C',
            }),
            bindPhaseLease: (
                token: EnvironmentPhaseToken,
                lease: AdapterPhaseLease,
                _state: FilteringEnvironmentAdapterState,
            ): BoundEnvironmentPhaseHandle => ({ token, lease }),
            completePhase: (
                token: EnvironmentPhaseToken,
                completion: ValidatorPhaseCompletion,
            ): EnvironmentPhaseEvidence => ({
                runId: 'run-7',
                experimentId: 'experiment-2',
                phase: token.phase as 'A' | 'B' | 'C',
                proof: {
                    leaseId: `lease-${token.phase}`,
                    adapterStateDigest: state.stateDigest,
                    phase: token.phase as 'A' | 'B' | 'C',
                    filteringState: 'disabled',
                    sessionId: `session-${token.phase}`,
                    actualContext,
                    baselineDigest: null,
                    candidateDigest: null,
                    extension: null,
                },
                completion,
            }),
        };

        try {
            const result = await runAdsEnvironmentExperiment({
                runId: 'run-7',
                experimentId: 'experiment-2',
                adapter,
                recorder,
                targetUrl: 'https://example.test/',
                candidate: { operation: 'add', rule: 'example.test##.ad' },
                observe: async () => {
                    throw new Error('net::ERR_TIMED_OUT at https://example.test/');
                },
            });

            expect(result.limitation).toMatchObject({ code: 'phase_proof_unavailable' });
            expect(recorded).toContainEqual(
                expect.objectContaining({
                    channel: 'cli_phase',
                    detail: expect.objectContaining({
                        note: 'phase_observation_failed',
                        phase: 'A',
                        error: expect.objectContaining({
                            message: expect.stringContaining('ERR_TIMED_OUT'),
                        }),
                    }),
                }),
            );
        } finally {
            installPreflightDiagnosticLog(null);
        }
    });
});

describe('probeElementGeometry', () => {
    it('returns the measured element box', async () => {
        const evaluator = mockTrustedEvaluator({ found: true, width: 1280, height: 400 });

        await expect(probeElementGeometry(evaluator, '.reserved-slot')).resolves.toEqual({
            found: true,
            width: 1280,
            height: 400,
        });
    });

    it('returns a missing measurement for invalid browser output', async () => {
        const evaluator = mockTrustedEvaluator('invalid');

        await expect(probeElementGeometry(evaluator, '.slot')).resolves.toEqual({
            found: false,
            width: 0,
            height: 0,
        });
    });
});

describe('materializePage', () => {
    it('accepts only a completed stable materialization pass', async () => {
        await expect(
            materializePage(
                mockTrustedEvaluator({ materialized: true, stable: true, height: 2400 }),
            ),
        ).resolves.toBe(true);
        await expect(
            materializePage(
                mockTrustedEvaluator({ materialized: true, stable: false, height: 3600 }),
            ),
        ).resolves.toBe(false);
    });

    it('fails closed before scrolling a document above the supported height', async () => {
        const scrollPositions: number[] = [];
        const evaluator: TrustedPageEvaluator = {
            evaluate: async (expression: string): Promise<unknown> =>
                runInNewContext(expression, {
                    document: {
                        body: { scrollHeight: 100_000 },
                        documentElement: { scrollHeight: 100_000 },
                    },
                    setTimeout: (callback: () => void) => callback(),
                    window: {
                        innerHeight: 1080,
                        scrollX: 0,
                        scrollY: 0,
                        scrollTo: (_x: number, y: number) => scrollPositions.push(y),
                    },
                }),
        };

        await expect(materializePage(evaluator)).resolves.toBe(false);
        expect(scrollPositions).toEqual([]);
    });

    it('uses viewport-overlapping scroll steps across a supported long document', async () => {
        const scrollPositions: number[] = [];
        const viewportHeight = 1080;
        const documentHeight = 23_500;
        const evaluator: TrustedPageEvaluator = {
            evaluate: async (expression: string): Promise<unknown> =>
                runInNewContext(expression, {
                    document: {
                        body: { scrollHeight: documentHeight },
                        documentElement: { scrollHeight: documentHeight },
                    },
                    setTimeout: (callback: () => void) => callback(),
                    window: {
                        innerHeight: viewportHeight,
                        scrollX: 0,
                        scrollY: 0,
                        scrollTo: (_x: number, y: number) => scrollPositions.push(y),
                    },
                }),
        };

        await expect(materializePage(evaluator)).resolves.toBe(true);
        const scanPositions = scrollPositions.slice(0, -1);
        expect(scanPositions.at(-1)).toBe(documentHeight);
        expect(scrollPositions.at(-1)).toBe(0);
        for (let index = 1; index < scanPositions.length; index += 1) {
            expect(scanPositions[index] - scanPositions[index - 1]).toBeLessThan(viewportHeight);
        }
    });
});

describe('validation viewport alignment', () => {
    it('anchors the target and restores the exact settled position', async () => {
        const absoluteTargetTop = 2000;
        const windowState = {
            innerHeight: 1000,
            scrollX: 0,
            scrollY: 500,
            scrollTo(options: { left: number; top: number }) {
                this.scrollX = options.left;
                this.scrollY = options.top;
            },
        };
        const evaluator: TrustedPageEvaluator = {
            evaluate: async (expression: string): Promise<unknown> =>
                runInNewContext(expression, {
                    document: {
                        body: {},
                        documentElement: {},
                        querySelectorAll: () => [
                            {
                                getBoundingClientRect: () => ({
                                    top: absoluteTargetTop - windowState.scrollY,
                                    width: 1920,
                                }),
                            },
                        ],
                    },
                    setTimeout: (callback: () => void) => callback(),
                    window: windowState,
                }),
        };

        const anchor = await createValidationViewportAnchor(evaluator, '.reported-slot');
        expect(anchor).toEqual({ x: 0, y: 1900 });

        windowState.scrollY = 4000;
        await expect(
            restoreValidationViewportAnchor(evaluator, anchor as { x: number; y: number }),
        ).resolves.toEqual(anchor);
        expect(windowState.scrollY).toBe(1900);
    });
});

describe('probeStructuralSnapshot', () => {
    it('samples the viewport intersection instead of clamping an offscreen center', async () => {
        const target = makeGeometryProbeElement('ad-target', 'DIV', {
            left: 0,
            right: 100,
            top: 20,
            bottom: 80,
            width: 100,
            height: 60,
        });
        const meaningful = makeGeometryProbeElement('article-copy', 'P', {
            left: 0,
            right: 100,
            top: -90,
            bottom: 10,
            width: 100,
            height: 100,
        });
        const blocker = makeGeometryProbeElement('viewport-edge', 'DIV', {
            left: 0,
            right: 100,
            top: 0,
            bottom: 1,
            width: 100,
            height: 1,
        });
        const sampledY: number[] = [];
        const evaluator = structuralGeometryEvaluator(target, meaningful, blocker, (_x, y) => {
            sampledY.push(y);
            return y <= 0 ? blocker : meaningful;
        });

        await expect(probeStructuralSnapshot(evaluator, '#ad-target')).resolves.toMatchObject({
            textGeometry: {
                totalCount: 1,
                occludedCount: 0,
            },
        });
        expect(sampledY.length).toBeGreaterThan(1);
        expect(sampledY.every((y) => y > 0 && y < 10)).toBe(true);
    });

    it('does not classify a single blocked sample as material content occlusion', async () => {
        const target = makeGeometryProbeElement('ad-target', 'DIV', {
            left: 0,
            right: 100,
            top: 0,
            bottom: 100,
            width: 100,
            height: 100,
        });
        const meaningful = makeGeometryProbeElement('article-copy', 'P', {
            left: 10,
            right: 90,
            top: 10,
            bottom: 90,
            width: 80,
            height: 80,
        });
        const blocker = makeGeometryProbeElement('small-badge', 'DIV', {
            left: 49,
            right: 51,
            top: 49,
            bottom: 51,
            width: 2,
            height: 2,
        });
        const evaluator = structuralGeometryEvaluator(target, meaningful, blocker, (x, y) =>
            x === 50 && y === 50 ? blocker : meaningful,
        );

        await expect(probeStructuralSnapshot(evaluator, '#ad-target')).resolves.toMatchObject({
            textGeometry: {
                occludedCount: 0,
            },
        });
    });

    it('ignores a transparent stretched-link hit area covering meaningful content', async () => {
        const target = makeGeometryProbeElement('ad-target', 'DIV', {
            left: 0,
            right: 100,
            top: 0,
            bottom: 10,
            width: 100,
            height: 10,
        });
        const meaningful = makeGeometryProbeElement('article-copy', 'P', {
            left: 10,
            right: 90,
            top: 10,
            bottom: 90,
            width: 80,
            height: 80,
        });
        const transparentLink = makeGeometryProbeElement('stretched-link', 'A', {
            left: 10,
            right: 90,
            top: 10,
            bottom: 90,
            width: 80,
            height: 80,
        });
        const evaluator = structuralGeometryEvaluator(
            target,
            meaningful,
            transparentLink,
            () => transparentLink,
        );

        await expect(probeStructuralSnapshot(evaluator, '#ad-target')).resolves.toMatchObject({
            textGeometry: {
                occludedCount: 0,
                occlusionEvidence: [],
            },
        });
    });

    it('excludes meaningful descendants of the candidate target from occlusion counting', async () => {
        const target = makeGeometryProbeElement('ad-target', 'DIV', {
            left: 0,
            right: 100,
            top: 0,
            bottom: 100,
            width: 100,
            height: 100,
        });
        const meaningful = makeGeometryProbeElement(
            'ad-copy',
            'P',
            {
                left: 10,
                right: 90,
                top: 10,
                bottom: 90,
                width: 80,
                height: 80,
            },
            target,
        );
        const blocker = makeGeometryProbeElement('page-overlay', 'DIV', {
            left: 0,
            right: 100,
            top: 0,
            bottom: 100,
            width: 100,
            height: 100,
        });
        const evaluator = structuralGeometryEvaluator(target, meaningful, blocker, () => blocker);

        await expect(probeStructuralSnapshot(evaluator, '#ad-target')).resolves.toMatchObject({
            textGeometry: {
                totalCount: 1,
                occludedCount: 0,
            },
        });
    });

    it('records a material overlay and keeps it available to the hard regression guard', async () => {
        const target = makeGeometryProbeElement('ad-target', 'DIV', {
            left: 0,
            right: 100,
            top: 0,
            bottom: 100,
            width: 100,
            height: 100,
        });
        const meaningful = makeGeometryProbeElement('article-copy', 'P', {
            left: 10,
            right: 90,
            top: 10,
            bottom: 90,
            width: 80,
            height: 80,
        });
        const blocker = makeGeometryProbeElement('modal-overlay', 'DIV', {
            left: 0,
            right: 100,
            top: 0,
            bottom: 100,
            width: 100,
            height: 100,
        });
        const evaluator = structuralGeometryEvaluator(target, meaningful, blocker, () => blocker);

        await expect(probeStructuralSnapshot(evaluator, '#ad-target')).resolves.toMatchObject({
            textGeometry: {
                occludedCount: 1,
                occlusionEvidence: [
                    {
                        targetKey: 'id:article-copy',
                        blockerKeys: ['id:modal-overlay'],
                        occludedSampleCount: 5,
                        sampleCount: 5,
                    },
                ],
            },
        });
    });

    it('keeps an exact semantic class family instead of a broader utility class', async () => {
        const targets = Array.from({ length: 4 }, (_, index) =>
            makeStructuralProbeElement(`article-${index}`, ['single-post-top-ad', 'z-20']),
        );
        const unrelatedUtilityElements = Array.from({ length: 27 }, (_, index) =>
            makeStructuralProbeElement(`utility-${index}`, ['z-20']),
        );

        await expect(
            probeStructuralSnapshot(
                structuralFamilyEvaluator(
                    targets[0],
                    {
                        'single-post-top-ad': targets,
                        'z-20': [...targets, ...unrelatedUtilityElements],
                    },
                    '.single-post-top-ad',
                    targets,
                ),
                '.single-post-top-ad',
            ),
        ).resolves.toMatchObject({
            probeSucceeded: true,
            targetCount: 4,
            targetFamilyClass: 'single-post-top-ad',
            familyProbeTruncated: false,
            familyTargetCount: 4,
            familyTargetVisibleCount: 4,
        });
    });

    it('keeps a tag-qualified multi-target semantic family over a broader utility class', async () => {
        const targets = Array.from({ length: 4 }, (_, index) =>
            makeStructuralProbeElement(`article-${index}`, ['single-post-top-ad', 'z-20']),
        );
        const unrelatedUtilityElements = Array.from({ length: 27 }, (_, index) =>
            makeStructuralProbeElement(`utility-${index}`, ['z-20']),
        );

        await expect(
            probeStructuralSnapshot(
                structuralFamilyEvaluator(
                    targets[0],
                    {
                        'single-post-top-ad': targets,
                        'z-20': [...targets, ...unrelatedUtilityElements],
                    },
                    'article.single-post-top-ad',
                    targets,
                ),
                'article.single-post-top-ad',
            ),
        ).resolves.toMatchObject({
            probeSucceeded: true,
            targetCount: 4,
            targetFamilyClass: 'single-post-top-ad',
            familyTargetCount: 4,
            familyTargetVisibleCount: 4,
        });
    });

    it('keeps a tag-qualified singleton semantic family over a broader utility class', async () => {
        const primary = makeStructuralProbeElement('article-primary', [
            'single-post-top-ad',
            'z-20',
        ]);
        const unrelatedUtilityElements = Array.from({ length: 27 }, (_, index) =>
            makeStructuralProbeElement(`utility-${index}`, ['z-20']),
        );

        await expect(
            probeStructuralSnapshot(
                structuralFamilyEvaluator(
                    primary,
                    {
                        'single-post-top-ad': [primary],
                        'z-20': [primary, ...unrelatedUtilityElements],
                    },
                    'article.single-post-top-ad',
                    [primary],
                ),
                'article.single-post-top-ad',
            ),
        ).resolves.toMatchObject({
            probeSucceeded: true,
            targetCount: 1,
            targetFamilyClass: 'single-post-top-ad',
            familyTargetCount: 1,
            familyTargetVisibleCount: 1,
        });
    });

    it('rejects an exact non-semantic class as a complete repeated-slot family', async () => {
        const primary = makeStructuralProbeElement('article-primary', [
            'article-primary',
            'single-post-top-ad',
        ]);
        const family = [
            primary,
            makeStructuralProbeElement('clone-1', ['single-post-top-ad']),
            makeStructuralProbeElement('clone-2', ['single-post-top-ad']),
            makeStructuralProbeElement('clone-3', ['single-post-top-ad']),
        ];

        await expect(
            probeStructuralSnapshot(
                structuralFamilyEvaluator(
                    primary,
                    {
                        'article-primary': [primary],
                        'single-post-top-ad': family,
                    },
                    '.article-primary',
                    [primary],
                ),
                '.article-primary',
            ),
        ).resolves.toMatchObject({
            probeSucceeded: true,
            targetCount: 1,
            targetFamilyClass: 'single-post-top-ad',
            familyTargetCount: 4,
            familyTargetVisibleCount: 4,
        });
    });

    it('rejects an exact singleton semantic class when a broader semantic family exists', async () => {
        const primary = makeStructuralProbeElement('article-primary', [
            'ad-slot-primary',
            'single-post-top-ad',
        ]);
        const family = [
            primary,
            makeStructuralProbeElement('clone-1', ['single-post-top-ad']),
            makeStructuralProbeElement('clone-2', ['single-post-top-ad']),
            makeStructuralProbeElement('clone-3', ['single-post-top-ad']),
        ];

        await expect(
            probeStructuralSnapshot(
                structuralFamilyEvaluator(
                    primary,
                    {
                        'ad-slot-primary': [primary],
                        'single-post-top-ad': family,
                    },
                    '.ad-slot-primary',
                    [primary],
                ),
                '.ad-slot-primary',
            ),
        ).resolves.toMatchObject({
            probeSucceeded: true,
            targetCount: 1,
            targetFamilyClass: 'single-post-top-ad',
            familyTargetCount: 4,
            familyTargetVisibleCount: 4,
        });
    });

    it('rejects an exact semantic subset when a broader semantic family exists', async () => {
        const subset = [
            makeStructuralProbeElement('article-primary', [
                'ad-slot-primary',
                'single-post-top-ad',
            ]),
            makeStructuralProbeElement('article-secondary', [
                'ad-slot-primary',
                'single-post-top-ad',
            ]),
        ];
        const family = [
            ...subset,
            makeStructuralProbeElement('clone-1', ['single-post-top-ad']),
            makeStructuralProbeElement('clone-2', ['single-post-top-ad']),
        ];

        await expect(
            probeStructuralSnapshot(
                structuralFamilyEvaluator(
                    subset[0],
                    {
                        'ad-slot-primary': subset,
                        'single-post-top-ad': family,
                    },
                    '.ad-slot-primary',
                    subset,
                ),
                '.ad-slot-primary',
            ),
        ).resolves.toMatchObject({
            probeSucceeded: true,
            targetCount: 2,
            targetFamilyClass: 'single-post-top-ad',
            familyTargetCount: 4,
            familyTargetVisibleCount: 4,
        });
    });

    it('uses the broadest semantic class across element tags as the target family', async () => {
        const primary = makeStructuralProbeElement(
            'article-primary',
            ['unique-ad', 'single-post-top-ad'],
            'DIV',
        );
        const family = [
            primary,
            makeStructuralProbeElement('clone-1', ['single-post-top-ad'], 'SECTION'),
            makeStructuralProbeElement('clone-2', ['single-post-top-ad'], 'ASIDE'),
            makeStructuralProbeElement('clone-3', ['single-post-top-ad'], 'DIV'),
        ];

        await expect(
            probeStructuralSnapshot(structuralFamilyEvaluator(primary, family), '#article-primary'),
        ).resolves.toMatchObject({
            probeSucceeded: true,
            targetCount: 1,
            targetFamilyClass: 'single-post-top-ad',
            familyProbeTruncated: false,
            familyTargetCount: 4,
            familyTargetVisibleCount: 4,
            familyTargetMaximumHeight: 400,
            familyTargetMeasurements: expect.arrayContaining([
                expect.objectContaining({ key: 'id:clone-1', height: 400 }),
                expect.objectContaining({ key: 'id:clone-2', height: 400 }),
            ]),
        });
    });

    it('marks an oversized semantic family unavailable instead of selecting a unique class', async () => {
        const primary = makeStructuralProbeElement('article-primary', [
            'unique-ad',
            'single-post-top-ad',
        ]);
        const family = [
            primary,
            ...Array.from({ length: 128 }, (_, index) =>
                makeStructuralProbeElement(`clone-${index}`, ['single-post-top-ad']),
            ),
        ];

        await expect(
            probeStructuralSnapshot(structuralFamilyEvaluator(primary, family), '#article-primary'),
        ).resolves.toMatchObject({
            probeSucceeded: true,
            targetFamilyClass: 'single-post-top-ad',
            familyProbeTruncated: true,
            familyTargetCount: 129,
            familyTargetMeasurements: [],
        });
    });

    it('normalizes camelCase ad-slot classes when binding a related target family', async () => {
        const primary = makeStructuralProbeElement('article-primary', ['unique-ad', 'adSlot']);
        const family = [
            primary,
            makeStructuralProbeElement('clone-1', ['adSlot']),
            makeStructuralProbeElement('clone-2', ['adSlot']),
        ];

        await expect(
            probeStructuralSnapshot(structuralFamilyEvaluator(primary, family), '#article-primary'),
        ).resolves.toMatchObject({
            targetFamilyClass: 'adSlot',
            familyTargetCount: 3,
        });
    });

    it('uses a broader opaque co-member class instead of a unique semantic class', async () => {
        const primary = makeStructuralProbeElement('article-primary', ['unique-ad', 'promoBox']);
        const family = [
            primary,
            makeStructuralProbeElement('clone-1', ['promoBox']),
            makeStructuralProbeElement('clone-2', ['promoBox']),
        ];

        await expect(
            probeStructuralSnapshot(structuralFamilyEvaluator(primary, family), '#article-primary'),
        ).resolves.toMatchObject({
            targetFamilyClass: 'promoBox',
            familyTargetCount: 3,
        });
    });

    it('prefers a strictly broader opaque family over a repeated semantic subset', async () => {
        const primary = makeStructuralProbeElement('article-primary', ['adSlot', 'promoBox']);
        const semanticSibling = makeStructuralProbeElement('semantic-sibling', [
            'adSlot',
            'promoBox',
        ]);
        const opaqueOnlySiblings = [
            makeStructuralProbeElement('opaque-1', ['promoBox']),
            makeStructuralProbeElement('opaque-2', ['promoBox']),
        ];

        await expect(
            probeStructuralSnapshot(
                structuralFamilyEvaluator(primary, {
                    adSlot: [primary, semanticSibling],
                    promoBox: [primary, semanticSibling, ...opaqueOnlySiblings],
                }),
                '#article-primary',
            ),
        ).resolves.toMatchObject({
            targetFamilyClass: 'promoBox',
            familyTargetCount: 4,
        });
    });

    it('accepts a complete deterministic browser snapshot', async () => {
        const page = mockPage();

        await expect(
            probeStructuralSnapshot(trustedEvaluatorFromPage(page), '.ad-slot'),
        ).resolves.toMatchObject({
            probeSucceeded: true,
            targetCount: 1,
            targetMaximumHeight: 320,
            targetFamilyClass: 'ad-slot',
            familyTargetCount: 1,
            fixedTopOverlayBottom: 80,
        });
        expect(page.evaluate).toHaveBeenCalledWith(expect.stringContaining('".ad-slot"'));
    });

    it('fails closed for malformed browser output', async () => {
        const page = mockPage();
        vi.mocked(page.evaluate).mockResolvedValueOnce({ targetCount: 1 });

        await expect(
            probeStructuralSnapshot(trustedEvaluatorFromPage(page), '.ad-slot'),
        ).resolves.toMatchObject({
            probeSucceeded: false,
            targetCount: 0,
        });
    });
});

describe('runPhase', () => {
    it('returns PhaseResult with error when open_page fails', async () => {
        const handlers = mockHandlers({
            openPageResult: { error: 'net::ERR_CONNECTION_TIMED_OUT' },
        });
        const page = mockPage();
        const artifactsDir = '/tmp/test-artifacts';

        const result = await runPhase({
            handlers,
            page,
            artifactsDir,
            phase: 'A',
            url: 'https://example.com',
            rules: [],
            trustedPageEvaluator: trustedEvaluatorFromHandlers(handlers),
            adElementSelector: undefined,
            recorder: mockRecorder(),
        });

        expect(result.error).toBeDefined();
        expect(result.phase).toBe('A');
    });

    it('bounds tile capture to the measured symptom window when a selector is localized', async () => {
        const handlers = mockHandlers();
        const screenshotArgs: Record<string, unknown>[] = [];
        vi.mocked(handlers.screenshot).mockImplementation(async (args) => {
            screenshotArgs.push(args as Record<string, unknown>);
            return {
                artifactId: 'shot',
                fullPageArtifactId: 'shot-full',
                viewportPosition: { x: 0, y: 0 },
            } as never;
        });
        vi.mocked(handlers.evaluate_js).mockImplementation(async (args) => {
            const expression = String((args as Record<string, unknown>).expression ?? '');
            if (expression.includes('window.scrollY')) {
                return { result: { found: true, top: 2_000, bottom: 2_600 } } as never;
            }
            return { result: null } as never;
        });
        const page = {
            ...mockPage(),
            viewportSize: vi.fn().mockReturnValue({ width: 1_000, height: 1_000 }),
        } as unknown as Page;

        await runPhase({
            handlers,
            page,
            artifactsDir: '/tmp/test-artifacts',
            phase: 'B',
            url: 'https://example.com',
            rules: [],
            trustedPageEvaluator: trustedEvaluatorFromHandlers(handlers),
            adElementSelector: '.ad-banner',
            captureVisualTiles: true,
            recorder: mockRecorder(),
        });

        // One viewport above and below the element: top 2000..2600 with a 1000px margin.
        expect(screenshotArgs).toEqual([
            {
                captureTiles: true,
                tileWindow: { fromY: 1_000, toY: 3_600 },
            },
        ]);
    });

    /**
     * Run one tile-capturing phase on a page whose selector matches the given document spans,
     * measuring them with the real in-page probe, and return the window the capture was asked for.
     */
    async function capturedTileWindow(
        matches: { top: number; bottom: number }[],
        viewportHeight: number,
    ): Promise<{ fromY: number; toY: number } | undefined> {
        const handlers = mockHandlers();
        const screenshotArgs: Record<string, unknown>[] = [];
        vi.mocked(handlers.screenshot).mockImplementation(async (args) => {
            screenshotArgs.push(args as Record<string, unknown>);
            return {
                artifactId: 'shot',
                fullPageArtifactId: 'shot-full',
                viewportPosition: { x: 0, y: 0 },
            } as never;
        });
        const scrollY = 500;
        const elements = matches.map(({ top, bottom }) => ({
            getBoundingClientRect: () => ({
                top: top - scrollY,
                bottom: bottom - scrollY,
                width: bottom > top ? 300 : 0,
                height: bottom - top,
            }),
        }));
        const evaluator: TrustedPageEvaluator = {
            evaluate: async (expression: string): Promise<unknown> =>
                runInNewContext(expression, {
                    document: {
                        querySelector: () => elements[0] ?? null,
                        querySelectorAll: () => elements,
                    },
                    window: { scrollY },
                }),
        };
        const page = {
            ...mockPage(),
            viewportSize: vi.fn().mockReturnValue({ width: 1_920, height: viewportHeight }),
        } as unknown as Page;

        await runPhase({
            handlers,
            page,
            artifactsDir: '/tmp/test-artifacts',
            phase: 'B',
            url: 'https://example.com',
            rules: [],
            trustedPageEvaluator: evaluator,
            adElementSelector: '.ad-slot',
            captureVisualTiles: true,
            recorder: mockRecorder(),
        });

        expect(screenshotArgs).toHaveLength(1);
        return screenshotArgs[0].tileWindow as { fromY: number; toY: number } | undefined;
    }

    it('bounds tile capture around every instance a multi-instance selector matches', async () => {
        // A selector that hides several slots must get original-resolution tiles at each of them;
        // judged from the downscaled overview, the lower slots leave the review unclear.
        const instances = [
            { top: 122, bottom: 322 },
            { top: 2_900, bottom: 3_200 },
            { top: 5_400, bottom: 5_650 },
        ];

        const window = await capturedTileWindow(
            [...instances, { top: 4_000, bottom: 4_000 }],
            1_080,
        );

        expect(window).toBeDefined();
        for (const instance of instances) {
            expect(window!.fromY).toBeLessThanOrEqual(instance.top);
            expect(window!.toY).toBeGreaterThanOrEqual(instance.bottom);
        }
    });

    it('captures the candidate over the same tile span the control capture recorded', async () => {
        // A candidate can bring the document width under the viewport width, and each capture fits
        // a window over the tile limit to its own column count. AFTER must cover the span BEFORE
        // covers, or the review compares different parts of the page.
        const artifactsDir = mkdtempSync(join(tmpdir(), 'phase-tile-span-'));
        let documentWidth = 2_178;
        const viewport = { width: 1_920, height: 1_080 };
        const tilePage = {
            viewportSize: () => viewport,
            evaluate: async () => ({
                documentWidth,
                documentHeight: 30_000,
                landmarks: [],
                scrollX: 0,
                scrollY: 0,
            }),
            screenshot: async (options: { clip: { width: number; height: number } }) => {
                const png = Buffer.alloc(24);
                Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png, 0);
                png.write('IHDR', 12, 'ascii');
                png.writeUInt32BE(options.clip.width, 16);
                png.writeUInt32BE(options.clip.height, 20);
                return png;
            },
        } as unknown as Page;
        const handlers = mockHandlers();
        let shot = 0;
        vi.mocked(handlers.screenshot).mockImplementation(async (args) => {
            shot += 1;
            return {
                artifactId: `shot-${shot}`,
                fullPageArtifactId: `full-${shot}`,
                viewportPosition: { x: 0, y: 0 },
                tileCoverage: await captureFullPageTiles(
                    tilePage,
                    artifactsDir,
                    mockRecorder(),
                    undefined,
                    undefined,
                    1_000,
                    (args as { tileWindow?: FullPageTileWindow }).tileWindow,
                ),
            } as never;
        });
        const page = { ...mockPage(), viewportSize: () => viewport } as unknown as Page;
        vi.mocked(page.addStyleTag).mockImplementation(async () => {
            documentWidth = viewport.width;
            return {
                evaluate: async (callback: (element: { remove: () => void }) => unknown) =>
                    callback({ remove: () => undefined }),
            } as never;
        });
        const instances = [
            { top: 500, bottom: 800 },
            { top: 25_700, bottom: 26_000 },
        ].map(({ top, bottom }) => ({
            getBoundingClientRect: () => ({ top, bottom, width: 300, height: bottom - top }),
        }));
        const evaluator: TrustedPageEvaluator = {
            evaluate: async (expression: string): Promise<unknown> =>
                runInNewContext(expression, {
                    document: { querySelectorAll: () => instances },
                    window: { scrollY: 0 },
                }),
        };

        try {
            const result = await runPhase({
                handlers,
                page,
                artifactsDir,
                phase: 'C',
                url: 'https://example.com',
                rules: [],
                deferredRule: 'example.com##.ad-slot',
                materialize: async () => true,
                createViewportAnchor: async () => ({ x: 0, y: 0 }),
                restoreViewportAnchor: async (anchor) => ({ ...anchor }),
                trustedPageEvaluator: evaluator,
                adElementSelector: '.ad-slot',
                captureVisualTiles: true,
                recorder: mockRecorder(),
            });

            const before = result.sameDocumentControlTileCoverage!;
            const after = result.tileCoverage!;
            expect(before.windowTrimmed).toBe(true);
            expect(after.complete).toBe(true);
            expect(after.window).toEqual(before.window);
            expect([...new Set(after.tiles.map((tile) => tile.y))]).toEqual([
                ...new Set(before.tiles.map((tile) => tile.y)),
            ]);
        } finally {
            rmSync(artifactsDir, { recursive: true, force: true });
        }
    });

    it('returns successful PhaseResult with artifacts', async () => {
        const handlers = mockHandlers();
        const page = mockPage();
        const artifactsDir = '/tmp/test-artifacts';

        const result = await runPhase({
            handlers,
            page,
            artifactsDir,
            phase: 'B',
            url: 'https://example.com',
            rules: ['||ads.example.com^'],
            trustedPageEvaluator: trustedEvaluatorFromHandlers(handlers),
            adElementSelector: '.ad-banner',
            recorder: mockRecorder(),
        });

        expect(result.phase).toBe('B');
        expect(result.screenshotArtifactId).toBeDefined();
        expect(result.fullPageScreenshotArtifactId).toBe('screenshot-full-page-uuid');
        expect(result.harArtifactId).toBeDefined();
        expect(result.domArtifactId).toBeDefined();
        expect(result.url).toBe('https://example.com');
        expect(result.error).toBeUndefined();
    });

    it('resets the network log before navigation', async () => {
        const handlers = mockHandlers();
        const calls: string[] = [];
        vi.mocked(handlers.reset_network_log).mockImplementation(async () => {
            calls.push('reset');
            return { reset: true };
        });
        vi.mocked(handlers.open_page).mockImplementation(async () => {
            calls.push('open');
            return { url: 'https://example.com', statusCode: 200 };
        });

        await runPhase({
            handlers,
            page: mockPage(),
            artifactsDir: '/tmp/test-artifacts',
            phase: 'A',
            url: 'https://example.com',
            rules: [],
            trustedPageEvaluator: trustedEvaluatorFromHandlers(handlers),
            recorder: mockRecorder(),
        });

        expect(handlers.reset_network_log).toHaveBeenCalledOnce();
        expect(calls).toEqual(['reset', 'open']);
    });

    it('records only rules that the safe applicator actually applied', async () => {
        const handlers = mockHandlers();
        const result = await runPhase({
            handlers,
            page: mockPage(),
            artifactsDir: '/tmp/test-artifacts',
            phase: 'C',
            url: 'https://example.com',
            rules: [
                'example.com##.ad-banner',
                "example.com#%#//scriptlet('abort-on-property-read','ads')",
            ],
            trustedPageEvaluator: trustedEvaluatorFromHandlers(handlers),
            adElementSelector: '.ad-banner',
            recorder: mockRecorder(),
        });

        expect(result.appliedRules).toEqual(['example.com##.ad-banner']);
        expect(result.ruleApplications).toEqual([
            { rule: 'example.com##.ad-banner', status: 'applied' },
            {
                rule: "example.com#%#//scriptlet('abort-on-property-read','ads')",
                status: 'skipped',
                reason: 'Scriptlet validation is unsupported; raw scriptlet text was not evaluated.',
            },
        ]);
    });

    it('materializes and reversibly probes a deferred candidate in the same document', async () => {
        const calls: string[] = [];
        const handlers = mockHandlers();
        vi.mocked(handlers.screenshot).mockImplementation(async () => {
            calls.push('screenshot');
            const label = calls.filter((call) => call === 'screenshot').length;
            return {
                artifactId: `screenshot-${label}`,
                fullPageArtifactId: `screenshot-full-page-${label}`,
                tileCoverage: {
                    complete: true,
                    documentWidth: 1_920,
                    documentHeight: 2_000,
                    viewportWidth: 1_920,
                    viewportHeight: 1_080,
                    overlapPx: 160,
                    tiles: [
                        {
                            artifactId: `tile-${label}`,
                            index: 0,
                            x: 0,
                            y: 0,
                            width: 1_920,
                            height: 1_080,
                            landmark: 'Top story',
                        },
                    ],
                },
                viewportPosition: { x: 0, y: 120 },
            };
        });
        const page = mockPage();
        vi.mocked(page.addStyleTag).mockImplementation(async () => {
            calls.push('candidate');
            return {
                evaluate: async (callback: (element: { remove: () => void }) => unknown) =>
                    callback({
                        remove: () => {
                            calls.push('cleanup');
                        },
                    }),
            } as never;
        });

        const result = await runPhase({
            handlers,
            page,
            artifactsDir: '/tmp/test-artifacts',
            phase: 'C',
            url: 'https://example.com',
            rules: [],
            deferredRule: 'example.com#$#.ad-slot { height: 64px !important; }',
            materialize: async () => {
                calls.push('materialize');
                return true;
            },
            createViewportAnchor: async () => {
                calls.push('align-viewport');
                return { x: 0, y: 120 };
            },
            restoreViewportAnchor: async (anchor) => {
                calls.push('restore-viewport');
                return { ...anchor };
            },
            beforeDeferredRule: async () => {
                calls.push('baseline-probe');
            },
            afterDeferredRule: async () => {
                calls.push('immediate-probe');
            },
            afterArtifacts: async () => {
                calls.push('candidate-probe');
            },
            afterDeferredRuleRemoved: async () => {
                calls.push('restoration-probe');
            },
            trustedPageEvaluator: trustedEvaluatorFromHandlers(handlers),
            recorder: mockRecorder(),
        });

        expect(calls).toEqual([
            'materialize',
            'align-viewport',
            'screenshot',
            'restore-viewport',
            'baseline-probe',
            'candidate',
            'immediate-probe',
            'restore-viewport',
            'screenshot',
            'candidate-probe',
            'cleanup',
            'restoration-probe',
        ]);
        expect(result.appliedRules).toEqual([
            'example.com#$#.ad-slot { height: 64px !important; }',
        ]);
        expect(result.sameDocumentControlScreenshotArtifactId).toBe('screenshot-1');
        expect(result.sameDocumentControlFullPageScreenshotArtifactId).toBe(
            'screenshot-full-page-1',
        );
        expect(result.sameDocumentControlViewport).toEqual({ x: 0, y: 120 });
        expect(result.sameDocumentControlTileCoverage?.tiles[0]?.artifactId).toBe('tile-1');
        expect(result.candidateViewport).toEqual({ x: 0, y: 120 });
        expect(result.screenshotArtifactId).toBe('screenshot-2');
        expect(result.tileCoverage?.tiles[0]?.artifactId).toBe('tile-2');
    });

    it('fails closed when the atomic candidate screenshot has a different viewport', async () => {
        const handlers = mockHandlers();
        vi.mocked(handlers.screenshot)
            .mockResolvedValueOnce({
                artifactId: 'control-viewport',
                fullPageArtifactId: 'control-full-page',
                viewportPosition: { x: 0, y: 120 },
            })
            .mockResolvedValueOnce({
                artifactId: 'candidate-viewport',
                fullPageArtifactId: 'candidate-full-page',
                viewportPosition: { x: 0, y: 400 },
            });

        const result = await runPhase({
            handlers,
            page: mockPage(),
            artifactsDir: '/tmp/test-artifacts',
            phase: 'C',
            url: 'https://example.com',
            rules: [],
            deferredRule: 'example.com#$#.ad-slot { height: 64px !important; }',
            materialize: async () => true,
            createViewportAnchor: async () => ({ x: 0, y: 120 }),
            restoreViewportAnchor: async (anchor) => ({ ...anchor }),
            trustedPageEvaluator: trustedEvaluatorFromHandlers(handlers),
            recorder: mockRecorder(),
        });

        expect(result.sameDocumentControlViewport).toEqual({ x: 0, y: 120 });
        expect(result.candidateViewport).toEqual({ x: 0, y: 400 });
        expect(result.sameDocumentControlError).toContain('same stable viewport position');
    });

    it('does not apply a deferred candidate without complete materialized control evidence', async () => {
        const handlers = mockHandlers({
            screenshotResult: {
                artifactId: 'control-viewport',
                fullPageError: 'full-page capture failed',
                viewportPosition: { x: 0, y: 0 },
            },
        });
        const page = mockPage();

        const result = await runPhase({
            handlers,
            page,
            artifactsDir: '/tmp/test-artifacts',
            phase: 'C',
            url: 'https://example.com',
            rules: [],
            deferredRule: 'example.com##.ad-slot',
            materialize: async () => true,
            trustedPageEvaluator: trustedEvaluatorFromHandlers(handlers),
            recorder: mockRecorder(),
        });

        expect(page.addStyleTag).not.toHaveBeenCalled();
        expect(result.appliedRules).toEqual([]);
        expect(result.sameDocumentControlError).toContain('complete viewport and full-page');
    });

    it('removes a deferred candidate when artifact capture throws', async () => {
        const handlers = mockHandlers();
        vi.mocked(handlers.screenshot)
            .mockResolvedValueOnce({
                artifactId: 'control-viewport',
                fullPageArtifactId: 'control-full-page',
                viewportPosition: { x: 0, y: 0 },
            })
            .mockRejectedValueOnce(new Error('candidate screenshot failed'));
        const page = mockPage();
        const remove = vi.fn();
        vi.mocked(page.addStyleTag).mockResolvedValueOnce({
            evaluate: async (callback: (element: { remove: () => void }) => unknown) =>
                callback({ remove }),
        } as never);

        await expect(
            runPhase({
                handlers,
                page,
                artifactsDir: '/tmp/test-artifacts',
                phase: 'C',
                url: 'https://example.com',
                rules: [],
                deferredRule: 'example.com##.ad-slot',
                materialize: async () => true,
                trustedPageEvaluator: trustedEvaluatorFromHandlers(handlers),
                recorder: mockRecorder(),
            }),
        ).rejects.toThrow('candidate screenshot failed');
        expect(remove).toHaveBeenCalledOnce();
    });

    it('clears validator-owned network routes before the next phase', async () => {
        const page = mockPage();
        const phaseBHandlers = mockHandlers();
        await runPhase({
            handlers: phaseBHandlers,
            page,
            artifactsDir: '/tmp/test-artifacts',
            phase: 'B',
            url: 'https://example.com',
            rules: ['||ads.example.com^'],
            trustedPageEvaluator: trustedEvaluatorFromHandlers(phaseBHandlers),
            recorder: mockRecorder(),
        });
        const [pattern, handler] = vi.mocked(page.route).mock.calls[0];

        const phaseAHandlers = mockHandlers();
        await runPhase({
            handlers: phaseAHandlers,
            page,
            artifactsDir: '/tmp/test-artifacts',
            phase: 'A',
            url: 'https://example.com',
            rules: [],
            trustedPageEvaluator: trustedEvaluatorFromHandlers(phaseAHandlers),
            recorder: mockRecorder(),
        });

        expect(page.unroute).toHaveBeenCalledWith(pattern, handler);
    });
});

describe('runValidation', () => {
    /**
     * Helper to create a ValidationConfig for tests.
     */
    function makeConfig(
        overrides: Partial<{
            openPageResultA: Record<string, unknown>;
            openPageResultB: Record<string, unknown>;
            openPageResultC: Record<string, unknown>;
            evaluateJsResult: Record<string, unknown>;
        }> = {},
    ) {
        const recorder = mockRecorder();
        const page = mockPage();

        // Create fresh handlers per phase to control behavior independently
        const handlersA = mockHandlers({
            openPageResult: overrides.openPageResultA ?? {
                url: 'https://example.com',
                title: 'Example',
                statusCode: 200,
            },
            evaluateJsResult: overrides.evaluateJsResult ?? { result: false },
        });
        const handlersB = mockHandlers({
            openPageResult: overrides.openPageResultB ?? {
                url: 'https://example.com',
                title: 'Example',
                statusCode: 200,
            },
            evaluateJsResult: overrides.evaluateJsResult ?? { result: false },
        });
        const handlersC = mockHandlers({
            openPageResult: overrides.openPageResultC ?? {
                url: 'https://example.com',
                title: 'Example',
                statusCode: 200,
            },
            evaluateJsResult: overrides.evaluateJsResult ?? { result: false },
        });

        return {
            handlers: handlersA, // Default — actual test uses runValidation directly
            page,
            artifactsDir: '/tmp/test-artifacts',
            recorder,
            url: 'https://example.com',
            candidateRule: 'example.com##.ad-banner',
            existingRules: ['||ads.example.com^'],
            testOnlyAllowMainWorldProbeFallback: true,
            adElementSelector: '.ad-banner',
            // For mocking phases independently
            handlersA,
            handlersB,
            handlersC,
        };
    }

    it('short-circuits on Phase A error', async () => {
        const cfg = makeConfig({
            openPageResultA: { error: 'net::ERR_CONNECTION_TIMED_OUT' },
        });

        // Mock handlers for the validation to use Phase A error
        const handlers = mockHandlers({
            openPageResult: { error: 'net::ERR_CONNECTION_TIMED_OUT' },
            evaluateJsResult: { result: false },
        });

        const result = await runValidation({
            handlers,
            page: cfg.page,
            artifactsDir: cfg.artifactsDir,
            recorder: cfg.recorder,
            url: cfg.url,
            candidateRule: cfg.candidateRule,
            existingRules: cfg.existingRules,
            testOnlyAllowMainWorldProbeFallback: true,
            adElementSelector: cfg.adElementSelector,
        });

        expect(result.phaseA.error).toBeDefined();
        expect(result.validatedSelector).toBe('.ad-banner');
        expect(result.adElementStatus).toEqual({
            selector: '.ad-banner',
            phaseB: 'not_probed',
            phaseC: 'not_probed',
        });
        expect(result.summary).toContain('Phase A navigation failed');
        expect(result.summary).toContain('net::ERR_CONNECTION_TIMED_OUT');
    });

    it('short-circuits on Phase B error', async () => {
        // Phase A succeeds, Phase B fails
        const handlers = mockHandlers({
            openPageResult: { url: 'https://example.com', title: 'OK', statusCode: 200 },
            evaluateJsResult: { result: false },
        });

        // Override open_page to succeed first, then fail on second call
        (handlers.open_page as ReturnType<typeof vi.fn>)
            .mockResolvedValueOnce({ url: 'https://example.com', title: 'OK', statusCode: 200 })
            .mockResolvedValueOnce({ error: 'net::ERR_CONNECTION_REFUSED' });

        const result = await runValidation({
            handlers,
            page: mockPage(),
            artifactsDir: '/tmp/test-artifacts',
            recorder: mockRecorder(),
            url: 'https://example.com',
            candidateRule: 'example.com##.ad-banner',
            existingRules: ['||ads.example.com^'],
            testOnlyAllowMainWorldProbeFallback: true,
            adElementSelector: '.ad-banner',
        });

        expect(result.phaseB.error).toBeDefined();
        expect(result.validatedSelector).toBe('.ad-banner');
        expect(result.summary).toContain('Phase B navigation failed');
        expect(result.summary).toContain('net::ERR_CONNECTION_REFUSED');
    });

    it('produces happy-path result with ad blocked in Phase C', async () => {
        // Since runValidation reuses the same handlers, we need to make the
        // evaluate_js return different values per phase.
        const multiPhaseHandlers = mockHandlers();
        vi.mocked(multiPhaseHandlers.evaluate_js)
            .mockResolvedValueOnce({ result: false }) // Phase A: content probe
            .mockResolvedValueOnce({ result: false }) // Phase A: anti-adblock
            .mockResolvedValueOnce({ result: false }) // Phase B: content probe
            .mockResolvedValueOnce({ result: false }) // Phase B: anti-adblock
            .mockResolvedValueOnce({ result: 'visible' }) // Phase B: ad probe
            .mockResolvedValueOnce({ result: false }) // Phase C: content probe
            .mockResolvedValueOnce({ result: false }) // Phase C: anti-adblock
            .mockResolvedValueOnce({ result: 'not_found' }); // Phase C: ad probe
        const page = mockPage();
        const visibleSnapshot = await page.evaluate('visible');
        const hiddenSnapshot = {
            ...(visibleSnapshot as Record<string, unknown>),
            targetVisibleCount: 0,
            targetTotalHeight: 0,
            targetTotalArea: 0,
            targetMaximumHeight: 0,
            familyTargetVisibleCount: 0,
            familyTargetTotalHeight: 0,
            familyTargetMaximumHeight: 0,
            targetMeasurements: [{ key: 'id:slot', width: 0, height: 0 }],
            familyTargetMeasurements: [{ key: 'id:slot', width: 0, height: 0 }],
        };
        mockDeferredStructuralSnapshots(page, visibleSnapshot, visibleSnapshot, hiddenSnapshot);

        const result = await runValidation({
            handlers: multiPhaseHandlers,
            page,
            artifactsDir: '/tmp/test-artifacts',
            recorder: mockRecorder(),
            url: 'https://example.com',
            candidateRule: 'example.com##.ad-banner',
            existingRules: ['||ads.example.com^'],
            testOnlyAllowMainWorldProbeFallback: true,
            adElementSelector: '.ad-banner',
        });

        expect(result.phaseA.error).toBeUndefined();
        expect(result.phaseB.error).toBeUndefined();
        expect(result.phaseC.error).toBeUndefined();
        expect(result.summary).toContain('Before target presence: visible');
        expect(result.summary).toContain('After target presence: hidden');
        expect(result.summary).toContain('No page-safety verdict was computed');
        expect(result.adElementStatus).toEqual({
            selector: '.ad-banner',
            phaseB: 'visible',
            phaseC: 'hidden',
        });
    });

    it('does not credit a hide rule when the same-document control was already hidden', async () => {
        const handlers = mockHandlers({ evaluateJsResult: { result: true } });
        const page = mockPage();
        const visibleSnapshot = await page.evaluate('visible');
        const hiddenSnapshot = {
            ...(visibleSnapshot as Record<string, unknown>),
            targetVisibleCount: 0,
            targetTotalHeight: 0,
            targetTotalArea: 0,
            targetMaximumHeight: 0,
            familyTargetVisibleCount: 0,
            familyTargetTotalHeight: 0,
            familyTargetMaximumHeight: 0,
            targetMeasurements: [{ key: 'id:slot', width: 0, height: 0 }],
            familyTargetMeasurements: [{ key: 'id:slot', width: 0, height: 0 }],
        };
        mockDeferredStructuralSnapshots(
            page,
            visibleSnapshot,
            hiddenSnapshot,
            hiddenSnapshot,
            hiddenSnapshot,
            hiddenSnapshot,
        );

        const result = await runValidation({
            handlers,
            page,
            artifactsDir: '/tmp/test-artifacts',
            recorder: mockRecorder(),
            url: 'https://example.com',
            candidateRule: 'example.com##.ad-banner',
            existingRules: [],
            testOnlyAllowMainWorldProbeFallback: true,
        });

        expect(result.adElementStatus).toEqual({
            selector: '.ad-banner',
            phaseB: 'hidden',
            phaseC: 'hidden',
        });
    });

    it('records raw structure changes without classifying them as a regression', async () => {
        const handlers = mockHandlers();
        vi.mocked(handlers.evaluate_js)
            .mockResolvedValueOnce({ result: false })
            .mockResolvedValueOnce({ result: true })
            .mockResolvedValueOnce({ result: false })
            .mockResolvedValueOnce({ result: true })
            .mockResolvedValueOnce({ result: 'visible' })
            .mockResolvedValueOnce({ result: false })
            .mockResolvedValueOnce({ result: true })
            .mockResolvedValueOnce({ result: 'hidden' });
        const page = mockPage();
        const baseline = await page.evaluate('baseline');
        const regressed = {
            ...(baseline as Record<string, unknown>),
            meaningfulTextLength: 500,
            textGeometry: {
                ...(baseline as Record<string, Record<string, unknown>>).textGeometry,
                visibleCount: 5,
                visibleArea: 100_000,
            },
        };
        mockDeferredStructuralSnapshots(page, baseline, baseline, regressed, regressed, baseline);

        const result = await runValidation({
            handlers,
            page,
            artifactsDir: '/tmp/test-artifacts',
            recorder: mockRecorder(),
            url: 'https://example.com',
            candidateRule: 'example.com##.ad-banner',
            existingRules: [],
            testOnlyAllowMainWorldProbeFallback: true,
        });

        expect(result.structureFacts?.after.meaningfulTextLength).toBe(500);
        expect(result.structureFacts?.after.textGeometry.visibleCount).toBe(5);
        expect(result).not.toHaveProperty('structuralValidation');
        expect(result).not.toHaveProperty('contentIntact');
        expect(result.summary).toContain('No page-safety verdict was computed');
    });

    it('handles no adElementSelector and no extractable selector from candidateRule', async () => {
        const handlers = mockHandlers({
            openPageResult: { url: 'https://example.com', title: 'OK', statusCode: 200 },
            evaluateJsResult: { result: false },
        });

        const result = await runValidation({
            handlers,
            page: mockPage(),
            artifactsDir: '/tmp/test-artifacts',
            recorder: mockRecorder(),
            url: 'https://example.com',
            candidateRule: '||ads.example.com^', // Network rule — no selector
            existingRules: ['||other-ads.com^'],
            testOnlyAllowMainWorldProbeFallback: true,
            // No adElementSelector provided
        });

        expect(result.validatedSelector).toBe('');
        expect(result.summary).toContain('Selector: (not available)');
        expect(result.summary).toContain('Before target presence: not_probed');
    });

    it('replaces the parent rule in Phase C instead of layering a narrowed rule over it', async () => {
        const handlers = mockHandlers({
            openPageResult: { url: 'https://example.com', title: 'OK', statusCode: 200 },
            evaluateJsResult: { result: false },
        });
        const parentRule = '||ads.example^$domain=example.com';
        const replacementRule = '||ads.example^$domain=example.com|~sub.example.com';
        const unrelatedRule = '||metrics.example^$domain=example.com';

        const result = await runValidation({
            handlers,
            page: mockPage(),
            artifactsDir: '/tmp/test-artifacts',
            recorder: mockRecorder(),
            url: 'https://example.com',
            candidateRule: replacementRule,
            existingRules: [parentRule, unrelatedRule],
            replacedRule: parentRule,
            testOnlyAllowMainWorldProbeFallback: true,
        });

        expect(result.phaseB.appliedRules).toEqual([parentRule, unrelatedRule]);
        expect(result.phaseC.appliedRules).toEqual([unrelatedRule, replacementRule]);
    });

    it('fails closed when a replacement parent is absent from the trusted baseline', async () => {
        const handlers = mockHandlers();

        await expect(
            runValidation({
                handlers,
                page: mockPage(),
                artifactsDir: '/tmp/test-artifacts',
                recorder: mockRecorder(),
                url: 'https://example.com',
                candidateRule: '||ads.example^$domain=example.com,script',
                existingRules: ['||metrics.example^$domain=example.com'],
                replacedRule: '||ads.example^$domain=example.com',
                testOnlyAllowMainWorldProbeFallback: true,
            }),
        ).rejects.toThrow(/replacement parent rule.*baseline/i);
        expect(handlers.open_page).not.toHaveBeenCalled();
    });

    it('ignores a mismatched model selector for a cosmetic candidate', async () => {
        const handlers = mockHandlers({
            openPageResult: { url: 'https://example.com', title: 'OK', statusCode: 200 },
            evaluateJsResult: { result: false },
        });
        const page = mockPage();
        const visibleSnapshot = await page.evaluate('visible');
        const hiddenSnapshot = {
            ...(visibleSnapshot as Record<string, unknown>),
            targetVisibleCount: 0,
            targetTotalHeight: 0,
            targetTotalArea: 0,
            targetMaximumHeight: 0,
            familyTargetVisibleCount: 0,
            familyTargetTotalHeight: 0,
            familyTargetMaximumHeight: 0,
            targetMeasurements: [{ key: 'id:slot', width: 0, height: 0 }],
            familyTargetMeasurements: [{ key: 'id:slot', width: 0, height: 0 }],
        };
        mockDeferredStructuralSnapshots(page, visibleSnapshot, visibleSnapshot, hiddenSnapshot);

        const result = await runValidation({
            handlers,
            page,
            artifactsDir: '/tmp/test-artifacts',
            recorder: mockRecorder(),
            url: 'https://example.com',
            candidateRule: 'example.com##.candidate-slot',
            existingRules: [],
            testOnlyAllowMainWorldProbeFallback: true,
            adElementSelector: '.model-selected-slot',
        });

        expect(result.validatedSelector).toBe('.candidate-slot');
        expect(result.adElementStatus).toMatchObject({
            selector: '.candidate-slot',
            phaseB: 'visible',
            phaseC: 'hidden',
        });
        expect(result.summary).toContain('Before target presence: visible');
        expect(result.summary).toContain('After target presence: hidden');
        expect(result.summary).not.toContain('.model-selected-slot');
    });

    it('uses the CSS-injection candidate selector instead of a mismatched model selector', async () => {
        const handlers = mockHandlers();
        vi.mocked(handlers.evaluate_js)
            .mockResolvedValueOnce({ result: false })
            .mockResolvedValueOnce({ result: true })
            .mockResolvedValueOnce({ result: false })
            .mockResolvedValueOnce({ result: true })
            .mockResolvedValueOnce({ result: 'visible' })
            .mockResolvedValueOnce({
                result: { found: true, width: 1280, height: 360 },
            })
            .mockResolvedValueOnce({ result: false })
            .mockResolvedValueOnce({ result: true })
            .mockResolvedValueOnce({ result: 'visible' })
            .mockResolvedValueOnce({
                result: { found: true, width: 1280, height: 64 },
            });

        const result = await runValidation({
            handlers,
            page: mockPage(),
            artifactsDir: '/tmp/test-artifacts',
            recorder: mockRecorder(),
            url: 'https://layout-test.example/article',
            candidateRule: 'layout-test.example#$#.candidate-slot { height: 64px !important; }',
            existingRules: [],
            testOnlyAllowMainWorldProbeFallback: true,
            adElementSelector: '.model-selected-slot',
        });

        expect(result.validatedSelector).toBe('.candidate-slot');
        expect(result.layoutFacts?.selector).toBe('.candidate-slot');
        expect(result).not.toHaveProperty('layoutValidation');
        const probeExpressions = vi
            .mocked(handlers.evaluate_js)
            .mock.calls.map(([call]) => call.expression)
            .map(String)
            .filter(
                (expression) =>
                    expression.includes('.candidate-slot') ||
                    expression.includes('.model-selected-slot'),
            );
        expect(probeExpressions).toHaveLength(4);
        expect(probeExpressions).toEqual(
            expect.arrayContaining([
                expect.stringContaining("document.querySelector('.candidate-slot')"),
            ]),
        );
        expect(
            probeExpressions.every((expression) => !expression.includes('.model-selected-slot')),
        ).toBe(true);
    });

    it('allows a model-provided selector for a network candidate', async () => {
        const handlers = mockHandlers({
            openPageResult: { url: 'https://example.com', title: 'OK', statusCode: 200 },
            evaluateJsResult: { result: false },
        });

        const result = await runValidation({
            handlers,
            page: mockPage(),
            artifactsDir: '/tmp/test-artifacts',
            recorder: mockRecorder(),
            url: 'https://example.com',
            candidateRule: '||ads.example.com^',
            existingRules: [],
            testOnlyAllowMainWorldProbeFallback: true,
            adElementSelector: '.reported-ad',
        });

        expect(result.validatedSelector).toBe('.reported-ad');
        expect(result.adElementStatus).toMatchObject({
            selector: '.reported-ad',
            phaseB: 'not_probed',
            phaseC: 'not_probed',
        });
        expect(result.summary).toContain('Before target presence: not_probed');
        expect(result.summary).toContain('After target presence: not_probed');
    });

    it('records CSS geometry without claiming resolution when flow evidence disagrees', async () => {
        const handlers = mockHandlers();
        vi.mocked(handlers.evaluate_js)
            .mockResolvedValueOnce({ result: false })
            .mockResolvedValueOnce({ result: true })
            .mockResolvedValueOnce({ result: false })
            .mockResolvedValueOnce({ result: true })
            .mockResolvedValueOnce({ result: 'visible' })
            .mockResolvedValueOnce({
                result: { found: true, width: 1280, height: 360 },
            })
            .mockResolvedValueOnce({ result: false })
            .mockResolvedValueOnce({ result: true })
            .mockResolvedValueOnce({ result: 'visible' })
            .mockResolvedValueOnce({
                result: { found: true, width: 1280, height: 64 },
            });

        const page = mockPage();
        const independentBaseline = await page.evaluate('baseline');
        const control = {
            ...(independentBaseline as Record<string, unknown>),
            targetTotalHeight: 360,
            targetTotalArea: 460_800,
            targetMaximumHeight: 360,
            familyTargetTotalHeight: 360,
            familyTargetMaximumHeight: 360,
            targetMeasurements: [{ key: 'id:slot', width: 1280, height: 360 }],
            familyTargetMeasurements: [{ key: 'id:slot', width: 1280, height: 360 }],
        };
        const candidate = {
            ...control,
            targetTotalHeight: 64,
            targetTotalArea: 81_920,
            targetMaximumHeight: 64,
            familyTargetTotalHeight: 64,
            familyTargetMaximumHeight: 64,
            targetMeasurements: [{ key: 'id:slot', width: 1280, height: 64 }],
            familyTargetMeasurements: [{ key: 'id:slot', width: 1280, height: 64 }],
        };
        mockDeferredStructuralSnapshots(page, independentBaseline, control, candidate);

        const result = await runValidation({
            handlers,
            page,
            artifactsDir: '/tmp/test-artifacts',
            recorder: mockRecorder(),
            url: 'https://layout-test.example/article',
            candidateRule: 'layout-test.example#$#.reserved-slot { height: 64px !important; }',
            existingRules: [],
            testOnlyAllowMainWorldProbeFallback: true,
        });

        expect(result.layoutFacts).toMatchObject({
            selector: '.reserved-slot',
            before: { found: true, width: 1280, height: 360 },
            after: { found: true, width: 1280, height: 64 },
        });
        expect(result.structureFacts?.before.targetTotalHeight).toBe(360);
        expect(result.structureFacts?.after.targetTotalHeight).toBe(64);
        expect(result.summary).toContain('Target geometry: 1280x360px -> 1280x64px');
        expect(result.summary).toContain('No page-safety verdict was computed');
    });

    it('stores independent validation artifacts for different candidates', async () => {
        const recorder = mockRecorder();
        const baseConfig = {
            handlers: mockHandlers({ evaluateJsResult: { result: true } }),
            page: mockPage(),
            artifactsDir: '/tmp/test-artifacts',
            recorder,
            url: 'https://example.com',
            existingRules: [],
            testOnlyAllowMainWorldProbeFallback: true,
        };

        await runValidation({
            ...baseConfig,
            candidateRule: 'example.com##.candidate-a',
        });
        await runValidation({
            ...baseConfig,
            candidateRule: 'example.com##.candidate-b',
        });

        const artifactPaths = vi
            .mocked(recorder.addArtifact)
            .mock.calls.map(([artifact]) => artifact.path);
        expect(artifactPaths).toHaveLength(2);
        expect(new Set(artifactPaths).size).toBe(2);
        expect(artifactPaths).toEqual([
            expect.stringMatching(/factual-validation-[a-f0-9]{12}\.json$/),
            expect.stringMatching(/factual-validation-[a-f0-9]{12}\.json$/),
        ]);
    });

    it('persists the exact trusted URL and canonical baseline hash in the factual artifact', async () => {
        const artifactsDir = mkdtempSync(join(tmpdir(), 'trusted-factual-validation-'));
        const recorder = mockRecorder();
        const reportedUrl = 'https://example.com/reported-path?issue=1';
        const existingRules = ['example.com##.existing-rule'];
        const trustedValidationContext = {
            reportedUrl,
            existingRules,
            baselineHash: calculateTrustedBaselineHash(reportedUrl, existingRules),
        };

        try {
            const result = await runValidation({
                handlers: mockHandlers({
                    openPageResult: { url: reportedUrl, title: 'OK', statusCode: 200 },
                    evaluateJsResult: { result: true },
                }),
                page: mockPage(),
                artifactsDir,
                recorder,
                url: reportedUrl,
                candidateRule: 'example.com##.candidate',
                existingRules,
                trustedValidationContext,
                testOnlyAllowMainWorldProbeFallback: true,
            });

            expect(result.trustedValidationContext).toEqual({
                reportedUrl,
                baselineHash: trustedValidationContext.baselineHash,
                existingRuleCount: 1,
            });
            expect(result.phaseB.url).toBe(reportedUrl);
            expect(result.phaseC.url).toBe(reportedUrl);
            const artifactPath = vi.mocked(recorder.addArtifact).mock.calls.at(-1)?.[0].path;
            const artifact = JSON.parse(readFileSync(String(artifactPath), 'utf8'));
            expect(artifact.trustedValidationContext).toEqual(result.trustedValidationContext);
        } finally {
            rmSync(artifactsDir, { recursive: true, force: true });
        }
    });

    it('fails closed when hostile main-world output disagrees with isolated-world failures', async () => {
        const handlers = mockHandlers({ evaluateJsResult: { result: 'visible' } });
        const page = mockPage();
        const send = vi.fn(async (method: string) => {
            if (method === 'Page.getFrameTree') {
                return { frameTree: { frame: { id: 'current-main-frame' } } };
            }
            if (method === 'Page.createIsolatedWorld') {
                return { executionContextId: 91 };
            }
            if (method === 'Runtime.evaluate') {
                return {
                    result: { type: 'undefined' },
                    exceptionDetails: { text: 'isolated probe failed' },
                };
            }
            return {};
        });
        const detach = vi.fn().mockResolvedValue(undefined);
        const newCDPSession = vi.fn().mockResolvedValue({ send, detach });
        Object.assign(page, { context: () => ({ newCDPSession }) });

        const result = await runValidation({
            handlers,
            page,
            artifactsDir: '/tmp/test-artifacts',
            recorder: mockRecorder(),
            url: 'https://example.com',
            candidateRule: 'example.com##.candidate',
            existingRules: [],
        });

        expect(handlers.evaluate_js).not.toHaveBeenCalled();
        expect(result.phaseA.antiAdblockDetected).toBe(true);
        expect(result.phaseB.antiAdblockDetected).toBe(true);
        expect(result.phaseC.antiAdblockDetected).toBe(true);
        expect(result.adElementStatus).toEqual({
            selector: '.candidate',
            phaseB: 'not_probed',
            phaseC: 'not_probed',
        });
        expect(result.structureFacts?.before.probeSucceeded).toBe(false);
        expect(result.structureFacts?.after.probeSucceeded).toBe(false);
        expect(result).not.toHaveProperty('structuralValidation');
        expect(result).not.toHaveProperty('contentIntact');
        expect(detach).toHaveBeenCalled();
    });
});
