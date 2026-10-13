import * as v from 'valibot';
import { ExtensionManifestVersion } from '../environment/extension-preparation';
import { FilterEngine } from '../types/filter-engine';
import type { AdGuardExtensionSettingsProfile } from './adguard-extension-settings';

/**
 * The observed-state shapes of the AdGuard extension: the message-transport schemas the extension
 * answers with, and the durable evidence records and state reads built over them.
 *
 * The host reads the blocker state back itself, so one state shape has exactly one declaration that
 * every consumer imports. The settings-request vocabulary those states are verified against lives
 * in `adguard-extension-settings.ts`.
 */

/**
 * Schema for non-negative MV3 rule counters.
 */
export const CounterSchema = v.pipe(v.number(), v.integer(), v.minValue(0));

/**
 * Runtime options data needed to prove imported extension settings.
 */
export const OptionsDataSchema = v.object({
    appVersion: v.pipe(v.string(), v.minLength(1)),
    settings: v.object({
        values: v.record(v.string(), v.unknown()),
    }),
    filtersMetadata: v.object({
        filters: v.array(
            v.object({
                filterId: v.pipe(v.number(), v.integer(), v.minValue(1)),
                enabled: v.boolean(),
                name: v.optional(v.string()),
                groupId: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
                version: v.optional(v.string()),
                tags: v.optional(v.array(v.pipe(v.number(), v.integer(), v.minValue(0)))),
            }),
        ),
        categories: v.optional(
            v.array(
                v.object({
                    groupId: v.pipe(v.number(), v.integer(), v.minValue(0)),
                    groupName: v.string(),
                }),
            ),
            [],
        ),
    }),
    runtimeInfo: v.optional(
        v.object({
            areFilterLimitsExceeded: v.boolean(),
        }),
        { areFilterLimitsExceeded: false },
    ),
});

/**
 * Runtime options payload read from the prepared extension's options page.
 */
export type AdGuardExtensionOptionsData = v.InferOutput<typeof OptionsDataSchema>;

/**
 * Runtime counters returned by AdGuard's MV3 rules-limits service.
 */
export const RulesLimitsSchema = v.object({
    dynamicRulesEnabledCount: CounterSchema,
    dynamicRulesMaximumCount: CounterSchema,
    dynamicRulesUnsafeEnabledCount: CounterSchema,
    dynamicRulesUnsafeMaximumCount: CounterSchema,
    dynamicRulesRegexpsEnabledCount: CounterSchema,
    dynamicRulesRegexpsMaximumCount: CounterSchema,
    staticFiltersEnabledCount: CounterSchema,
    staticFiltersMaximumCount: CounterSchema,
    staticRulesEnabledCount: CounterSchema,
    staticRulesMaximumCount: CounterSchema,
    staticRulesRegexpsEnabledCount: CounterSchema,
    staticRulesRegexpsMaxCount: CounterSchema,
    actuallyEnabledFilters: v.array(v.pipe(v.number(), v.integer(), v.minValue(1))),
    expectedEnabledFilters: v.array(v.pipe(v.number(), v.integer(), v.minValue(1))),
    areFilterLimitsExceeded: v.boolean(),
});

/**
 * Complete MV3 limit counters captured after settings import.
 */
export type AdGuardMv3RulesLimitsEvidence = v.InferOutput<typeof RulesLimitsSchema>;

/**
 * User-rule payload returned by the AdGuard options application.
 */
export const UserRulesResponseSchema = v.object({
    content: v.string(),
});

/**
 * Proof that one complete user-rule bundle was persisted by the historical extension runtime.
 */
export interface AdGuardUserRulesEvidence {
    /**
     * Manifest generation used to execute the user rules.
     */
    manifestVersion: ExtensionManifestVersion;

    /**
     * Number of exact non-empty rules saved in the bundle.
     */
    ruleCount: number;

    /**
     * SHA-256 digest of the exact newline-delimited rule payload.
     */
    contentSha256: string;

    /**
     * MV3 rule-limit counters observed after the extension rebuilt its engine.
     */
    rulesLimits: AdGuardMv3RulesLimitsEvidence | null;
}

/**
 * Metadata for one enabled filter observed in the extension runtime.
 */
export interface AdGuardEnabledFilterEvidence {
    /**
     * Numeric AdGuard filter identifier.
     */
    filterId: number;

    /**
     * Human-readable filter name when exposed by the extension.
     */
    name?: string;

    /**
     * Filter group identifier when exposed by the extension.
     */
    groupId?: number;

    /**
     * Human-readable filter group name when exposed by extension metadata.
     */
    groupName?: string;

    /**
     * Exact filter version bundled in the extension.
     */
    version?: string;

    /**
     * Metadata tag identifiers bundled with the filter.
     */
    tags?: number[];
}

/**
 * Deterministic settings evidence derived from one host read-back: the blocker state the host
 * verified itself, flattened onto the settings-record surface every runtime consumer reads.
 *
 * All fields come from the {@link AdGuardExtensionStateRead} the host took plus the settings profile
 * the session requested, so the record holds no field that only a settings-import protocol could
 * fill.
 */
export interface AdGuardExtensionSettingsEvidence {
    /**
     * Settings profile whose postconditions the read-back verified.
     */
    profileKind: AdGuardExtensionSettingsProfile['kind'];

    /**
     * Manifest generation observed in the loaded extension runtime.
     */
    manifestVersion: ExtensionManifestVersion;

    /**
     * Network filtering engine corresponding to the loaded manifest generation.
     */
    filterEngine: FilterEngine;

    /**
     * Chromium ID of the configured AdGuard extension.
     */
    extensionId: string;

    /**
     * Extension options page used for app messaging.
     */
    optionsPageUrl: string;

    /**
     * Exact installed extension version the options app reported.
     */
    appVersion: string;

    /**
     * Exact enabled filter IDs after options-data verification, or null when the read-back could
     * not observe the enabled set.
     */
    enabledFilterIds: number[] | null;

    /**
     * Metadata (names, groups, versions) of the enabled filters.
     */
    enabledFilters: AdGuardEnabledFilterEvidence[];

    /**
     * Enabled filter IDs independently observed in options metadata.
     */
    optionsEnabledFilterIds: number[];

    /**
     * Filter IDs observed as active by the applicable MV2 or MV3 runtime proof.
     */
    runtimeEnabledFilterIds: number[];

    /**
     * Filter IDs whose DNR rulesets Chromium reports as active, or null when the read-back could
     * not observe them: an MV2 runtime exposes no MV3 counters, and an empty array there would read
     * as a verified "no rulesets active".
     */
    activeRulesetFilterIds: number[] | null;

    /**
     * Tracking-protection state read back from the extension's settings, or null when the read-back
     * could not observe it.
     */
    stealthEnabled: boolean | null;

    /**
     * Combined options/runtime indication that MV3 limits were exceeded.
     */
    limitsExceeded: boolean;

    /**
     * Complete post-import MV3 rule-limit counters.
     */
    rulesLimits: AdGuardMv3RulesLimitsEvidence | null;
}

/**
 * The user-rule state a host read-back observes from the live extension.
 *
 * This is the read-side companion of {@link AdGuardUserRulesEvidence}: the host that verifies the
 * application steps needs the exact content itself, not only its digest, so it can compare the
 * state against the candidate byte for byte.
 */
export interface AdGuardUserRulesStateRead extends AdGuardUserRulesEvidence {
    /**
     * Exact user-rule content as the extension persists it, with the outer whitespace the runtime
     * adds or drops removed the same way the historical read-back compared bundles.
     */
    content: string;
}

/**
 * The complete observable state of the prepared AdGuard extension after one application pass.
 *
 * The `extension-state` verification method reads exactly this: the options settings, the user
 * rules, and the MV3 counters, all observed over the extension's own message transport.
 */
export interface AdGuardExtensionStateRead {
    /**
     * Chromium ID of the extension the state was read from.
     */
    extensionId: string;

    /**
     * Extension options page the messaging transport used.
     */
    optionsPageUrl: string;

    /**
     * Manifest generation observed in the located extension runtime.
     */
    manifestVersion: ExtensionManifestVersion;

    /**
     * Network filtering engine corresponding to the observed manifest generation.
     */
    filterEngine: FilterEngine;

    /**
     * Exact installed extension version the options app reported.
     */
    appVersion: string;

    /**
     * Filter-IDs parsed from the options metadata, normalized.
     */
    optionsEnabledFilterIds: number[];

    /**
     * Exact parsed options-data payload behind the facts above.
     */
    optionsData: AdGuardExtensionOptionsData;

    /**
     * User-rule state read back from the extension.
     */
    userRules: AdGuardUserRulesStateRead;

    /**
     * MV3 rule-limit counters when the runtime is MV3, else null.
     */
    rulesLimits: AdGuardMv3RulesLimitsEvidence | null;
}
