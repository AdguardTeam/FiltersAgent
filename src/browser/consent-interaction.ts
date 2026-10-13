import * as v from 'valibot';
import type { Page } from 'playwright-core';
import type { IBrowserSession } from './browser-interfaces';
import { ConsentStrategy, type ReproProfile } from '../types/repro-profile';
import { stabilizePageForCapture, type PageStabilizationEvidence } from './page-stability';

/**
 * Consent banner detection and accept/reject interaction with restabilization.
 */
/**
 * Bounded page-state facts collected around one trusted consent interaction.
 */
export interface ConsentPageStateEvidence {
    /**
     * Current body classes, truncated before leaving the browser boundary.
     */
    bodyClassName: string;

    /**
     * Number of visible dialog-, modal-, cookie-, or consent-like elements in the bounded scan.
     */
    visibleObstructionCount: number;

    /**
     * Bounded structural identities for the first visible obstruction-like elements.
     */
    visibleObstructions: Array<{
        /**
         * Lowercase element tag.
         */
        tagName: string;

        /**
         * Bounded element ID.
         */
        id: string;

        /**
         * Bounded element classes.
         */
        className: string;

        /**
         * Bounded ARIA role.
         */
        role: string;
    }>;
}

/**
 * Typed evidence from one runner-owned consent setup performed after navigation.
 */
export interface ConsentHandlingEvidence {
    /**
     * Profile strategy applied by the trusted browser runner.
     */
    strategy: ReproProfile['consentStrategy'];

    /**
     * Whether the runner searched for one allowlisted consent control.
     */
    attempted: boolean;

    /**
     * Whether one visible allowlisted control was clicked.
     */
    clicked: boolean;

    /**
     * Bounded normalized label of the clicked control, when found.
     */
    matchedLabel: string | null;

    /**
     * Page obstruction facts immediately before the bounded click.
     */
    before: ConsentPageStateEvidence | null;

    /**
     * Page obstruction facts after the bounded post-click stabilization pass.
     */
    after: ConsentPageStateEvidence | null;

    /**
     * Post-click stabilization evidence, when a control was clicked.
     */
    stabilization: PageStabilizationEvidence | null;

    /**
     * Bounded setup error retained as a fact without failing navigation.
     */
    error?: string;
}

/**
 * Runtime schema for bounded consent obstruction facts returned by a trusted page probe.
 */
const ConsentPageStateEvidenceSchema = v.strictObject({
    bodyClassName: v.pipe(v.string(), v.maxLength(500)),
    visibleObstructionCount: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(250)),
    visibleObstructions: v.pipe(
        v.array(
            v.strictObject({
                tagName: v.pipe(v.string(), v.maxLength(30)),
                id: v.pipe(v.string(), v.maxLength(120)),
                className: v.pipe(v.string(), v.maxLength(300)),
                role: v.pipe(v.string(), v.maxLength(50)),
            }),
        ),
        v.maxLength(8),
    ),
});

/**
 * Runtime schema for the sole trusted consent-control click result.
 */
const ConsentClickEvidenceSchema = v.strictObject({
    clicked: v.boolean(),
    matchedLabel: v.nullable(v.pipe(v.string(), v.maxLength(120))),
});

/**
 * Maximum time spent proving the page stable after one consent click.
 */
const CONSENT_RESTABILIZATION_TIMEOUT_MS = 3_000;

/**
 * Maximum button-like controls inspected for one bounded consent interaction.
 */
const MAX_CONSENT_CONTROLS = 200;

/**
 * Exact normalized labels allowed for an accept interaction.
 */
const ACCEPT_CONSENT_LABELS = [
    'accept',
    'accept all',
    'accept all cookies',
    'agree',
    'allow all',
    'allow all cookies',
    'i agree',
    'akceptuj',
    'akceptuję',
    'akceptuj wszystkie',
    'akceptuję wszystkie',
    'zaakceptuj wszystkie',
    'zaakceptuj wszystko',
    'zgadzam się',
    'zgadzam się na wszystkie',
    'zezwól na wszystko',
    'alle akzeptieren',
    'tout accepter',
    'aceptar todo',
    'aceitar tudo',
    'accetta tutto',
] as const;

/**
 * Exact normalized labels allowed for a reject interaction.
 */
const REJECT_CONSENT_LABELS = [
    'reject',
    'reject all',
    'decline',
    'decline all',
    'deny all',
    'necessary only',
    'only necessary',
    'odrzuć',
    'odrzuć wszystkie',
    'nie zgadzam się',
    'tylko niezbędne',
    'alle ablehnen',
    'tout refuser',
    'rechazar todo',
    'recusar tudo',
    'rifiuta tutto',
] as const;

/**
 * Fixed trusted probe for bounded modal-, cookie-, and consent-like structural facts.
 */
const CONSENT_PAGE_STATE_EXPRESSION = `
(function () {
    var marker = '__adguard_consent_page_state__';
    var candidates = Array.prototype.slice.call(document.querySelectorAll(
        '[role="dialog"],[aria-modal="true"],dialog[open],' +
        '[class*="cookie" i],[id*="cookie" i],' +
        '[class*="consent" i],[id*="consent" i],' +
        '[class*="modal" i],[id*="modal" i],' +
        '[class*="overlay" i],[id*="overlay" i]'
    ), 0, 250);
    var visible = candidates.filter(function (element) {
        var rect = element.getBoundingClientRect();
        var style = window.getComputedStyle(element);
        return rect.width > 1 && rect.height > 1 && style.display !== 'none' &&
            style.visibility !== 'hidden' && Number(style.opacity || '1') > 0;
    });
    return {
        bodyClassName: String(document.body && document.body.className || '').slice(0, 500),
        visibleObstructionCount: visible.length,
        visibleObstructions: visible.slice(0, 8).map(function (element) {
            return {
                tagName: String(element.tagName || '').toLowerCase().slice(0, 30),
                id: String(element.id || '').slice(0, 120),
                className: String(element.className || '').slice(0, 300),
                role: String(element.getAttribute('role') || '').slice(0, 50),
            };
        }),
    };
})()
`;

/**
 * Build the fixed trusted click expression for one runner-owned consent strategy.
 *
 * @param labels - Exact normalized labels selected from a static runner allowlist.
 * @returns Trusted expression that inspects at most 200 controls and clicks at most one.
 */
function buildConsentClickExpression(labels: readonly string[]): string {
    const encodedLabels = JSON.stringify(labels);
    return `
(function () {
    var marker = '__adguard_consent_control_click__';
    var labels = ${encodedLabels};
    var obstructionSelector =
        '[role="dialog"],[aria-modal="true"],dialog[open],' +
        '[class*="cookie" i],[id*="cookie" i],' +
        '[class*="consent" i],[id*="consent" i]';
    var consentSignal =
        /cookie|consent|privacy|gdpr|cmp|ciastecz|zgod|datenschutz|confidentialit|privacidad|privacidade|riservatezza/i;
    var isVisible = function (element) {
        var rect = element.getBoundingClientRect();
        var style = window.getComputedStyle(element);
        return rect.width > 1 && rect.height > 1 && rect.bottom > 0 && rect.right > 0 &&
            rect.top < window.innerHeight && rect.left < window.innerWidth &&
            style.display !== 'none' && style.visibility !== 'hidden' &&
            Number(style.opacity || '1') > 0;
    };
    var containers = Array.prototype.slice.call(document.querySelectorAll(
        obstructionSelector
    ), 0, 100).filter(function (element) {
        if (element === document.body || element === document.documentElement ||
            !isVisible(element)) return false;
        var style = window.getComputedStyle(element);
        var semanticDialog = element.getAttribute('role') === 'dialog' ||
            element.getAttribute('aria-modal') === 'true' ||
            String(element.tagName || '').toLowerCase() === 'dialog';
        var signature = [
            element.id,
            element.className,
            element.getAttribute('aria-label'),
            String(element.textContent || '').slice(0, 2000),
        ].join(' ');
        return consentSignal.test(signature) &&
            (semanticDialog || style.position === 'fixed' || style.position === 'sticky');
    });
    if (containers.length === 0) return { clicked: false, matchedLabel: null };
    var controls = [];
    containers.some(function (container) {
        var nested = container.querySelectorAll(
            'button,[role="button"],input[type="button"],input[type="submit"],a'
        );
        for (var index = 0; index < nested.length; index += 1) {
            if (controls.indexOf(nested[index]) === -1) controls.push(nested[index]);
            if (controls.length >= ${MAX_CONSENT_CONTROLS}) return true;
        }
        return false;
    });
    var target = controls.find(function (element) {
        var rawLabel = element instanceof HTMLInputElement
            ? element.value
            : (element.textContent || element.getAttribute('aria-label') || '');
        var normalizedLabel = String(rawLabel).normalize('NFKC').replace(/\\s+/g, ' ').trim()
            .toLocaleLowerCase();
        return isVisible(element) && element.getAttribute('aria-disabled') !== 'true' &&
            !element.disabled &&
            labels.indexOf(normalizedLabel) !== -1;
    });
    if (!target) return { clicked: false, matchedLabel: null };
    var rawLabel = target instanceof HTMLInputElement
        ? target.value
        : (target.textContent || target.getAttribute('aria-label') || '');
    var matchedLabel = String(rawLabel).normalize('NFKC').replace(/\\s+/g, ' ').trim()
        .slice(0, 120);
    target.click();
    return { clicked: true, matchedLabel: matchedLabel };
})()
`;
}

/**
 * Collect bounded structural facts for visible consent- or modal-like page obstructions.
 *
 * @param page - Active page inspected in its main frame.
 * @returns Bounded body and visible obstruction facts.
 */
export async function collectConsentPageState(page: Page): Promise<ConsentPageStateEvidence> {
    return v.parse(
        ConsentPageStateEvidenceSchema,
        await page.evaluate(CONSENT_PAGE_STATE_EXPRESSION),
    );
}

/**
 * Apply one trusted, bounded consent interaction and collect before/after setup facts.
 *
 * This runner-owned interaction is deliberately separate from the model's read-only `evaluate_js`
 * tool. It searches only visible button-like controls, requires an exact allowlisted normalized
 * label, and clicks at most one control.
 *
 * @param session - Active browser session whose main page is already stable.
 * @param strategy - Requested untouched, accept, or reject strategy.
 * @param timeoutMs - Navigation stabilization budget used to bound post-click settling.
 * @param pollMs - Interval used by the post-click stability probes.
 * @param quietMs - Required post-click quiet window.
 * @returns Typed setup and obstruction facts without making a semantic fix decision.
 */
export async function applyConsentStrategy(
    session: IBrowserSession,
    strategy: ReproProfile['consentStrategy'],
    timeoutMs: number,
    pollMs: number,
    quietMs: number,
): Promise<ConsentHandlingEvidence> {
    if (strategy === ConsentStrategy.Untouched) {
        return {
            strategy,
            attempted: false,
            clicked: false,
            matchedLabel: null,
            before: null,
            after: null,
            stabilization: null,
        };
    }

    const page = session.getPage();
    try {
        const labels =
            strategy === ConsentStrategy.Accept ? ACCEPT_CONSENT_LABELS : REJECT_CONSENT_LABELS;
        const before = await collectConsentPageState(page);
        if (before.visibleObstructionCount === 0) {
            return {
                strategy,
                attempted: true,
                clicked: false,
                matchedLabel: null,
                before,
                after: before,
                stabilization: null,
            };
        }
        const click = v.parse(
            ConsentClickEvidenceSchema,
            await page.evaluate(buildConsentClickExpression(labels)),
        );
        if (!click.clicked) {
            return {
                strategy,
                attempted: true,
                clicked: false,
                matchedLabel: null,
                before,
                after: before,
                stabilization: null,
            };
        }
        const stabilization = await stabilizePageForCapture(session, {
            timeoutMs: Math.min(timeoutMs, CONSENT_RESTABILIZATION_TIMEOUT_MS),
            pollMs,
            quietMs: Math.min(quietMs, 750),
        });
        const after = await collectConsentPageState(page);
        return {
            strategy,
            attempted: true,
            clicked: true,
            matchedLabel: click.matchedLabel,
            before,
            after,
            stabilization,
        };
    } catch (error) {
        return {
            strategy,
            attempted: true,
            clicked: false,
            matchedLabel: null,
            before: null,
            after: null,
            stabilization: null,
            error: String((error as Error).message).slice(0, 500),
        };
    }
}
