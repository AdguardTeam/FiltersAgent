import type { BrowserContext, Page } from 'playwright-core';
import {
    EnvironmentCapability,
    EnvironmentPreparationState,
    FilteringEnvironmentAvailability,
    type FilteringEnvironmentDescriptor,
} from '../../src/environment/environment-vocabulary';
import { ExtensionManifestVersion } from '../../src/environment/extension-preparation';
import {
    CUSTOM_FILTERS_GROUP_ID,
    CUSTOM_FILTERS_START_ID,
    type ExtensionCustomFilterEntry,
} from '../../src/browser/adguard-custom-filters';
import { AdGuardExtensionMessageType } from '../../src/browser/adguard-extension-message-types';
import type {
    AdGuardExtensionStateRead,
    AdGuardMv3RulesLimitsEvidence,
} from '../../src/browser/adguard-extension-state-shapes';
import { FilterEngine } from '../../src/types/filter-engine';

/**
 * The consistent MV3 app version {@link readBackStateFixture} reports by default, both at the top
 * level and inside `optionsData`. A suite whose surrounding fixtures declare a different pinned
 * version passes its own `appVersion` override instead of letting the two drift apart.
 */
const DEFAULT_APP_VERSION = '5.4.3.99';

/**
 * The group the fake surface files every built-in filter under, so a consumer that derives required
 * groups from the options metadata sees a group distinct from the custom filters group.
 */
const BUILT_IN_FILTER_GROUP_ID = 1;

/**
 * Chrome's cap on enabled static DNR rulesets (`MAX_NUMBER_OF_ENABLED_STATIC_RULESETS`): the limit
 * the reporter's 52-filter set overshot in AdguardFilters#242720.
 */
const CHROME_MAX_ENABLED_STATIC_RULESETS = 50;

/**
 * Chrome's global static rule budget across the enabled rulesets, as the extension's rules-limits
 * service reports it as `staticRulesMaximumCount`.
 */
const CHROME_MAX_STATIC_RULES = 330_000;

/**
 * Static rules the kept rulesets of {@link exceededRulesLimitsFixture} contribute: well under the
 * budget, so the fixture exceeds the ruleset count alone, as the live case did.
 */
const KEPT_STATIC_RULES_COUNT = 120_000;

/**
 * Fresh fake descriptor for the browser-extension executor: available, not started, and carrying
 * the capabilities the extension executor registers in production.
 *
 * @returns A descriptor fixture independent of any default executor list.
 */
export function extensionExecutorDescriptor(): FilteringEnvironmentDescriptor {
    return {
        kind: 'browser_extension',
        availability: FilteringEnvironmentAvailability.Available,
        preparationState: EnvironmentPreparationState.NotStarted,
        limitationCode: null,
        capabilities: [
            EnvironmentCapability.BrowserNavigation,
            EnvironmentCapability.FilteringControl,
            EnvironmentCapability.ExtensionFiltering,
            EnvironmentCapability.CandidateApplication,
            EnvironmentCapability.BaselineIntegrity,
            EnvironmentCapability.PhaseProof,
        ],
    };
}

/**
 * Fresh fake descriptor for the preparable AdGuard CLI proxy executor: available and ready to
 * prepare, carrying only the CLI capabilities that executor registers in production.
 *
 * @returns A descriptor fixture independent of any default executor list.
 */
export function cliExecutorDescriptor(): FilteringEnvironmentDescriptor {
    return {
        kind: 'adguard_cli',
        availability: FilteringEnvironmentAvailability.Available,
        preparationState: EnvironmentPreparationState.Preparable,
        limitationCode: null,
        capabilities: [EnvironmentCapability.CliInstallation, EnvironmentCapability.CliActivation],
    };
}

/**
 * Field overrides for {@link readBackStateFixture}.
 */
export interface ReadBackStateFixtureOptions {
    /**
     * App version the read-back reports, both at the top level and inside `optionsData` — a live
     * read-back always agrees between the two, so the fixture exposes a single knob for both
     * instead of letting callers set them independently.
     */
    appVersion?: string;

    /**
     * The MV3 rules-limits counters the read-back reports, when a suite needs the extension to
     * report limits exceeded; `optionsData.runtimeInfo` follows their flag. Absent (the default)
     * reports no counters at all.
     */
    rulesLimits?: AdGuardMv3RulesLimitsEvidence;
}

/**
 * The rules-limits counters the extension reports after Chrome refused part of a requested filter
 * set: the requested filters as expected, the ones Chrome kept as actually enabled, and the
 * counters against Chrome's static limits, limits exceeded.
 *
 * @param expectedEnabledFilters - Filter IDs the settings import asked the extension to enable.
 * @param actuallyEnabledFilters - Filter IDs Chrome kept enabled.
 * @returns The counters to hand {@link readBackStateFixture} as `rulesLimits`.
 */
export function exceededRulesLimitsFixture(
    expectedEnabledFilters: readonly number[],
    actuallyEnabledFilters: readonly number[],
): AdGuardMv3RulesLimitsEvidence {
    return {
        dynamicRulesEnabledCount: 0,
        dynamicRulesMaximumCount: 0,
        dynamicRulesUnsafeEnabledCount: 0,
        dynamicRulesUnsafeMaximumCount: 0,
        dynamicRulesRegexpsEnabledCount: 0,
        dynamicRulesRegexpsMaximumCount: 0,
        staticFiltersEnabledCount: actuallyEnabledFilters.length,
        staticFiltersMaximumCount: CHROME_MAX_ENABLED_STATIC_RULESETS,
        staticRulesEnabledCount: KEPT_STATIC_RULES_COUNT,
        staticRulesMaximumCount: CHROME_MAX_STATIC_RULES,
        staticRulesRegexpsEnabledCount: 0,
        staticRulesRegexpsMaxCount: 0,
        actuallyEnabledFilters: [...actuallyEnabledFilters],
        expectedEnabledFilters: [...expectedEnabledFilters],
        areFilterLimitsExceeded: true,
    };
}

/**
 * The host read-back one fake prepared-extension session reports: the given filter set enabled, no
 * user rules, Stealth off, and a consistent MV3 app version.
 *
 * @param enabledFilterIds - Filter IDs the observed options state reports enabled.
 * @param options - Fields this suite needs to differ from the default fixture.
 * @returns Consistent prepared-extension state read.
 */
export function readBackStateFixture(
    enabledFilterIds: readonly number[] = [2],
    options: ReadBackStateFixtureOptions = {},
): AdGuardExtensionStateRead {
    const appVersion = options.appVersion ?? DEFAULT_APP_VERSION;
    return {
        extensionId: 'test-extension-id',
        optionsPageUrl: 'chrome-extension://test-extension-id/pages/options.html',
        manifestVersion: ExtensionManifestVersion.Mv3,
        filterEngine: FilterEngine.DeclarativeNetRequest,
        appVersion,
        optionsEnabledFilterIds: [...enabledFilterIds],
        optionsData: {
            appVersion,
            settings: { values: { 'stealth-disable-stealth-mode': true } },
            filtersMetadata: {
                filters: [...enabledFilterIds].map((filterId) => ({
                    filterId,
                    enabled: true,
                    name: 'AdGuard Base filter',
                })),
                categories: [{ groupId: 2, groupName: 'Ads' }],
            },
            runtimeInfo: {
                areFilterLimitsExceeded: options.rulesLimits?.areFilterLimitsExceeded ?? false,
            },
        },
        userRules: {
            manifestVersion: ExtensionManifestVersion.Mv3,
            ruleCount: 0,
            contentSha256: 'b'.repeat(64),
            rulesLimits: null,
            content: '',
        },
        rulesLimits: options.rulesLimits ?? null,
    };
}

/**
 * The filters section of an imported settings document.
 */
interface ImportedFiltersSection {
    /**
     * Official filter IDs the document enables.
     */
    'enabled-filters'?: unknown;

    /**
     * Custom filters the document installs, as the host's own payload builder writes them.
     */
    'custom-filters'?: ExtensionCustomFilterEntry[];
}

/**
 * One custom filter the fake surface installed from an import.
 */
export interface FakeCustomFilter {
    /**
     * The id the import allocated, from 1000 up in import order.
     */
    filterId: number;

    /**
     * The name the surface stores: the entry's title, or its URL when it carried none.
     */
    name: string;

    /**
     * The entry's URL, recorded and never fetched.
     */
    customUrl: string;
}

/**
 * The only part of an imported settings document the fake surface reads back.
 */
interface ImportedSettingsDocument {
    /**
     * The document's filters section, when it carries one.
     */
    filters?: ImportedFiltersSection;
}

/**
 * One app message a fake prepared-extension surface received.
 */
export interface FakeExtensionMessage {
    /**
     * The message type, exactly as the sender spelled it.
     */
    type: string;

    /**
     * The message payload, when the sender carried one.
     */
    data?: Record<string, unknown>;
}

/**
 * Knobs of {@link fakePreparedExtensionSurface}.
 */
export interface FakeExtensionSurfaceOptions {
    /**
     * Filter IDs the surface reports enabled before any settings import.
     */
    initialEnabledFilterIds?: readonly number[];

    /**
     * Filter IDs the surface keeps enabled whatever it is told: it re-adds them after every import
     * and ignores `disableFilter` for them. Models the build that re-enables filters from settings
     * of its own, which is what the enabled-filter reconciliation exists for.
     */
    stubbornFilterIds?: readonly number[];

    /**
     * How many settings imports the surface refuses (answers `false`, changes nothing) before it
     * accepts one. Models a fresh install that reports itself initialized while its bootstrap is
     * still settling.
     */
    refusedImports?: number;
    /**
     * App version the options data reports.
     */
    appVersion?: string;
}

/**
 * A fake prepared-extension management surface: a persistent context whose pages answer the AdGuard
 * app-message protocol the host speaks.
 */
export interface FakePreparedExtensionSurface {
    /**
     * The persistent context the host opens its dedicated surface pages on.
     */
    context: BrowserContext;

    /**
     * Every app message the surface received, in the order it received them.
     */
    messages: readonly FakeExtensionMessage[];

    /**
     * Built-in filter IDs the surface currently reports enabled, ascending and distinct. Custom
     * filters are listed by {@link customFilters} instead.
     */
    enabledFilterIds: () => number[];

    /**
     * The custom filters the last accepted import installed and no `disableFilter` removed since,
     * in import order.
     */
    customFilters: () => FakeCustomFilter[];

    /**
     * The user-rules text the last `saveUserRules` stored, or undefined when none was sent.
     */
    savedUserRules: () => string | undefined;
}

/**
 * Build a fake prepared-extension management surface for the host's own application protocol.
 *
 * The host performs the built-in AdGuard route's application itself — wait for readiness, import
 * the settings document, reconcile the enabled filters, save the candidate — so a suite that
 * launches a prepared session needs a surface that behaves like the extension for those messages,
 * not a page that answers `true` to everything. State lives on the context, not the page: the
 * settings-payload pre-read and the application itself each open their own dedicated page.
 *
 * Custom filters follow the pinned build's import: every accepted import drops the ones before it
 * and installs the document's enabled entries with ids allocated from 1000 up, named by their title
 * and filed under the custom filters group. The surface never fetches an entry's URL — the text
 * behind it is no concern of the protocol this fake models.
 *
 * @param options - What the surface starts with and what it refuses to turn off.
 * @returns The context to hand a fake prepared session, plus what the surface observed.
 */
export function fakePreparedExtensionSurface(
    options: FakeExtensionSurfaceOptions = {},
): FakePreparedExtensionSurface {
    const stubborn = [...(options.stubbornFilterIds ?? [])];
    let importsLeftToRefuse = options.refusedImports ?? 0;
    const enabled = new Set<number>([...(options.initialEnabledFilterIds ?? [2]), ...stubborn]);
    const customFilters: FakeCustomFilter[] = [];
    const appVersion = options.appVersion ?? DEFAULT_APP_VERSION;
    const messages: FakeExtensionMessage[] = [];
    let savedUserRules: string | undefined;

    /**
     * The enabled set as the extension reports it.
     *
     * @returns Ascending distinct filter IDs.
     */
    const enabledFilterIds = (): number[] => [...enabled].sort((left, right) => left - right);

    /**
     * The complete settings export `loadSettingsJson` answers with: every section a real AdGuard
     * export carries, so the settings-payload pre-read never throws for a missing one.
     *
     * @returns The export as a JSON string.
     */
    const settingsExport = (): string =>
        JSON.stringify({
            'protocol-version': '1.0',
            'general-settings': { 'app-language': 'en', 'allow-acceptable-ads': false },
            'extension-specific-settings': { 'use-optimized-filters': false },
            filters: {
                'enabled-filters': enabledFilterIds(),
                'enabled-groups': [1],
                'custom-filters': [],
            },
            stealth: { 'stealth-disable-stealth-mode': true },
        });

    /**
     * Answer one app message the way the pinned build answers it.
     *
     * @param message - The routed message the sender handed `page.evaluate`.
     * @returns The background response.
     */
    const respond = (message: FakeExtensionMessage): unknown => {
        messages.push({ type: message.type, ...(message.data ? { data: message.data } : {}) });
        switch (message.type) {
            case AdGuardExtensionMessageType.GetIsAppInitialized:
                return true;
            case AdGuardExtensionMessageType.LoadSettingsJson:
                return { content: settingsExport() };
            case AdGuardExtensionMessageType.ApplySettingsJson: {
                if (importsLeftToRefuse > 0) {
                    importsLeftToRefuse -= 1;
                    return false;
                }
                const document = JSON.parse(String(message.data?.json)) as ImportedSettingsDocument;
                const imported = document.filters?.['enabled-filters'];
                enabled.clear();
                for (const filterId of Array.isArray(imported) ? imported : []) {
                    if (typeof filterId === 'number') {
                        enabled.add(filterId);
                    }
                }
                for (const filterId of stubborn) {
                    enabled.add(filterId);
                }
                customFilters.length = 0;
                for (const entry of document.filters?.['custom-filters'] ?? []) {
                    if (entry.enabled) {
                        customFilters.push({
                            filterId: CUSTOM_FILTERS_START_ID + customFilters.length,
                            name: entry.title ?? entry.customUrl,
                            customUrl: entry.customUrl,
                        });
                    }
                }
                return true;
            }
            case AdGuardExtensionMessageType.GetOptionsData:
                return {
                    appVersion,
                    settings: { values: { 'stealth-disable-stealth-mode': true } },
                    filtersMetadata: {
                        filters: [
                            ...enabledFilterIds().map((filterId) => ({
                                filterId,
                                enabled: true,
                                name: 'AdGuard Base filter',
                                groupId: BUILT_IN_FILTER_GROUP_ID,
                            })),
                            ...customFilters.map((filter) => ({
                                filterId: filter.filterId,
                                enabled: true,
                                name: filter.name,
                                groupId: CUSTOM_FILTERS_GROUP_ID,
                            })),
                        ],
                        categories: [{ groupId: 2, groupName: 'Ads' }],
                    },
                    runtimeInfo: { areFilterLimitsExceeded: false },
                };
            case AdGuardExtensionMessageType.DisableFilter: {
                const filterId = message.data?.filterId;
                if (typeof filterId === 'number' && !stubborn.includes(filterId)) {
                    enabled.delete(filterId);
                    const custom = customFilters.findIndex(
                        (filter) => filter.filterId === filterId,
                    );
                    if (custom !== -1) {
                        customFilters.splice(custom, 1);
                    }
                }
                return true;
            }
            case AdGuardExtensionMessageType.SaveUserRules:
                savedUserRules = String(message.data?.value ?? '');
                return true;
            default:
                // Every other read of this surface belongs to the host state read-back, which the
                // suites using this fake inject directly; answering `true` keeps an unmodelled
                // message from looking like a transport failure.
                return true;
        }
    };

    const context = {
        newPage: async (): Promise<Page> =>
            ({
                goto: async () => null,
                close: async () => undefined,
                url: () => 'chrome-extension://test-extension-id/pages/options.html',
                title: async () => 'AdGuard',
                evaluate: async (_fn: unknown, message: FakeExtensionMessage) => respond(message),
            }) as unknown as Page,
    } as unknown as BrowserContext;

    return {
        context,
        messages,
        enabledFilterIds,
        customFilters: () => customFilters.map((filter) => ({ ...filter })),
        savedUserRules: () => savedUserRules,
    };
}
