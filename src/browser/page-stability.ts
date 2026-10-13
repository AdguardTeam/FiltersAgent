import type { IBrowserSession } from './browser-interfaces';
import type { ValidationViewportPosition } from '../types/validation';
import { createTrustedPageEvaluator } from './trusted-page-evaluator';
import { TargetMatchedBy } from '../environment/safe-interaction';

/**
 * Page stability probing and target scrolling used before evidence capture.
 */
/**
 * Bounded target used to reveal lazy content before a browser capture.
 */
export interface PageStabilizationTarget {
    /**
     * CSS selector for the reported area, truncated before it reaches the page.
     */
    selector?: string;

    /**
     * Human-readable text expected near the reported area.
     */
    textHint?: string;
}

/**
 * Options for an event-driven DOM/network stabilization pass.
 */
export interface PageStabilizationOptions {
    /**
     * Shared hard budget for the pass, capped at 15 seconds.
     */
    timeoutMs?: number;

    /**
     * Interval between bounded state probes.
     */
    pollMs?: number;

    /**
     * Required period with matching DOM and network state.
     */
    quietMs?: number;

    /**
     * Optional reported area that should be scrolled into view before the final stable state.
     */
    target?: PageStabilizationTarget;
}

/**
 * Evidence returned after a bounded page stabilization pass.
 */
export interface PageStabilizationEvidence {
    /**
     * Whether a stable capture point was proven before the budget expired.
     */
    status: 'stable' | 'timed_out';

    /**
     * Number of DOM/network samples inspected during the pass.
     */
    sampleCount: number;

    /**
     * Bounded time budget consumed by the probes.
     */
    elapsedMs: number;

    /**
     * Number of completed network entries present in the final sample.
     */
    networkEntryCount: number;

    /**
     * Whether a bounded selector or text hint was provided.
     */
    targetRequested: boolean;

    /**
     * Whether the requested target was found in the live DOM.
     */
    targetFound: boolean;

    /**
     * Whether the target was scrolled into view.
     */
    targetScrolled: boolean;

    /**
     * Signal that matched the target when one was found.
     */
    targetMatchedBy?: TargetMatchedBy;

    /**
     * Bounded technical detail when stability could not be proven.
     */
    detail?: string;
}

/**
 * Hard upper bound for one navigation-and-stabilization attempt.
 *
 * Forty-five seconds, because a heavy news site can miss a 15s `domcontentloaded` even when the
 * proxy answers in under a second and a direct navigation finishes in 1.4s: an ad-laden article
 * with dozens of third-party requests is slow to settle. A run that gives up early reports an
 * unreachable target for a site that is merely slow, which is a worse error than waiting.
 */
export const MAX_PAGE_STABILIZATION_TIMEOUT_MS = 45_000;

/**
 * Default interval between page stability samples.
 */
export const DEFAULT_PAGE_STABILITY_POLL_MS = 250;

/**
 * Default quiet window required before a capture is considered stable.
 */
export const DEFAULT_PAGE_STABILITY_QUIET_MS = 750;

/**
 * Maximum accepted CSS selector length for a capture target.
 */
export const MAX_TARGET_SELECTOR_LENGTH = 500;

/**
 * Maximum accepted human-readable target hint length.
 */
export const MAX_TARGET_HINT_LENGTH = 200;

/**
 * Fixed read-only page expression used to sample DOM state for capture stabilization.
 */
const PAGE_STABILITY_STATE_PROBE = `
(function () {
    var marker = '__adguard_page_stability_probe__';
    var root = document.documentElement;
    var body = document.body;
    var elements = Array.prototype.slice.call(document.querySelectorAll('body *'), -64);
    var tail = elements.map(function (element) {
        return String(element.tagName) + ':' + String(element.id) + ':' +
            String(element.className);
    }).join('|');
    var boundedContent = String(body && body.textContent || '').slice(0, 2048) + '|' + tail;
    var hash = 2166136261;
    for (var index = 0; index < boundedContent.length; index += 1) {
        hash ^= boundedContent.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return {
        marker: marker,
        readyState: document.readyState,
        htmlLength: root ? root.innerHTML.length : 0,
        nodeCount: document.getElementsByTagName('*').length,
        textLength: body ? body.innerText.length : 0,
        scrollHeight: root ? root.scrollHeight : 0,
        scrollY: Math.max(0, Number(window.scrollY) || 0),
        resourceCount: performance.getEntriesByType('resource').length,
        domFingerprint: (hash >>> 0).toString(16),
    };
})()
`;

/**
 * Bounded DOM state sampled inside the page without returning page content.
 */
interface PageStabilitySnapshot {
    /**
     * Current document readiness state.
     */
    readyState: string;

    /**
     * Serialized document element length.
     */
    htmlLength: number;

    /**
     * Number of elements currently present in the DOM.
     */
    nodeCount: number;

    /**
     * Length of the current body text.
     */
    textLength: number;

    /**
     * Current page scroll height.
     */
    scrollHeight: number;

    /**
     * Current vertical viewport position.
     */
    scrollY: number;

    /**
     * Number of completed resource timing entries.
     */
    resourceCount: number;

    /**
     * Bounded non-reversible signature of representative DOM content.
     */
    domFingerprint: string;
}

/**
 * Shared mutable budget used across the initial and post-scroll stability phases.
 */
interface PageStabilityBudget {
    /**
     * Original bounded pass duration.
     */
    initialMs: number;

    /**
     * Remaining virtual and wall-clock budget.
     */
    remainingMs: number;

    /**
     * Wall-clock deadline that protects against slow probes.
     */
    deadline: number;
}

/**
 * Internal result of one stable-state wait phase.
 */
interface PageStabilityPhaseResult {
    /**
     * Whether enough consecutive matching samples were observed.
     */
    stable: boolean;

    /**
     * Number of samples read during this phase.
     */
    sampleCount: number;

    /**
     * Completed network entry count in the final sample.
     */
    networkEntryCount: number;
}

/**
 * Internal comparison key paired with its completed request count.
 */
interface PageStabilityKeyResult {
    /**
     * Combined bounded DOM and network state key.
     */
    key: string;

    /**
     * Completed request count represented by the key.
     */
    networkEntryCount: number;
}

/**
 * Result of a bounded target lookup and scroll operation.
 */
interface PageTargetScrollResult {
    /**
     * Whether a target signal was provided.
     */
    requested: boolean;

    /**
     * Whether a matching element was found.
     */
    found: boolean;

    /**
     * Whether the matching element was scrolled into view.
     */
    scrolled: boolean;

    /**
     * Signal that matched the live element.
     */
    matchedBy?: TargetMatchedBy;
}

/**
 * Isolated-world probe that waits for a stable viewport position before or after capture.
 */
const VIEWPORT_STABILITY_PROBE = `
(async function () {
    var readPosition = function () {
        return {
            x: Math.max(0, Number(window.scrollX) || 0),
            y: Math.max(0, Number(window.scrollY) || 0),
        };
    };
    var waitForFrame = function () {
        return new Promise(function (resolve) {
            var settled = false;
            var finish = function () {
                if (settled) return;
                settled = true;
                resolve();
            };
            requestAnimationFrame(function () { requestAnimationFrame(finish); });
            setTimeout(finish, 100);
        });
    };
    var before = readPosition();
    await waitForFrame();
    var after = readPosition();
    return {
        x: after.x,
        y: after.y,
        stable: Math.abs(before.x - after.x) <= 1 && Math.abs(before.y - after.y) <= 1,
    };
})()
`;

/**
 * Read a stable non-negative viewport position from the isolated browser world.
 *
 * @param page - Active Playwright page whose viewport is being captured.
 * @returns The stable position, or null when stability cannot be proven.
 */
export async function readStableViewportPosition(
    page: ReturnType<IBrowserSession['getPage']>,
): Promise<ValidationViewportPosition | null> {
    try {
        const evaluator = await createTrustedPageEvaluator(page);
        const result = await evaluator.evaluate(VIEWPORT_STABILITY_PROBE);
        if (!result || typeof result !== 'object') {
            return null;
        }
        const record = result as Record<string, unknown>;
        if (
            record.stable !== true ||
            typeof record.x !== 'number' ||
            !Number.isFinite(record.x) ||
            record.x < 0 ||
            typeof record.y !== 'number' ||
            !Number.isFinite(record.y) ||
            record.y < 0
        ) {
            return null;
        }
        return { x: record.x, y: record.y };
    } catch {
        return null;
    }
}

/**
 * Determine whether two viewport samples describe the same captured position.
 *
 * @param before - Stable position sampled immediately before capture.
 * @param after - Stable position sampled immediately after capture.
 * @returns True when both coordinates remain within one pixel.
 */
export function viewportPositionMatches(
    before: ValidationViewportPosition,
    after: ValidationViewportPosition,
): boolean {
    return Math.abs(before.x - after.x) <= 1 && Math.abs(before.y - after.y) <= 1;
}

/**
 * Clamp a configurable duration to a safe integer range.
 *
 * @param value - Caller-provided duration.
 * @param fallback - Duration used when the caller did not provide a finite value.
 * @param minimum - Smallest accepted duration.
 * @param maximum - Largest accepted duration.
 * @returns A bounded integer duration.
 */
export function boundedDuration(
    value: number | undefined,
    fallback: number,
    minimum: number,
    maximum: number,
): number {
    const candidate = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    return Math.min(maximum, Math.max(minimum, Math.floor(candidate)));
}

/**
 * Normalize an untrusted target string without interpreting it as executable code.
 *
 * @param value - Raw selector or text hint.
 * @param maximumLength - Maximum retained character count.
 * @returns A bounded non-empty value, or undefined.
 */
export function boundedTargetValue(value: unknown, maximumLength: number): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const normalized = value.trim().slice(0, maximumLength);
    return normalized || undefined;
}

/**
 * Read a bounded structural snapshot of the live document.
 *
 * The fixed callback does not receive model-authored JavaScript and only returns numeric state plus
 * a non-reversible hash, keeping page content out of stability diagnostics.
 *
 * @param page - Active Playwright page.
 * @returns Parsed structural state used for consecutive-sample comparisons.
 */
async function readPageStabilitySnapshot(
    page: ReturnType<IBrowserSession['getPage']>,
): Promise<PageStabilitySnapshot> {
    const raw = await page.evaluate(PAGE_STABILITY_STATE_PROBE);
    if (!raw || typeof raw !== 'object') {
        throw new Error('page stability probe returned no structural state');
    }
    const result = raw as Record<string, unknown>;
    const numericFields = [
        'htmlLength',
        'nodeCount',
        'textLength',
        'scrollHeight',
        'scrollY',
        'resourceCount',
    ];
    if (
        typeof result.readyState !== 'string' ||
        typeof result.domFingerprint !== 'string' ||
        numericFields.some(
            (field) =>
                typeof result[field] !== 'number' ||
                !Number.isFinite(result[field]) ||
                (result[field] as number) < 0,
        )
    ) {
        throw new Error('page stability probe returned invalid structural state');
    }
    return result as unknown as PageStabilitySnapshot;
}

/**
 * Build a fixed target-scroll expression with data transported as base64 JSON.
 *
 * @param selector - Bounded CSS selector.
 * @param textHint - Bounded human-readable target hint.
 * @returns Read-only browser expression containing no executable caller-authored source.
 */
function buildTargetScrollProbe(
    selector: string | undefined,
    textHint: string | undefined,
): string {
    const encodedInput = Buffer.from(JSON.stringify({ selector, textHint })).toString('base64');
    return `
(function () {
    var marker = '__adguard_scroll_target_probe__';
    var input = JSON.parse(atob('${encodedInput}'));
    var match = null;
    var matchedBy;
    if (input.selector) {
        try {
            match = document.querySelector(input.selector);
            if (match) matchedBy = ${JSON.stringify(TargetMatchedBy.Selector)};
        } catch (_) {
            // Invalid selectors are unmatched hints, not technical failures.
        }
    }
    if (!match && input.textHint) {
        var hint = String(input.textHint).toLocaleLowerCase();
        var candidates = Array.prototype.slice.call(document.querySelectorAll(
            'main,article,section,aside,header,footer,h1,h2,h3,[role="main"],' +
                '[aria-label],figcaption,p'
        ), 0, 2000).filter(function (element) {
            return String(element.textContent || '').toLocaleLowerCase().includes(hint);
        }).sort(function (left, right) {
            return String(left.textContent || '').length - String(right.textContent || '').length;
        });
        match = candidates[0] || null;
        if (match) matchedBy = ${JSON.stringify(TargetMatchedBy.TextHint)};
    }
    if (!match) {
        return { marker: marker, requested: true, found: false, scrolled: false };
    }
    match.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'nearest' });
    return {
        marker: marker,
        requested: true,
        found: true,
        scrolled: true,
        matchedBy: matchedBy,
    };
})()
`;
}

/**
 * Build a comparison key from one DOM snapshot and the completed network log.
 *
 * @param snapshot - Bounded live DOM state.
 * @param session - Browser session that owns the redacted-at-export network log.
 * @returns Internal state key and the current completed request count.
 */
function pageStabilityKey(
    snapshot: PageStabilitySnapshot,
    session: IBrowserSession,
): PageStabilityKeyResult {
    const networkLog = session.getNetworkLog();
    const recentNetwork = networkLog
        .slice(-8)
        .map((entry) => `${entry.method}:${entry.statusCode}:${entry.resourceType}:${entry.url}`)
        .join('|');
    return {
        key: JSON.stringify(snapshot) + `|${networkLog.length}|${recentNetwork}`,
        networkEntryCount: networkLog.length,
    };
}

/**
 * Wait for consecutive matching DOM and network samples within a shared hard budget.
 *
 * @param session - Browser session whose page and network state are sampled.
 * @param budget - Shared initial/post-scroll time budget.
 * @param pollMs - Interval between probes.
 * @param quietMs - Required unchanged period.
 * @returns Stable-state evidence for this phase.
 */
async function waitForStablePageState(
    session: IBrowserSession,
    budget: PageStabilityBudget,
    pollMs: number,
    quietMs: number,
): Promise<PageStabilityPhaseResult> {
    const page = session.getPage();
    const requiredMatches = Math.max(1, Math.ceil(quietMs / pollMs));
    let previousKey: string | undefined;
    let matchingSamples = 0;
    let sampleCount = 0;
    let networkEntryCount = session.getNetworkLog().length;

    while (budget.remainingMs >= 0 && Date.now() <= budget.deadline) {
        const probeStartedAt = Date.now();
        const snapshot = await readPageStabilitySnapshot(page);
        budget.remainingMs = Math.max(
            0,
            budget.remainingMs - Math.max(0, Date.now() - probeStartedAt),
        );
        const state = pageStabilityKey(snapshot, session);
        sampleCount += 1;
        networkEntryCount = state.networkEntryCount;
        if (snapshot.readyState !== 'loading' && state.key === previousKey) {
            matchingSamples += 1;
        } else {
            matchingSamples = 0;
        }
        previousKey = state.key;
        if (matchingSamples >= requiredMatches) {
            return { stable: true, sampleCount, networkEntryCount };
        }
        if (budget.remainingMs === 0 || Date.now() >= budget.deadline) {
            break;
        }
        const delayMs = Math.min(pollMs, budget.remainingMs);
        await page.waitForTimeout(delayMs);
        budget.remainingMs -= delayMs;
    }

    return { stable: false, sampleCount, networkEntryCount };
}

/**
 * Find a bounded reported area and scroll it into view without executing caller-authored code.
 *
 * @param page - Active Playwright page.
 * @param target - Bounded selector and/or text hint.
 * @returns Target lookup and scroll evidence.
 */
async function scrollToPageTarget(
    page: ReturnType<IBrowserSession['getPage']>,
    target: PageStabilizationTarget,
): Promise<PageTargetScrollResult> {
    const selector = boundedTargetValue(target.selector, MAX_TARGET_SELECTOR_LENGTH);
    const textHint = boundedTargetValue(target.textHint, MAX_TARGET_HINT_LENGTH);
    if (!selector && !textHint) {
        return { requested: false, found: false, scrolled: false };
    }
    const raw = await page.evaluate(buildTargetScrollProbe(selector, textHint));
    if (!raw || typeof raw !== 'object') {
        throw new Error('target scroll probe returned no result');
    }
    const result = raw as Record<string, unknown>;
    return {
        requested: result.requested === true,
        found: result.found === true,
        scrolled: result.scrolled === true,
        ...(result.matchedBy === TargetMatchedBy.Selector ||
        result.matchedBy === TargetMatchedBy.TextHint
            ? { matchedBy: result.matchedBy }
            : {}),
    };
}

/**
 * Prove a capture-ready DOM/network state and optionally reveal a reported target area.
 *
 * This helper never searches for ads and therefore never retries merely because advertising is
 * absent. A missing target remains a successful stable result; only technical instability times
 * out. Callers can capture once before this helper and once after it for a bounded before/target
 * evidence pair.
 *
 * @param session - Browser session whose page should be stabilized.
 * @param options - Bounded timing and optional target options.
 * @returns Typed evidence describing stability and target scrolling.
 */
export async function stabilizePageForCapture(
    session: IBrowserSession,
    options: PageStabilizationOptions = {},
): Promise<PageStabilizationEvidence> {
    const timeoutMs = boundedDuration(
        options.timeoutMs,
        MAX_PAGE_STABILIZATION_TIMEOUT_MS,
        25,
        MAX_PAGE_STABILIZATION_TIMEOUT_MS,
    );
    const pollMs = boundedDuration(options.pollMs, DEFAULT_PAGE_STABILITY_POLL_MS, 25, 1_000);
    const quietMs = boundedDuration(
        options.quietMs,
        DEFAULT_PAGE_STABILITY_QUIET_MS,
        0,
        Math.min(3_000, timeoutMs),
    );
    const budget: PageStabilityBudget = {
        initialMs: timeoutMs,
        remainingMs: timeoutMs,
        deadline: Date.now() + timeoutMs,
    };
    const initial = await waitForStablePageState(session, budget, pollMs, quietMs);
    let sampleCount = initial.sampleCount;
    let networkEntryCount = initial.networkEntryCount;
    const emptyTarget = { requested: false, found: false, scrolled: false };
    if (!initial.stable) {
        return {
            status: 'timed_out',
            sampleCount,
            elapsedMs: budget.initialMs - budget.remainingMs,
            networkEntryCount,
            targetRequested: false,
            targetFound: false,
            targetScrolled: false,
            detail: `page did not stabilize within ${timeoutMs}ms`,
        };
    }

    let targetResult: PageTargetScrollResult = emptyTarget;
    try {
        targetResult = await scrollToPageTarget(session.getPage(), options.target ?? {});
    } catch (error) {
        return {
            status: 'timed_out',
            sampleCount,
            elapsedMs: budget.initialMs - budget.remainingMs,
            networkEntryCount,
            targetRequested: true,
            targetFound: false,
            targetScrolled: false,
            detail: `target stabilization failed: ${(error as Error).message}`,
        };
    }
    if (targetResult.scrolled) {
        const postScroll = await waitForStablePageState(session, budget, pollMs, quietMs);
        sampleCount += postScroll.sampleCount;
        networkEntryCount = postScroll.networkEntryCount;
        if (!postScroll.stable) {
            return {
                status: 'timed_out',
                sampleCount,
                elapsedMs: budget.initialMs - budget.remainingMs,
                networkEntryCount,
                targetRequested: targetResult.requested,
                targetFound: targetResult.found,
                targetScrolled: targetResult.scrolled,
                ...(targetResult.matchedBy ? { targetMatchedBy: targetResult.matchedBy } : {}),
                detail: `page did not stabilize after target scroll within ${timeoutMs}ms`,
            };
        }
    }

    return {
        status: 'stable',
        sampleCount,
        elapsedMs: budget.initialMs - budget.remainingMs,
        networkEntryCount,
        targetRequested: targetResult.requested,
        targetFound: targetResult.found,
        targetScrolled: targetResult.scrolled,
        ...(targetResult.matchedBy ? { targetMatchedBy: targetResult.matchedBy } : {}),
    };
}

/**
 * Round one geometry value for a compact model-facing ad-slot identifier.
 *
 * @param value - Measured CSS-pixel value.
 * @returns Nearest integer CSS-pixel value.
 */
export function roundedGeometry(value: number): number {
    return Math.round(value);
}
