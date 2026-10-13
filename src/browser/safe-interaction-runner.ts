import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EnvironmentArtifactReference } from '../environment/filtering-environment';
import {
    TargetMatchedBy,
    SafeInteractionKind,
    SafeInteractionRefusalReason,
    classifySafeInteraction,
    compareSafeInteractionRecords,
    redactSafeInteractionRecord,
    resolveSafeInteractionBounds,
    SYNTHETIC_TEXT_CATALOG,
    type NormalizedSafeInteractionPlan,
    type SafeInteractionBounds,
    type SafeInteractionFailureDetail,
    type SafeInteractionPageState,
    type SafeInteractionRecord,
    type SafeInteractionStep,
    type SafeInteractionStepEvidence,
    type SafeInteractionStepObservation,
    type SafeInteractionTargetFacts,
} from '../environment/safe-interaction';
import { createLogger, type Logger } from '../logger/logger';
import type { TraceRecorder } from '../tracer/trace-recorder';
import type { IBrowserSession } from './browser-interfaces';
import { attachInteractionPageEventRecorders } from './interaction-page-events';
import { stabilizePageForCapture } from './page-stability';
import { canonicalHttpOrigin } from './network-safety';
import { encodeProbeInput, factNumber, factString } from './page-probe-transport';
import { createTrustedPageEvaluator } from './trusted-page-evaluator';

/**
 * Attribute that binds the element the gate inspected to the element Playwright operates.
 */
const INTERACTION_TARGET_ATTRIBUTE = 'data-adguard-interaction-target';

/**
 * Longest attribute value one probe reports back about the resolved element.
 */
const MAX_FACT_LENGTH = 300;

/**
 * Build the fixed expression that resolves one element, marks it, and reports bounded facts.
 *
 * Marking the element is what makes the gate's decision binding: Playwright afterwards addresses
 * the element through the marker, so it cannot act on a different element than the one judged.
 *
 * @param selector - Bounded CSS selector, or null.
 * @param textHint - Bounded human-readable target hint, or null.
 * @param nonce - Fresh per-step marker value.
 * @returns Runner-owned browser expression containing no caller-authored source.
 */
function buildResolveProbe(
    selector: string | null,
    textHint: string | null,
    nonce: string,
): string {
    const encodedInput = encodeProbeInput({ selector, textHint, nonce });
    return `
(function () {
    var marker = '__adguard_interaction_resolve_probe__';
    var input = JSON.parse(atob('${encodedInput}'));
    var bounded = function (value, max) {
        return String(value === null || value === undefined ? '' : value).slice(0, max);
    };
    var match = null;
    var matchedBy = null;
    if (input.selector) {
        try {
            match = document.querySelector(input.selector);
            if (match) matchedBy = ${JSON.stringify(TargetMatchedBy.Selector)};
        } catch (_) {
            // An invalid selector is an unmatched hint, not a technical failure.
        }
    }
    if (!match && input.textHint) {
        var hint = String(input.textHint).toLocaleLowerCase();
        var candidates = Array.prototype.slice.call(document.querySelectorAll(
            'a,button,input,select,textarea,summary,label,[role="button"],[role="link"],' +
                '[role="menuitem"],[role="tab"],[role="checkbox"],[tabindex]'
        ), 0, 2000).filter(function (element) {
            var label = String(element.textContent || '') + ' ' +
                String(element.getAttribute('aria-label') || '');
            return label.toLocaleLowerCase().indexOf(hint) !== -1;
        }).sort(function (left, right) {
            return String(left.textContent || '').length - String(right.textContent || '').length;
        });
        match = candidates[0] || null;
        if (match) matchedBy = ${JSON.stringify(TargetMatchedBy.TextHint)};
    }
    if (!match) {
        return {
            marker: marker,
            found: false,
            matchedBy: null,
            visible: false,
            disabled: false,
            tagName: '',
            inputType: '',
            elementRole: '',
            elementId: '',
            elementClasses: '',
            elementName: '',
            autocompleteHint: '',
            accessibleLabel: '',
            destination: '',
            formDestination: '',
            hasMaskedInput: false,
            hasFileInput: false
        };
    }
    match.setAttribute('${INTERACTION_TARGET_ATTRIBUTE}', input.nonce);
    var style = getComputedStyle(match);
    var rect = match.getBoundingClientRect();
    var form = match.closest ? match.closest('form') : null;
    var anchor = match.closest ? match.closest('a[href]') : null;
    var maskedInput = form ? form.querySelector('input[type="password"]') : null;
    if (!maskedInput && match.querySelector) maskedInput = match.querySelector('input[type="password"]');
    var fileInput = match.querySelector ? match.querySelector('input[type="file"]') : null;
    var type = bounded(match.getAttribute('type'), 40).toLocaleLowerCase();
    var mediaTag = match.tagName === 'VIDEO' || match.tagName === 'AUDIO';
    var containsMedia = mediaTag ||
        !!(match.querySelector && match.querySelector('video,audio'));
    var coversMedia = false;
    var matchArea = rect.width * rect.height;
    if (!containsMedia && matchArea > 0) {
        var media = Array.prototype.slice.call(document.querySelectorAll('video,audio'), 0, 20);
        for (var mediaIndex = 0; mediaIndex < media.length; mediaIndex++) {
            var mediaRect = media[mediaIndex].getBoundingClientRect();
            var overlapWidth = Math.min(rect.right, mediaRect.right) -
                Math.max(rect.left, mediaRect.left);
            var overlapHeight = Math.min(rect.bottom, mediaRect.bottom) -
                Math.max(rect.top, mediaRect.top);
            if (overlapWidth <= 0 || overlapHeight <= 0) continue;
            if (overlapWidth * overlapHeight >= matchArea * 0.5) {
                coversMedia = true;
                break;
            }
        }
    }
    return {
        marker: marker,
        found: true,
        matchedBy: matchedBy,
        visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' &&
            style.display !== 'none' && style.opacity !== '0',
        disabled: match.disabled === true || match.getAttribute('aria-disabled') === 'true',
        tagName: bounded(match.tagName, 40).toLocaleLowerCase(),
        inputType: type,
        elementRole: bounded(match.getAttribute('role'), 40),
        elementId: bounded(match.id, ${MAX_FACT_LENGTH}),
        elementClasses: bounded(match.getAttribute('class'), ${MAX_FACT_LENGTH}),
        elementName: bounded(match.getAttribute('name'), ${MAX_FACT_LENGTH}),
        autocompleteHint: bounded(match.getAttribute('autocomplete'), 40),
        accessibleLabel: bounded(
            String(match.getAttribute('aria-label') || match.textContent || '')
                .replace(/\\s+/g, ' ').trim(),
            ${MAX_FACT_LENGTH}
        ),
        destination: bounded(anchor ? anchor.href : (match.href || ''), 2000),
        formDestination: bounded(form && form.action ? form.action : '', 2000),
        hasMaskedInput: !!maskedInput || type === 'password',
        hasFileInput: !!fileInput || type === 'file',
        containsMediaElement: containsMedia,
        coversMediaElement: coversMedia
    };
})()
`;
}

/**
 * Build the fixed expression that samples bounded page state around one step.
 *
 * @param nonce - Marker of the step's target, or the empty string when it resolves none.
 * @returns Runner-owned browser expression containing no caller-authored source.
 */
function buildStateProbe(nonce: string): string {
    const encodedInput = encodeProbeInput({ nonce });
    return `
(function () {
    var marker = '__adguard_interaction_state_probe__';
    var input = JSON.parse(atob('${encodedInput}'));
    var target = input.nonce
        ? document.querySelector('[${INTERACTION_TARGET_ATTRIBUTE}="' + input.nonce + '"]')
        : null;
    var targetVisible = false;
    if (target) {
        var targetStyle = getComputedStyle(target);
        var targetRect = target.getBoundingClientRect();
        targetVisible = targetRect.width > 0 && targetRect.height > 0 &&
            targetStyle.visibility !== 'hidden' && targetStyle.display !== 'none';
    }
    var obstructions = 0;
    var viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
    var nodes = Array.prototype.slice.call(document.querySelectorAll('body *'), 0, 1500);
    for (var index = 0; index < nodes.length; index++) {
        var style = getComputedStyle(nodes[index]);
        if (style.position !== 'fixed' && style.position !== 'sticky') continue;
        if (style.visibility === 'hidden' || style.display === 'none') continue;
        var rect = nodes[index].getBoundingClientRect();
        if (rect.width * rect.height >= viewportArea * 0.2) obstructions++;
    }
    return {
        marker: marker,
        url: String(location.href),
        scrollY: Math.round(window.scrollY || 0),
        documentHeight: Math.round(document.documentElement.scrollHeight || 0),
        visibleObstructionCount: obstructions,
        targetFound: !!target,
        targetVisible: targetVisible
    };
})()
`;
}

/**
 * Build the fixed expression that removes the step marker from the page.
 *
 * @param nonce - Marker written by the resolve probe.
 * @returns Runner-owned browser expression containing no caller-authored source.
 */
function buildReleaseProbe(nonce: string): string {
    const encodedInput = encodeProbeInput({ nonce });
    return `
(function () {
    var marker = '__adguard_interaction_release_probe__';
    var input = JSON.parse(atob('${encodedInput}'));
    var marked = document.querySelectorAll('[${INTERACTION_TARGET_ATTRIBUTE}="' + input.nonce + '"]');
    for (var index = 0; index < marked.length; index++) {
        marked[index].removeAttribute('${INTERACTION_TARGET_ATTRIBUTE}');
    }
    return { marker: marker, released: marked.length };
})()
`;
}

/**
 * Convert one raw resolve-probe result into bounded target facts.
 *
 * @param raw - Value the isolated-world probe returned.
 * @returns Bounded facts the gate reads.
 * @throws When the probe returned no structural result at all.
 */
function readTargetFacts(raw: unknown): SafeInteractionTargetFacts {
    if (!raw || typeof raw !== 'object') {
        throw new Error('interaction resolve probe returned no structural result');
    }
    const result = raw as Record<string, unknown>;
    const matchedBy = result.matchedBy;
    return {
        found: result.found === true,
        matchedBy:
            matchedBy === TargetMatchedBy.Selector || matchedBy === TargetMatchedBy.TextHint
                ? matchedBy
                : null,
        visible: result.visible === true,
        disabled: result.disabled === true,
        tagName: factString(result.tagName),
        inputType: factString(result.inputType),
        elementRole: factString(result.elementRole),
        elementId: factString(result.elementId),
        elementClasses: factString(result.elementClasses),
        elementName: factString(result.elementName),
        autocompleteHint: factString(result.autocompleteHint),
        accessibleLabel: factString(result.accessibleLabel),
        destination: factString(result.destination),
        formDestination: factString(result.formDestination),
        hasMaskedInput: result.hasMaskedInput === true,
        hasFileInput: result.hasFileInput === true,
        containsMediaElement: result.containsMediaElement === true,
        coversMediaElement: result.coversMediaElement === true,
    };
}

/**
 * Convert one raw state-probe result into a bounded page state.
 *
 * @param raw - Value the isolated-world probe returned.
 * @returns Bounded page state.
 * @throws When the probe returned no structural result at all.
 */
function readPageState(raw: unknown): SafeInteractionPageState {
    if (!raw || typeof raw !== 'object') {
        throw new Error('interaction page-state probe returned no structural result');
    }
    const result = raw as Record<string, unknown>;
    return {
        url: factString(result.url),
        scrollY: factNumber(result.scrollY),
        documentHeight: factNumber(result.documentHeight),
        visibleObstructionCount: factNumber(result.visibleObstructionCount),
        targetFound: result.targetFound === true,
        targetVisible: result.targetVisible === true,
    };
}

/**
 * Everything one bounded interaction sequence needs.
 */
export interface SafeInteractionRunnerConfig {
    /**
     * Adapter-established browser session for this phase.
     */
    session: IBrowserSession;

    /**
     * Exact normalized plan both the baseline and the replay execute.
     */
    plan: NormalizedSafeInteractionPlan;

    /**
     * Canonical origin of the reported site.
     */
    allowedOrigin: string;

    /**
     * Optional narrowed action and time bounds.
     */
    bounds?: Partial<SafeInteractionBounds>;

    /**
     * Injectable clock so budget exhaustion is testable without waiting.
     */
    now?: () => number;

    /**
     * Sink for the raw browser errors behind every typed failure detail.
     */
    logger?: Logger;
}

/**
 * Name the browser-side cause of one failed step without inventing a policy reason.
 *
 * Playwright reports an intercepted click as an actionability timeout whose call log names the
 * element that swallowed the pointer, so interception is matched before the timeout it presents
 * as.
 *
 * @param error - Raw error thrown while performing or observing the step.
 * @returns Finite failure category for the step evidence.
 */
function classifyFailureDetail(error: unknown): SafeInteractionFailureDetail {
    const text = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
    if (/intercepts pointer events/iu.test(text)) {
        return 'click_intercepted';
    }
    if (
        /execution context was destroyed|frame was detached|has been closed|frame got detached/iu.test(
            text,
        )
    ) {
        return 'navigation_destroyed';
    }
    if (/timeout .*exceeded|timeouterror/iu.test(text)) {
        return 'step_timeout';
    }
    return 'unknown';
}

/**
 * Whether one step resolves an element before it can be performed.
 *
 * @param step - Normalized step.
 * @returns Whether the step names a target.
 */
function resolvesTarget(step: SafeInteractionStep): boolean {
    return step.target !== null;
}

/**
 * Perform one gated step through the marked element or the page itself.
 *
 * @param session - Browser session that owns the page.
 * @param step - Normalized step to perform.
 * @param nonce - Marker of the element the gate inspected.
 * @param stepTimeoutMs - Hard budget for this single action.
 * @returns A promise resolved once the action completed.
 */
async function performStep(
    session: IBrowserSession,
    step: SafeInteractionStep,
    nonce: string,
    stepTimeoutMs: number,
): Promise<void> {
    const page = session.getPage();
    const options = { timeout: stepTimeoutMs };
    if (step.kind === SafeInteractionKind.Reload) {
        await page.reload(options);
        return;
    }
    if (step.kind === SafeInteractionKind.Back) {
        await page.goBack(options);
        return;
    }
    // A wait performs no action at all: the stabilization pass that follows every step is the wait.
    if (step.kind === SafeInteractionKind.Wait) {
        return;
    }

    const locator = page.locator(`[${INTERACTION_TARGET_ATTRIBUTE}="${nonce}"]`);
    if (step.kind === SafeInteractionKind.Scroll) {
        await locator.scrollIntoViewIfNeeded(options);
        return;
    }
    if (step.kind === SafeInteractionKind.Hover) {
        await locator.hover(options);
        return;
    }
    if (step.kind === SafeInteractionKind.Click) {
        await locator.click(options);
        return;
    }
    await locator.fill(SYNTHETIC_TEXT_CATALOG[step.text!], options);
}

/**
 * Execute one bounded interaction sequence and preserve its ordered evidence.
 *
 * Every targeted step is gated before any browser action is performed, so a refused step leaves the
 * page exactly as the previous step did.
 *
 * @param config - Session, normalized plan, reported origin, and bounds.
 * @returns Ordered evidence and the finite terminal status.
 */
export async function runSafeInteractionSequence(
    config: SafeInteractionRunnerConfig,
): Promise<SafeInteractionRecord> {
    const bounds = resolveSafeInteractionBounds(config.bounds);
    const now = config.now ?? Date.now;
    const session = config.session;
    const logger = config.logger ?? createLogger();
    const evaluator = await createTrustedPageEvaluator(session.getPage(), { logger });
    const pageEvents = attachInteractionPageEventRecorders(session.getPage(), now);
    const steps: SafeInteractionStepEvidence[] = [];
    const startedAt = now();
    let status: SafeInteractionRecord['status'] = 'completed';
    let refusal: SafeInteractionRecord['refusal'] = null;

    try {
        for (const [index, step] of config.plan.steps.entries()) {
            const stepStartedAt = now();
            if (stepStartedAt - startedAt >= bounds.totalBudgetMs) {
                status = 'bounded_out';
                break;
            }

            const targeted = resolvesTarget(step);
            const nonce = targeted ? randomUUID() : '';
            const networkBefore = session.getNetworkLog().length;
            const popupsBefore = pageEvents.popupCount();
            const dialogsBefore = pageEvents.dialogs().length;

            /**
             * Count the console errors the session has accumulated so far.
             *
             * @returns Number of console entries the page reported as errors.
             */
            const consoleErrors = (): number =>
                session.getConsoleLog().filter((entry) => entry.type === 'error').length;

            /**
             * Build the observation for one step from the session's own logs.
             *
             * @param stabilization - Whether the page settled after the step.
             * @returns Bounded browser activity observed around the step.
             */
            const observationOf = (
                stabilization: SafeInteractionStepObservation['stabilization'],
            ): SafeInteractionStepObservation => {
                const networkEntryCount = session.getNetworkLog().length;
                return {
                    networkEntryCount,
                    networkEntriesAdded: Math.max(0, networkEntryCount - networkBefore),
                    consoleErrorCount: consoleErrors(),
                    popupsOpened: Math.max(0, pageEvents.popupCount() - popupsBefore),
                    dialogsDismissed: Math.max(0, pageEvents.dialogs().length - dialogsBefore),
                    stabilization,
                };
            };

            let facts: SafeInteractionTargetFacts | null = null;
            let outcome: SafeInteractionStepEvidence['outcome'] = 'performed';
            let refusalReason: SafeInteractionRefusalReason | null = null;
            let failureDetail: SafeInteractionFailureDetail | null = null;
            let precondition: SafeInteractionPageState | null = null;
            let result: SafeInteractionPageState | null = null;
            let stabilization: SafeInteractionStepObservation['stabilization'] = 'not_attempted';

            try {
                if (targeted) {
                    facts = readTargetFacts(
                        await evaluator.evaluate(
                            buildResolveProbe(step.target!.selector, step.target!.textHint, nonce),
                        ),
                    );
                }
                precondition = readPageState(await evaluator.evaluate(buildStateProbe(nonce)));

                const decision = classifySafeInteraction(step, facts, config.allowedOrigin);
                if (!decision.allowed) {
                    outcome = 'refused';
                    refusalReason = decision.reason;
                } else {
                    await performStep(session, step, nonce, bounds.stepTimeoutMs);
                    const stabilized = await stabilizePageForCapture(session, {
                        timeoutMs: bounds.stepTimeoutMs,
                        ...(step.quietMs === null ? {} : { quietMs: step.quietMs }),
                    });
                    stabilization = stabilized.status;
                    result = readPageState(await evaluator.evaluate(buildStateProbe(nonce)));
                    // The network guard aborts an off-origin main-frame navigation, but a step that
                    // moved the page anyway ends the sequence rather than observing another site.
                    if (!sameOrigin(result.url, config.allowedOrigin)) {
                        outcome = 'failed';
                        refusalReason = SafeInteractionRefusalReason.ExternalDestination;
                    }
                }
            } catch (error) {
                // An infrastructure failure is never reported as a policy refusal: inventing a
                // reason for a browser error is exactly the fabrication a refusal must not contain.
                outcome = 'failed';
                refusalReason = null;
                failureDetail = classifyFailureDetail(error);
                logger.warn(
                    { err: error, stepIndex: index, stepKind: step.kind, failureDetail },
                    'safe interaction step failed',
                );
            } finally {
                if (targeted) {
                    await evaluator.evaluate(buildReleaseProbe(nonce)).catch(() => undefined);
                }
            }

            steps.push({
                index,
                step,
                resolvedTarget: facts,
                precondition: precondition ?? unknownPageState(),
                outcome,
                refusalReason,
                failureDetail,
                result,
                startedAtMs: Math.max(0, stepStartedAt - startedAt),
                durationMs: Math.max(0, now() - stepStartedAt),
                observation: observationOf(stabilization),
            });

            if (outcome === 'refused') {
                status = 'refused';
                refusal = { index, reason: refusalReason! };
                break;
            }
            if (outcome === 'failed') {
                status = 'failed';
                break;
            }
        }
    } finally {
        await pageEvents.detach();
    }

    return {
        planDigest: config.plan.digest,
        steps,
        status,
        refusal,
        elapsedMs: Math.max(0, now() - startedAt),
        popupsOpened: pageEvents.popupCount(),
        popups: pageEvents.popups(),
        dialogs: pageEvents.dialogs(),
    };
}

/**
 * Build the page state used when a step failed before it could be sampled.
 *
 * @returns Page state that asserts nothing about the page.
 */
function unknownPageState(): SafeInteractionPageState {
    return {
        url: '',
        scrollY: 0,
        documentHeight: 0,
        visibleObstructionCount: 0,
        targetFound: false,
        targetVisible: false,
    };
}

/**
 * Decide whether one observed URL is still on the reported site.
 *
 * @param url - URL observed after a step.
 * @param allowedOrigin - Canonical origin of the reported site.
 * @returns Whether the page is still on the reported origin.
 */
function sameOrigin(url: string, allowedOrigin: string): boolean {
    try {
        return canonicalHttpOrigin(url) === canonicalHttpOrigin(allowedOrigin);
    } catch {
        return false;
    }
}

/**
 * Everything needed to retain one interaction record as phase evidence.
 */
export interface SafeInteractionRecordPersistence {
    /**
     * Complete record for this phase.
     */
    record: SafeInteractionRecord;

    /**
     * Baseline record when this phase is a replay, else null.
     */
    baseline: SafeInteractionRecord | null;

    /**
     * Exact Host-configured secrets.
     */
    configuredSecrets: readonly string[];

    /**
     * Run-owned artifacts directory.
     */
    artifactsDir: string;

    /**
     * Authoritative trace artifact registry.
     */
    recorder: TraceRecorder;

    /**
     * Recorder-token-derived physical execution identity.
     */
    artifactIdSuffix: string;
}

/**
 * Redact, persist, and register one interaction record as first-class phase evidence.
 *
 * @param input - Record, optional baseline to compare against, secrets, artifact sink.
 * @returns Canonical artifact reference for the phase completion.
 */
export function persistSafeInteractionRecord(
    input: SafeInteractionRecordPersistence,
): EnvironmentArtifactReference {
    const replay = input.baseline
        ? compareSafeInteractionRecords(input.baseline, input.record)
        : null;
    const payload = {
        record: redactSafeInteractionRecord(input.record, input.configuredSecrets),
        replay,
    };
    const artifactId = `interaction-${input.artifactIdSuffix}`;
    const path = join(input.artifactsDir, `safe-interaction-${input.artifactIdSuffix}.json`);
    mkdirSync(input.artifactsDir, { recursive: true });
    const serialized = JSON.stringify(payload, null, 2);
    writeFileSync(path, serialized);
    input.recorder.addArtifact({
        id: artifactId,
        path,
        type: 'application/json',
        bytes: Buffer.byteLength(serialized),
    });
    return { artifactId, kind: 'interaction', path };
}
