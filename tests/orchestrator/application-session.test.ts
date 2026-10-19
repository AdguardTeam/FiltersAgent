import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright-core';
import { ToolName } from '../../src/agent/tool-names';
import { ConsoleCoverage, type IBrowserSession } from '../../src/browser/browser-interfaces';
import { buildApplicationToolSet } from '../../src/orchestrator/application-session';
import type { AdaptedToolInput } from '../../src/pi/session-tools';
import type { TraceRecorder } from '../../src/tracer/trace-recorder';
import { BrowserFallbackReason } from '../../src/types/browser-fallback-reason';

const SURFACE_URL = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/pages/options.html';

const SURFACE_SUBPATH_URL = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/pages/rules.html';

const OTHER_EXTENSION_URL =
    'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/pages/options.html';

/**
 * A URL matcher installed through `page.route`; the tool set installs its continuation predicate.
 */
type RouteUrlMatcher = (url: URL) => boolean;

/**
 * A route handler installed through `page.route`; recorded so an install stays whole.
 */
type RouteHandler = (route: unknown) => unknown;

/**
 * One route install the fake page recorded.
 */
interface RecordedRoute {
    /**
     * The URL matcher handed to `page.route`.
     */
    matcher: RouteUrlMatcher;

    /**
     * The handler paired with the matcher.
     */
    handler: RouteHandler;
}

/**
 * The route installs, navigations, and runtime messages one fake page recorded.
 */
interface RecordedPageCalls {
    /**
     * Routes installed through `page.route`, in install order.
     */
    routes: RecordedRoute[];

    /**
     * URLs handed to `page.goto`.
     */
    navigations: string[];

    /**
     * Runtime messages the fake page received through `page.evaluate`.
     */
    messages: unknown[];
}

/**
 * Build the phase lease session fake whose page records route installs, navigations, and messages.
 *
 * @param recorded - Collector the fake page appends every route install, navigation, and message
 *   to.
 * @param pageUrl - URL the fake page reports as current; defaults to the prepared surface.
 * @returns The fake session over one recording page.
 */
function fakeSession(recorded: RecordedPageCalls, pageUrl: string = SURFACE_URL): IBrowserSession {
    const page = {
        route: vi.fn(async (matcher: RouteUrlMatcher, handler: RouteHandler) => {
            recorded.routes.push({ matcher, handler });
        }),
        goto: vi.fn(async (url: string) => {
            recorded.navigations.push(url);
            return { status: () => 200 };
        }),
        evaluate: vi.fn(async (...evaluateArgs: unknown[]) => {
            recorded.messages.push(evaluateArgs[1]);
            return true;
        }),
        url: vi.fn(() => pageUrl),
        title: vi.fn(async () => 'Options'),
    };
    return {
        getPage: () => page as unknown as Page,
        close: vi.fn(async () => undefined),
        getNetworkLog: vi.fn(() => []),
        resetNetworkLog: vi.fn(),
        getConsoleLog: vi.fn(() => []),
        consoleCoverage: ConsoleCoverage.BrowserLogOnly,
        artifactsDir: '/tmp/application-session-test',
        isClosed: false,
    };
}

/**
 * Build the application tool set over one recording fake session.
 *
 * @param recorded - Collector the fake page appends every route install, navigation, and message
 *   to.
 * @param pageUrl - URL the fake page reports as current; defaults to the prepared surface.
 * @returns The tool set's inputs and host-recorded action log.
 */
function toolSetOf(
    recorded: RecordedPageCalls,
    pageUrl: string = SURFACE_URL,
): ReturnType<typeof buildApplicationToolSet> {
    return buildApplicationToolSet(
        {
            session: fakeSession(recorded, pageUrl),
            recorder: { addArtifact: vi.fn() } as unknown as TraceRecorder,
            allowedOrigin: 'https://example.com',
            blockerSurfaceUrl: SURFACE_URL,
        },
        { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    );
}

/**
 * Resolve one tool input of the application tool set over one recording fake session.
 *
 * @param recorded - Collector the fake page appends every route install, navigation, and message
 *   to.
 * @param name - Tool name to resolve.
 * @param pageUrl - URL the fake page reports as current; defaults to the prepared surface.
 * @returns The resolved adapted tool input.
 */
function toolOf(
    recorded: RecordedPageCalls,
    name: ToolName,
    pageUrl: string = SURFACE_URL,
): AdaptedToolInput {
    const tool = toolSetOf(recorded, pageUrl).inputs.find((input) => input.name === name);
    if (tool === undefined) {
        throw new Error(`the application tool set carries no ${name} tool`);
    }
    return tool;
}

describe('application-session open_page admission', () => {
    it('refuses a navigation whose protocol or host does not match the prepared surface', async () => {
        const recorded: RecordedPageCalls = { routes: [], navigations: [], messages: [] };
        const execute = toolOf(recorded, ToolName.OpenPage).execute;

        for (const url of [
            'file:///etc/passwd',
            'data:text/html,<p>hello</p>',
            OTHER_EXTENSION_URL,
            'not a url',
        ]) {
            const result = await execute({ url }, undefined);
            expect(result.fallbackReason).toBe(BrowserFallbackReason.UnsafeTargetUrl);
        }

        expect(recorded.navigations).toEqual([]);
        expect(recorded.routes).toEqual([]);
    });

    it('admits the prepared surface and a sub-path of it with the protocol-host continuation route', async () => {
        const recorded: RecordedPageCalls = { routes: [], navigations: [], messages: [] };
        const execute = toolOf(recorded, ToolName.OpenPage).execute;

        const surfaceResult = await execute({ url: SURFACE_URL }, undefined);
        const subPathResult = await execute({ url: SURFACE_SUBPATH_URL }, undefined);

        expect(surfaceResult.error).toBeUndefined();
        expect(surfaceResult.statusCode).toBe(200);
        expect(subPathResult.error).toBeUndefined();
        expect(recorded.navigations).toEqual([SURFACE_URL, SURFACE_SUBPATH_URL]);
        expect(recorded.routes).toHaveLength(2);
        for (const { matcher } of recorded.routes) {
            expect(matcher(new URL(SURFACE_URL))).toBe(true);
            expect(matcher(new URL(SURFACE_SUBPATH_URL))).toBe(true);
            expect(matcher(new URL(OTHER_EXTENSION_URL))).toBe(false);
        }
    });

    it('settles a surface request whose browser closed before the continuation', async () => {
        const recorded: RecordedPageCalls = { routes: [], navigations: [], messages: [] };
        await toolOf(recorded, ToolName.OpenPage).execute({ url: SURFACE_URL }, undefined);
        const closedRoute = {
            continue: vi.fn(async () => {
                throw new Error('route.continue: Target page, context or browser has been closed');
            }),
        };

        await expect(recorded.routes[0].handler(closedRoute)).resolves.toBeUndefined();
    });
});

describe('application-session send_extension_message admission', () => {
    it('refuses a message from a page that is not the prepared surface', async () => {
        const recorded: RecordedPageCalls = { routes: [], navigations: [], messages: [] };
        const toolSet = toolSetOf(recorded, 'https://example.com/article');
        const execute = toolSet.inputs.find(
            (input) => input.name === ToolName.SendExtensionMessage,
        )!.execute;

        const result = await execute({ type: 'getIsAppInitialized' }, undefined);

        expect(result.error).toContain('prepared blocker management surface');
        // The refusal happens before any transport call, and the host trace records it.
        expect(recorded.messages).toEqual([]);
        expect(toolSet.recordedActionLog()).toEqual([
            {
                tool: ToolName.SendExtensionMessage,
                ok: false,
                summary: expect.stringContaining('message blocked'),
            },
        ]);
    });

    it('sends the accepted message from the surface page and records it in the action log', async () => {
        const recorded: RecordedPageCalls = { routes: [], navigations: [], messages: [] };
        const toolSet = toolSetOf(recorded);
        const execute = toolSet.inputs.find(
            (input) => input.name === ToolName.SendExtensionMessage,
        )!.execute;

        const result = await execute(
            { type: 'applySettingsJson', data: { json: '{"filters":{"enabled-filters":[2]}}' } },
            undefined,
        );

        expect(result).toEqual({ response: true });
        expect(recorded.messages).toEqual([
            {
                handlerName: 'app',
                type: 'applySettingsJson',
                data: { json: '{"filters":{"enabled-filters":[2]}}' },
            },
        ]);
        expect(toolSet.recordedActionLog()).toEqual([
            {
                tool: ToolName.SendExtensionMessage,
                ok: true,
                summary: '{"response":true}',
            },
        ]);
    });
});

describe('application-session tool surface', () => {
    it('never offers evaluate_js: the declared write channel and the read tools cover every step', () => {
        const recorded: RecordedPageCalls = { routes: [], navigations: [], messages: [] };

        const toolSet = toolSetOf(recorded);

        expect(toolSet.inputs.some((input) => input.name === ToolName.EvaluateJs)).toBe(false);
    });
});
