import type { Page } from 'playwright-core';
import { createLogger, type Logger } from '../logger/logger';

/**
 * Render a CDP `Runtime.ExceptionDetails` record as the one line a failure log needs.
 *
 * `text` alone is nearly always the bare word "Uncaught": the thrown value lives in
 * `exception.description` (for an Error, its name, message and stack) and the location in
 * `lineNumber`/`columnNumber`. Logging `text` alone turns a failed safe-interaction click into
 * "Trusted page evaluation failed: Uncaught" with `failureDetail: unknown`, which names nothing
 * about what the page threw.
 *
 * @param exception - The `exceptionDetails` record of a `Runtime.evaluate` response.
 * @returns The thrown value's description (first line) with the text and location, when present.
 */
function describeRuntimeException(exception: Record<string, unknown>): string {
    const text = typeof exception.text === 'string' ? exception.text : 'unknown error';
    const thrown =
        typeof exception.exception === 'object' && exception.exception !== null
            ? (exception.exception as Record<string, unknown>)
            : undefined;
    const description =
        typeof thrown?.description === 'string'
            ? thrown.description.split('\n', 1)[0]
            : typeof thrown?.value === 'string'
              ? thrown.value
              : undefined;
    const location =
        typeof exception.lineNumber === 'number'
            ? ` at line ${exception.lineNumber}` +
              (typeof exception.columnNumber === 'number' ? `:${exception.columnNumber}` : '')
            : '';
    return description === undefined ? `${text}${location}` : `${text}: ${description}${location}`;
}

/**
 * Stable isolated-world name used only for deterministic validation probes.
 */
const VALIDATION_WORLD_NAME = 'adguard-filter-agent-validation';

/**
 * Diagnostic message emitted when the CDP capability probe fails and evaluation degrades to the
 * page's main world. The caught error travels next to it, so the run log shows why the family fell
 * back instead of looking silent.
 */
const CDP_PROBE_DEGRADED_MESSAGE =
    'CDP is unavailable for this page; trusted evaluation degrades to the main world';

/**
 * Options for creating a trusted page evaluator.
 */
export interface TrustedPageEvaluatorOptions {
    /**
     * Logger for the diagnostic line emitted when the CDP capability probe fails and the evaluator
     * degrades to the page's main world. Defaults to the standard app logger.
     */
    logger?: Logger;
}

/**
 * Minimal CDP session surface needed by isolated-world evaluation.
 */
interface CdpSessionLike {
    /**
     * Send one Chrome DevTools Protocol command.
     *
     * @param method - Fully qualified CDP method name.
     * @param params - Optional serializable command parameters.
     * @returns Raw CDP response payload.
     */
    send(method: string, params?: Record<string, unknown>): Promise<unknown>;

    /**
     * Detach this short-lived session from the page target.
     *
     * @returns A promise resolved after detachment.
     */
    detach(): Promise<void>;
}

/**
 * Page evaluator whose JavaScript realm is outside the website's main world.
 */
export interface TrustedPageEvaluator {
    /**
     * Evaluate an expression in a newly resolved isolated world for the current main frame.
     *
     * @param expression - Self-contained JavaScript expression returning JSON-serializable data.
     * @returns The expression's by-value result.
     */
    evaluate(expression: string): Promise<unknown>;
}

/**
 * Convert an unknown CDP response to a record or fail closed.
 *
 * @param value - Raw CDP response value.
 * @param label - Human-readable response label for diagnostics.
 * @returns Record-shaped response.
 */
function requireRecord(value: unknown, label: string): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`Trusted page evaluation received an invalid ${label}.`);
    }
    return value as Record<string, unknown>;
}

/**
 * Chromium CDP evaluator that creates an isolated world against the current main-frame document for
 * every probe. A new short-lived CDP session prevents stale execution-context IDs after page
 * navigation and ensures the website's main-world monkeypatches are never consulted.
 */
class CdpIsolatedWorldEvaluator implements TrustedPageEvaluator {
    constructor(private readonly page: Page) {}

    /**
     * Evaluate an expression through Runtime.evaluate in the current document's isolated world.
     *
     * @param expression - Self-contained JavaScript expression returning JSON-serializable data.
     * @returns The expression's by-value result.
     */
    async evaluate(expression: string): Promise<unknown> {
        const session = (await this.page
            .context()
            .newCDPSession(this.page)) as unknown as CdpSessionLike;
        try {
            await session.send('Page.enable');
            await session.send('Runtime.enable');

            const frameTreeResponse = requireRecord(
                await session.send('Page.getFrameTree'),
                'main-frame tree',
            );
            const frameTree = requireRecord(frameTreeResponse.frameTree, 'main-frame tree');
            const frame = requireRecord(frameTree.frame, 'main-frame descriptor');
            if (typeof frame.id !== 'string' || frame.id.length === 0) {
                throw new Error(
                    'Trusted page evaluation could not resolve the current main frame.',
                );
            }

            const worldResponse = requireRecord(
                await session.send('Page.createIsolatedWorld', {
                    frameId: frame.id,
                    worldName: VALIDATION_WORLD_NAME,
                    grantUniveralAccess: false,
                }),
                'isolated-world response',
            );
            if (
                typeof worldResponse.executionContextId !== 'number' ||
                !Number.isInteger(worldResponse.executionContextId)
            ) {
                throw new Error(
                    'Trusted page evaluation could not create an isolated execution context.',
                );
            }

            const evaluationResponse = requireRecord(
                await session.send('Runtime.evaluate', {
                    expression,
                    contextId: worldResponse.executionContextId,
                    awaitPromise: true,
                    returnByValue: true,
                    userGesture: false,
                }),
                'Runtime.evaluate response',
            );
            if (evaluationResponse.exceptionDetails !== undefined) {
                throw new Error(
                    'Trusted page evaluation failed: ' +
                        describeRuntimeException(
                            requireRecord(evaluationResponse.exceptionDetails, 'Runtime exception'),
                        ),
                );
            }

            const remoteObject = requireRecord(evaluationResponse.result, 'Runtime remote object');
            if (!Object.prototype.hasOwnProperty.call(remoteObject, 'value')) {
                throw new Error(
                    'Trusted page evaluation did not produce a return-by-value result.',
                );
            }
            return remoteObject.value;
        } finally {
            await session.detach();
        }
    }
}

/**
 * Create a Chromium isolated-world evaluator for deterministic validation probes.
 *
 * @param page - Current Playwright Chromium page.
 * @returns Trusted evaluator that resolves a fresh current-document world per call.
 */
export function createCdpIsolatedWorldEvaluator(page: Page): TrustedPageEvaluator {
    return new CdpIsolatedWorldEvaluator(page);
}

/**
 * Main-world evaluator for browser families without CDP (Firefox).
 *
 * The expression runs in the website's main world, so the isolated-world anti-tamper hardening is
 * degraded: the page's own scripts observe (and could interfere with) the probe. This is the
 * accepted Firefox trade-off — no isolated-world channel exists — and is recorded in the module
 * documentation.
 */
class MainWorldEvaluator implements TrustedPageEvaluator {
    constructor(private readonly page: Page) {}

    /**
     * Evaluate an expression in the current page's main world.
     *
     * @param expression - Self-contained JavaScript expression returning JSON-serializable data.
     * @returns The expression's by-value result.
     */
    async evaluate(expression: string): Promise<unknown> {
        return await this.page.evaluate(expression);
    }
}

/**
 * The capability probes already answered, one per browser context.
 *
 * A context's browser family cannot change, and every trusted evaluation builds its evaluator anew:
 * probing each time only repeated the same refusal — 16 to 39 identical warn lines a Firefox run.
 * The promise is cached, so concurrent first evaluations share one probe too.
 */
const cdpSupportByContext = new WeakMap<object, Promise<boolean>>();

/**
 * Detect whether this page belongs to a CDP-capable (Chromium) family.
 *
 * The probe opens one CDP session and detaches it; non-Chromium families reject the operation. A
 * rejected probe is always logged before the fallback is chosen, so a Firefox run (or an unexpected
 * Chromium capability failure) is diagnosable from the log alone.
 *
 * @param page - Active Playwright page.
 * @param logger - Logger for the degradation diagnostic.
 * @returns Whether isolated-world evaluation is available for this page.
 */
async function cdpSessionSupported(page: Page, logger: Logger): Promise<boolean> {
    let context: object;
    try {
        context = page.context();
    } catch {
        // A page that exposes no context at all has no CDP either; the probe says so, with its
        // own diagnostic, exactly as it did before the answer was cached.
        return probeCdpSession(page, logger);
    }
    const known = cdpSupportByContext.get(context);
    if (known !== undefined) {
        return known;
    }
    const probed = probeCdpSession(page, logger);
    cdpSupportByContext.set(context, probed);
    return probed;
}

/**
 * Open and detach one CDP session to learn whether the context's browser speaks CDP.
 *
 * @param page - Active Playwright page.
 * @param logger - Logger for the degradation diagnostic.
 * @returns Whether a CDP session could be opened for this page.
 */
async function probeCdpSession(page: Page, logger: Logger): Promise<boolean> {
    try {
        const session = (await page.context().newCDPSession(page)) as unknown as CdpSessionLike;
        await session.detach();
        return true;
    } catch (error) {
        logger.warn({ err: error }, CDP_PROBE_DEGRADED_MESSAGE);
        return false;
    }
}

/**
 * Create the trusted evaluator this page's browser family supports.
 *
 * Chromium (CDP available) keeps the isolated-world evaluator unchanged; Firefox falls back to
 * main-world evaluation, and the degradation is logged with the caught error before the fallback.
 * The family is fixed for the page, so no call ever silently switches worlds after the factory's
 * decision.
 *
 * @param page - Active Playwright page.
 * @param options - Optional evaluator options; the logger for the degradation diagnostic.
 * @returns Trusted evaluator for the page's browser family.
 */
export async function createTrustedPageEvaluator(
    page: Page,
    options: TrustedPageEvaluatorOptions = {},
): Promise<TrustedPageEvaluator> {
    const logger = options.logger ?? createLogger();
    if (await cdpSessionSupported(page, logger)) {
        return new CdpIsolatedWorldEvaluator(page);
    }
    return new MainWorldEvaluator(page);
}
