import { createHash } from 'node:crypto';
import type { AdGuardExtensionSettingsProfile } from '../browser/adguard-extension-settings';
import { readAdGuardExtensionState as readAdGuardExtensionStateDefault } from '../browser/adguard-extension-state-read';
import { readBundledFilterCatalogIds } from '../browser/extension-filter-catalog';
import type { BrowserSession } from '../browser/browser-session';
import {
    classifyMissingCatalogFilterId,
    type MissingCatalogFilterClassification,
} from '../environment/third-party-filter-catalog';
import {
    BrowserExtensionEnvironmentOptions,
    EnvironmentPhaseConfigurationOutcome,
    type BrowserExtensionCreatedSession,
    type BrowserExtensionSessionRequest,
    type EnvironmentPhaseConfigurationRequest,
    type ExtensionBaselineSettings,
} from '../environment/browser-extension-environment';
import { ExtensionLaunchFamily } from '../environment/extension-launch';
import { adguardListKey } from '../environment/filter-list-ref';
import { normalizeRulesContent } from '../environment/rules-content';
import {
    readPreparedExtensionManifest,
    requireChromiumPreparedExtension,
} from '../local/prepared-extension';
import { createLogger, type Logger } from '../logger/logger';
import type { LoadedInstruction } from '../knowledge/instruction-loader';
import { SettingsProfileKind } from '../types/settings-profile-kind';
import { PhaseLabel } from '../types/validation';
import { ApplicationGoalKind } from '../validator/phase-application-contract';
import type { AgentRuntimeSessionState } from './agent-runtime-session-evidence';
import { launchFirefoxDeclaredBaseline } from './firefox-launch-baseline';
import { LaunchBaselineOutcomeKind, type LaunchBaselineOutcome } from './launch-baseline-outcome';
import { launchListSliceBaseline, ListSliceBaselineOutcomeKind } from './list-slice-baseline';
import { runApplication } from './phase-application-flow';
import {
    applicationInstructionContent,
    type PhaseApplicationFlowHost,
} from './phase-application-flow-host';
import { expectedStealthEnabledFor, launchBaselineFilterIds } from './phase-application-wiring';

/**
 * The launch-time Baseline application and the browser-extension environment adapter's production
 * options: what runs right after `launch_browser` establishes a prepared session, and what the
 * concrete Extension environment adapter is built with. Both build on `phase-application-flow.ts`'s
 * `runApplication`, so one procedure credits the launch's Baseline and every between-phases
 * application; a launch with `settings.slice` delegates to `list-slice-baseline.ts` instead.
 * Neither module imports `agent-runtime.ts`; the runtime privates travel in as callbacks. The
 * outcome vocabulary and its model-facing projection live in `launch-baseline-outcome.ts`.
 */

/**
 * Degrade one expected filter set onto the filter IDs the prepared build actually carries.
 *
 * Settings that name filters the installed build catalog does not list leave the expected set
 * behind instead of failing the launch: each missing ID is classified against the pinned registry
 * and recorded as a filter-selection approximation, and only the convergent subset is applied and
 * compared. A set with no convergent subset at all cannot be honored, so the launch rejects it here
 * — typed by the classified conflicts and logged with them — before any application session
 * starts.
 *
 * @param extensionPath - Unpacked root of the prepared extension build.
 * @param expectedFilterIds - Exact filter IDs the settings request expects enabled.
 * @param logger - Run logger for the degradation record.
 * @param recordFilterFidelity - Callback recording the run's filter-selection approximation.
 * @returns The convergent subset, or undefined when no requested filter remains.
 */
async function convergeExpectedFilterIds(
    extensionPath: string,
    expectedFilterIds: readonly number[],
    logger: Logger,
    recordFilterFidelity: (conflicts: readonly MissingCatalogFilterClassification[]) => void,
): Promise<number[] | undefined> {
    const catalogFilterIds = await readBundledFilterCatalogIds(extensionPath);
    if (!catalogFilterIds) {
        // The bundled catalog is an optimization source only: without it the exact expectation
        // stays and the options read-back decides.
        return [...expectedFilterIds];
    }
    const missingFilterIds = expectedFilterIds.filter(
        (filterId) => !catalogFilterIds.has(filterId),
    );
    if (missingFilterIds.length === 0) {
        return [...expectedFilterIds];
    }
    const conflicts = missingFilterIds.map((filterId) => classifyMissingCatalogFilterId(filterId));
    recordFilterFidelity(conflicts);
    const convergentFilterIds = expectedFilterIds.filter((filterId) =>
        catalogFilterIds.has(filterId),
    );
    if (convergentFilterIds.length === 0) {
        logger.error(
            {
                conflicts,
                missingFilterIds: [...missingFilterIds],
            },
            'the requested filter set has no convergent subset in the prepared build catalog',
        );
        return undefined;
    }
    logger.warn(
        {
            conflicts,
            skippedFilterIds: [...missingFilterIds],
            convergentFilterIds,
        },
        'the requested filter set degraded onto the prepared build catalog subset',
    );
    return convergentFilterIds;
}

/**
 * Run the prepared session's Baseline application right after its launch.
 *
 * The launch route does not rely on launch-time settings pieces: the instruction's steps (exactly
 * like phase B in the environment route) plus the host read-back produce the session's settings
 * record, and `settingsVerified` is gated on that record. The expected filter set is the state the
 * exact requested settings name — the pre-read defaults plus the required IDs for a
 * defaults-plus-required request — degraded onto the filters the installed build catalog actually
 * carries.
 *
 * @param host - The runtime seam this flow acts through.
 * @param state - The launched session's state record.
 * @param session - The just-launched session carrying its persistent context.
 * @param targetUrl - Canonical target the session was created for.
 * @param settings - Model-selected extension settings profile of the launch request.
 * @param recordFilterFidelity - Callback recording the run's filter-selection approximation.
 * @param signal - Launch deadline signal: an abort settles the outcome unverified.
 * @returns The verified read-back, or the refusal/unverified detail the launch result carries.
 */
export async function launchExtensionBaseline(
    host: PhaseApplicationFlowHost,
    state: AgentRuntimeSessionState,
    session: BrowserSession,
    targetUrl: string,
    settings: AdGuardExtensionSettingsProfile | undefined,
    recordFilterFidelity: (conflicts: readonly MissingCatalogFilterClassification[]) => void,
    signal?: AbortSignal,
): Promise<LaunchBaselineOutcome> {
    const logger = createLogger({ verbose: host.verbose });
    const extension = state.extension;
    // The launch Baseline below is the AdGuard route's own settings proof: it pre-reads the live
    // extension state, converges the requested filter set against the build's bundled catalog and
    // credits the session from a state read-back. A Firefox-family build has none of those — no
    // unpacked directory, no driveable extension page — so its baseline is the instruction's own
    // declaration, applied by the browser when it force-installed the XPI, and its phases are
    // credited by the host-performed file-backed application between them.
    if (extension && extension.launchFamily === ExtensionLaunchFamily.Firefox) {
        const declared = launchFirefoxDeclaredBaseline(extension, logger);
        if (declared === null) {
            return {
                kind: LaunchBaselineOutcomeKind.Unverified,
                detail:
                    `The ${extension.extensionId} launch declaration selects no filter list, so ` +
                    'this session has no executable baseline to credit.',
            };
        }
        return {
            kind: LaunchBaselineOutcomeKind.Declared,
            listKeys: declared.listKeys,
            detail: declared.detail,
        };
    }
    if (!extension || !session.extensionContext || !settings) {
        const detail =
            'The prepared launch session carried no verified extension context and requested ' +
            'settings, so the Baseline application could not run.';
        logger.warn({}, 'the launch Baseline application could not run');
        return { kind: LaunchBaselineOutcomeKind.Unverified, detail };
    }
    const chromiumLaunch = requireChromiumPreparedExtension(
        extension,
        'The launch Baseline application',
    );
    if (signal?.aborted) {
        const detail =
            'The launch deadline aborted before the Baseline application; no prepared settings ' +
            'could be verified.';
        logger.warn({}, 'the launch Baseline application was aborted before it ran');
        return { kind: LaunchBaselineOutcomeKind.Unverified, detail };
    }
    const context = session.extensionContext;
    host.applicationReadContexts.set(session, context);
    const readState = host.readAdGuardExtensionState ?? readAdGuardExtensionStateDefault;
    let preReadFailure: string | undefined;
    const preRead = await readState(context, chromiumLaunch.manifestVersion).catch((error) => {
        preReadFailure = error instanceof Error ? error.message : String(error);
        logger.error(
            { error: preReadFailure },
            'the launch read-back of the prepared extension state failed',
        );
        return undefined;
    });
    if (!preRead) {
        return {
            kind: LaunchBaselineOutcomeKind.Unverified,
            detail:
                'The launch pre-read of the prepared extension state failed before any ' +
                `application: ${preReadFailure ?? 'unknown error'}`,
        };
    }
    if (signal?.aborted) {
        const detail =
            'The launch deadline aborted after the pre-read, before the Baseline application ' +
            'could run.';
        logger.warn({}, 'the launch Baseline application was aborted after its pre-read');
        return { kind: LaunchBaselineOutcomeKind.Unverified, detail };
    }
    // A sliced list runs as a custom filter, so it leaves the built-in set the Baseline applies;
    // the remaining common lists converge like any other request.
    const slice = settings.kind === SettingsProfileKind.AgentSelected ? settings.slice : undefined;
    const requestedFilterIds = launchBaselineFilterIds(
        settings,
        preRead.optionsEnabledFilterIds,
    ) ?? [...preRead.optionsEnabledFilterIds];
    const baselineEnabledFilterIds = await convergeExpectedFilterIds(
        chromiumLaunch.extensionPath,
        slice === undefined
            ? requestedFilterIds
            : requestedFilterIds.filter((filterId) => filterId !== slice.filterId),
        logger,
        recordFilterFidelity,
    );
    if (baselineEnabledFilterIds === undefined) {
        return {
            kind: LaunchBaselineOutcomeKind.Unverified,
            detail:
                'The requested filter set has no convergent subset in the prepared build ' +
                'catalog, so the launch Baseline could not be applied.',
        };
    }
    if (slice !== undefined) {
        const outcome = await launchListSliceBaseline({
            host,
            state,
            context,
            extension: chromiumLaunch,
            targetUrl,
            settings,
            slice,
            preRead,
            commonFilterIds: baselineEnabledFilterIds,
            ...(signal === undefined ? {} : { signal }),
        });
        return outcome.kind === ListSliceBaselineOutcomeKind.Verified
            ? {
                  kind: LaunchBaselineOutcomeKind.Verified,
                  readBack: outcome.readBack,
                  listSlice: outcome.listSlice,
              }
            : { kind: LaunchBaselineOutcomeKind.Unverified, detail: outcome.detail };
    }
    const request: EnvironmentPhaseConfigurationRequest = {
        phase: PhaseLabel.B,
        targetUrl,
        candidateRule: null,
        application: applicationInstructionContent(host.instruction),
        baselineEnabledFilterIds: baselineEnabledFilterIds.map(adguardListKey),
        ...(signal === undefined ? {} : { signal }),
    };
    const { result, stateRead } = await runApplication(
        host,
        state,
        request,
        { kind: ApplicationGoalKind.Baseline },
        session,
        expectedStealthEnabledFor(settings, preRead),
        // state.extensionBaselineReadBack does not exist until this very call returns it: the
        // settings payload's required groups come from this pre-read's own filter catalog instead.
        preRead.optionsData.filtersMetadata,
    );
    if (result.kind === EnvironmentPhaseConfigurationOutcome.Refused) {
        // The refusal's stable gap and its bounded detail both go to the run log and to the launch
        // result, so the model learns why the Baseline could not run.
        logger.warn(
            { outcome: result.kind, gap: result.gap, detail: result.detail },
            'the launch Baseline application was refused before any model turn',
        );
        return {
            kind: LaunchBaselineOutcomeKind.Refused,
            gap: result.gap,
            detail: result.detail,
        };
    }
    if (
        result.kind !== EnvironmentPhaseConfigurationOutcome.Applied ||
        stateRead === undefined ||
        normalizeRulesContent(stateRead.userRules.content).length !== 0
    ) {
        // The baseline session must end with exactly the requested filter set and no user rule;
        // anything else leaves settingsVerified false, and the model learns the detail.
        const unverified =
            result.kind === EnvironmentPhaseConfigurationOutcome.Unverified ? result : undefined;
        const detail =
            unverified?.detail ??
            'The launch Baseline application ran but left user rules in the baseline state.';
        logger.warn(
            { outcome: result.kind, detail, settingsLimitation: unverified?.settingsLimitation },
            'the launch Baseline application did not verify the prepared settings',
        );
        return {
            kind: LaunchBaselineOutcomeKind.Unverified,
            detail,
            ...(unverified?.settingsLimitation === undefined
                ? {}
                : { settingsLimitation: unverified.settingsLimitation }),
        };
    }
    logger.info(
        {
            enabledFilterIds: [...stateRead.optionsEnabledFilterIds],
            optionsPageUrl: stateRead.optionsPageUrl,
        },
        'the launch Baseline application verified the prepared settings',
    );
    return { kind: LaunchBaselineOutcomeKind.Verified, readBack: stateRead };
}

/**
 * Runtime privates the environment-adapter options still need, bound to one prepared session.
 */
export interface BrowserExtensionEnvironmentCallbacks {
    /**
     * Read the session's locked baseline-identity filter sets from its launch read-back record.
     */
    extensionBaselineSettingsFor: () => ExtensionBaselineSettings;

    /**
     * Create one adapter-owned browser session in the exact requested filtering state.
     */
    createSession: (
        request: BrowserExtensionSessionRequest,
    ) => Promise<BrowserExtensionCreatedSession>;

    /**
     * The between-phases configuration option the adapter calls back into for this session.
     */
    phaseConfiguration: NonNullable<BrowserExtensionEnvironmentOptions['phaseConfiguration']>;
}

/**
 * Build production options for the concrete Extension environment adapter.
 *
 * A prepared release build records exactly one version — manifest.json's own — so the adapter's
 * package and manifest version strings are that single value; the build-from-source distinction
 * between source-package and built-manifest versions is gone with that mechanism.
 *
 * @param instruction - The run instruction loaded at run start, when this run carries one.
 * @param state - Active prepared Extension session selected by the model.
 * @param callbacks - The runtime privates this construction still needs, bound to `state`.
 * @returns Verified build, settings, browser, and phase-session seams.
 */
export function buildBrowserExtensionEnvironmentOptions(
    instruction: LoadedInstruction | undefined,
    state: AgentRuntimeSessionState,
    callbacks: BrowserExtensionEnvironmentCallbacks,
): BrowserExtensionEnvironmentOptions {
    if (!state.extension || !state.settingsProfile || !state.extensionBaselineReadBack) {
        throw new Error('A verified prepared Extension session is required.');
    }
    // This adapter locks its baseline from an unpacked root's own manifest and resource bytes, so
    // it is a Chromium-family construction by definition; a Firefox-family build fails named here
    // rather than reaching a baseline lock that would find no manifest. The Chromium record is
    // structurally the serialized single-source provenance: the proof schema and the runtime carry
    // the same field set.
    const provenance = requireChromiumPreparedExtension(
        state.extension,
        'Building the Extension environment options',
    );
    const { packageVersion } = readPreparedExtensionManifest(provenance.extensionPath);
    const buildDigest = createHash('sha256').update(JSON.stringify(provenance)).digest('hex');
    return {
        extensionRoot: provenance.extensionPath,
        packageVersion,
        manifestVersion: packageVersion,
        profileKind: state.settingsProfile.kind,
        application: applicationInstructionContent(instruction),
        extensionProvenance: provenance,
        buildDigest,
        settingsProvider: async () => structuredClone(callbacks.extensionBaselineSettingsFor()),
        createSession: callbacks.createSession,
        phaseConfiguration: callbacks.phaseConfiguration,
    };
}
