/**
 * This app's tool catalog: the advertisement parameter schemas the pi layer derives each tool's
 * advertised parameters from. The per-tool model-facing guidance text lives in `tool-guidance.ts`.
 * This is an input to the pi session module, not part of it: the pi module receives the parameters
 * on `AdaptedToolInput` and the guidance through `AdaptSessionToolsOptions.guidance`.
 */
import * as v from 'valibot';
import { CANDIDATE_OPERATION_VALUES } from '../environment/filtering-environment';
import { EnvironmentSelectionKindSchema } from '../environment/environment-vocabulary';
import {
    AgentEnvironmentSelectionRequestSchema,
    AgentIntentAssessmentSchema,
} from '../environment/environment-selection-contract';
import {
    DEFAULT_SAFE_INTERACTION_BOUNDS,
    SafeInteractionKindSchema,
    SyntheticTextTokenSchema,
} from '../environment/safe-interaction';
import { RuleGuidanceQuerySchema, RuleGuidanceTopicSchema } from '../knowledge/rule-guidance';
import { DomChecksRequestSchema } from '../types/dom-check';
import { MissingInformationEntrySchema } from '../types/missing-information';
import { ConsentStrategySchema, ViewportSchema } from '../types/repro-profile';
import { SETTINGS_PROFILE_KIND_VALUES } from '../types/settings-profile-kind';
import { EXTENSION_MODE_VALUES } from '../types/fix-run-result';
import { FindingSchema } from '../types/site-analysis';
import { ToolName } from './tool-names';

// The step bound belongs on the advertisement, not only in the executor: the normalizer refuses an
// over-long plan with `step_limit_exceeded`, and a model that was never told the limit can only
// discover it by wasting a call on it. `maxLength` projects to `maxItems`, so pi bounces the
// over-long plan before dispatch and the model reads the bound in the schema. interact_page and
// apply_rule share it because a rehearsed sequence is passed to apply_rule unchanged.
const SafeInteractionStepsRequestSchema = v.pipe(
    v.array(
        v.object({
            kind: SafeInteractionKindSchema,
            selector: v.optional(v.string()),
            textHint: v.optional(v.string()),
            text: v.optional(SyntheticTextTokenSchema),
            quietMs: v.optional(v.number()),
        }),
    ),
    v.maxLength(DEFAULT_SAFE_INTERACTION_BOUNDS.maxSteps),
);

/**
 * The shape both advertisement maps are checked against: a partial map from a declared
 * {@link ToolName} to its schema. The maps themselves stay indexable by a plain string because the
 * runtime looks a schema up by a name it read off a registry definition; this check only refuses an
 * entry keyed by a name no tool answers to.
 */
type ToolSchemaEntries = Partial<Record<ToolName, v.GenericSchema<Record<string, unknown>>>>;

/**
 * A positive integer as the model writes one: a filter id in the extension's own registry
 * numbering, or a 1-based line number into a list's text. Zero names no filter and no line.
 */
const POSITIVE_INTEGER = v.pipe(v.number(), v.integer(), v.minValue(1));

/**
 * The `search_rules` arguments: one target field for a match query, or `filePath` alone for that
 * file's outline, or `filePath` with `line` for a window. Every string is non-empty: an empty
 * target names nothing to search for.
 */
export const SEARCH_RULES_PARAMETERS = v.object({
    /**
     * A domain to search for (e.g. "ads.example.com").
     */
    domain: v.optional(v.pipe(v.string(), v.minLength(1))),

    /**
     * A CSS selector to search for in cosmetic rules.
     */
    selector: v.optional(v.pipe(v.string(), v.minLength(1))),

    /**
     * A network URL pattern to search for (e.g. "||ads.example.com^").
     */
    urlPattern: v.optional(v.pipe(v.string(), v.minLength(1))),

    /**
     * A scriptlet name to search for in scriptlet rules.
     */
    scriptlet: v.optional(v.pipe(v.string(), v.minLength(1))),

    /**
     * Repository-relative path of one list file: alone it selects the outline, with `line` a
     * window, and beside a target field it limits the matches to that file.
     */
    filePath: v.optional(v.pipe(v.string(), v.minLength(1))),

    /**
     * One-based line number of the window's centre; only valid with `filePath` and no target field.
     */
    line: v.optional(POSITIVE_INTEGER),
});
/**
 * The parsed `search_rules` arguments, derived from the schema the tool advertises and parses.
 */
export type SearchRulesArguments = v.InferOutput<typeof SEARCH_RULES_PARAMETERS>;

export const TOOL_PARAMETER_SCHEMAS: Readonly<
    Record<string, v.GenericSchema<Record<string, unknown>>>
> = {
    // ── Always present ──────────────────────────────────────────────────────
    [ToolName.FetchIssue]: v.object({ issueNumber: v.number() }),

    // ── Repository lint command present ─────────────────────────────────────
    [ToolName.LintRule]: v.object({ rule: v.string(), filePath: v.string() }),

    // ── Filters checkout present ────────────────────────────────────────────
    [ToolName.SearchRules]: SEARCH_RULES_PARAMETERS,

    // ── Browser session present ─────────────────────────────────────────────
    [ToolName.OpenPage]: v.object({ url: v.string() }),
    [ToolName.Screenshot]: v.object({
        captureTiles: v.optional(v.boolean()),
        tileWindow: v.optional(
            v.object({ fromY: v.optional(v.number()), toY: v.optional(v.number()) }),
        ),
    }),
    [ToolName.StabilizePage]: v.object({
        targetSelector: v.optional(v.string()),
        targetHint: v.optional(v.string()),
    }),
    [ToolName.GetDom]: v.object({}),
    [ToolName.InspectAdSlots]: v.object({}),
    [ToolName.GetNetworkLog]: v.object({}),
    [ToolName.GetAppliedRules]: v.object({}),
    [ToolName.GetConsoleLog]: v.object({}),
    [ToolName.InspectPageState]: v.object({}),
    [ToolName.EvaluateJs]: v.object({ expression: v.string() }),
    // The application session's one write channel: the message shape the extension's own
    // background dispatcher takes. `data` stays a free-form record because its keys differ per
    // message type (`json` for applySettingsJson, `value` for saveUserRules), and the instruction
    // is the only place that names them.
    [ToolName.SendExtensionMessage]: v.object({
        type: v.string(),
        data: v.optional(v.record(v.string(), v.unknown())),
    }),
    [ToolName.ReportFinding]: FindingSchema,
    [ToolName.ApplyRule]: v.object({
        candidateRule: v.string(),
        adElementSelector: v.optional(v.string()),
        operation: v.optional(v.picklist(CANDIDATE_OPERATION_VALUES)),
        originalRule: v.optional(v.string()),
        symptomDescription: v.optional(v.string()),
        revealSteps: v.optional(SafeInteractionStepsRequestSchema),
        domChecks: v.optional(DomChecksRequestSchema),
    }),
    [ToolName.InteractPage]: v.object({
        steps: SafeInteractionStepsRequestSchema,
    }),

    // ── Vision / artifact store present ─────────────────────────────────────
    // The shape tool-factory registers: both references required, artifact IDs only. The agentic
    // fix runtime re-registers a widened definition that also accepts the reporter screenshot
    // index; that widening is fix-only and lives in FIX_TOOL_PARAMETER_SCHEMAS, so the surfaces
    // that dispatch straight into this registry advertise exactly what it accepts.
    [ToolName.AnalyzeScreenshot]: v.object({
        artifactId: v.string(),
        prompt: v.string(),
    }),
    [ToolName.GetDetail]: v.object({
        artifactId: v.string(),
        filter: v.optional(
            v.object({ key: v.optional(v.string()), limit: v.optional(v.number()) }),
        ),
    }),

    // ── Gate-refusing stubs (widened session surface) ───────────────────────
    // The universal system.md mandates these four steps, but a session registry never registers
    // these tools and nothing executes: buildRegistrySessionTools advertises them with a gate
    // callback that always refuses, so a call returns the typed tool_gated refusal (see
    // SESSION_GATED_STUBS in src/session/registry-session-tools.ts). Every property is
    // optional and only doc-pinned value
    // vocabularies keep their picklists — the advertisement's only job is to let a plausible call
    // through pi's pre-execute validation into the gate refusal; a call outside the mirrored shape
    // bounces at that validation with "Validation failed for tool" like any other tool.
    [ToolName.SelectEnvironment]: v.object({
        kind: v.optional(EnvironmentSelectionKindSchema),
        requiredCapabilities: v.optional(v.array(v.string())),
        intent: v.optional(
            v.object({
                issueType: v.optional(v.string()),
                rationale: v.optional(v.string()),
                confidence: v.optional(v.number()),
                evidence: v.optional(
                    v.array(
                        v.object({
                            source: v.optional(v.string()),
                            observation: v.optional(v.string()),
                        }),
                    ),
                ),
                conflicts: v.optional(v.array(v.string())),
            }),
        ),
    }),
    [ToolName.LookupRuleGuidance]: v.object({
        topic: v.optional(RuleGuidanceTopicSchema),
        query: v.optional(RuleGuidanceQuerySchema),
    }),
    [ToolName.LaunchBrowser]: v.object({
        extension: v.optional(v.picklist(EXTENSION_MODE_VALUES)),
        targetUrl: v.optional(v.string()),
        profile: v.optional(
            v.object({
                viewport: v.optional(ViewportSchema),
                locale: v.optional(v.string()),
                timezone: v.optional(v.string()),
                consentStrategy: v.optional(ConsentStrategySchema),
                geolocation: v.optional(
                    v.object({
                        latitude: v.optional(v.number()),
                        longitude: v.optional(v.number()),
                    }),
                ),
            }),
        ),
        settings: v.optional(
            v.object({
                kind: v.optional(v.string()),
                filterIds: v.optional(v.array(v.number())),
                stealthEnabled: v.optional(v.boolean()),
                slice: v.optional(
                    v.object({
                        filterId: v.optional(v.number()),
                        firstLine: v.optional(v.number()),
                        lastLine: v.optional(v.number()),
                    }),
                ),
                requiredFilterIds: v.optional(v.array(v.number())),
                reporterImportUrl: v.optional(v.string()),
                siteHostname: v.optional(v.string()),
                reportedFilterNames: v.optional(v.array(v.string())),
                issueLabels: v.optional(v.array(v.string())),
                importUrl: v.optional(v.string()),
            }),
        ),
    }),
    [ToolName.InspectFullPageCapture]: v.object({}),
} satisfies ToolSchemaEntries;

/**
 * The advertised `launch_browser` profile: what the model may say about the browser context.
 */
const ADVERTISED_BROWSER_PROFILE = v.strictObject({
    viewport: ViewportSchema,
    locale: v.string(),
    timezone: v.string(),
    consentStrategy: ConsentStrategySchema,
    geolocation: v.optional(v.strictObject({ latitude: v.number(), longitude: v.number() })),
});

/**
 * The `slice` of model-selected settings: lines `firstLine..lastLine` (1-based, inclusive) of the
 * build's own text of the list `filterId` — one of the selected `filterIds` — run as a trusted
 * custom filter while that built-in list stays off. The request schema shares this leaf, so the
 * model never sees a slice property the validation would reject.
 */
export const LIST_SLICE_PARAMETERS = v.strictObject({
    filterId: POSITIVE_INTEGER,
    firstLine: POSITIVE_INTEGER,
    lastLine: POSITIVE_INTEGER,
});

export const LAUNCH_BROWSER_PARAMETERS = v.strictObject({
    extension: v.picklist(EXTENSION_MODE_VALUES),
    targetUrl: v.string(),
    profile: ADVERTISED_BROWSER_PROFILE,
    // One flat object, not a union of per-kind shapes: a provider validates the call against this
    // advertisement before the runtime sees it, and a union fails with every branch's errors and no
    // field named. `launchBrowserRequestSchema` holds each kind to its own fields and names the one
    // that does not belong.
    settings: v.optional(
        v.strictObject({
            kind: v.picklist(SETTINGS_PROFILE_KIND_VALUES),
            filterIds: v.optional(
                v.pipe(v.array(POSITIVE_INTEGER), v.description('agent_selected only.')),
            ),
            stealthEnabled: v.optional(v.pipe(v.boolean(), v.description('agent_selected only.'))),
            slice: v.optional(v.pipe(LIST_SLICE_PARAMETERS, v.description('agent_selected only.'))),
            requiredFilterIds: v.optional(
                v.pipe(v.array(POSITIVE_INTEGER), v.description('defaults_plus_required only.')),
            ),
            reporterImportUrl: v.optional(
                v.pipe(v.string(), v.description('defaults_plus_required only.')),
            ),
            siteHostname: v.optional(
                v.pipe(v.string(), v.description('defaults_plus_required only.')),
            ),
            reportedFilterNames: v.optional(
                v.pipe(v.array(v.string()), v.description('defaults_plus_required only.')),
            ),
            issueLabels: v.optional(
                v.pipe(v.array(v.string()), v.description('defaults_plus_required only.')),
            ),
            importUrl: v.optional(
                v.pipe(v.string(), v.description('report_exact and reported_on_current only.')),
            ),
        }),
    ),
});

export const DECLARED_BASELINE_LAUNCH_BROWSER_PARAMETERS = v.strictObject({
    extension: v.picklist(EXTENSION_MODE_VALUES),
    targetUrl: v.string(),
    profile: ADVERTISED_BROWSER_PROFILE,
});

/**
 * Strict advertisement schemas for the fix session surface, one per tool name whose only committed
 * shape is a permissive widened-stub entry (select_environment, launch_browser,
 * lookup_rule_guidance) plus the fix-only names (update_observed_intent, close_browser,
 * report_missing_information). The fix surface is a REAL tool surface: every name resolves at
 * session build time and executes through the runtime registry, so the advertisement must mirror
 * the runtime's registered JSON definitions — required fields included — rather than a widened stub
 * shape. A name with a committed real shape in TOOL_PARAMETER_SCHEMAS is not listed here; the fix
 * wiring resolves via `FIX_TOOL_PARAMETER_SCHEMAS[name] ?? TOOL_PARAMETER_SCHEMAS[name]`.
 */
export const FIX_TOOL_PARAMETER_SCHEMAS: Readonly<
    Record<string, v.GenericSchema<Record<string, unknown>>>
> = {
    // The registered select_environment definition (environment-selection-tools.ts) is exactly
    // AgentEnvironmentSelectionRequestSchema: a strict object with the same required fields, so the
    // runtime's own Valibot schema is reused instead of mirrored by hand.
    [ToolName.SelectEnvironment]: AgentEnvironmentSelectionRequestSchema,
    // The registered update_observed_intent definition (environment-selection-tools.ts) mirrors
    // AgentIntentAssessmentSchema field-for-field: issueType, rationale, confidence, evidence, and
    // conflicts, all required.
    [ToolName.UpdateObservedIntent]: AgentIntentAssessmentSchema,
    // The preparation stage's two step tools: strict argv and inside-workdir shapes. These names
    // exist only on the short-lived preparation surface — never on the fix session surface — and
    // their registration derives the same strict shape through REGISTERED_SHAPE_OVERRIDES.
    [ToolName.RunCommand]: v.strictObject({
        command: v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(1)),
        timeoutMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
    }),
    [ToolName.WriteFile]: v.strictObject({
        path: v.pipe(v.string(), v.minLength(1)),
        content: v.string(),
    }),
    [ToolName.LaunchBrowser]: LAUNCH_BROWSER_PARAMETERS,
    [ToolName.CloseBrowser]: v.strictObject({}),
    [ToolName.LookupRuleGuidance]: v.strictObject({
        topic: RuleGuidanceTopicSchema,
        query: v.optional(RuleGuidanceQuerySchema),
    }),
    // The registered report_missing_information definition is exactly MissingInformationEntrySchema:
    // a strict object whose subject/detail bounds also validate the run result's capped block, so
    // the model is machine-checked against the same contract the harvest reads back.
    [ToolName.ReportMissingInformation]: MissingInformationEntrySchema,
    // The agentic fix runtime re-registers analyze_screenshot behind a reporter-aware definition
    // (agent-runtime.ts, `reporterAwareScreenshotDefinition`): reporter evidence is addressed by
    // the one-based issueScreenshotIndex from fetch_issue, never by an invented artifact ID, so
    // only the prompt stays required and the two references are mutually exclusive (the handler
    // rejects a call carrying both). No other surface re-registers the tool, so the widened shape
    // belongs here rather than in the shared catalog entry.
    [ToolName.AnalyzeScreenshot]: v.object({
        artifactId: v.optional(v.string()),
        issueScreenshotIndex: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
        prompt: v.string(),
    }),
} satisfies ToolSchemaEntries;
