import { afterEach, describe, it, expect, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import {
    createBrowserToolHandlers,
    type BrowserToolConfig,
    type BrowserToolHandlers,
} from '../../src/browser/browser-tools';
import { ConsoleCoverage, type IBrowserSession } from '../../src/browser/browser-interfaces';
import type { TraceRecorder } from '../../src/tracer/trace-recorder';
import { evaluatePageScript, fakeElement } from './fixtures/page-script-sandbox';
import type { HostnameResolver } from '../../src/browser/network-safety';
import { MAX_VISION_IMAGE_BYTES } from '../../src/pi/single-shot-input';
import type { FullPageTileCoverage } from '../../src/types/validation';
import type { BrowserFallbackReason } from '../../src/types/fix-run-result';
import {
    browserFallbackOrigin,
    BrowserFallbackOrigin,
} from '../../src/types/browser-fallback-origin';

vi.mock('node:fs', () => ({ writeFileSync: vi.fn(), mkdirSync: vi.fn() }));

afterEach(() => {
    vi.clearAllMocks();
});

const publicResolver: HostnameResolver = vi.fn().mockResolvedValue(['93.184.216.34']);

type TestBrowserToolConfig = Omit<BrowserToolConfig, 'allowedOrigin' | 'resolveHostname'> &
    Partial<Pick<BrowserToolConfig, 'allowedOrigin' | 'resolveHostname'>>;

function createTestBrowserToolHandlers(config: TestBrowserToolConfig): BrowserToolHandlers {
    return createBrowserToolHandlers({
        allowedOrigin: 'https://example.com',
        resolveHostname: publicResolver,
        ...config,
    });
}

function mockPng(width: number, height: number): Buffer {
    const buffer = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer, 0);
    buffer.write('IHDR', 12, 'ascii');
    buffer.writeUInt32BE(width, 16);
    buffer.writeUInt32BE(height, 20);
    return buffer;
}

function mockSession(overrides: Partial<IBrowserSession> = {}): IBrowserSession {
    const cdpSession = {
        send: vi.fn().mockImplementation(async (method: string) => {
            if (method === 'Page.getFrameTree') {
                return { frameTree: { frame: { id: 'main-frame' } } };
            }
            if (method === 'Page.createIsolatedWorld') {
                return { executionContextId: 1 };
            }
            if (method === 'Runtime.evaluate') {
                return { result: { value: { x: 0, y: 0, stable: true } } };
            }
            return {};
        }),
        detach: vi.fn().mockResolvedValue(undefined),
    };
    return {
        getPage: vi.fn().mockReturnValue({
            goto: vi.fn().mockResolvedValue(undefined),
            title: vi.fn().mockResolvedValue('Test'),
            waitForLoadState: vi.fn().mockResolvedValue(undefined),
            waitForTimeout: vi.fn().mockResolvedValue(undefined),
            screenshot: vi.fn().mockImplementation(async (options?: Record<string, unknown>) => {
                const clip = options?.clip as { width?: number; height?: number } | undefined;
                return mockPng(clip?.width ?? 1, clip?.height ?? 1);
            }),
            content: vi.fn().mockResolvedValue('<html>Test</html>'),
            evaluate: vi.fn().mockImplementation(async (expression: unknown) => {
                if (typeof expression === 'string') {
                    if (expression.includes('__adguard_page_stability_probe__')) {
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
                    return expression.includes('innerText') ? 'Test' : undefined;
                }
                return undefined;
            }),
            url: vi.fn().mockReturnValue('https://example.com'),
            viewportSize: vi.fn().mockReturnValue({ width: 1920, height: 1080 }),
            context: vi.fn().mockReturnValue({
                route: vi.fn().mockResolvedValue(undefined),
                unroute: vi.fn().mockResolvedValue(undefined),
                cookies: vi.fn().mockResolvedValue([]),
                newCDPSession: vi.fn().mockResolvedValue(cdpSession),
            }),
            frames: vi.fn().mockReturnValue([]),
            on: vi.fn(),
            off: vi.fn(),
            mainFrame: vi.fn().mockReturnValue({}),
        }),
        getNetworkLog: vi.fn().mockReturnValue([]),
        resetNetworkLog: vi.fn(),
        getConsoleLog: vi.fn().mockReturnValue([]),
        consoleCoverage: ConsoleCoverage.BrowserLogOnly,
        close: vi.fn().mockResolvedValue(undefined),
        artifactsDir: '/tmp',
        isClosed: false,
        ...overrides,
    };
}

describe('evaluate_js validation (F5)', () => {
    const tools = createTestBrowserToolHandlers({
        session: mockSession(),
        recorder: { addArtifact: vi.fn() } as unknown as TraceRecorder,
        artifactsDir: '/tmp',
    });

    it('rejects expressions over 2000 chars', async () => {
        const long = 'a'.repeat(2001);
        const result = await tools.evaluate_js({ expression: long });
        expect(result.error).toContain('exceeds maximum length');
        expect(result.errorKind).toBe('policy_rejection');
    });

    it('rejects expressions containing fetch(', async () => {
        const result = await tools.evaluate_js({ expression: 'fetch("/admin")' });
        expect(result.error).toContain('rejected by safety validator');
    });

    it('rejects expressions containing document.cookie', async () => {
        const result = await tools.evaluate_js({ expression: 'document.cookie' });
        expect(result.error).toContain('rejected by safety validator');
    });

    it('rejects expressions containing localStorage.', async () => {
        const result = await tools.evaluate_js({ expression: 'localStorage.clear()' });
        expect(result.error).toContain('rejected by safety validator');
    });

    it.each([
        'new WebSocket("wss://example.com/socket")',
        'new EventSource("https://example.com/events")',
        'navigator.sendBeacon("https://example.com/collect")',
        'navigator.serviceWorker.register("/worker.js")',
        'new SharedWorker("/worker.js")',
    ])('rejects an alternate outbound channel: %s', async (expression) => {
        const result = await tools.evaluate_js({ expression });
        expect(result.error).toContain('rejected by safety validator');
    });

    it.each([
        "(() => { const el = document.querySelector('div.bs5wp-ads-placement--global_top_leaderboard'); if (!el) return; el.style.display = 'block'; el.style.visibility = 'visible'; el.style.opacity = '1'; return el.getBoundingClientRect(); })()",
        "(() => { const btn = Array.from(document.querySelectorAll('button')).find((button) => button.textContent.includes('Akceptuj')); if (btn) btn.click(); return 'done'; })()",
        "document.body.setAttribute('data-agent-test', 'true')",
        "document.body.classList.add('agent-test')",
        "document.body.dispatchEvent(new Event('change'))",
        "document.body.appendChild(document.createElement('div'))",
        "Object.defineProperty(document.body, 'agentTest', { value: true })",
        '(() => { const invoke = document.body.click; return invoke(); })()',
        "document.body['click']()",
        'setTimeout(() => document.title, 0)',
        'window.setTimeout(() => document.title, 0)',
        'delete document.body.dataset.agentTest',
        '(() => { document.body.scrollTop++; return 1; })()',
        // A write reaching the page through a local alias: the container is the expression's,
        // its property holds a page element, and the second level writes the element.
        "(() => { const box = {}; box.el = document.body; box.el.style.display = 'none'; return 1; })()",
        // A container the expression rebinds to a page element before writing through it.
        '(() => { let out = {}; out = document.body; out.hidden = true; return 1; })()',
        // An undeclared name is a page global.
        '(() => { agentProbe = 1; return agentProbe; })()',
        // A declaration in an inner scope does not make the outer name local.
        "(() => { let location; })(); location = 'https://evil.example/'",
    ])('rejects a page-contaminating diagnostic: %s', async (expression) => {
        const result = await tools.evaluate_js({ expression });
        expect(result.error).toContain('rejected by read-only validator');
        expect(result.errorKind).toBe('policy_rejection');
    });

    it('refuses an expression that does not parse without counting it as a policy rejection', async () => {
        const evaluate = vi.fn();
        const session = mockSession({
            getPage: vi.fn().mockReturnValue({ ...mockSession().getPage(), evaluate }),
        });
        const handlers = createTestBrowserToolHandlers({
            session,
            recorder: { addArtifact: vi.fn() } as unknown as TraceRecorder,
            artifactsDir: '/tmp',
        });

        const result = await handlers.evaluate_js({ expression: '(() => { const x = ; })()' });

        expect(result.errorKind).toBe('syntax_error');
        expect(result.error).toContain('not valid JavaScript');
        expect(evaluate).not.toHaveBeenCalled();
    });

    it.each([
        "(() => { const el = document.querySelector('div.bs5wp-ads-placement--global_top_leaderboard'); if (!el) return 'not found'; const style = el.getAttribute('style'); const computed = getComputedStyle(el); let inlineStyles = el.style.cssText || '(none)'; return { inlineStyle: inlineStyles, originalStyle: style, display: computed.display, hidden: computed.display === 'none' && !el.style.display }; })()",
        "Array.from(document.querySelectorAll('.ad')).map((el) => ({ tag: el.tagName, hidden: getComputedStyle(el).display === 'none', area: el.clientWidth * el.clientHeight }))",
        "document.querySelector('[data-state=\"a=b\"]')?.getAttribute('aria-label')",
        "/display\\s*=/.test(document.body.textContent ?? '')",
        "document.title.replace(/\\s+/g, ' ').trim()",
        "document.body.textContent.includes('.click()')",
        // The expression's own variables are its to reassign and count with; the lexer this
        // replaced refused every parent-chain walk (AdguardFilters #242044).
        "(() => { const el = document.querySelector('a.tab'); if (!el) return 'not found'; const chain = []; let n = el; let depth = 0; while (n && depth < 8) { chain.push({ tag: n.tagName, cls: n.className }); n = n.parentElement; depth++; } return chain; })()",
        '(() => { let index = 0; index++; return index; })()',
        // The `function` keyword is not a call of the Function constructor.
        "(function (sel) { var el = document.querySelector(sel); function chain(node, depth) { if (!node || depth > 9) return []; var cur = { tag: node.tagName }; return [cur].concat(chain(node.parentElement, depth + 1)); } return chain(el, 0); })('a.tab')",
        '(function () { var el = document.body; var p1 = el.parentElement, p2 = p1 ? p1.parentElement : null; return [p1, p2].map((n) => n && n.tagName); })()',
        // An object or array literal the expression declares is its own to fill.
        "(() => { const out = {}; ['.ad', '.banner'].forEach((s) => { out[s] = document.querySelectorAll(s).length; }); return out; })()",
        'Array.from(document.querySelectorAll("iframe")).map((f) => { let o = {}; o.sameOrigin = !!f.contentDocument; return o; })',
        'Array.from(document.images).map((i) => `${i.width}x${i.height}`)',
        "(() => { const seen = new Set(); seen.add('x'); return seen.size; })()",
    ])('accepts a read-only diagnostic: %s', async (expression) => {
        const session = mockSession({
            getPage: vi.fn().mockReturnValue({
                ...mockSession().getPage(),
                evaluate: vi.fn().mockResolvedValue(42),
            }),
        });
        const safeTools = createTestBrowserToolHandlers({
            session,
            recorder: { addArtifact: vi.fn() } as unknown as TraceRecorder,
            artifactsDir: '/tmp',
        });
        const result = await safeTools.evaluate_js({ expression });
        expect(result.error).toBeUndefined();
        expect(result.result).toBe(42);
    });

    it('persists an oversized read-only result and returns a bounded structural summary', async () => {
        const oversized = Array.from({ length: 2_000 }, (_value, index) => ({
            selector: `.banner-${index}`,
            height: index,
        }));
        const recorder = { addArtifact: vi.fn() } as unknown as TraceRecorder;
        const session = mockSession({
            getPage: vi.fn().mockReturnValue({
                ...mockSession().getPage(),
                evaluate: vi.fn().mockResolvedValue(oversized),
            }),
        });
        const handlers = createTestBrowserToolHandlers({
            session,
            recorder,
            artifactsDir: '/tmp',
        });

        const result = await handlers.evaluate_js({
            expression:
                'Array.from(document.querySelectorAll(".banner")).map((element) => element.id)',
        });

        expect(result).toMatchObject({
            artifactId: expect.any(String),
            resultSummary: { kind: 'array', itemCount: 2_000 },
        });
        expect(result.result).toBeUndefined();
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(6 * 1024);
        expect(recorder.addArtifact).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'evaluate-js-result' }),
        );
        const written = vi.mocked(writeFileSync).mock.calls[0][1] as string;
        expect(JSON.parse(written)).toEqual({ result: oversized });
    });
});

describe('inspect_ad_slots', () => {
    it('runs a no-argument fixed scan in an isolated world and writes validated JSON', async () => {
        const scan = {
            scope: 'main_frame_light_dom',
            candidateCount: 0,
            returnedCount: 0,
            truncated: false,
            slots: [],
        };
        const cdpSession = {
            send: vi.fn().mockImplementation(async (method: string) => {
                if (method === 'Page.getFrameTree') {
                    return { frameTree: { frame: { id: 'main-frame' } } };
                }
                if (method === 'Page.createIsolatedWorld') {
                    return { executionContextId: 1 };
                }
                if (method === 'Runtime.evaluate') {
                    return { result: { value: scan } };
                }
                return {};
            }),
            detach: vi.fn().mockResolvedValue(undefined),
        };
        const page = {
            ...mockSession().getPage(),
            evaluate: vi.fn().mockResolvedValue({ forged: true }),
            context: vi.fn().mockReturnValue({
                cookies: vi.fn().mockResolvedValue([]),
                newCDPSession: vi.fn().mockResolvedValue(cdpSession),
            }),
        };
        const recorder = { addArtifact: vi.fn() } as unknown as TraceRecorder;
        const tools = createTestBrowserToolHandlers({
            session: mockSession({ getPage: vi.fn().mockReturnValue(page) }),
            recorder,
            artifactsDir: '/tmp',
        });

        const result = await tools.inspect_ad_slots({ ignored: 'model input' });

        expect(result).toMatchObject({
            scope: 'main_frame_light_dom',
            candidateCount: 0,
            returnedCount: 0,
            truncated: false,
            stateGroups: {
                visibility: {},
                content: {},
                matchedSignals: {},
            },
            topSlots: [],
        });
        expect(result.artifactId).toEqual(expect.any(String));
        expect(page.evaluate).not.toHaveBeenCalled();
        expect(recorder.addArtifact).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'ad-slot-inspection' }),
        );
        const runtimeCall = cdpSession.send.mock.calls.find(
            ([method]) => method === 'Runtime.evaluate',
        );
        expect(runtimeCall?.[1]).toMatchObject({ userGesture: false, returnByValue: true });
    });

    it('preserves a complete large scan while returning a compact model-facing inventory', async () => {
        const classToken = 'a'.repeat(128);
        const snapshot = {
            tag: 'div',
            id: 'ad',
            classes: Array.from({ length: 16 }, () => classToken),
            viewportRect: {
                x: 0,
                y: 0,
                top: 0,
                right: 1,
                bottom: 1,
                left: 0,
                width: 1,
                height: 1,
            },
            computedStyle: {
                display: 'block',
                visibility: 'visible',
                opacity: '1',
                position: 'static',
                height: '1px',
                minHeight: '0px',
                maxHeight: 'none',
            },
            visibility: {
                state: 'visible',
                occupiesLayoutSpace: true,
                intersectsViewport: true,
                ancestorHidden: false,
            },
        };
        const slot = {
            element: snapshot,
            ancestors: Array.from({ length: 32 }, () => snapshot),
            ancestorChainTruncated: false,
            matchedSignals: ['id-ad-token'],
            contentState: 'empty',
            creativeSignals: [],
            meaningfulTextLength: 0,
            descendantCount: 0,
            contentScanTruncated: false,
        };
        const oversized = {
            scope: 'main_frame_light_dom',
            candidateCount: 32,
            returnedCount: 32,
            truncated: false,
            slots: Array.from({ length: 32 }, () => slot),
        };
        const cdpSession = {
            send: vi.fn().mockImplementation(async (method: string) => {
                if (method === 'Page.getFrameTree') {
                    return { frameTree: { frame: { id: 'main-frame' } } };
                }
                if (method === 'Page.createIsolatedWorld') {
                    return { executionContextId: 1 };
                }
                if (method === 'Runtime.evaluate') {
                    return { result: { value: oversized } };
                }
                return {};
            }),
            detach: vi.fn().mockResolvedValue(undefined),
        };
        const page = {
            ...mockSession().getPage(),
            context: vi.fn().mockReturnValue({
                cookies: vi.fn().mockResolvedValue([]),
                newCDPSession: vi.fn().mockResolvedValue(cdpSession),
            }),
        };
        const recorder = { addArtifact: vi.fn() } as unknown as TraceRecorder;
        const tools = createTestBrowserToolHandlers({
            session: mockSession({ getPage: vi.fn().mockReturnValue(page) }),
            recorder,
            artifactsDir: '/tmp',
        });

        const result = await tools.inspect_ad_slots({});

        expect(result.error).toBeUndefined();
        expect(result.truncated).toBe(false);
        expect(result.returnedCount).toBe(32);
        expect(result.topSlots).toHaveLength(6);
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(6 * 1024);
        const written = vi.mocked(writeFileSync).mock.calls[0][1] as string;
        expect(Buffer.byteLength(written)).toBeGreaterThan(128 * 1024);
        expect(Buffer.byteLength(written)).toBeLessThanOrEqual(4 * 1024 * 1024);
        const persisted = JSON.parse(written) as Record<string, unknown>;
        expect(persisted).toMatchObject({
            candidateCount: 32,
            returnedCount: 32,
            truncated: false,
        });
        expect(persisted.slots).toHaveLength(32);
        expect(recorder.addArtifact).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'ad-slot-inspection' }),
        );
    });
});

describe('HAR redaction in get_network_log (F1)', () => {
    it('calls redactNetworkLog before writing', async () => {
        const session = mockSession({
            getNetworkLog: vi.fn().mockReturnValue([
                {
                    url: 'https://example.com',
                    method: 'GET',
                    resourceType: 'document',
                    statusCode: 200,
                    requestHeaders: { Cookie: 'secret' },
                    responseHeaders: {},
                },
            ]),
        });
        const tools = createTestBrowserToolHandlers({
            session,
            recorder: { addArtifact: vi.fn() } as unknown as TraceRecorder,
            artifactsDir: '/tmp',
        });
        await tools.get_network_log({});
        const written = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
        const parsed = JSON.parse(written);
        expect(parsed[0].requestHeaders['Cookie']).toBe('[redacted]');
    });
});

describe('open_page navigation failure log', () => {
    it('logs the frame navigation chain on navigation failure', async () => {
        const session = mockSession();
        const page = session.getPage();
        const mainFrame = { url: vi.fn().mockReturnValue('https://example.com/redirect-1') };
        let navigatedHandler: ((frame: unknown) => void) | undefined;
        page.mainFrame = vi.fn().mockReturnValue(mainFrame);
        page.on = vi.fn().mockImplementation((event: string, handler: (frame: unknown) => void) => {
            if (event === 'framenavigated') {
                navigatedHandler = handler;
            }
            return page;
        });
        page.goto = vi.fn().mockImplementation(async () => {
            navigatedHandler?.(mainFrame);
            throw new Error(
                'page.evaluate: Execution context was destroyed, most likely because of a ' +
                    'navigation.',
            );
        });
        const warn = vi.fn();
        const tools = createTestBrowserToolHandlers({
            session,
            recorder: { addArtifact: vi.fn() } as unknown as TraceRecorder,
            artifactsDir: '/tmp',
            openPageRetries: 1,
            logger: { warn } as unknown as BrowserToolConfig['logger'],
        });

        const result = await tools.open_page({ url: 'https://example.com' });

        expect(result).toMatchObject({ fallbackReason: 'navigation_timeout' });
        expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({
                targetUrl: 'https://example.com',
                fallbackReason: 'navigation_timeout',
                frameNavigations: ['https://example.com/redirect-1'],
            }),
            'open_page navigation failed',
        );
    });
});

describe('open_page', () => {
    it('returns page metadata on success', async () => {
        const session = mockSession();
        const tools = createTestBrowserToolHandlers({
            session,
            recorder: { addArtifact: vi.fn() } as unknown as TraceRecorder,
            artifactsDir: '/tmp',
        });
        const result = await tools.open_page({ url: 'https://example.com' });
        expect(result.url).toBe('https://example.com');
        expect(result.title).toBe('Test');
        expect(result.statusCode).toBe(200);
        expect(result.stabilization).toMatchObject({
            status: 'stable',
            targetRequested: false,
        });
        expect(session.getPage().waitForTimeout).toHaveBeenCalledWith(250);
        expect(session.getPage().waitForLoadState).not.toHaveBeenCalled();
        expect(session.getPage().context().unroute).not.toHaveBeenCalled();
    });

    it.each([
        ['accept', 'zaakceptuj wszystkie', 'Zaakceptuj wszystkie'],
        ['reject', 'odrzuć wszystkie', 'Odrzuć wszystkie'],
    ] as const)(
        'applies bounded %s consent setup and restabilizes before returning',
        async (strategy, expectedAllowlistedLabel, matchedLabel) => {
            let consentStateReads = 0;
            const basePage = mockSession().getPage();
            const baseEvaluate = basePage.evaluate as ReturnType<typeof vi.fn>;
            const page = {
                ...basePage,
                evaluate: vi.fn().mockImplementation(async (expression: unknown) => {
                    if (
                        typeof expression === 'string' &&
                        expression.includes('__adguard_consent_page_state__')
                    ) {
                        consentStateReads += 1;
                        return {
                            bodyClassName: consentStateReads === 1 ? 'show--consent' : '',
                            visibleObstructionCount: consentStateReads === 1 ? 1 : 0,
                            visibleObstructions:
                                consentStateReads === 1
                                    ? [
                                          {
                                              tagName: 'div',
                                              id: 'consent',
                                              className: 'consent modal',
                                              role: 'dialog',
                                          },
                                      ]
                                    : [],
                        };
                    }
                    if (
                        typeof expression === 'string' &&
                        expression.includes('__adguard_consent_control_click__')
                    ) {
                        expect(expression.toLocaleLowerCase()).toContain(expectedAllowlistedLabel);
                        expect(expression).toContain('container.querySelectorAll');
                        expect(expression).toContain('element === document.body');
                        return { clicked: true, matchedLabel };
                    }
                    return await baseEvaluate(expression);
                }),
            };
            const tools = createTestBrowserToolHandlers({
                session: mockSession({ getPage: vi.fn().mockReturnValue(page) }),
                recorder: { addArtifact: vi.fn() } as unknown as TraceRecorder,
                artifactsDir: '/tmp',
                consentStrategy: strategy,
            });

            const result = await tools.open_page({ url: 'https://example.com' });

            expect(result.error).toBeUndefined();
            expect(result.consent).toMatchObject({
                strategy,
                attempted: true,
                clicked: true,
                matchedLabel,
                before: {
                    bodyClassName: 'show--consent',
                    visibleObstructionCount: 1,
                },
                after: { bodyClassName: '', visibleObstructionCount: 0 },
                stabilization: { status: 'stable' },
            });
            expect(consentStateReads).toBe(2);
        },
    );

    it('does not search or click controls when no visible consent obstruction exists', async () => {
        const basePage = mockSession().getPage();
        const baseEvaluate = basePage.evaluate as ReturnType<typeof vi.fn>;
        const evaluate = vi.fn().mockImplementation(async (expression: unknown) => {
            if (
                typeof expression === 'string' &&
                expression.includes('__adguard_consent_page_state__')
            ) {
                return {
                    bodyClassName: '',
                    visibleObstructionCount: 0,
                    visibleObstructions: [],
                };
            }
            if (
                typeof expression === 'string' &&
                expression.includes('__adguard_consent_control_click__')
            ) {
                throw new Error('Consent controls must not be searched without an obstruction.');
            }
            return await baseEvaluate(expression);
        });
        const page = { ...basePage, evaluate };
        const tools = createTestBrowserToolHandlers({
            session: mockSession({ getPage: vi.fn().mockReturnValue(page) }),
            recorder: { addArtifact: vi.fn() } as unknown as TraceRecorder,
            artifactsDir: '/tmp',
            consentStrategy: 'accept',
        });

        const result = await tools.open_page({ url: 'https://example.com' });

        expect(result.error).toBeUndefined();
        expect(result.consent).toMatchObject({
            strategy: 'accept',
            attempted: true,
            clicked: false,
            before: { visibleObstructionCount: 0 },
            after: { visibleObstructionCount: 0 },
        });
        expect(
            evaluate.mock.calls.some(
                ([expression]) =>
                    typeof expression === 'string' &&
                    expression.includes('__adguard_consent_control_click__'),
            ),
        ).toBe(false);
    });

    it('rejects a cross-origin page transition caused by consent setup', async () => {
        let consentStateReads = 0;
        const basePage = mockSession().getPage();
        const baseEvaluate = basePage.evaluate as ReturnType<typeof vi.fn>;
        const page = {
            ...basePage,
            url: vi
                .fn()
                .mockReturnValueOnce('https://example.com')
                .mockReturnValue('https://unexpected.example.net'),
            evaluate: vi.fn().mockImplementation(async (expression: unknown) => {
                if (
                    typeof expression === 'string' &&
                    expression.includes('__adguard_consent_page_state__')
                ) {
                    consentStateReads += 1;
                    return {
                        bodyClassName: consentStateReads === 1 ? 'show--consent' : '',
                        visibleObstructionCount: consentStateReads === 1 ? 1 : 0,
                        visibleObstructions:
                            consentStateReads === 1
                                ? [
                                      {
                                          tagName: 'div',
                                          id: 'cookie-consent',
                                          className: 'cookie-consent',
                                          role: 'dialog',
                                      },
                                  ]
                                : [],
                    };
                }
                if (
                    typeof expression === 'string' &&
                    expression.includes('__adguard_consent_control_click__')
                ) {
                    return { clicked: true, matchedLabel: 'Accept all' };
                }
                return await baseEvaluate(expression);
            }),
        };
        const tools = createTestBrowserToolHandlers({
            session: mockSession({ getPage: vi.fn().mockReturnValue(page) }),
            recorder: { addArtifact: vi.fn() } as unknown as TraceRecorder,
            artifactsDir: '/tmp',
            consentStrategy: 'accept',
        });

        const result = await tools.open_page({ url: 'https://example.com' });

        expect(result).toMatchObject({
            url: 'https://unexpected.example.net',
            fallbackReason: 'navigation_off_origin',
            consent: { clicked: true },
        });
        expect(result.error).toContain('navigation blocked after consent setup');
    });

    it('waits for matching DOM and network samples instead of a blind dwell', async () => {
        let sample = 0;
        const page = {
            ...mockSession().getPage(),
            evaluate: vi.fn().mockImplementation(async (expression: unknown) => {
                if (
                    typeof expression === 'string' &&
                    expression.includes('__adguard_scroll_target_probe__')
                ) {
                    return { requested: false, found: false, scrolled: false };
                }
                sample += 1;
                return {
                    readyState: 'complete',
                    htmlLength: sample === 1 ? 500 : 700,
                    nodeCount: sample === 1 ? 10 : 15,
                    textLength: 80,
                    scrollHeight: 1_080,
                    scrollY: 0,
                    resourceCount: 4,
                    domFingerprint: sample === 1 ? 'loading' : 'settled',
                };
            }),
        };
        const networkSnapshots = [
            [],
            [
                {
                    url: 'https://example.com/app.js',
                    method: 'GET',
                    resourceType: 'script',
                    statusCode: 200,
                    requestHeaders: {},
                    responseHeaders: {},
                },
            ],
        ];
        const session = mockSession({
            getPage: vi.fn().mockReturnValue(page),
            getNetworkLog: vi.fn().mockImplementation(() => networkSnapshots[Math.min(sample, 1)]),
        });
        const tools = createTestBrowserToolHandlers({
            session,
            recorder: { addArtifact: vi.fn() } as unknown as TraceRecorder,
            artifactsDir: '/tmp',
        });

        const result = await tools.open_page({ url: 'https://example.com' });

        expect(result.error).toBeUndefined();
        expect(result.stabilization).toMatchObject({
            status: 'stable',
            networkEntryCount: 1,
        });
        expect(page.evaluate).toHaveBeenCalledTimes(5);
    });

    it('caps every navigation attempt at the hard upper bound', async () => {
        const page = {
            ...mockSession().getPage(),
            goto: vi.fn().mockRejectedValue(new Error('ERR_TIMED_OUT')),
        };
        const tools = createTestBrowserToolHandlers({
            session: mockSession({ getPage: vi.fn().mockReturnValue(page) }),
            recorder: { addArtifact: vi.fn() } as unknown as TraceRecorder,
            artifactsDir: '/tmp',
            openPageRetries: 1,
            pageStabilizationTimeoutMs: 90_000,
        });

        await tools.open_page({ url: 'https://example.com' });

        expect(page.goto).toHaveBeenCalledWith(
            'https://example.com',
            expect.objectContaining({ timeout: 45_000 }),
        );
    });

    it('retries a technically unstable page within the bounded attempt budget', async () => {
        let signature = 0;
        const page = {
            ...mockSession().getPage(),
            evaluate: vi.fn().mockImplementation(async () => ({
                readyState: 'complete',
                htmlLength: 1_000 + signature,
                nodeCount: 20,
                textLength: 100,
                scrollHeight: 1_080,
                scrollY: 0,
                resourceCount: 4,
                domFingerprint: `changing-${signature++}`,
            })),
        };
        const tools = createTestBrowserToolHandlers({
            session: mockSession({ getPage: vi.fn().mockReturnValue(page) }),
            recorder: { addArtifact: vi.fn() } as unknown as TraceRecorder,
            artifactsDir: '/tmp',
            openPageRetries: 2,
            pageStabilizationTimeoutMs: 100,
            pageStabilityPollMs: 25,
        });

        const result = await tools.open_page({ url: 'https://example.com' });

        expect(page.goto).toHaveBeenCalledTimes(2);
        expect(result.error).toContain('did not stabilize');
        expect(result.fallbackReason).toBe('navigation_timeout');
    });

    it('scrolls to a bounded target hint and stabilizes again before returning', async () => {
        const slot = fakeElement('DIV', 'Advertisement', { class: 'reported-ad-slot' });
        const page = {
            ...mockSession().getPage(),
            evaluate: vi.fn().mockImplementation(async (expression: unknown) => {
                if (
                    typeof expression === 'string' &&
                    expression.includes('__adguard_scroll_target_probe__')
                ) {
                    // The real target script, run the way the page runs it.
                    return evaluatePageScript(expression, '.reported-ad-slot', [slot]);
                }
                return {
                    readyState: 'complete',
                    htmlLength: 1_024,
                    nodeCount: 20,
                    textLength: 100,
                    scrollHeight: 4_000,
                    scrollY: 2_000,
                    resourceCount: 8,
                    domFingerprint: 'stable-dom',
                };
            }),
        };
        const tools = createTestBrowserToolHandlers({
            session: mockSession({ getPage: vi.fn().mockReturnValue(page) }),
            recorder: { addArtifact: vi.fn() } as unknown as TraceRecorder,
            artifactsDir: '/tmp',
        });

        const result = await tools.open_page({
            url: 'https://example.com/article',
            targetSelector: '.reported-ad-slot',
            targetHint: 'Advertisement above the comments',
        });

        expect(result.error).toBeUndefined();
        expect(result.stabilization).toMatchObject({
            status: 'stable',
            targetRequested: true,
            targetFound: true,
            targetScrolled: true,
            targetMatchedBy: 'selector',
        });
        const targetExpression = page.evaluate.mock.calls
            .map(([expression]) => expression)
            .find(
                (expression) =>
                    typeof expression === 'string' &&
                    expression.includes('__adguard_scroll_target_probe__'),
            ) as string;
        const encodedInput = targetExpression.match(/atob\('([^']+)'\)/)?.[1] ?? '';
        expect(JSON.parse(Buffer.from(encodedInput, 'base64').toString('utf8'))).toEqual({
            selector: '.reported-ad-slot',
            textHint: 'Advertisement above the comments',
        });
        expect(slot.scrolledIntoView).toBe(true);
    });

    it('does not retry when a stable page has no requested target or ad evidence', async () => {
        const session = mockSession();
        const page = session.getPage();
        const tools = createTestBrowserToolHandlers({
            session,
            recorder: { addArtifact: vi.fn() } as unknown as TraceRecorder,
            artifactsDir: '/tmp',
            openPageRetries: 3,
        });

        const result = await tools.open_page({ url: 'https://example.com/no-ads' });

        expect(result.error).toBeUndefined();
        expect(result.stabilization).toMatchObject({ status: 'stable' });
        expect(page.goto).toHaveBeenCalledOnce();
    });

    it('keeps a stable page usable when a supplied target hint is not found', async () => {
        const page = {
            ...mockSession().getPage(),
            evaluate: vi.fn().mockImplementation(async (expression: unknown) => {
                if (
                    typeof expression === 'string' &&
                    expression.includes('__adguard_scroll_target_probe__')
                ) {
                    return { requested: true, found: false, scrolled: false };
                }
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
            }),
        };
        const tools = createTestBrowserToolHandlers({
            session: mockSession({ getPage: vi.fn().mockReturnValue(page) }),
            recorder: { addArtifact: vi.fn() } as unknown as TraceRecorder,
            artifactsDir: '/tmp',
            openPageRetries: 3,
        });

        const result = await tools.open_page({
            url: 'https://example.com/no-ads',
            targetHint: 'reported advertising slot',
        });

        expect(result.error).toBeUndefined();
        expect(result.stabilization).toMatchObject({
            status: 'stable',
            targetRequested: true,
            targetFound: false,
            targetScrolled: false,
        });
        expect(page.goto).toHaveBeenCalledOnce();
    });

    it('returns the actual main-document HTTP status', async () => {
        const page = {
            ...mockSession().getPage(),
            goto: vi.fn().mockResolvedValue({ status: () => 403 }),
        };
        const session = mockSession({ getPage: vi.fn().mockReturnValue(page) });
        const tools = createTestBrowserToolHandlers({
            session,
            recorder: { addArtifact: vi.fn() } as unknown as TraceRecorder,
            artifactsDir: '/tmp',
        });

        const result = await tools.open_page({ url: 'https://example.com/blocked' });

        expect(result.statusCode).toBe(403);
        expect(result.fallbackReason).toBe('http_blocked');
    });

    it('classifies a missing target separately from an HTTP block', async () => {
        const page = {
            ...mockSession().getPage(),
            goto: vi.fn().mockResolvedValue({ status: () => 404 }),
        };
        const session = mockSession({ getPage: vi.fn().mockReturnValue(page) });
        const tools = createTestBrowserToolHandlers({
            session,
            recorder: { addArtifact: vi.fn() } as unknown as TraceRecorder,
            artifactsDir: '/tmp',
        });

        const result = await tools.open_page({ url: 'https://example.com/missing' });

        expect(result).toMatchObject({
            statusCode: 404,
            fallbackReason: 'not_found',
            error: 'main document returned HTTP 404',
        });
    });

    it('does not wait for global networkidle after DOMContentLoaded', async () => {
        const page = {
            ...mockSession().getPage(),
            goto: vi.fn().mockResolvedValue({ status: () => 200 }),
            waitForLoadState: vi.fn().mockRejectedValue(new Error('networkidle timeout')),
        };
        const session = mockSession({ getPage: vi.fn().mockReturnValue(page) });
        const tools = createTestBrowserToolHandlers({
            session,
            recorder: { addArtifact: vi.fn() } as unknown as TraceRecorder,
            artifactsDir: '/tmp',
        });

        const result = await tools.open_page({ url: 'https://example.com/busy' });

        expect(result.error).toBeUndefined();
        expect(page.goto).toHaveBeenCalledWith(
            'https://example.com/busy',
            expect.objectContaining({ waitUntil: 'domcontentloaded' }),
        );
        expect(page.waitForLoadState).not.toHaveBeenCalled();
    });

    it('retries and returns error after exhausting retries', async () => {
        const page = {
            ...mockSession().getPage(),
            goto: vi.fn().mockRejectedValue(new Error('ERR_TIMED_OUT')),
        };
        const session = mockSession({ getPage: vi.fn().mockReturnValue(page) });
        const tools = createTestBrowserToolHandlers({
            session,
            recorder: { addArtifact: vi.fn() } as unknown as TraceRecorder,
            artifactsDir: '/tmp',
            openPageRetries: 2,
        });
        const result = await tools.open_page({ url: 'https://example.com/down' });
        expect(result.error).toContain('Navigation did not complete');
        expect(result.fallbackReason).toBe('navigation_timeout');
    });

    it('distinguishes a refused target from a navigation timeout', async () => {
        const page = {
            ...mockSession().getPage(),
            goto: vi
                .fn()
                .mockRejectedValue(
                    new Error(
                        'page.goto: net::ERR_CONNECTION_REFUSED at https://example.com/down\n' +
                            'Call log:\n  - navigating to the reported target',
                    ),
                ),
        };
        const session = mockSession({ getPage: vi.fn().mockReturnValue(page) });
        const tools = createTestBrowserToolHandlers({
            session,
            recorder: { addArtifact: vi.fn() } as unknown as TraceRecorder,
            artifactsDir: '/tmp',
            openPageRetries: 2,
        });

        const result = await tools.open_page({ url: 'https://example.com/down?token=secret#part' });

        expect(page.goto).toHaveBeenCalledTimes(2);
        expect(result).toMatchObject({
            fallbackReason: 'target_unreachable',
            targetUrl: 'https://example.com/down',
            attempts: 2,
            networkErrorCode: 'ERR_CONNECTION_REFUSED',
            error:
                'Target unreachable from this runner after 2 attempts: ' +
                'https://example.com/down (ERR_CONNECTION_REFUSED).',
        });
        expect(result.error).not.toContain('Call log');
        expect(result.error).not.toContain('secret');
    });

    it.each(['file:///etc/passwd', 'data:text/plain,secret', 'http://127.0.0.1/'])(
        'blocks unsafe navigation input %s before goto',
        async (url) => {
            const session = mockSession();
            const page = session.getPage();
            const tools = createTestBrowserToolHandlers({
                session,
                recorder: { addArtifact: vi.fn() } as unknown as TraceRecorder,
                artifactsDir: '/tmp',
            });

            const result = await tools.open_page({ url });

            expect(result.fallbackReason).toBe('unsafe_target_url');
            expect(page.goto).not.toHaveBeenCalled();
        },
    );

    it('never records our own refusal to navigate as a fact about the site', async () => {
        // The published comment says "the site was unavailable" for a site-origin fallback. When
        // the refusal was ours — the reported URL is not one we will open, or the site redirected
        // off the configured issue origin and our guard stopped it — saying that tells the reporter
        // something false. Only a real HTTP status from the target may carry a site claim.
        const refusals = {
            offOrigin: await createTestBrowserToolHandlers({
                session: mockSession(),
                recorder: { addArtifact: vi.fn() } as unknown as TraceRecorder,
                artifactsDir: '/tmp',
            }).open_page({ url: 'https://elsewhere.test/page' }),
            unsafeUrl: await createTestBrowserToolHandlers({
                session: mockSession(),
                recorder: { addArtifact: vi.fn() } as unknown as TraceRecorder,
                artifactsDir: '/tmp',
                allowedOrigin: 'ftp://example.com',
            }).open_page({ url: 'ftp://example.com/page' }),
        };
        const siteRefusal = await createTestBrowserToolHandlers({
            session: mockSession({
                getPage: () =>
                    ({
                        ...mockSession().getPage(),
                        goto: vi.fn().mockResolvedValue({ status: () => 403 }),
                    }) as unknown as ReturnType<IBrowserSession['getPage']>,
            }),
            recorder: { addArtifact: vi.fn() } as unknown as TraceRecorder,
            artifactsDir: '/tmp',
        }).open_page({ url: 'https://example.com/page' });

        for (const [name, refusal] of Object.entries(refusals)) {
            expect(refusal.fallbackReason, name).toBeDefined();
            expect(
                browserFallbackOrigin(refusal.fallbackReason as BrowserFallbackReason),
                name,
            ).toBe(BrowserFallbackOrigin.Agent);
        }
        expect(browserFallbackOrigin(siteRefusal.fallbackReason as BrowserFallbackReason)).toBe(
            BrowserFallbackOrigin.Site,
        );
    });

    it('blocks a public hostname that DNS resolves to a private address', async () => {
        const session = mockSession();
        const page = session.getPage();
        const tools = createTestBrowserToolHandlers({
            session,
            recorder: { addArtifact: vi.fn() } as unknown as TraceRecorder,
            artifactsDir: '/tmp',
            resolveHostname: vi.fn().mockResolvedValue(['169.254.169.254']),
        });

        const result = await tools.open_page({ url: 'https://example.com' });

        expect(result.error).toContain('non-public address');
        expect(page.goto).not.toHaveBeenCalled();
    });

    it('installs one safety route on the browser context but revalidates DNS across repeated navigation', async () => {
        const resolver: HostnameResolver = vi
            .fn()
            .mockResolvedValueOnce(['93.184.216.34'])
            .mockResolvedValueOnce(['93.184.216.34'])
            .mockResolvedValueOnce(['169.254.169.254']);
        const session = mockSession();
        const page = session.getPage();
        const tools = createTestBrowserToolHandlers({
            session,
            recorder: { addArtifact: vi.fn() } as unknown as TraceRecorder,
            artifactsDir: '/tmp',
            resolveHostname: resolver,
        });

        const first = await tools.open_page({ url: 'https://example.com/one' });
        const rebound = await tools.open_page({ url: 'https://example.com/two' });

        expect(first.error).toBeUndefined();
        expect(rebound.fallbackReason).toBe('unsafe_target_url');
        expect(rebound.error).toContain('non-public address');
        expect(page.context().route).toHaveBeenCalledTimes(1);
        expect(resolver).toHaveBeenCalledTimes(3);
        expect(page.goto).toHaveBeenCalledTimes(1);
        expect(page.context().unroute).not.toHaveBeenCalled();
    });

    it('follows the redirect the site performs while the reported page loads and keeps the landing origin', async () => {
        // A reported short link or interstitial lands on another origin by design; the guard used
        // to refuse that landing on every attempt until the target counted as unavailable
        // (AdguardFilters #239967, oii.la). The model's own navigation is still held to the
        // issue origins, which now include the landing one.
        let navigationGuard:
            | ((route: Record<string, unknown>, request: Record<string, unknown>) => Promise<void>)
            | undefined;
        const mainFrame = {};
        const route = {
            abort: vi.fn().mockResolvedValue(undefined),
            fallback: vi.fn().mockResolvedValue(undefined),
        };
        let currentUrl = 'https://example.com/';
        const page = {
            ...mockSession().getPage(),
            mainFrame: vi.fn().mockReturnValue(mainFrame),
            url: vi.fn().mockImplementation(() => currentUrl),
            context: vi.fn().mockReturnValue({
                ...mockSession().getPage().context(),
                route: vi
                    .fn()
                    .mockImplementation(
                        async (
                            _pattern: string,
                            handler: (
                                route: Record<string, unknown>,
                                request: Record<string, unknown>,
                            ) => Promise<void>,
                        ) => {
                            navigationGuard = handler;
                        },
                    ),
            }),
            goto: vi.fn().mockImplementation(async (url: string) => {
                if (url === 'https://example.com/short') {
                    // The short link answers with a script redirect: a new top-level request.
                    await navigationGuard?.(route, {
                        url: () => 'https://landing.example/page',
                        isNavigationRequest: () => true,
                        serviceWorker: () => null,
                        frame: () => mainFrame,
                    });
                    currentUrl = 'https://landing.example/page';
                } else {
                    currentUrl = url;
                }
                return { status: () => 200 };
            }),
        };
        const tools = createTestBrowserToolHandlers({
            session: mockSession({ getPage: vi.fn().mockReturnValue(page) }),
            recorder: { addArtifact: vi.fn() } as unknown as TraceRecorder,
            artifactsDir: '/tmp',
            openPageRetries: 1,
        });

        const landed = await tools.open_page({ url: 'https://example.com/short' });

        expect(route.fallback).toHaveBeenCalled();
        expect(route.abort).not.toHaveBeenCalled();
        expect(landed).toMatchObject({ url: 'https://landing.example/page', statusCode: 200 });
        expect(landed.error).toBeUndefined();

        // The landing origin is now an issue origin for the model's own navigation…
        const onLanding = await tools.open_page({ url: 'https://landing.example/next' });
        expect(onLanding.error).toBeUndefined();
        expect(onLanding.url).toBe('https://landing.example/next');

        // …and any other origin is still refused before a request is made.
        const gotoCalls = (page.goto as ReturnType<typeof vi.fn>).mock.calls.length;
        const elsewhere = await tools.open_page({ url: 'https://elsewhere.example/' });
        expect(elsewhere.fallbackReason).toBe('navigation_off_origin');
        expect(elsewhere.error).toContain('issue origins');
        expect((page.goto as ReturnType<typeof vi.fn>).mock.calls.length).toBe(gotoCalls);
    });

    it('keeps refusing a cross-origin top-level navigation outside a page load', async () => {
        // The window in which a redirect is the site's own closes with the page load: a
        // navigation a later script or click performs is held to the issue origins.
        let navigationGuard:
            | ((route: Record<string, unknown>, request: Record<string, unknown>) => Promise<void>)
            | undefined;
        const mainFrame = {};
        const route = {
            abort: vi.fn().mockResolvedValue(undefined),
            fallback: vi.fn().mockResolvedValue(undefined),
        };
        const page = {
            ...mockSession().getPage(),
            mainFrame: vi.fn().mockReturnValue(mainFrame),
            context: vi.fn().mockReturnValue({
                ...mockSession().getPage().context(),
                route: vi
                    .fn()
                    .mockImplementation(
                        async (
                            _pattern: string,
                            handler: (
                                route: Record<string, unknown>,
                                request: Record<string, unknown>,
                            ) => Promise<void>,
                        ) => {
                            navigationGuard = handler;
                        },
                    ),
            }),
        };
        const tools = createTestBrowserToolHandlers({
            session: mockSession({ getPage: vi.fn().mockReturnValue(page) }),
            recorder: { addArtifact: vi.fn() } as unknown as TraceRecorder,
            artifactsDir: '/tmp',
            openPageRetries: 1,
        });
        await tools.open_page({ url: 'https://example.com/' });

        await navigationGuard?.(route, {
            url: () => 'https://elsewhere.example/',
            isNavigationRequest: () => true,
            serviceWorker: () => null,
            frame: () => mainFrame,
        });

        expect(route.abort).toHaveBeenCalledWith('blockedbyclient');
        expect(route.fallback).not.toHaveBeenCalled();
    });

    it('blocks a private subresource request before it reaches the network', async () => {
        let requestGuard:
            | ((route: Record<string, unknown>, request: Record<string, unknown>) => Promise<void>)
            | undefined;
        const route = {
            abort: vi.fn().mockResolvedValue(undefined),
            continue: vi.fn().mockResolvedValue(undefined),
        };
        const page = {
            ...mockSession().getPage(),
            mainFrame: vi.fn().mockReturnValue({ url: () => 'https://example.com/' }),
            context: vi.fn().mockReturnValue({
                ...mockSession().getPage().context(),
                route: vi
                    .fn()
                    .mockImplementation(
                        async (
                            _pattern: string,
                            handler: (
                                route: Record<string, unknown>,
                                request: Record<string, unknown>,
                            ) => Promise<void>,
                        ) => {
                            requestGuard = handler;
                        },
                    ),
            }),
            goto: vi.fn().mockImplementation(async () => {
                await requestGuard?.(route, {
                    url: () => 'http://10.0.0.9/secret',
                    isNavigationRequest: () => false,
                    serviceWorker: () => null,
                    frame: () => ({ page: () => page }),
                });
                return { status: () => 200 };
            }),
        };
        const tools = createTestBrowserToolHandlers({
            session: mockSession({ getPage: vi.fn().mockReturnValue(page) }),
            recorder: { addArtifact: vi.fn() } as unknown as TraceRecorder,
            artifactsDir: '/tmp',
        });

        await tools.open_page({ url: 'https://example.com' });

        expect(route.abort).toHaveBeenCalled();
        expect(route.continue).not.toHaveBeenCalled();
    });
});

describe('screenshot', () => {
    it('writes a detailed viewport capture plus a full-page context capture', async () => {
        const session = mockSession();
        const recorder = { addArtifact: vi.fn() } as unknown as TraceRecorder;
        const tools = createTestBrowserToolHandlers({
            session,
            recorder,
            artifactsDir: '/tmp',
        });
        const result = await tools.screenshot({});

        expect(result.artifactId).toBeDefined();
        expect(result.fullPageArtifactId).toBeDefined();
        expect(result.format).toBe('png');
        expect(result.viewportPosition).toEqual({ x: 0, y: 0 });
        expect(session.getPage().screenshot).toHaveBeenNthCalledWith(1, {
            fullPage: false,
            type: 'png',
        });
        expect(session.getPage().screenshot).toHaveBeenNthCalledWith(2, {
            fullPage: true,
            type: 'png',
        });
        expect(recorder.addArtifact).toHaveBeenCalledTimes(2);
        expect(vi.mocked(recorder.addArtifact).mock.calls[0][0].type).toBe('screenshot');
        expect(vi.mocked(recorder.addArtifact).mock.calls[1][0].type).toBe('screenshot-full-page');
    });

    it('captures the full-page overview as JPEG when the PNG exceeds the vision ceiling', async () => {
        const basePage = mockSession().getPage();
        const oversizedPng = Buffer.alloc(MAX_VISION_IMAGE_BYTES + 1);
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(oversizedPng, 0);
        const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
        const page = {
            ...basePage,
            screenshot: vi.fn().mockImplementation(async (options?: Record<string, unknown>) => {
                if (options?.fullPage === true) {
                    return options?.type === 'jpeg' ? jpeg : oversizedPng;
                }
                return mockPng(1, 1);
            }),
        };
        const session = mockSession({ getPage: vi.fn().mockReturnValue(page) });
        const recorder = { addArtifact: vi.fn() } as unknown as TraceRecorder;
        const tools = createTestBrowserToolHandlers({
            session,
            recorder,
            artifactsDir: '/tmp',
        });

        const result = await tools.screenshot({});

        expect(result.fullPageArtifactId).toBeDefined();
        expect(page.screenshot).toHaveBeenCalledWith({ fullPage: true, type: 'jpeg', quality: 60 });
        expect(vi.mocked(recorder.addArtifact).mock.calls[1][0]).toMatchObject({
            type: 'screenshot-full-page',
            bytes: jpeg.length,
            path: expect.stringContaining('.jpg'),
        });
    });

    it('discards a viewport frame when the page moves during capture', async () => {
        const positions = [
            { x: 0, y: 0, stable: true },
            { x: 0, y: 5, stable: true },
            { x: 0, y: 5, stable: true },
            { x: 0, y: 5, stable: true },
        ];
        const cdpSession = {
            send: vi.fn().mockImplementation(async (method: string) => {
                if (method === 'Page.getFrameTree') {
                    return { frameTree: { frame: { id: 'main-frame' } } };
                }
                if (method === 'Page.createIsolatedWorld') {
                    return { executionContextId: 1 };
                }
                if (method === 'Runtime.evaluate') {
                    return { result: { value: positions.shift() } };
                }
                return {};
            }),
            detach: vi.fn().mockResolvedValue(undefined),
        };
        const basePage = mockSession().getPage();
        const page = {
            ...basePage,
            context: vi.fn().mockReturnValue({
                cookies: vi.fn().mockResolvedValue([]),
                newCDPSession: vi.fn().mockResolvedValue(cdpSession),
            }),
        };
        const session = mockSession({ getPage: vi.fn().mockReturnValue(page) });
        const recorder = { addArtifact: vi.fn() } as unknown as TraceRecorder;
        const tools = createTestBrowserToolHandlers({
            session,
            recorder,
            artifactsDir: '/tmp',
        });

        await expect(tools.screenshot({})).resolves.toMatchObject({
            viewportPosition: { x: 0, y: 5 },
        });
        expect(page.screenshot).toHaveBeenCalledTimes(3);
        expect(recorder.addArtifact).toHaveBeenCalledTimes(2);
    });

    it('captures overlapping document clips without evaluating a scroll expression', async () => {
        const basePage = mockSession().getPage();
        let probeCount = 0;
        let scrollExpressionCount = 0;
        let probeExpression = '';
        const page = {
            ...basePage,
            viewportSize: vi.fn().mockReturnValue({ width: 100, height: 100 }),
            evaluate: vi.fn().mockImplementation(async (expression: unknown) => {
                if (
                    typeof expression === 'string' &&
                    expression.includes('__adguard_full_page_tile_probe__')
                ) {
                    probeCount += 1;
                    probeExpression = expression;
                    return {
                        documentWidth: 100,
                        documentHeight: 250,
                        landmarks: [
                            { y: 20, text: 'Top story' },
                            { y: 190, text: 'Latest news' },
                        ],
                    };
                }
                if (
                    typeof expression === 'string' &&
                    expression.includes('__adguard_full_page_tile_scroll__')
                ) {
                    scrollExpressionCount += 1;
                }
                return undefined;
            }),
        };
        const recorder = { addArtifact: vi.fn() } as unknown as TraceRecorder;
        const tools = createTestBrowserToolHandlers({
            session: mockSession({ getPage: vi.fn().mockReturnValue(page) }),
            recorder,
            artifactsDir: '/tmp',
            fullPageTileOverlapPx: 20,
            pageStabilizationTimeoutMs: 100,
        });

        const result = await tools.screenshot({ captureTiles: true });

        expect(result.tileCoverage).toMatchObject({
            complete: true,
            documentWidth: 100,
            documentHeight: 250,
            overlapPx: 20,
            tiles: [
                { index: 0, y: 0, width: 100, height: 100, landmark: 'Top story' },
                { index: 1, y: 80, width: 100, height: 100 },
                { index: 2, y: 150, width: 100, height: 100, landmark: 'Latest news' },
            ],
        });
        const tileScreenshots = vi
            .mocked(page.screenshot)
            .mock.calls.map(([options]) => options)
            .filter((options) => options && 'clip' in options);
        expect(tileScreenshots).toEqual([
            {
                fullPage: true,
                clip: { x: 0, y: 0, width: 100, height: 100 },
                scale: 'css',
                timeout: 100,
                type: 'png',
            },
            {
                fullPage: true,
                clip: { x: 0, y: 80, width: 100, height: 100 },
                scale: 'css',
                timeout: 100,
                type: 'png',
            },
            {
                fullPage: true,
                clip: { x: 0, y: 150, width: 100, height: 100 },
                scale: 'css',
                timeout: 100,
                type: 'png',
            },
        ]);
        expect(scrollExpressionCount).toBe(0);
        expect(probeCount).toBe(7);
        expect(probeExpression).toContain('offsetWidth');
        expect(probeExpression).toContain('offsetHeight');
        expect(vi.mocked(recorder.addArtifact).mock.calls.map((call) => call[0].type)).toEqual([
            'screenshot',
            'screenshot-full-page',
            'screenshot-tile',
            'screenshot-tile',
            'screenshot-tile',
        ]);
    });

    it('captures only tiles intersecting a caller-supplied document window', async () => {
        const basePage = mockSession().getPage();
        const page = {
            ...basePage,
            viewportSize: vi.fn().mockReturnValue({ width: 100, height: 100 }),
            evaluate: vi.fn().mockImplementation(async (expression: unknown) => {
                if (
                    typeof expression === 'string' &&
                    expression.includes('__adguard_full_page_tile_probe__')
                ) {
                    return { documentWidth: 100, documentHeight: 450, landmarks: [] };
                }
                return undefined;
            }),
        };
        const recorder = { addArtifact: vi.fn() } as unknown as TraceRecorder;
        const tools = createTestBrowserToolHandlers({
            session: mockSession({ getPage: vi.fn().mockReturnValue(page) }),
            recorder,
            artifactsDir: '/tmp',
            fullPageTileOverlapPx: 20,
            pageStabilizationTimeoutMs: 100,
        });

        const result = await tools.screenshot({
            captureTiles: true,
            tileWindow: { fromY: 85, toY: 165 },
        });

        expect(result.tileCoverage).toMatchObject({
            complete: true,
            window: { fromY: 85, toY: 165 },
        });
        const tileScreenshots = vi
            .mocked(page.screenshot)
            .mock.calls.map(([options]) => options)
            .filter(
                (options): options is NonNullable<typeof options> =>
                    options !== undefined && 'clip' in options,
            );
        expect(tileScreenshots.map((options) => options.clip)).toEqual([
            { x: 0, y: 0, width: 100, height: 100 },
            { x: 0, y: 80, width: 100, height: 100 },
            { x: 0, y: 160, width: 100, height: 100 },
        ]);
        expect(vi.mocked(recorder.addArtifact).mock.calls.map((call) => call[0].type)).toEqual([
            'screenshot',
            'screenshot-full-page',
            'screenshot-tile',
            'screenshot-tile',
            'screenshot-tile',
        ]);
    });

    it('caps the default plan to the first five screens of a long-feed document', async () => {
        const basePage = mockSession().getPage();
        const page = {
            ...basePage,
            viewportSize: vi.fn().mockReturnValue({ width: 100, height: 100 }),
            evaluate: vi.fn().mockImplementation(async (expression: unknown) => {
                if (
                    typeof expression === 'string' &&
                    expression.includes('__adguard_full_page_tile_probe__')
                ) {
                    return { documentWidth: 100, documentHeight: 1250, landmarks: [] };
                }
                return undefined;
            }),
        };
        const recorder = { addArtifact: vi.fn() } as unknown as TraceRecorder;
        const tools = createTestBrowserToolHandlers({
            session: mockSession({ getPage: vi.fn().mockReturnValue(page) }),
            recorder,
            artifactsDir: '/tmp',
            fullPageTileOverlapPx: 20,
            pageStabilizationTimeoutMs: 100,
        });

        const result = await tools.screenshot({ captureTiles: true });

        expect(result.tileCoverage).toMatchObject({
            complete: true,
            documentHeight: 1250,
            window: { fromY: 0, toY: 500 },
            windowDefaulted: true,
        });
        const tileCoverage = result.tileCoverage as FullPageTileCoverage;
        expect(tileCoverage.tiles.length).toBeGreaterThan(0);
        expect(tileCoverage.tiles.every((tile) => tile.y < 500)).toBe(true);
    });

    it('uses an explicit window deep in a long document unchanged, never clipped by the default cap', async () => {
        const basePage = mockSession().getPage();
        const page = {
            ...basePage,
            viewportSize: vi.fn().mockReturnValue({ width: 100, height: 100 }),
            evaluate: vi.fn().mockImplementation(async (expression: unknown) => {
                if (
                    typeof expression === 'string' &&
                    expression.includes('__adguard_full_page_tile_probe__')
                ) {
                    return { documentWidth: 100, documentHeight: 20_000, landmarks: [] };
                }
                return undefined;
            }),
        };
        const recorder = { addArtifact: vi.fn() } as unknown as TraceRecorder;
        const tools = createTestBrowserToolHandlers({
            session: mockSession({ getPage: vi.fn().mockReturnValue(page) }),
            recorder,
            artifactsDir: '/tmp',
            fullPageTileOverlapPx: 20,
            pageStabilizationTimeoutMs: 100,
        });

        const result = await tools.screenshot({
            captureTiles: true,
            tileWindow: { fromY: 15_000, toY: 15_100 },
        });

        expect(result.tileCoverage).toMatchObject({
            complete: true,
            documentHeight: 20_000,
            window: { fromY: 15_000, toY: 15_100 },
        });
        const tileCoverage = result.tileCoverage as FullPageTileCoverage;
        expect(tileCoverage.windowDefaulted).toBeUndefined();
        expect(tileCoverage.tiles.length).toBeGreaterThan(0);
        expect(
            tileCoverage.tiles.every((tile) => tile.y + tile.height > 15_000 && tile.y < 15_100),
        ).toBe(true);
    });

    it('leaves a short document unwindowed, exactly as before the default cap existed', async () => {
        const basePage = mockSession().getPage();
        const page = {
            ...basePage,
            viewportSize: vi.fn().mockReturnValue({ width: 100, height: 100 }),
            evaluate: vi.fn().mockImplementation(async (expression: unknown) => {
                if (
                    typeof expression === 'string' &&
                    expression.includes('__adguard_full_page_tile_probe__')
                ) {
                    return { documentWidth: 100, documentHeight: 250, landmarks: [] };
                }
                return undefined;
            }),
        };
        const recorder = { addArtifact: vi.fn() } as unknown as TraceRecorder;
        const tools = createTestBrowserToolHandlers({
            session: mockSession({ getPage: vi.fn().mockReturnValue(page) }),
            recorder,
            artifactsDir: '/tmp',
            fullPageTileOverlapPx: 20,
            pageStabilizationTimeoutMs: 100,
        });

        const result = await tools.screenshot({ captureTiles: true });

        expect(result.tileCoverage).toMatchObject({
            complete: true,
            documentHeight: 250,
            window: null,
        });
        expect((result.tileCoverage as FullPageTileCoverage).windowDefaulted).toBeUndefined();
    });

    it('retries document clips once after transient ambient dimension drift', async () => {
        const basePage = mockSession().getPage();
        const heights = [250, 250, 220, 220, 220, 220, 220, 220, 220, 220];
        let probeCount = 0;
        const recorder = { addArtifact: vi.fn() } as unknown as TraceRecorder;
        const page = {
            ...basePage,
            viewportSize: vi.fn().mockReturnValue({ width: 100, height: 100 }),
            evaluate: vi.fn().mockImplementation(async (expression: unknown) => {
                if (
                    typeof expression === 'string' &&
                    expression.includes('__adguard_full_page_tile_probe__')
                ) {
                    const documentHeight = heights[probeCount] ?? 220;
                    probeCount += 1;
                    return { documentWidth: 100, documentHeight, landmarks: [] };
                }
                return undefined;
            }),
        };
        const tools = createTestBrowserToolHandlers({
            session: mockSession({ getPage: vi.fn().mockReturnValue(page) }),
            recorder,
            artifactsDir: '/tmp',
            fullPageTileOverlapPx: 20,
        });

        const result = await tools.screenshot({ captureTiles: true });

        expect(result.tileCoverage).toMatchObject({
            complete: true,
            documentHeight: 220,
            tiles: [{ y: 0 }, { y: 80 }, { y: 120 }],
        });
        expect(probeCount).toBe(10);
        const tileScreenshotCount = vi
            .mocked(page.screenshot)
            .mock.calls.filter(([options]) => options && 'clip' in options).length;
        expect(tileScreenshotCount).toBe(4);
        expect(
            vi
                .mocked(recorder.addArtifact)
                .mock.calls.filter(([artifact]) => artifact.type === 'screenshot-tile'),
        ).toHaveLength(3);
    });

    it('fails document clips closed after one retry when dimensions keep drifting', async () => {
        const basePage = mockSession().getPage();
        const heights = [250, 250, 220, 220, 220, 190];
        let probeCount = 0;
        const recorder = { addArtifact: vi.fn() } as unknown as TraceRecorder;
        const page = {
            ...basePage,
            viewportSize: vi.fn().mockReturnValue({ width: 100, height: 100 }),
            evaluate: vi.fn().mockImplementation(async (expression: unknown) => {
                if (
                    typeof expression === 'string' &&
                    expression.includes('__adguard_full_page_tile_probe__')
                ) {
                    const documentHeight = heights[probeCount] ?? 190;
                    probeCount += 1;
                    return { documentWidth: 100, documentHeight, landmarks: [] };
                }
                return undefined;
            }),
        };
        const tools = createTestBrowserToolHandlers({
            session: mockSession({ getPage: vi.fn().mockReturnValue(page) }),
            recorder,
            artifactsDir: '/tmp',
            fullPageTileOverlapPx: 20,
        });

        const result = await tools.screenshot({ captureTiles: true });

        expect(result.tileCoverage).toMatchObject({
            complete: false,
            documentHeight: 220,
            tiles: [],
            error: expect.stringContaining('document dimensions changed'),
        });
        expect(probeCount).toBe(6);
        expect(
            vi
                .mocked(recorder.addArtifact)
                .mock.calls.filter(([artifact]) => artifact.type === 'screenshot-tile'),
        ).toHaveLength(0);
    });

    it('fails document clips closed without retrying a screenshot error', async () => {
        const basePage = mockSession().getPage();
        let probeCount = 0;
        let tileScreenshotCount = 0;
        const recorder = { addArtifact: vi.fn() } as unknown as TraceRecorder;
        const page = {
            ...basePage,
            screenshot: vi.fn().mockImplementation(async (options: { clip?: unknown }) => {
                if (options.clip) {
                    tileScreenshotCount += 1;
                    throw new Error('document clip capture failed');
                }
                return Buffer.from('png');
            }),
            viewportSize: vi.fn().mockReturnValue({ width: 100, height: 100 }),
            evaluate: vi.fn().mockImplementation(async (expression: unknown) => {
                if (
                    typeof expression === 'string' &&
                    expression.includes('__adguard_full_page_tile_probe__')
                ) {
                    probeCount += 1;
                    return { documentWidth: 100, documentHeight: 250, landmarks: [] };
                }
                return undefined;
            }),
        };
        const tools = createTestBrowserToolHandlers({
            session: mockSession({ getPage: vi.fn().mockReturnValue(page) }),
            recorder,
            artifactsDir: '/tmp',
            fullPageTileOverlapPx: 20,
        });

        const result = await tools.screenshot({ captureTiles: true });

        expect(result.tileCoverage).toMatchObject({
            complete: false,
            error: expect.stringContaining('document clip capture failed'),
        });
        expect(probeCount).toBe(2);
        expect(tileScreenshotCount).toBe(1);
        expect(
            vi
                .mocked(recorder.addArtifact)
                .mock.calls.filter(([artifact]) => artifact.type === 'screenshot-tile'),
        ).toHaveLength(0);
    });

    it('fails document clips closed when the page scroll position changes', async () => {
        const basePage = mockSession().getPage();
        const scrollPositions = [0, 0, 2];
        let probeCount = 0;
        const page = {
            ...basePage,
            viewportSize: vi.fn().mockReturnValue({ width: 100, height: 100 }),
            evaluate: vi.fn().mockImplementation(async (expression: unknown) => {
                if (
                    typeof expression === 'string' &&
                    expression.includes('__adguard_full_page_tile_probe__')
                ) {
                    const scrollY = scrollPositions[probeCount] ?? 2;
                    probeCount += 1;
                    return {
                        documentWidth: 100,
                        documentHeight: 100,
                        scrollX: 0,
                        scrollY,
                        landmarks: [],
                    };
                }
                return undefined;
            }),
        };
        const tools = createTestBrowserToolHandlers({
            session: mockSession({ getPage: vi.fn().mockReturnValue(page) }),
            recorder: { addArtifact: vi.fn() } as unknown as TraceRecorder,
            artifactsDir: '/tmp',
        });

        const result = await tools.screenshot({ captureTiles: true });

        expect(result.tileCoverage).toMatchObject({
            complete: false,
            tiles: [],
            error: expect.stringContaining('scroll position changed'),
        });
        expect(probeCount).toBe(3);
    });

    it('fails document clips closed when the Playwright viewport changes', async () => {
        const basePage = mockSession().getPage();
        let viewportProbeCount = 0;
        const page = {
            ...basePage,
            viewportSize: vi.fn().mockImplementation(() => {
                viewportProbeCount += 1;
                return viewportProbeCount <= 2
                    ? { width: 100, height: 100 }
                    : { width: 90, height: 100 };
            }),
            evaluate: vi.fn().mockImplementation(async (expression: unknown) => {
                if (
                    typeof expression === 'string' &&
                    expression.includes('__adguard_full_page_tile_probe__')
                ) {
                    return { documentWidth: 100, documentHeight: 100, landmarks: [] };
                }
                return undefined;
            }),
        };
        const tools = createTestBrowserToolHandlers({
            session: mockSession({ getPage: vi.fn().mockReturnValue(page) }),
            recorder: { addArtifact: vi.fn() } as unknown as TraceRecorder,
            artifactsDir: '/tmp',
        });

        const result = await tools.screenshot({ captureTiles: true });

        expect(result.tileCoverage).toMatchObject({
            complete: false,
            tiles: [],
            error: expect.stringContaining('viewport dimensions changed'),
        });
    });

    it('fails document clips closed when PNG IHDR dimensions do not match the clip', async () => {
        const basePage = mockSession().getPage();
        const recorder = { addArtifact: vi.fn() } as unknown as TraceRecorder;
        const page = {
            ...basePage,
            screenshot: vi
                .fn()
                .mockImplementation(async (options: { clip?: { width: number; height: number } }) =>
                    options.clip
                        ? mockPng(options.clip.width, options.clip.height - 1)
                        : mockPng(1, 1),
                ),
            viewportSize: vi.fn().mockReturnValue({ width: 100, height: 100 }),
            evaluate: vi.fn().mockImplementation(async (expression: unknown) => {
                if (
                    typeof expression === 'string' &&
                    expression.includes('__adguard_full_page_tile_probe__')
                ) {
                    return { documentWidth: 100, documentHeight: 100, landmarks: [] };
                }
                return undefined;
            }),
        };
        const tools = createTestBrowserToolHandlers({
            session: mockSession({ getPage: vi.fn().mockReturnValue(page) }),
            recorder,
            artifactsDir: '/tmp',
        });

        const result = await tools.screenshot({ captureTiles: true });

        expect(result.tileCoverage).toMatchObject({
            complete: false,
            tiles: [],
            error: expect.stringContaining('PNG dimensions did not match'),
        });
        expect(
            vi
                .mocked(recorder.addArtifact)
                .mock.calls.filter(([artifact]) => artifact.type === 'screenshot-tile'),
        ).toHaveLength(0);
    });

    it('does not retry genuinely incomplete tile coverage caused by the configured limit', async () => {
        const basePage = mockSession().getPage();
        let probeCount = 0;
        const page = {
            ...basePage,
            viewportSize: vi.fn().mockReturnValue({ width: 100, height: 100 }),
            evaluate: vi.fn().mockImplementation(async (expression: unknown) => {
                if (
                    typeof expression === 'string' &&
                    expression.includes('__adguard_full_page_tile_probe__')
                ) {
                    probeCount += 1;
                    return {
                        documentWidth: 100,
                        documentHeight: 250,
                        landmarks: [],
                    };
                }
                return undefined;
            }),
        };
        const tools = createTestBrowserToolHandlers({
            session: mockSession({ getPage: vi.fn().mockReturnValue(page) }),
            recorder: { addArtifact: vi.fn() } as unknown as TraceRecorder,
            artifactsDir: '/tmp',
            fullPageTileOverlapPx: 20,
            fullPageTileLimit: 1,
        });

        const result = await tools.screenshot({ captureTiles: true });

        expect(result.tileCoverage).toMatchObject({
            complete: false,
            error: expect.stringContaining('bounded to 1'),
        });
        expect(probeCount).toBe(1);
        expect(
            vi
                .mocked(page.screenshot)
                .mock.calls.filter(([options]) => options && 'clip' in options),
        ).toHaveLength(0);
        expect(page.waitForTimeout).not.toHaveBeenCalled();
    });
});

describe('stabilize_page', () => {
    it('supports a bounded before, target-scroll, and after capture sequence', async () => {
        const page = {
            ...mockSession().getPage(),
            evaluate: vi.fn().mockImplementation(async (expression: unknown) => {
                if (
                    typeof expression === 'string' &&
                    expression.includes('__adguard_scroll_target_probe__')
                ) {
                    return {
                        requested: true,
                        found: true,
                        scrolled: true,
                        matchedBy: 'text_hint',
                    };
                }
                return {
                    readyState: 'complete',
                    htmlLength: 1_024,
                    nodeCount: 20,
                    textLength: 100,
                    scrollHeight: 4_000,
                    scrollY: 2_000,
                    resourceCount: 8,
                    domFingerprint: 'stable-dom',
                };
            }),
        };
        const tools = createTestBrowserToolHandlers({
            session: mockSession({ getPage: vi.fn().mockReturnValue(page) }),
            recorder: { addArtifact: vi.fn() } as unknown as TraceRecorder,
            artifactsDir: '/tmp',
        });

        await tools.screenshot({});
        const stabilization = await tools.stabilize_page?.({ targetHint: 'comments area' });
        await tools.screenshot({});

        expect(stabilization).toMatchObject({
            status: 'stable',
            targetFound: true,
            targetScrolled: true,
            targetMatchedBy: 'text_hint',
        });
        const evaluateMock = vi.mocked(page.evaluate);
        const screenshotMock = vi.mocked(page.screenshot);
        const targetCallIndex = evaluateMock.mock.calls.findIndex(
            ([expression]) =>
                typeof expression === 'string' &&
                expression.includes('__adguard_scroll_target_probe__'),
        );
        const targetCallOrder = evaluateMock.mock.invocationCallOrder[targetCallIndex];
        expect(screenshotMock).toHaveBeenCalledTimes(4);
        expect(screenshotMock.mock.invocationCallOrder[1]).toBeLessThan(targetCallOrder);
        expect(targetCallOrder).toBeLessThan(screenshotMock.mock.invocationCallOrder[2]);
    });
});

describe('get_network_log', () => {
    it('returns request count and ad requests', async () => {
        const session = mockSession({
            getNetworkLog: vi.fn().mockReturnValue([
                {
                    url: 'https://example.com/',
                    method: 'GET',
                    resourceType: 'document',
                    statusCode: 200,
                    requestHeaders: {},
                    responseHeaders: {},
                },
                {
                    url: 'https://ad.doubleclick.net/ad',
                    method: 'GET',
                    resourceType: 'image',
                    statusCode: 200,
                    requestHeaders: {},
                    responseHeaders: {},
                },
            ]),
        });
        const tools = createTestBrowserToolHandlers({
            session,
            recorder: { addArtifact: vi.fn() } as unknown as TraceRecorder,
            artifactsDir: '/tmp',
        });
        const result = await tools.get_network_log({});
        expect(result.requestCount).toBe(2);
        // Every request reaches the model, page document included — not just ad-looking URLs.
        expect(result.requests).toHaveLength(2);
        expect(result.evidenceRef).toBe(`artifact:har:${String(result.artifactId)}`);
    });
});

describe('reset_network_log', () => {
    it('clears the session network log without creating an artifact', async () => {
        const session = mockSession();
        const recorder = { addArtifact: vi.fn() } as unknown as TraceRecorder;
        const tools = createTestBrowserToolHandlers({
            session,
            recorder,
            artifactsDir: '/tmp',
        });

        const result = await tools.reset_network_log({});

        expect(session.resetNetworkLog).toHaveBeenCalledOnce();
        expect(recorder.addArtifact).not.toHaveBeenCalled();
        expect(result).toEqual({ reset: true });
    });
});

describe('get_console_log', () => {
    it('returns the messages with the coverage the session declares for them', async () => {
        const messages = [
            { type: 'error', text: 'Failed to load resource: net::ERR_BLOCKED_BY_CLIENT' },
        ];
        const tools = createTestBrowserToolHandlers({
            session: mockSession({
                consoleCoverage: ConsoleCoverage.PageConsole,
                getConsoleLog: vi.fn().mockReturnValue(messages),
            }),
            recorder: { addArtifact: vi.fn() } as unknown as TraceRecorder,
            artifactsDir: '/tmp',
        });

        const result = await tools.get_console_log({});

        expect(result).toEqual({ consoleCoverage: ConsoleCoverage.PageConsole, messages });
    });
});
