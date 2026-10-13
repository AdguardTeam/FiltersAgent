/**
 * The settings import of the host-performed AdGuard application, and the one question both of its
 * writing steps ask of a reply.
 *
 * Split out of `host-extension-application.ts` along its one independent seam: the import is the
 * only step that waits on the extension, and that wait has its own evidence and its own knob.
 */
import type { Page } from 'playwright-core';
import { AdGuardExtensionMessageType } from '../browser/adguard-extension-message-types';
import { sendExtensionMessage } from '../browser/adguard-extension-state-transport';
import type { Logger } from '../logger/logger';

/**
 * Whether one extension reply is the protocol's explicit refusal.
 *
 * The pinned build answers `applySettingsJson` and `saveUserRules` with a boolean, and `false`
 * means it applied nothing. It is recorded as a step that did not do what it was asked rather than
 * thrown: the read-back still decides the phase, and it will say precisely what the state is.
 *
 * @param reply - Whatever the options application answered.
 * @returns True when the reply is exactly `false`.
 */
export function replyRefused(reply: unknown): boolean {
    return reply === false;
}

/**
 * Pause between two settings imports while the extension still refuses the document.
 *
 * `getIsAppInitialized` turns true before a fresh install has finished settling: it can answer
 * `true` in 4 ms, then `applySettingsJson` answers `false` within half a second and the enabled set
 * reads back empty in some phases, while in others the same import takes three seconds and
 * succeeds. A model-driven application never meets that window only because a model turn takes
 * 20-50 seconds. The import's own answer is the one readiness signal the protocol gives for it, so
 * the host repeats the import, unhurried, until it is accepted or the readiness budget ends.
 */
const SETTINGS_IMPORT_SETTLE_DELAY_MS = 2_000;

/**
 * What the settings import step ended with.
 */
export interface SettledSettingsImport {
    /**
     * The options application's last answer.
     */
    reply: unknown;

    /**
     * How many times the document was sent.
     */
    attempts: number;
}

/**
 * Import the settings document, repeating while the extension refuses it, within the readiness
 * budget.
 *
 * @param page - The dedicated surface page.
 * @param settingsPayload - The complete settings-import document, passed exactly as handed.
 * @param readinessDeadlineAt - Absolute deadline shared by this application's waits.
 * @param settleDelayMs - Pause between two imports; the module default when undefined.
 * @param logger - Run logger for every refused import.
 * @param signal - Caller cancellation.
 * @returns The last answer and how many imports it took.
 */
export async function importSettingsOnceSettled(
    page: Page,
    settingsPayload: string,
    readinessDeadlineAt: number,
    settleDelayMs: number = SETTINGS_IMPORT_SETTLE_DELAY_MS,
    logger: Logger,
    signal: AbortSignal | undefined,
): Promise<SettledSettingsImport> {
    for (let attempts = 1; ; attempts += 1) {
        const reply = await sendExtensionMessage(page, {
            type: AdGuardExtensionMessageType.ApplySettingsJson,
            data: { json: settingsPayload },
        });
        if (!replyRefused(reply)) {
            return { reply, attempts };
        }
        const outOfTime = Date.now() + settleDelayMs >= readinessDeadlineAt;
        logger.warn(
            { attempts, settleDelayMs, outOfTime, aborted: signal?.aborted ?? false },
            'the extension refused the settings import; its fresh-install bootstrap may still be settling',
        );
        if (outOfTime || (signal?.aborted ?? false)) {
            return { reply, attempts };
        }
        await new Promise<void>((resolve) => {
            setTimeout(resolve, settleDelayMs);
        });
    }
}
