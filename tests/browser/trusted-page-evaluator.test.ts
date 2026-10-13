import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright-core';
import type { Logger } from 'pino';
import {
    createCdpIsolatedWorldEvaluator,
    createTrustedPageEvaluator,
} from '../../src/browser/trusted-page-evaluator';

/**
 * One warn entry captured by the sink below: the structured fields next to the message.
 */
interface CapturedWarn {
    /**
     * Structured fields of the warn line (for example the caught error).
     */
    fields: unknown;

    /**
     * The message text.
     */
    message: string;
}

/**
 * Create one capturing sink standing in for the pino logger, so a test can assert that the
 * evaluator logged a degradation instead of silently swallowing it (AGLint test-sink pattern).
 *
 * @returns The pino-compatible sink cast and the captured warn entries.
 */
function createCapturingLogger(): { logger: Logger; warns: CapturedWarn[] } {
    const warns: CapturedWarn[] = [];
    const sink = {
        info: () => undefined,
        warn: (fields: unknown, message: string) => warns.push({ fields, message }),
        error: () => undefined,
    };
    return { logger: sink as unknown as Logger, warns };
}

function mockPage(options?: {
    runtimeResult?: unknown;
    runtimeException?: unknown;
    createWorldResult?: unknown;
}): {
    page: Page;
    send: ReturnType<typeof vi.fn>;
    detach: ReturnType<typeof vi.fn>;
    newCDPSession: ReturnType<typeof vi.fn>;
    pageEvaluate: ReturnType<typeof vi.fn>;
} {
    const send = vi.fn(async (method: string) => {
        if (method === 'Page.getFrameTree') {
            return { frameTree: { frame: { id: 'main-frame', url: 'https://example.com/' } } };
        }
        if (method === 'Page.createIsolatedWorld') {
            return options?.createWorldResult ?? { executionContextId: 73 };
        }
        if (method === 'Runtime.evaluate') {
            return {
                result: options?.runtimeResult ?? { type: 'string', value: 'trusted-result' },
                exceptionDetails: options?.runtimeException,
            };
        }
        return {};
    });
    const detach = vi.fn().mockResolvedValue(undefined);
    const newCDPSession = vi.fn().mockResolvedValue({ send, detach });
    const pageEvaluate = vi.fn().mockResolvedValue('forged-main-world-result');
    const page = {
        context: () => ({ newCDPSession }),
        evaluate: pageEvaluate,
    } as unknown as Page;
    return { page, send, detach, newCDPSession, pageEvaluate };
}

describe('createCdpIsolatedWorldEvaluator', () => {
    it('evaluates in an isolated world for the current main-frame document', async () => {
        const { page, send, detach, newCDPSession, pageEvaluate } = mockPage();
        const evaluator = createCdpIsolatedWorldEvaluator(page);

        await expect(evaluator.evaluate('document.title')).resolves.toBe('trusted-result');

        expect(newCDPSession).toHaveBeenCalledWith(page);
        expect(send).toHaveBeenCalledWith('Page.createIsolatedWorld', {
            frameId: 'main-frame',
            worldName: 'adguard-filter-agent-validation',
            grantUniveralAccess: false,
        });
        expect(send).toHaveBeenCalledWith('Runtime.evaluate', {
            expression: 'document.title',
            contextId: 73,
            awaitPromise: true,
            returnByValue: true,
            userGesture: false,
        });
        expect(pageEvaluate).not.toHaveBeenCalled();
        expect(detach).toHaveBeenCalledOnce();
    });

    it('resolves the current main frame and creates a fresh world for every evaluation', async () => {
        const { page, send, newCDPSession } = mockPage();
        const evaluator = createCdpIsolatedWorldEvaluator(page);

        await evaluator.evaluate('1');
        await evaluator.evaluate('2');

        expect(newCDPSession).toHaveBeenCalledTimes(2);
        expect(send.mock.calls.filter(([method]) => method === 'Page.getFrameTree')).toHaveLength(
            2,
        );
        expect(
            send.mock.calls.filter(([method]) => method === 'Page.createIsolatedWorld'),
        ).toHaveLength(2);
    });

    it('rejects Runtime exceptions instead of accepting hostile-page output', async () => {
        const { page, detach } = mockPage({
            runtimeException: { text: 'Uncaught', exceptionId: 1 },
        });
        const evaluator = createCdpIsolatedWorldEvaluator(page);

        await expect(evaluator.evaluate('document.body')).rejects.toThrow('Uncaught');
        expect(detach).toHaveBeenCalledOnce();
    });

    it('names what the page threw, not just that it threw', async () => {
        // CDP puts the thrown Error in exception.description (name, message, then the stack);
        // `text` is the bare "Uncaught". The failure must carry the message and the location.
        const { page } = mockPage({
            runtimeException: {
                text: 'Uncaught',
                exceptionId: 2,
                lineNumber: 41,
                columnNumber: 7,
                exception: {
                    type: 'object',
                    subtype: 'error',
                    className: 'TypeError',
                    description:
                        "TypeError: Cannot read properties of null (reading 'click')\n" +
                        '    at eval (eval at evaluate:1:1)',
                },
            },
        });
        const evaluator = createCdpIsolatedWorldEvaluator(page);

        await expect(evaluator.evaluate('document.body')).rejects.toThrow(
            "Uncaught: TypeError: Cannot read properties of null (reading 'click') at line 41:7",
        );
    });

    it('rejects a missing isolated-world execution context', async () => {
        const { page, detach } = mockPage({ createWorldResult: {} });
        const evaluator = createCdpIsolatedWorldEvaluator(page);

        await expect(evaluator.evaluate('document.body')).rejects.toThrow('execution context');
        expect(detach).toHaveBeenCalledOnce();
    });

    it('rejects a non-serializable or missing return value', async () => {
        const { page } = mockPage({ runtimeResult: { type: 'undefined' } });
        const evaluator = createCdpIsolatedWorldEvaluator(page);

        await expect(evaluator.evaluate('document.body')).rejects.toThrow('return-by-value');
    });
});

describe('createTrustedPageEvaluator', () => {
    it('logs the degradation and falls back to main-world evaluation when CDP sessions are unavailable', async () => {
        const newCDPSession = vi.fn().mockRejectedValue(new Error('CDP is not supported here'));
        const pageEvaluate = vi.fn().mockImplementation(async (expression: unknown) => {
            if (expression === '1 + 1') {
                return 2;
            }
            return undefined;
        });
        const page = {
            context: () => ({ newCDPSession }),
            evaluate: pageEvaluate,
        } as unknown as Page;
        const { logger, warns } = createCapturingLogger();

        const evaluator = await createTrustedPageEvaluator(page, { logger });
        await expect(evaluator.evaluate('1 + 1')).resolves.toBe(2);

        expect(newCDPSession).toHaveBeenCalledTimes(1);
        expect(pageEvaluate).toHaveBeenCalledWith('1 + 1');

        expect(warns).toHaveLength(1);
        const firstWarn = warns[0];
        if (!firstWarn) {
            throw new Error('expected exactly one captured warn entry');
        }
        expect(firstWarn.message).toContain('degrades to the main world');
        expect((firstWarn.fields as { err: Error }).err.message).toBe('CDP is not supported here');
    });

    it('keeps isolated-world evaluation when CDP sessions work', async () => {
        const { page, pageEvaluate, newCDPSession } = mockPage();
        const evaluator = await createTrustedPageEvaluator(page);

        await expect(evaluator.evaluate('document.title')).resolves.toBe('trusted-result');

        // One CDP session for the family probe plus one for the actual evaluation.
        expect(newCDPSession).toHaveBeenCalledTimes(2);
        expect(pageEvaluate).not.toHaveBeenCalled();
    });
});
