/**
 * The launch-time Baseline of a session that runs a list slice (`settings.slice`): one selected
 * list is replaced by a line range of the build's own text of it, installed as a trusted custom
 * filter, while the built-in list stays off and every other selected list runs whole. The steps:
 * cut the slice from the build text, turn Chromium's "Allow User Scripts" on (without it the pinned
 * MV3 build runs no custom filter), serve the slice from the run's loopback text server, build the
 * settings document with the common lists and the one custom filter, have the host runner import
 * and reconcile it, read the state back and verify it: the common lists on, exactly one custom
 * filter carrying the slice's title, no user rule, the expected Stealth state, the MV3 limits not
 * exceeded. `phase-application-launch.ts` delegates here after its own pre-read; the credit rule of
 * `blocker-state-credit.ts` is not used, because it would count the custom filter as a stray.
 */
import type { BrowserContext } from 'playwright-core';
import type { AdGuardExtensionSettingsProfile } from '../browser/adguard-extension-settings';
import type { AdGuardExtensionStateRead } from '../browser/adguard-extension-state-shapes';
import { readBundledListLines, sliceListText } from '../browser/extension-list-text';
import { adguardListKey } from '../environment/filter-list-ref';
import {
    sliceLineCount,
    sliceTitle,
    type ListSlice,
    type ListSliceFacts,
} from '../environment/list-slice';
import type { ChromiumPreparedExtension } from '../local/prepared-extension';
import { createLogger, type Logger } from '../logger/logger';
import {
    APPLICATION_SESSION_BUDGET_MS,
    APPLICATION_SESSION_MAX_TURNS,
    ApplicationGoalKind,
} from '../validator/phase-application-contract';
import type { AgentRuntimeSessionState } from './agent-runtime-session-evidence';
import { createHostExtensionApplicationRunner } from './host-extension-application';
import { listNameFor } from './list-slice-launch';
import { sliceFacts, verifySliceReadBack } from './list-slice-verification';
import {
    buildExtensionSettingsPayloadOverDedicatedPage,
    preparedBlockerSurfaceUrl,
    readExtensionBlockerState,
} from './phase-application-extension-surface';
import type { PhaseApplicationFlowHost } from './phase-application-flow-host';
import { expectedStealthEnabledFor, requiredExtensionGroupIds } from './phase-application-wiring';

/**
 * The prompt handed to the host-performed runner. It ignores the prompt — there is no model to read
 * one, the host follows the protocol in code — and the runner request requires a string.
 */
const HOST_RUNNER_PROMPT = '';

/**
 * How the served slice document is named: `slice-<list>-<first>-<last>.txt`, one name per slice, so
 * two slices of one run never overwrite each other on the text server.
 *
 * @param slice - The slice.
 * @returns The document name.
 */
function sliceDocumentName(slice: ListSlice): string {
    return `slice-${slice.filterId}-${slice.firstLine}-${slice.lastLine}.txt`;
}

/**
 * How the slice Baseline ended.
 */
export const ListSliceBaselineOutcomeKind = {
    /**
     * The read-back carried exactly the common lists, the slice's custom filter and nothing else.
     */
    Verified: 'verified',

    /**
     * A step failed or the read-back did not match; the detail names which.
     */
    Unverified: 'unverified',
} as const;

/**
 * ListSliceBaselineOutcomeKind value.
 */
export type ListSliceBaselineOutcomeKind =
    (typeof ListSliceBaselineOutcomeKind)[keyof typeof ListSliceBaselineOutcomeKind];

/**
 * Outcome of one slice Baseline.
 */
export type ListSliceBaselineOutcome =
    | {
          /**
           * Discriminator: the read-back verified the slice session.
           */
          kind: typeof ListSliceBaselineOutcomeKind.Verified;

          /**
           * The complete host read-back the session's settings record is derived from.
           */
          readBack: AdGuardExtensionStateRead;

          /**
           * What the session reports about its slice.
           */
          listSlice: ListSliceFacts;
      }
    | {
          /**
           * Discriminator: the slice session did not verify.
           */
          kind: typeof ListSliceBaselineOutcomeKind.Unverified;

          /**
           * Bounded detail naming the failed step or the mismatch.
           */
          detail: string;
      };

/**
 * Everything one slice Baseline acts on.
 */
export interface ListSliceBaselineInput {
    /**
     * The runtime seam the application flow acts through, the slice support included.
     */
    host: PhaseApplicationFlowHost;

    /**
     * The launched session's state record.
     */
    state: AgentRuntimeSessionState;

    /**
     * The session's persistent context the extension is loaded in.
     */
    context: BrowserContext;

    /**
     * The prepared Chromium build whose text the slice is cut from.
     */
    extension: ChromiumPreparedExtension;

    /**
     * Canonical target the session was created for.
     */
    targetUrl: string;

    /**
     * The launch request's settings, for the expected Stealth state.
     */
    settings: AdGuardExtensionSettingsProfile;

    /**
     * The slice the request named, already checked against the build.
     */
    slice: ListSlice;

    /**
     * The extension state the launch read before any application.
     */
    preRead: AdGuardExtensionStateRead;

    /**
     * The selected lists that run whole: the request's lists minus the sliced one, converged onto
     * the build catalog.
     */
    commonFilterIds: readonly number[];

    /**
     * Launch deadline signal.
     */
    signal?: AbortSignal;
}

/**
 * Settle the slice Baseline unverified, with the reason logged and returned.
 *
 * @param logger - Run logger.
 * @param detail - Why the slice session did not verify.
 * @param fields - Structured context for the log line.
 * @returns The unverified outcome.
 */
function unverified(
    logger: Logger,
    detail: string,
    fields: Record<string, unknown> = {},
): ListSliceBaselineOutcome {
    logger.warn({ ...fields, detail }, 'the slice Baseline did not verify');
    return { kind: ListSliceBaselineOutcomeKind.Unverified, detail };
}

/**
 * Run the slice Baseline of one just-launched prepared session.
 *
 * @param input - The host seam, the session, the slice, the pre-read and the common lists.
 * @returns The verified read-back with the slice facts, or the unverified detail.
 */
export async function launchListSliceBaseline(
    input: ListSliceBaselineInput,
): Promise<ListSliceBaselineOutcome> {
    const { host, state, context, slice, preRead, commonFilterIds, signal } = input;
    const logger = createLogger({ verbose: host.verbose });
    const startedAt = Date.now();
    let lines: string[];
    let text: string;
    try {
        lines = readBundledListLines(input.extension.extensionPath, slice.filterId);
        text = sliceListText(lines, slice);
    } catch (error) {
        logger.error({ err: error, slice }, 'the slice could not be cut from the build text');
        return unverified(
            logger,
            'The slice could not be cut from the build text: ' +
                (error instanceof Error ? error.message : String(error)),
            { slice },
        );
    }
    const title = sliceTitle(
        listNameFor(preRead.optionsData.filtersMetadata, slice.filterId),
        slice,
        lines.length,
    );
    logger.info(
        {
            slice,
            totalLines: lines.length,
            sliceLines: sliceLineCount(slice),
            sliceBytes: text.length,
            title,
            commonFilterIds: [...commonFilterIds],
            cutMs: Date.now() - startedAt,
        },
        'the slice was cut from the build text',
    );
    if (signal?.aborted) {
        return unverified(
            logger,
            'The launch deadline aborted before the slice could be installed.',
        );
    }
    const toggleStartedAt = Date.now();
    try {
        await host.listSlice.allowUserScripts(context, preRead.extensionId, logger);
    } catch (error) {
        logger.error(
            { err: error, extensionId: preRead.extensionId },
            'Chromium "Allow User Scripts" could not be turned on; the slice would not run',
        );
        return unverified(
            logger,
            'Chromium "Allow User Scripts" could not be turned on for the extension, so its ' +
                'custom filter would be inert: ' +
                (error instanceof Error ? error.message : String(error)),
        );
    }
    let customUrl: string;
    try {
        const server = await host.listSlice.textServer();
        customUrl = server.publish(sliceDocumentName(slice), text);
        logger.info(
            { customUrl, port: server.port, toggleMs: Date.now() - toggleStartedAt },
            'the slice is served to the extension from the loopback text server',
        );
    } catch (error) {
        logger.error(
            { err: error, slice },
            'the slice could not be served from the loopback text server',
        );
        return unverified(
            logger,
            "The run's loopback text server could not serve the slice: " +
                (error instanceof Error ? error.message : String(error)),
        );
    }
    const blockerSurfaceUrl = await preparedBlockerSurfaceUrl(host, state, context);
    if (blockerSurfaceUrl === undefined) {
        return unverified(
            logger,
            'The prepared blocker management surface could not be located, so the slice could ' +
                'not be imported.',
        );
    }
    const expectedStealthEnabled = expectedStealthEnabledFor(input.settings, preRead);
    const payloadStartedAt = Date.now();
    let settingsPayload: string;
    try {
        settingsPayload = await buildExtensionSettingsPayloadOverDedicatedPage(
            host,
            context,
            blockerSurfaceUrl,
            {
                enabledFilterIds: commonFilterIds,
                requiredGroupIds: requiredExtensionGroupIds(
                    commonFilterIds,
                    preRead.optionsData.filtersMetadata,
                ),
                customFilters: [{ customUrl, title, trusted: true, enabled: true }],
                ...(expectedStealthEnabled === undefined
                    ? {}
                    : { stealthEnabled: expectedStealthEnabled }),
            },
        );
    } catch (error) {
        logger.error({ err: error }, 'the settings document with the slice could not be built');
        return unverified(
            logger,
            'The settings document carrying the slice could not be built: ' +
                (error instanceof Error ? error.message : String(error)),
        );
    }
    logger.info(
        { settingsPayloadBytes: settingsPayload.length, payloadMs: Date.now() - payloadStartedAt },
        'the settings document carrying the slice was built',
    );
    const runner = createHostExtensionApplicationRunner({
        goal: { kind: ApplicationGoalKind.Baseline },
        expectedFilterIds: commonFilterIds,
        expectedCustomFilterTitles: [title],
        context,
        ...(host.phaseReadinessBudgetMs === undefined
            ? {}
            : { readinessBudgetMs: host.phaseReadinessBudgetMs }),
        logger,
    });
    const applyStartedAt = Date.now();
    const run = await runner.run({
        prompt: HOST_RUNNER_PROMPT,
        session: {
            targetUrl: input.targetUrl,
            blockerSurfaceUrl,
            settingsPayload,
            baselineEnabledFilterIds: commonFilterIds.map(adguardListKey),
            ...(expectedStealthEnabled === undefined
                ? {}
                : { expectStealthEnabled: expectedStealthEnabled }),
        },
        budget: { turns: APPLICATION_SESSION_MAX_TURNS, budgetMs: APPLICATION_SESSION_BUDGET_MS },
        ...(signal === undefined ? {} : { signal }),
    });
    logger[run.completed ? 'info' : 'warn'](
        {
            completed: run.completed,
            detail: run.detail,
            steps: run.actionLog,
            applyMs: Date.now() - applyStartedAt,
        },
        'the host applied the slice Baseline',
    );
    if (signal?.aborted) {
        return unverified(logger, 'The launch deadline aborted before the slice read-back.');
    }
    const readStartedAt = Date.now();
    let readBack: AdGuardExtensionStateRead;
    try {
        readBack = (await readExtensionBlockerState(host, state, context)).stateRead;
    } catch (error) {
        logger.error({ err: error }, 'the read-back after the slice application failed');
        return unverified(
            logger,
            'The read-back after the slice application failed: ' +
                (error instanceof Error ? error.message : String(error)),
        );
    }
    const verification = verifySliceReadBack(
        readBack,
        commonFilterIds,
        title,
        expectedStealthEnabled,
    );
    if (verification.mismatches.length > 0 || verification.customFilterId === undefined) {
        return unverified(
            logger,
            `The slice session did not verify: ${verification.mismatches.join('; ')}` +
                (run.completed ? '' : ` (the application did not complete: ${run.detail ?? ''})`),
            {
                enabledFilterIds: readBack.optionsEnabledFilterIds,
                readMs: Date.now() - readStartedAt,
            },
        );
    }
    // The verification above refused a read-back without counters, so they exist here.
    const facts = sliceFacts(slice, lines, verification.customFilterId, readBack.rulesLimits!);
    logger.info(
        {
            listSlice: { ...facts, lines: undefined },
            enabledFilterIds: readBack.optionsEnabledFilterIds,
            readMs: Date.now() - readStartedAt,
            totalMs: Date.now() - startedAt,
        },
        'the slice Baseline verified the prepared session',
    );
    return { kind: ListSliceBaselineOutcomeKind.Verified, readBack, listSlice: facts };
}
