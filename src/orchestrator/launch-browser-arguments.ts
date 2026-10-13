/**
 * The `launch_browser` tool argument vocabulary: the strict Valibot shapes the runtime validates a
 * launch request against, the shapes the model is shown, and the two compatibility readers that run
 * before that validation.
 *
 * Nothing here touches runtime state, so a launch argument shape can be read and exercised without
 * constructing a browser session.
 *
 * The shapes are per-run because the two blocker families answer the question "what settings does
 * this session launch with?" differently, and one shared shape gives a uBO run both answers at
 * once: one call is refused with `Expected "settings" but received undefined`, a later one with
 * `Expected never but received "settings"`. A Firefox-family run has no host-writable settings
 * surface at all — its baseline is the run instruction's own managed-storage declaration, applied
 * by the browser when it force-installs the XPI — so the request takes no `settings`, the
 * advertisement shows none, and the refusal says what the baseline is instead.
 */
import * as v from 'valibot';
import {
    DECLARED_BASELINE_LAUNCH_BROWSER_PARAMETERS,
    LAUNCH_BROWSER_PARAMETERS,
    LIST_SLICE_PARAMETERS,
} from '../agent/tool-catalog';
import { ToolName } from '../agent/tool-names';
import { formatIssues } from '../pi/valibot-issues';
import type { AdGuardExtensionSettingsProfile } from '../browser/adguard-extension-settings';
import { ExtensionLaunchFamily } from '../environment/extension-launch';
import type { PreparedExtension } from '../local/prepared-extension';
import { CONSENT_STRATEGY_VALUES, VIEWPORT_VALUES } from '../types/repro-profile';
import { SettingsProfileKind } from '../types/settings-profile-kind';

const AgentSelectedSettingsSchema = v.strictObject({
    kind: v.literal(SettingsProfileKind.AgentSelected),
    filterIds: v.array(v.pipe(v.number(), v.integer(), v.minValue(1))),
    stealthEnabled: v.boolean(),
    slice: v.optional(LIST_SLICE_PARAMETERS),
});

const DefaultsSettingsSchema = v.strictObject({
    kind: v.literal(SettingsProfileKind.DefaultsPlusRequired),
    requiredFilterIds: v.array(v.pipe(v.number(), v.integer(), v.minValue(1))),
    reporterImportUrl: v.optional(v.pipe(v.string(), v.url())),
    siteHostname: v.optional(v.string()),
    reportedFilterNames: v.optional(v.array(v.string())),
    issueLabels: v.optional(v.array(v.string())),
});

const ReportExactSettingsSchema = v.strictObject({
    kind: v.literal(SettingsProfileKind.ReportExact),
    importUrl: v.pipe(v.string(), v.url()),
});

const ReportedOnCurrentSettingsSchema = v.strictObject({
    kind: v.literal(SettingsProfileKind.ReportedOnCurrent),
    importUrl: v.pipe(v.string(), v.url()),
});

const AgentBrowserProfileSchema = v.strictObject({
    viewport: v.picklist(VIEWPORT_VALUES),
    locale: v.pipe(v.string(), v.minLength(2), v.maxLength(35)),
    timezone: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
    consentStrategy: v.picklist(CONSENT_STRATEGY_VALUES),
    geolocation: v.optional(
        v.strictObject({
            latitude: v.pipe(v.number(), v.minValue(-90), v.maxValue(90)),
            longitude: v.pipe(v.number(), v.minValue(-180), v.maxValue(180)),
        }),
    ),
});

const ControlSessionSchema = v.strictObject({
    extension: v.literal('none'),
    targetUrl: v.pipe(v.string(), v.url()),
    profile: AgentBrowserProfileSchema,
    // An unfiltered control session applies no blocker settings by definition. Declared as never
    // rather than left out, so `settings` exists on every request shape and a handler reads one
    // field instead of narrowing on the extension mode to learn whether it may.
    settings: v.optional(v.never()),
});

export const LaunchBrowserSchema = v.variant('extension', [
    ControlSessionSchema,
    v.strictObject({
        extension: v.literal('prepared'),
        targetUrl: v.pipe(v.string(), v.url()),
        profile: AgentBrowserProfileSchema,
        // A variant, not a union: Valibot's union reports a branch's own issues only when exactly
        // one branch fits the type, so a missing required field came back as "Expected Object |
        // Object". The variant picks the branch by `kind` and names the failing field.
        settings: v.variant('kind', [
            AgentSelectedSettingsSchema,
            DefaultsSettingsSchema,
            ReportExactSettingsSchema,
            ReportedOnCurrentSettingsSchema,
        ]),
    }),
]);

export const DeclaredBaselineLaunchBrowserSchema = v.variant('extension', [
    ControlSessionSchema,
    v.strictObject({
        extension: v.literal('prepared'),
        targetUrl: v.pipe(v.string(), v.url()),
        profile: AgentBrowserProfileSchema,
        // Declared as never rather than simply absent: the refusal then says that this run has no
        // settings to take, instead of the generic unknown-key message a strict object produces.
        settings: v.optional(v.never()),
    }),
]);

/**
 * Where a launched session's filter baseline comes from, which decides whether the request carries
 * `settings` at all.
 */
export const LaunchBrowserSettingsPolicy = {
    /**
     * The model chooses the settings and the host applies them to the blocker, then reads the
     * resulting state back: the Chromium line, where the extension has a writable settings
     * surface.
     */
    ModelSelected: 'model-selected',

    /**
     * The baseline is the run instruction's own declared list selection, already applied by the
     * browser at startup: a Firefox-family run, whose blocker has no host-writable settings
     * surface, so there is nothing for the model to select.
     */
    DeclaredBaseline: 'declared-baseline',
} as const;

/**
 * LaunchBrowserSettingsPolicy value.
 */
export type LaunchBrowserSettingsPolicy =
    (typeof LaunchBrowserSettingsPolicy)[keyof typeof LaunchBrowserSettingsPolicy];

/**
 * Decide one run's launch-settings policy from the build it prepared.
 *
 * @param prepared - The run's host-prepared extension build, when it prepared one.
 * @returns The policy every `launch_browser` request of that run is read under.
 */
export function launchBrowserSettingsPolicy(
    prepared: PreparedExtension | undefined,
): LaunchBrowserSettingsPolicy {
    return prepared?.launchFamily === ExtensionLaunchFamily.Firefox
        ? LaunchBrowserSettingsPolicy.DeclaredBaseline
        : LaunchBrowserSettingsPolicy.ModelSelected;
}

/**
 * The strict request schema one run's `launch_browser` calls are validated against. Keyed off the
 * prepared build rather than the policy value, so a caller wires one thing and never keeps two
 * derivations of the policy in step.
 *
 * @param prepared - The run's host-prepared extension build, when it prepared one.
 * @returns The Valibot schema for that run's request shape.
 */
export function launchBrowserRequestSchema(
    prepared: PreparedExtension | undefined,
): typeof LaunchBrowserSchema | typeof DeclaredBaselineLaunchBrowserSchema {
    return launchBrowserSettingsPolicy(prepared) === LaunchBrowserSettingsPolicy.DeclaredBaseline
        ? DeclaredBaselineLaunchBrowserSchema
        : LaunchBrowserSchema;
}

/**
 * What the model is shown for `launch_browser` on one run: its description and its parameters.
 *
 * The advertisement and the request schema are separate shapes on purpose — the advertisement is
 * one flattened object rather than a discriminated variant, because that is what the providers
 * render — so this is the second half of the same promise: the model never sees a property the
 * validation would reject.
 */
export interface LaunchBrowserAdvertisement {
    /**
     * The model-facing description, naming where this run's baseline comes from.
     */
    description: string;

    /**
     * The advertised parameter schema, carrying `settings` only where a request may pass it.
     */
    parameters: v.GenericSchema<Record<string, unknown>>;
}

/**
 * Build the `launch_browser` advertisement for one run.
 *
 * @param prepared - The run's host-prepared extension build, when it prepared one.
 * @returns The description and parameter schema the model is shown for this run.
 */
export function launchBrowserAdvertisement(
    prepared: PreparedExtension | undefined,
): LaunchBrowserAdvertisement {
    const policy = launchBrowserSettingsPolicy(prepared);
    return {
        description: launchBrowserDescription(policy),
        parameters:
            policy === LaunchBrowserSettingsPolicy.DeclaredBaseline
                ? DECLARED_BASELINE_LAUNCH_BROWSER_PARAMETERS
                : LAUNCH_BROWSER_PARAMETERS,
    };
}

/**
 * The settings profile a declared-baseline session records instead of a model-selected one.
 *
 * The session bookkeeping, the phase proofs and the report all name the profile a session ran
 * under, and a declared-baseline run does have one — the blocker's own declared defaults with
 * nothing added on top. Naming that, rather than leaving the field empty or letting the model
 * invent a profile the route ignores, keeps the recorded kind equal to what actually ran.
 */
export const DECLARED_BASELINE_SETTINGS_PROFILE: AdGuardExtensionSettingsProfile = {
    kind: SettingsProfileKind.DefaultsPlusRequired,
    requiredFilterIds: [],
};

/**
 * One run's `launch_browser` description, keyed by tool name for the session builder.
 *
 * @param prepared - The run's host-prepared extension build, when it prepared one.
 * @returns The per-run description overrides the fix session applies.
 */
export function launchBrowserSessionDescriptions(
    prepared: PreparedExtension | undefined,
): Readonly<Record<string, string>> {
    return { [ToolName.LaunchBrowser]: launchBrowserAdvertisement(prepared).description };
}

/**
 * One run's `launch_browser` advertisement schema, keyed by tool name for the session builder.
 *
 * @param prepared - The run's host-prepared extension build, when it prepared one.
 * @returns The per-run advertisement overrides the fix session applies.
 */
export function launchBrowserSessionParameters(
    prepared: PreparedExtension | undefined,
): Readonly<Record<string, v.GenericSchema<Record<string, unknown>>>> {
    return { [ToolName.LaunchBrowser]: launchBrowserAdvertisement(prepared).parameters };
}

/**
 * The model-facing description of `launch_browser` under one run's policy.
 *
 * @param policy - The run's launch-settings policy.
 * @returns The description the model is shown for this run.
 */
function launchBrowserDescription(policy: LaunchBrowserSettingsPolicy): string {
    if (policy === LaunchBrowserSettingsPolicy.DeclaredBaseline) {
        return (
            'Starts a fresh isolated headless session for live evidence: extension=none for a ' +
            'control session, extension=prepared for the prepared blocker. This run takes no ' +
            'settings argument — the prepared blocker is a Firefox-family build whose filter ' +
            "baseline is the run instruction's own declared list selection, applied by the " +
            'browser when it force-installs the signed extension. There is no host-writable ' +
            'settings surface to select into, so passing settings is refused. Returns the ' +
            'readiness facts every browser tool then uses.'
        );
    }
    return (
        'Starts a fresh isolated headless Chromium session for live evidence: extension=none for ' +
        'a control session, extension=prepared with model-selected settings. settings.slice runs ' +
        'lines firstLine..lastLine of one of the selected lists instead of the whole list ' +
        "(halving a list once it is found); the answer reports each enabled list's line count " +
        'in enabledLists. Returns the readiness facts every browser tool then uses.'
    );
}

/**
 * Whether the request paired an unfiltered control session with blocker settings.
 *
 * The control shape declares `settings` as `never`, so Valibot reports the pairing as "Expected
 * never but received Object". A generic refusal that answers by listing the accepted settings
 * shapes leaves the model resending the same settings on the same control session — up to eight
 * times, or until it concludes the browser is unavailable and finishes without ever launching one.
 *
 * @param issues - The Valibot issues the request failed with.
 * @returns Whether the failure is `settings` on a control session.
 */
function pairsControlSessionWithSettings(issues: readonly v.BaseIssue<unknown>[]): boolean {
    return issues.some(
        (issue) => issue.expected === 'never' && issue.path?.[0]?.key === 'settings',
    );
}

/**
 * The refusal text a malformed `launch_browser` request is answered with.
 *
 * The Valibot issues are truncated here rather than at the call site: the bound exists so the
 * refusal stays readable, which is this function's concern and nobody else's.
 *
 * @param prepared - The run's host-prepared extension build, when it prepared one.
 * @param issues - The Valibot issues the request failed with.
 * @returns The model-facing refusal, naming the shapes this run actually accepts.
 */
export function launchBrowserRefusal(
    prepared: PreparedExtension | undefined,
    issues: readonly v.BaseIssue<unknown>[],
): string {
    // Path-prefixed, so a field that does not belong to the chosen kind is named
    // (`settings.siteHostname: Invalid key`) rather than left for the model to guess.
    const validationDetail = formatIssues(issues).slice(0, MAX_BROWSER_VALIDATION_DETAIL_LENGTH);
    if (launchBrowserSettingsPolicy(prepared) === LaunchBrowserSettingsPolicy.DeclaredBaseline) {
        return [
            'Invalid launch_browser request. This run accepts no "settings": the prepared',
            'blocker is a Firefox-family build and its filter baseline is the run',
            "instruction's own declared list selection, already applied by the browser at",
            'startup. Accepted shapes:',
            '{"extension":"none","targetUrl":"https://...","profile":{...}};',
            '{"extension":"prepared","targetUrl":"https://...","profile":{...}}.',
            `Validation detail: ${validationDetail}`,
        ].join(' ');
    }
    if (pairsControlSessionWithSettings(issues)) {
        return [
            'Invalid launch_browser request. A control session (extension "none") runs no blocker',
            'and takes no "settings". Drop "settings" to launch the unfiltered control session, or',
            'pass extension "prepared" to launch the prepared blocker with these settings.',
            `Validation detail: ${validationDetail}`,
        ].join(' ');
    }
    return [
        'Invalid launch_browser request. Accepted settings shapes:',
        '{"kind":"agent_selected","filterIds":[2],"stealthEnabled":false};',
        '{"kind":"defaults_plus_required","requiredFilterIds":[2]};',
        '{"kind":"report_exact","importUrl":"https://..."};',
        '{"kind":"reported_on_current","importUrl":"https://..."}.',
        `Validation detail: ${validationDetail}`,
    ].join(' ');
}

/**
 * Maximum encoded profile size accepted for the narrow model-output compatibility path.
 */
const MAX_ENCODED_BROWSER_PROFILE_LENGTH = 4_096;

/**
 * Maximum validation detail returned to the model for a malformed browser launch request.
 */
export const MAX_BROWSER_VALIDATION_DETAIL_LENGTH = 1_000;

/**
 * Exact own keys accepted on a model-selected browser profile.
 */
const AGENT_BROWSER_PROFILE_KEYS = new Set([
    'viewport',
    'locale',
    'timezone',
    'consentStrategy',
    'geolocation',
]);

/**
 * Exact own keys accepted on a model-selected geolocation object.
 */
const AGENT_BROWSER_GEOLOCATION_KEYS = new Set(['latitude', 'longitude']);

/**
 * Determine whether a parsed JSON value is an ordinary key-value object.
 *
 * @param value - Candidate value parsed from a tool argument.
 * @returns Whether the value is a non-array object with a safe standard or null prototype.
 */
function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

/**
 * Check an object's own enumerable keys against one explicit allowlist.
 *
 * This closes a Valibot strict-object edge case for names inherited from `Object.prototype`, such
 * as `constructor`, `toString`, and `__proto__`.
 *
 * @param value - Plain object whose keys must be checked.
 * @param allowedKeys - Complete accepted own-key set.
 * @returns Whether every own enumerable key is explicitly allowed.
 */
function hasOnlyAllowedOwnKeys(
    value: Record<string, unknown>,
    allowedKeys: ReadonlySet<string>,
): boolean {
    return Object.keys(value).every((key) => allowedKeys.has(key));
}

/**
 * Normalize the one known nested JSON-string artifact emitted by compatible model providers.
 *
 * Only `profile` is parsed, at most once. The returned object uses the existing strict Valibot
 * schema output and never merges unvalidated parsed data into browser configuration.
 *
 * @param args - Raw `launch_browser` arguments supplied by the model.
 * @returns Arguments containing a validated object profile, or a stable invalid sentinel that the
 *   existing launch schema rejects.
 */
export function normalizeLaunchBrowserArguments(
    args: Record<string, unknown>,
): Record<string, unknown> {
    const rawProfile = args.profile;
    let candidateProfile: unknown = rawProfile;
    if (typeof rawProfile === 'string') {
        if (rawProfile.length === 0 || rawProfile.length > MAX_ENCODED_BROWSER_PROFILE_LENGTH) {
            return { ...args, profile: null };
        }
        try {
            candidateProfile = JSON.parse(rawProfile) as unknown;
        } catch {
            return { ...args, profile: null };
        }
    }
    if (!isPlainJsonObject(candidateProfile)) {
        return { ...args, profile: null };
    }
    if (!hasOnlyAllowedOwnKeys(candidateProfile, AGENT_BROWSER_PROFILE_KEYS)) {
        return { ...args, profile: null };
    }
    if (
        candidateProfile.geolocation !== undefined &&
        (!isPlainJsonObject(candidateProfile.geolocation) ||
            !hasOnlyAllowedOwnKeys(candidateProfile.geolocation, AGENT_BROWSER_GEOLOCATION_KEYS))
    ) {
        return { ...args, profile: null };
    }
    const parsedProfile = v.safeParse(AgentBrowserProfileSchema, candidateProfile);
    if (!parsedProfile.success) {
        return { ...args, profile: candidateProfile };
    }
    return { ...args, profile: parsedProfile.output };
}

/**
 * Detect an unsupported geographic proxy request before strict launch validation.
 *
 * The compatibility branch recognizes both the object form and the one bounded JSON-encoded profile
 * form accepted from model providers. It never treats the field as applied: the runtime has no
 * proxy backend and must tell the model that network egress stayed unchanged.
 *
 * @param args - Raw `launch_browser` arguments supplied by the model.
 * @returns Whether the model explicitly requested the unsupported `proxyRegion` field.
 */
export function requestsUnsupportedProxyRegion(args: Record<string, unknown>): boolean {
    let candidateProfile: unknown = args.profile;
    if (typeof candidateProfile === 'string') {
        if (
            candidateProfile.length === 0 ||
            candidateProfile.length > MAX_ENCODED_BROWSER_PROFILE_LENGTH
        ) {
            return false;
        }
        try {
            candidateProfile = JSON.parse(candidateProfile) as unknown;
        } catch {
            return false;
        }
    }
    return (
        isPlainJsonObject(candidateProfile) &&
        Object.prototype.hasOwnProperty.call(candidateProfile, 'proxyRegion')
    );
}
