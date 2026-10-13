/**
 * The host-performed application of the built-in AdGuard Browser Extension route.
 *
 * The route's steps are a fixed message protocol, not a judgement — wait for the fresh-install
 * bootstrap, import the settings document the host already built, turn off whatever filter the
 * import left on that the prepared expectation does not name, and for a candidate phase save the
 * rule as the one user rule. Driving that through a model cost 20-50 seconds a turn, five to eight
 * minutes an application, two applications an experiment, and regularly overran the 30-minute
 * `apply_rule` deadline without even sealing a terminal payload. So the host sends the messages
 * itself, in the order `src/prompts/documents/instructions/adguard-extension.md` specifies — that
 * document remains the contract this module implements. The read-and-disable rounds of the third
 * step, custom filters included, live in `host-extension-filter-reconciliation.ts`.
 *
 * What does not move: the runner never decides whether the phase applied. It reports how far it got
 * and the trace of what it did; `phase-application-procedure.ts` reads the live extension state
 * back afterwards and `blocker-state-credit.ts` credits only an exact match, exactly as it does for
 * a model-driven instruction.
 *
 * Bounds: the model-driven session's turn cap and wall-clock budget
 * (`APPLICATION_SESSION_MAX_TURNS`, `APPLICATION_SESSION_BUDGET_MS`) do not apply here and are
 * ignored when the procedure hands them over. This runner is bounded by the extension-readiness
 * deadline every host read of the blocker state shares — one shared wall-clock budget across the
 * bootstrap wait and every options read — and by the request's abort signal, which is checked
 * before each step and between reconciliation rounds so a phase the outer deadline already
 * abandoned stops instead of writing on behind it.
 */
import type { BrowserContext, Page } from 'playwright-core';
import type { EnabledCustomFilter } from '../browser/adguard-custom-filters';
import { AdGuardExtensionMessageType } from '../browser/adguard-extension-message-types';
import { waitForAppInitialized } from '../browser/adguard-extension-state-read';
import {
    DEFAULT_READINESS_BUDGET_MS,
    sendExtensionMessage,
} from '../browser/adguard-extension-state-transport';
import {
    PROOF_APPLICATION_DETAIL_MAX,
    type ActionLogEntry,
} from '../environment/environment-proofs';
import { HostApplicationStep } from '../environment/host-application-step';
import {
    boundedText,
    failureReason,
    hostApplicationStepPerformer,
    HostApplicationStepFailure,
    type HostApplicationStepPerformer,
} from './host-application-step-log';
import { normalizeRulesContent } from '../environment/rules-content';
import type { Logger } from '../logger/logger';
import {
    ApplicationGoalKind,
    type ApplicationGoal,
    type PhaseApplicationRunner,
    type PhaseApplicationRunnerResult,
} from '../validator/phase-application-contract';
import { reconcileEnabledFilters } from './host-extension-filter-reconciliation';
import { importSettingsOnceSettled, replyRefused } from './host-settings-import';
import { overDedicatedSurfacePage } from './phase-application-extension-surface';

/**
 * Everything one host-performed AdGuard application acts on beyond what the runner request carries.
 */
export interface HostExtensionApplicationInput {
    /**
     * The expected blocker state this application performs toward: the candidate rule to save, or
     * the baseline that saves none.
     */
    goal: ApplicationGoal;

    /**
     * Exact official filter IDs the prepared expectation names, in the extension's own registry
     * numbering. Every enabled filter outside this set is turned off; nothing is ever turned on.
     */
    expectedFilterIds: readonly number[];

    /**
     * Titles of the custom filters the imported document installs and the expectation keeps. The
     * import allocates their ids, so they cannot be named in `expectedFilterIds`; an enabled custom
     * filter carrying one of these names stays on, every other custom filter is turned off like a
     * built-in filter the expectation does not name. Omitted or empty keeps no custom filter.
     */
    expectedCustomFilterTitles?: readonly string[];

    /**
     * The lease session's persistent extension context the dedicated surface page is opened on.
     */
    context: BrowserContext;

    /**
     * Wall-clock budget shared by the bootstrap wait and every options read of this application;
     * the shared transport default when the run configures none.
     */
    readinessBudgetMs?: number;

    /**
     * Pause between two settings imports while the extension still refuses the document; the module
     * default when the run configures none.
     */
    importSettleDelayMs?: number;

    /**
     * Run logger receiving every step with its duration, and every failure with its caught error.
     */
    logger: Logger;
}

/**
 * Maximum characters of an extension reply quoted into a step summary.
 *
 * A reply the protocol defines is a boolean or a small record; quoting more than this would push
 * the step's own facts out of the summary's 200-character ceiling.
 */
const REPLY_TOKEN_MAX = 40;

/**
 * Reduce one extension reply to a short token for a step summary.
 *
 * @param reply - Whatever the options application answered.
 * @returns A bounded serialization of the reply.
 */
function replyToken(reply: unknown): string {
    return boundedText(JSON.stringify(reply) ?? String(reply), REPLY_TOKEN_MAX);
}

/**
 * Name the kept custom filters in a step summary, by id and title.
 *
 * @param kept - The enabled custom filters the expectation named.
 * @returns A clause to append to the summary, or nothing when no custom filter was kept.
 */
function keptCustomFiltersClause(kept: readonly EnabledCustomFilter[]): string {
    return kept.length === 0
        ? ''
        : `; kept custom ${kept.map((filter) => `${filter.filterId} "${filter.name}"`).join(', ')}`;
}

/**
 * Send the protocol the built-in document specifies over one loaded surface page.
 *
 * @param page - The dedicated surface page, already loaded on the prepared management surface.
 * @param input - The goal, the expected filter IDs and the readiness budget.
 * @param settingsPayload - The complete settings-import document the host built, passed as handed.
 * @param step - The recorded-step performer.
 * @param signal - Caller cancellation.
 * @returns Nothing; each step's own record says what it did.
 * @throws {HostApplicationStepFailure} When a step fails.
 */
async function performExtensionApplication(
    page: Page,
    input: HostExtensionApplicationInput,
    settingsPayload: string,
    step: HostApplicationStepPerformer,
    signal: AbortSignal | undefined,
): Promise<void> {
    const { goal, expectedFilterIds, logger } = input;
    const readinessBudgetMs = input.readinessBudgetMs ?? DEFAULT_READINESS_BUDGET_MS;
    const readinessDeadlineAt = Date.now() + readinessBudgetMs;

    await step(
        HostApplicationStep.AwaitExtensionReady,
        async () => await waitForAppInitialized(page, readinessDeadlineAt),
        () => ({
            ok: true,
            summary:
                'the extension reported its fresh-install bootstrap finished within the ' +
                `${readinessBudgetMs}ms readiness budget`,
        }),
    );

    await step(
        HostApplicationStep.ApplyExtensionSettings,
        async () =>
            await importSettingsOnceSettled(
                page,
                settingsPayload,
                readinessDeadlineAt,
                input.importSettleDelayMs,
                logger,
                signal,
            ),
        (settled) => ({
            ok: !replyRefused(settled.reply),
            summary:
                `imported the ${settingsPayload.length}-byte settings document naming ` +
                `${expectedFilterIds.length} official filter(s) in ${settled.attempts} ` +
                `attempt(s); the options application answered ${replyToken(settled.reply)}`,
        }),
    );

    await step(
        HostApplicationStep.ReconcileEnabledFilters,
        async () =>
            await reconcileEnabledFilters(
                page,
                expectedFilterIds,
                input.expectedCustomFilterTitles ?? [],
                readinessDeadlineAt,
                logger,
                signal,
            ),
        (reconciliation) => ({
            ok: reconciliation.unexpectedFilterIds.length === 0,
            summary:
                (reconciliation.unexpectedFilterIds.length === 0
                    ? `the enabled set matched after ${reconciliation.rounds} round(s)`
                    : `[${reconciliation.unexpectedFilterIds.join(', ')}] stayed enabled after ` +
                      `${reconciliation.rounds} round(s)`) +
                `; turned off [${reconciliation.disabledFilterIds.join(', ')}]` +
                keptCustomFiltersClause(reconciliation.keptCustomFilters),
        }),
    );

    if (goal.kind !== ApplicationGoalKind.Candidate) {
        // The document prescribes no user-rules step for the Baseline goal, and none is needed: a
        // phase session always bootstraps a fresh profile, so it starts with no user rule, and the
        // settings document imported above is that same profile's own export. Sending an empty
        // `saveUserRules` here would be a step the contract does not name.
        logger.info(
            { goal: goal.kind },
            'the baseline goal leaves the user rules untouched: a fresh phase profile carries none',
        );
        return;
    }
    const rule = normalizeRulesContent(goal.rule);
    await step(
        HostApplicationStep.SaveExtensionUserRules,
        async () =>
            await sendExtensionMessage(page, {
                type: AdGuardExtensionMessageType.SaveUserRules,
                data: { value: rule },
            }),
        (reply) => ({
            ok: !replyRefused(reply),
            summary:
                `saved the candidate as the only user rule (${rule.split('\n').length} line(s), ` +
                `${rule.length} bytes); the options application answered ${replyToken(reply)}`,
        }),
    );
}

/**
 * Create the host-performed application runner of the built-in AdGuard route.
 *
 * The runner opens one throwaway page on the prepared management surface, sends the document's
 * message protocol over it, and closes the page whether the protocol finished or threw. It reports
 * only how far it got and the trace of what it did — never a verdict: the procedure that called it
 * reads the live extension state back afterwards and credits the phase on that alone.
 *
 * @param input - The goal, the expected filter IDs, the lease context, the readiness budget and the
 *   run logger.
 * @returns The runner the between-phases application procedure performs through.
 */
export function createHostExtensionApplicationRunner(
    input: HostExtensionApplicationInput,
): PhaseApplicationRunner {
    return {
        run: async (request): Promise<PhaseApplicationRunnerResult> => {
            const { logger } = input;
            const actionLog: ActionLogEntry[] = [];
            const blockerSurfaceUrl = request.session.blockerSurfaceUrl;
            const settingsPayload = request.session.settingsPayload;
            if (blockerSurfaceUrl === undefined || settingsPayload === undefined) {
                const missing = [
                    ...(blockerSurfaceUrl === undefined
                        ? ['the prepared blocker management surface']
                        : []),
                    ...(settingsPayload === undefined ? ['the prepared settings document'] : []),
                ];
                const detail =
                    'The host has nothing to apply the prepared state through: ' +
                    `${missing.join(' and ')} could not be prepared for this phase.`;
                logger.error(
                    {
                        goal: input.goal.kind,
                        hasBlockerSurfaceUrl: blockerSurfaceUrl !== undefined,
                        hasSettingsPayload: settingsPayload !== undefined,
                    },
                    'the host-performed application has no prepared surface or settings document',
                );
                return {
                    completed: false,
                    detail: boundedText(detail, PROOF_APPLICATION_DETAIL_MAX),
                    actionLog,
                };
            }
            const step = hostApplicationStepPerformer(actionLog, logger, request.signal);
            logger.info(
                {
                    goal: input.goal.kind,
                    blockerSurfaceUrl,
                    expectedFilterIds: [...input.expectedFilterIds],
                    expectedCustomFilterTitles: [...(input.expectedCustomFilterTitles ?? [])],
                    settingsPayloadBytes: settingsPayload.length,
                    readinessBudgetMs: input.readinessBudgetMs ?? DEFAULT_READINESS_BUDGET_MS,
                },
                'the host performs this phase application itself: import, reconcile, save',
            );
            try {
                await overDedicatedSurfacePage(
                    input.context,
                    blockerSurfaceUrl,
                    logger,
                    async (page) =>
                        await performExtensionApplication(
                            page,
                            input,
                            settingsPayload,
                            step,
                            request.signal,
                        ),
                );
            } catch (error) {
                if (error instanceof HostApplicationStepFailure) {
                    return {
                        completed: false,
                        detail: boundedText(error.message, PROOF_APPLICATION_DETAIL_MAX),
                        actionLog,
                    };
                }
                // Everything left is the surface page itself: opening or loading it failed before
                // any step could run, so there is no step to name.
                logger.error(
                    { err: error, blockerSurfaceUrl, goal: input.goal.kind },
                    'the host could not open the prepared blocker management surface to apply over',
                );
                return {
                    completed: false,
                    detail: boundedText(
                        'The host could not open the prepared blocker management surface ' +
                            `${blockerSurfaceUrl}: ${failureReason(error)}`,
                        PROOF_APPLICATION_DETAIL_MAX,
                    ),
                    actionLog,
                };
            }
            const incomplete = actionLog.find((entry) => !entry.ok);
            if (incomplete !== undefined) {
                return {
                    completed: false,
                    detail: boundedText(
                        `The host application step "${incomplete.tool}" did not complete: ` +
                            incomplete.summary,
                        PROOF_APPLICATION_DETAIL_MAX,
                    ),
                    actionLog,
                };
            }
            return { completed: true, actionLog };
        },
    };
}
