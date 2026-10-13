/**
 * The agent tool vocabulary: every tool name this app registers, advertises, gates, or quarantines.
 *
 * A tool name is a domain concept, not an incidental string: it keys the guidance map, the
 * advertisement schema maps, the frozen fix surface, the gate-refusing stub tables, and the
 * diagnostic quarantine rules. Declaring it once here means a new tool is spelled in exactly one
 * place and a typo at any call site is a compile error rather than a silently inert table entry.
 *
 * This module deliberately imports nothing, so every layer — catalog, factory, orchestrator
 * sessions — can depend on it without creating a cycle.
 */

/**
 * Every agent tool name, grouped the way the catalog presents them: issue and policy reasoning,
 * repository lookups, browser lifecycle, page evidence, and the four mode terminals.
 */
export const ToolName = {
    /**
     * Runs one disposable preparation command inside the preparation workdir.
     */
    RunCommand: 'run_command',

    /**
     * Writes one file inside the preparation workdir.
     */
    WriteFile: 'write_file',

    /**
     * Fetches the GitHub issue under investigation.
     */
    FetchIssue: 'fetch_issue',

    /**
     * Locks the filtering environment the run reproduces in.
     */
    SelectEnvironment: 'select_environment',

    /**
     * Refines the observed issue classification without relocking the environment.
     */
    UpdateObservedIntent: 'update_observed_intent',

    /**
     * Reads one bounded topic from the pinned AdGuard KnowledgeBase.
     */
    LookupRuleGuidance: 'lookup_rule_guidance',

    /**
     * Records exactly what the run instruction lacks so the gap reaches the run result.
     */
    ReportMissingInformation: 'report_missing_information',

    /**
     * Searches the AdguardFilters checkout for existing rules.
     */
    SearchRules: 'search_rules',

    /**
     * Validates a candidate rule's syntax.
     */
    LintRule: 'lint_rule',

    /**
     * Starts a fresh isolated browser session for live evidence.
     */
    LaunchBrowser: 'launch_browser',

    /**
     * Closes the active browser session and releases its evidence route.
     */
    CloseBrowser: 'close_browser',

    /**
     * Navigates the active browser session to a URL.
     */
    OpenPage: 'open_page',

    /**
     * Waits for bounded DOM and network stability before capturing evidence.
     */
    StabilizePage: 'stabilize_page',

    /**
     * Captures viewport and full-page screenshots as artifacts.
     */
    Screenshot: 'screenshot',

    /**
     * Inspects a registered screenshot artifact with the dedicated vision model.
     */
    AnalyzeScreenshot: 'analyze_screenshot',

    /**
     * Inspects the latest complete tiled page capture with the dedicated vision model.
     */
    InspectFullPageCapture: 'inspect_full_page_capture',

    /**
     * Captures the current page's full DOM as an artifact.
     */
    GetDom: 'get_dom',

    /**
     * Runs the fixed read-only ad-slot scan of the main-frame light DOM.
     */
    InspectAdSlots: 'inspect_ad_slots',

    /**
     * Returns the redacted network inventory collected since session start.
     */
    GetNetworkLog: 'get_network_log',

    /**
     * Returns the rules the session's filtering engine reported applying to the page, with their
     * lists.
     */
    GetAppliedRules: 'get_applied_rules',

    /**
     * Returns the console-event messages collected since session start and what they cover.
     */
    GetConsoleLog: 'get_console_log',

    /**
     * Returns the bounded cookie, storage, and frame snapshot a rule can depend on.
     */
    InspectPageState: 'inspect_page_state',

    /**
     * Evaluates a read-only JavaScript diagnostic in the page context.
     */
    EvaluateJs: 'evaluate_js',

    /**
     * Records one finding with its evidence.
     */
    ReportFinding: 'report_finding',

    /**
     * Performs a bounded sequence of safe page interactions and reports what they provoked.
     */
    InteractPage: 'interact_page',

    /**
     * Runs the collect-only A/B/C experiment for a candidate rule.
     */
    ApplyRule: 'apply_rule',

    /**
     * Retrieves a byte-bounded slice of a persisted artifact.
     */
    GetDetail: 'get_detail',

    /**
     * The only terminal channel of a fix run, agentic and pre-orchestrated alike.
     */
    FinishFix: 'finish_fix',

    /**
     * The analyze run's only terminal channel.
     */
    SubmitAnalysis: 'submit_analysis',

    /**
     * Sends one application runtime message from the prepared blocker management surface page.
     *
     * The application session's one declared write channel: `evaluate_js` stays read-only on the
     * privileged surface, so settings and candidate rules reach the blocker only through the
     * extension's own background message handlers.
     */
    SendExtensionMessage: 'send_extension_message',

    /**
     * The preparation session's only terminal channel.
     */
    FinishPreparation: 'finish_preparation',

    /**
     * The rule-application session's only terminal channel: ends the bounded session that performs
     * the instruction's application steps over the phase lease.
     */
    FinishApplication: 'finish_application',

    /**
     * The replay run's only terminal channel.
     */
    SubmitReplayVerdict: 'submit_replay_verdict',
} as const;

/**
 * One agent tool name.
 */
export type ToolName = (typeof ToolName)[keyof typeof ToolName];
