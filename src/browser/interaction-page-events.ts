import type { Dialog, Page } from 'playwright-core';

/**
 * Longest popup URL retained as interaction evidence.
 */
const MAX_POPUP_URL_LENGTH = 300;

/**
 * Most popups whose URL is retained for one interaction sequence.
 *
 * Bounds the evidence and the page handles held open, never the count: how many tabs a click opens
 * is the measurement a popup rule is judged by, so it is tallied in full even when only the first
 * few are described.
 */
const MAX_DESCRIBED_POPUPS = 5;

/**
 * Most dialogs recorded for one interaction sequence.
 */
const MAX_RECORDED_DIALOGS = 5;

/**
 * One page the site opened while an interaction sequence was running.
 */
export interface InteractionPopupObservation {
    /**
     * Bounded URL the popup settled on, or the empty string when it never navigated.
     */
    url: string;

    /**
     * Milliseconds on the sequence clock at which the popup appeared.
     */
    openedAtMs: number;
}

/**
 * One native dialog the site raised while an interaction sequence was running.
 */
export interface InteractionDialogObservation {
    /**
     * Dialog kind Chromium reported, such as `alert` or `beforeunload`.
     */
    type: string;

    /**
     * Milliseconds on the sequence clock at which the dialog was raised.
     */
    atMs: number;
}

/**
 * Bounded view of everything the site opened or raised during one interaction sequence.
 */
export interface InteractionPageEventRecorder {
    /**
     * Count every page the site has opened so far, including ones left undescribed.
     *
     * @returns Total number of popups observed.
     */
    popupCount(): number;

    /**
     * Read the popups described so far, in arrival order.
     *
     * @returns Bounded popup observations.
     */
    popups(): InteractionPopupObservation[];

    /**
     * Read the dialogs observed so far, in arrival order.
     *
     * @returns Bounded dialog observations.
     */
    dialogs(): InteractionDialogObservation[];

    /**
     * Stop observing and close every popup this sequence opened.
     *
     * @returns A promise resolved once the listeners are removed and the popups are closed.
     */
    detach(): Promise<void>;
}

/**
 * Bound one string to the retained popup URL length.
 *
 * @param value - Raw URL reported by the popup page.
 * @returns Bounded URL, or the empty string for a blank page.
 */
function boundedPopupUrl(value: string): string {
    return value === 'about:blank' ? '' : value.slice(0, MAX_POPUP_URL_LENGTH);
}

/**
 * Observe the pages and dialogs one interaction sequence provokes.
 *
 * A click that opens a tab is the whole symptom for a popup rule, so the popup is counted rather
 * than suppressed, and it stays open until the sequence ends so its final URL — the ad network the
 * rule must name — is observed instead of the `about:blank` it starts on. Dialogs are dismissed the
 * moment they appear: Chromium blocks the pending input command until a dialog is answered, so a
 * click that raises one would otherwise stall until the step budget expires.
 *
 * Attach for the duration of one sequence only. A session-wide recorder would fold navigation and
 * consent popups into interaction evidence and break the phase-to-phase replay comparison, which
 * requires every phase to observe between exactly the same two points.
 *
 * @param page - Live page the sequence operates.
 * @param now - Sequence clock, injected so evidence is testable without waiting.
 * @returns Recorder that exposes bounded observations and reverses every listener it added.
 */
export function attachInteractionPageEventRecorders(
    page: Page,
    now: () => number = Date.now,
): InteractionPageEventRecorder {
    const attachedAt = now();
    const popups: InteractionPopupObservation[] = [];
    const dialogs: InteractionDialogObservation[] = [];
    const tracked: Page[] = [];
    let opened = 0;

    /**
     * Tally one page the site opened, describing it while the evidence bound allows.
     *
     * @param popup - Page the browser context reported.
     */
    const onPage = (popup: Page): void => {
        if (popup === page) {
            return;
        }
        opened += 1;
        if (tracked.length >= MAX_DESCRIBED_POPUPS) {
            void popup.close().catch(() => undefined);
            return;
        }
        const observation: InteractionPopupObservation = {
            url: boundedPopupUrl(popup.url()),
            openedAtMs: Math.max(0, now() - attachedAt),
        };
        popups.push(observation);
        tracked.push(popup);
        popup.on('framenavigated', (frame) => {
            if (frame === popup.mainFrame()) {
                observation.url = boundedPopupUrl(frame.url());
            }
        });
    };

    /**
     * Record one native dialog and dismiss it so the pending input command can complete.
     *
     * @param dialog - Dialog Chromium raised on the observed page.
     */
    const onDialog = (dialog: Dialog): void => {
        if (dialogs.length < MAX_RECORDED_DIALOGS) {
            dialogs.push({ type: dialog.type(), atMs: Math.max(0, now() - attachedAt) });
        }
        void dialog.dismiss().catch(() => undefined);
    };

    page.context().on('page', onPage);
    page.on('dialog', onDialog);

    return {
        popupCount: () => opened,
        popups: () => popups.map((popup) => ({ ...popup })),
        dialogs: () => dialogs.map((dialog) => ({ ...dialog })),
        // Detaching runs while the sequence is unwinding, including after the page crashed, and a
        // closed page throws from `context()`. Failing here would replace whatever the sequence
        // observed with a teardown error, so every step of it is best-effort.
        detach: async () => {
            try {
                page.context().off('page', onPage);
                page.off('dialog', onDialog);
            } catch {
                // Listeners die with the context that owned them.
            }
            await Promise.all(tracked.map((popup) => popup.close().catch(() => undefined)));
            tracked.length = 0;
        },
    };
}
