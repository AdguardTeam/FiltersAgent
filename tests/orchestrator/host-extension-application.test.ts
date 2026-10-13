import { describe, expect, it } from 'vitest';
import type { ExtensionCustomFilterEntry } from '../../src/browser/adguard-custom-filters';
import { AdGuardExtensionMessageType } from '../../src/browser/adguard-extension-message-types';
import { BlockerVerificationMethod } from '../../src/environment/environment-proofs';
import { HostApplicationStep } from '../../src/environment/host-application-step';
import { adguardListKey } from '../../src/environment/filter-list-ref';
import { createLogger } from '../../src/logger/logger';
import { createHostExtensionApplicationRunner } from '../../src/orchestrator/host-extension-application';
import { createPromptDocumentLoader, PromptDocumentName } from '../../src/prompts/prompt-documents';
import {
    ApplicationGoalKind,
    PhaseApplicationOutcomeKind,
    type ApplicationGoal,
    type PhaseApplicationResult,
} from '../../src/validator/phase-application-contract';
import { runPhaseApplication } from '../../src/validator/phase-application-procedure';
import {
    fakePreparedExtensionSurface,
    type FakePreparedExtensionSurface,
} from '../environment/test-filtering-environment-fixtures';

/**
 * The contract this suite holds: on the built-in AdGuard route the host brings the extension to the
 * prepared state itself, over the app-message protocol the shipped document specifies, and the
 * phase is still credited by the same read-back-and-credit procedure every other application path
 * runs through. A regression here is a candidate phase that observes a browser the run never
 * actually configured.
 */

const CANDIDATE_RULE = 'example.org##.promo-banner';

const PREPARED_FILTER_ID = 2;

const SURFACE_URL = 'chrome-extension://test-extension-id/pages/options.html';

/**
 * The custom filter a list-slice session installs: one built-in list's line range, served by the
 * host and titled after the list.
 */
const SLICE_CUSTOM_FILTER = {
    customUrl: 'http://127.0.0.1:41234/slice-14.txt',
    title: 'EasyList Hebrew lines 1-900 of 1766',
    trusted: true,
    enabled: true,
};

/**
 * A custom filter the import installed that no expectation names.
 */
const STRAY_CUSTOM_FILTER = {
    customUrl: 'http://127.0.0.1:41234/stray.txt',
    title: 'stray',
    trusted: true,
    enabled: true,
};

/**
 * What one application run carries beyond its goal.
 */
interface ApplicationOptions {
    /**
     * Custom filters the settings document installs.
     */
    customFilters?: readonly ExtensionCustomFilterEntry[];

    /**
     * Titles of the custom filters the runner must leave enabled.
     */
    expectedCustomFilterTitles?: readonly string[];
}

/**
 * The settings-import document the host built for the phase, as the runner receives it.
 *
 * Only the enabled-filter list and the custom filters matter to the fake surface, which imports
 * exactly what the document names, so the rest is the shape a real export carries.
 *
 * @param enabledFilterIds - Official filter IDs the document enables.
 * @param customFilters - Custom filters the document installs.
 * @returns The document as a JSON string.
 */
function settingsPayload(
    enabledFilterIds: readonly number[],
    customFilters: readonly ExtensionCustomFilterEntry[] = [],
): string {
    return JSON.stringify({
        'protocol-version': '1.0',
        'general-settings': { 'allow-acceptable-ads': false },
        'extension-specific-settings': {},
        filters: {
            'enabled-filters': [...enabledFilterIds],
            'enabled-groups': [1],
            'custom-filters': [...customFilters],
        },
        stealth: { 'stealth-disable-stealth-mode': true },
    });
}

/**
 * Run one application the way the flow runs it: the host runner performs the steps, then the host
 * reads the state back over the same fake extension and the shared credit judges it.
 *
 * @param surface - The fake prepared-extension surface the application acts on.
 * @param goal - The expected blocker state.
 * @param options - Custom filters the document installs and the titles the runner keeps.
 * @returns The credited application result.
 */
async function applyOverSurface(
    surface: FakePreparedExtensionSurface,
    goal: ApplicationGoal,
    options: ApplicationOptions = {},
): Promise<PhaseApplicationResult> {
    return runPhaseApplication({
        // The shipped built-in document is the contract the host runner implements, so the suite
        // runs the real one rather than a paraphrase of its steps.
        application: createPromptDocumentLoader().read(
            PromptDocumentName.InstructionsAdguardExtension,
        ),
        goal,
        session: {
            targetUrl: 'https://nettg.pl/',
            blockerSurfaceUrl: SURFACE_URL,
            settingsPayload: settingsPayload([PREPARED_FILTER_ID], options.customFilters),
            baselineEnabledFilterIds: [adguardListKey(PREPARED_FILTER_ID)],
        },
        runner: createHostExtensionApplicationRunner({
            goal,
            expectedFilterIds: [PREPARED_FILTER_ID],
            ...(options.expectedCustomFilterTitles === undefined
                ? {}
                : { expectedCustomFilterTitles: options.expectedCustomFilterTitles }),
            context: surface.context,
            importSettleDelayMs: 5,
            logger: createLogger(),
        }),
        readBack: {
            // The live extension read-back, reported from the very state the steps left behind on
            // the fake extension: what the host did is what the credit then judges.
            [BlockerVerificationMethod.ExtensionState]: async () => ({
                rulesContent: surface.savedUserRules() ?? '',
                enabledFilterIds: surface.enabledFilterIds().map(adguardListKey),
                limitsExceeded: false,
            }),
        },
    });
}

describe('the host-performed AdGuard application', () => {
    it('brings the extension to the candidate state over the protocol and is credited by the read-back', async () => {
        const surface = fakePreparedExtensionSurface({ initialEnabledFilterIds: [] });

        const result = await applyOverSurface(surface, {
            kind: ApplicationGoalKind.Candidate,
            rule: CANDIDATE_RULE,
        });

        // Readiness, then the import, then the enabled-set confirmation, then the candidate: the
        // order the shipped document specifies, with no step invented and none skipped.
        expect(surface.messages.map((message) => message.type)).toEqual([
            AdGuardExtensionMessageType.GetIsAppInitialized,
            AdGuardExtensionMessageType.ApplySettingsJson,
            AdGuardExtensionMessageType.GetOptionsData,
            AdGuardExtensionMessageType.SaveUserRules,
        ]);
        expect(surface.savedUserRules()).toBe(CANDIDATE_RULE);
        expect(surface.enabledFilterIds()).toEqual([PREPARED_FILTER_ID]);
        // The credit comes from the ordinary read-back procedure, not from the runner's report.
        expect(result).toMatchObject({
            kind: PhaseApplicationOutcomeKind.Applied,
            readBack: { rulesContent: CANDIDATE_RULE },
        });
        if (result.kind !== PhaseApplicationOutcomeKind.Applied) {
            throw new Error(`the application was not credited: ${result.kind} ${result.detail}`);
        }
        expect(result.actionLog.map((entry) => entry.tool)).toEqual([
            HostApplicationStep.AwaitExtensionReady,
            HostApplicationStep.ApplyExtensionSettings,
            HostApplicationStep.ReconcileEnabledFilters,
            HostApplicationStep.SaveExtensionUserRules,
        ]);
        expect(result.actionLog.every((entry) => entry.ok)).toBe(true);
    });

    it('keeps importing while a freshly installed extension still refuses the document', async () => {
        // `getIsAppInitialized` turns true before a fresh install has settled: a live run got the
        // import refused in half of its phases. The import's own answer is the readiness signal.
        const surface = fakePreparedExtensionSurface({
            initialEnabledFilterIds: [],
            refusedImports: 2,
        });

        const result = await applyOverSurface(surface, { kind: ApplicationGoalKind.Baseline });

        expect(
            surface.messages.filter(
                (message) => message.type === AdGuardExtensionMessageType.ApplySettingsJson,
            ),
        ).toHaveLength(3);
        expect(surface.enabledFilterIds()).toEqual([PREPARED_FILTER_ID]);
        expect(result.kind).toBe(PhaseApplicationOutcomeKind.Applied);
    });

    it('turns off a filter the import left enabled and stops after three reconciliation rounds', async () => {
        // A build that re-enables one filter from settings of its own, whatever it is told — the
        // live failure the reconciliation exists for, and the reason it is bounded.
        const surface = fakePreparedExtensionSurface({ stubbornFilterIds: [10] });

        const result = await applyOverSurface(surface, { kind: ApplicationGoalKind.Baseline });

        const disables = surface.messages.filter(
            (message) => message.type === AdGuardExtensionMessageType.DisableFilter,
        );
        expect(disables.map((message) => message.data?.filterId)).toEqual([10, 10, 10]);
        // The unexpected filter is still on, so the phase is not credited and the detail names the
        // state the host read back rather than the steps it took.
        expect(result).toMatchObject({
            kind: PhaseApplicationOutcomeKind.Unverified,
            detail: expect.stringContaining('10'),
        });
    });
});

describe('the custom filters of the host-performed application', () => {
    it('keeps the custom filter the expectation names and turns off every other one', async () => {
        // A list-slice session installs one list's line range as a custom filter; the import gives
        // it an id from 1000 up that no expectation can name in advance, so the runner recognises
        // it by the title the host gave it and leaves it on, while a custom filter no expectation
        // names is a stray like any built-in filter the import left on.
        const surface = fakePreparedExtensionSurface({ initialEnabledFilterIds: [] });

        const result = await applyOverSurface(
            surface,
            { kind: ApplicationGoalKind.Baseline },
            {
                customFilters: [SLICE_CUSTOM_FILTER, STRAY_CUSTOM_FILTER],
                expectedCustomFilterTitles: [SLICE_CUSTOM_FILTER.title],
            },
        );

        expect(surface.customFilters()).toEqual([
            {
                filterId: 1000,
                name: SLICE_CUSTOM_FILTER.title,
                customUrl: SLICE_CUSTOM_FILTER.customUrl,
            },
        ]);
        const disables = surface.messages.filter(
            (message) => message.type === AdGuardExtensionMessageType.DisableFilter,
        );
        expect(disables.map((message) => message.data?.filterId)).toEqual([1001]);
        expect(result.kind).toBe(PhaseApplicationOutcomeKind.Applied);
        if (result.kind !== PhaseApplicationOutcomeKind.Applied) {
            throw new Error(`the application was not credited: ${result.kind} ${result.detail}`);
        }
        // The step record names the custom filter it kept, so the evidence says which slice ran.
        const reconciled = result.actionLog.find(
            (entry) => entry.tool === HostApplicationStep.ReconcileEnabledFilters,
        );
        expect(reconciled).toMatchObject({
            ok: true,
            summary: expect.stringContaining(SLICE_CUSTOM_FILTER.title),
        });
    });

    it('turns a custom filter off when the expectation names none', async () => {
        const surface = fakePreparedExtensionSurface({ initialEnabledFilterIds: [] });

        const result = await applyOverSurface(
            surface,
            { kind: ApplicationGoalKind.Baseline },
            { customFilters: [SLICE_CUSTOM_FILTER] },
        );

        expect(surface.customFilters()).toEqual([]);
        const disables = surface.messages.filter(
            (message) => message.type === AdGuardExtensionMessageType.DisableFilter,
        );
        expect(disables.map((message) => message.data?.filterId)).toEqual([1000]);
        expect(result.kind).toBe(PhaseApplicationOutcomeKind.Applied);
    });
});
