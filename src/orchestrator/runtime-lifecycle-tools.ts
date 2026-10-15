/**
 * The issue and browser lifecycle tools the agent runtime owns: `fetch_issue`, the runtime's own
 * wrappers over the base registry's guidance and screenshot tools, full-page capture inspection,
 * and the `launch_browser` / `close_browser` session lifecycle. The run's extension build is
 * prepared host-side before the session, so no preparation tool exists here.
 *
 * They register through {@link RuntimeLifecycleToolsHost} rather than against the runtime class, so
 * each handler's bookkeeping is one named seam instead of a reach into runtime state. The
 * reporter-aware `analyze_screenshot` variant is one tool rather than a lifecycle concern and lives
 * beside the plain one in `src/agent/reporter-screenshot-tool.ts`; this file only adapts the host
 * for it.
 *
 * Every one of them reads its registered JSON parameters from the shared catalog through
 * `registeredParameters`, so the catalog stays their single declaration. `close_browser` has no
 * `TOOL_PARAMETER_SCHEMAS` entry at all, so it resolves through a `REGISTERED_SHAPE_OVERRIDES`
 * entry onto its strict `FIX_TOOL_PARAMETER_SCHEMAS` mirror — the same shape the fix session
 * already advertises. `launch_browser` is the one per-run shape: the host hands it the run's
 * advertisement, because whether the request carries `settings` depends on the family of the
 * blocker this run prepared. Nothing advertises the registry `parameters` itself; the drift guard
 * is its only reader, so deriving both sides from one schema makes them agree by construction.
 */
import { registeredParameters } from '../agent/registered-parameters';
import { toAdvertisedSchema } from '../pi/tool-schema';
import { ToolName } from '../agent/tool-names';
import { ToolRegistry } from '../agent/tool-registry';
import { registerReporterScreenshotTool } from '../agent/reporter-screenshot-tool';
import type { FilteringEnvironmentDescriptor } from '../environment/environment-vocabulary';
import type { RawIssue } from '../github/fetch-issue';
import { withToolDeadline } from '../pi/session-tools';
import type { AgentRuntimeSessionState } from './agent-runtime-session-evidence';
import { BROWSER_LAUNCH_DEADLINE_MS, BROWSER_TOOL_DEADLINE_MS } from './browser-tool-deadlines';
import { VISION_TOOL_DEADLINE_MS } from '../agent/vision-tool-deadline';
import type { LaunchBrowserAdvertisement } from './launch-browser-arguments';
import type { WithheldPageObstruction } from '../types/page-obstruction';

/**
 * The runtime seam the lifecycle tools act through.
 */
export interface RuntimeLifecycleToolsHost {
    /**
     * Prompt-safe issue snapshot exposed by `fetch_issue`.
     */
    readonly issue: RawIssue;

    /**
     * Reporter screenshot artifact identities, in the one-based order `fetch_issue` advertises.
     */
    readonly issueAttachmentArtifactIds: readonly string[];

    /**
     * What the model is shown for `launch_browser` on this run.
     *
     * Per-run rather than catalog-fixed: a Firefox-family run has no host-writable settings
     * surface, so its request takes no `settings` and the registered shape must say the same thing
     * the session advertises — the drift guard compares the two.
     */
    readonly launchBrowserAdvertisement: LaunchBrowserAdvertisement;

    /**
     * Registry holding the preserved handlers of the persistent non-browser tools.
     */
    readonly baseRegistry: ToolRegistry;

    /**
     * Filtering environments the Host advertises for this run.
     *
     * @returns The advertised environment descriptors.
     */
    capabilities(): FilteringEnvironmentDescriptor[];

    /**
     * Record one tool name as runtime-owned rather than inherited from the base registry.
     *
     * @param name - Registered tool name.
     */
    markBaseTool(name: string): void;

    /**
     * Dispatch one base-registry tool through the runtime's own bookkeeping.
     *
     * @param name - Base tool name.
     * @param args - Model-supplied arguments.
     * @returns The tool result.
     */
    dispatchBaseTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;

    /**
     * Record that the model read the issue through `fetch_issue`.
     */
    recordFetchedIssue(): void;

    /**
     * Record that the model consulted the rule guidance knowledge base.
     */
    recordGuidanceConsulted(): void;

    /**
     * Read the cached analysis of one reporter screenshot.
     *
     * @param artifactId - Reporter screenshot artifact identity.
     * @returns The cached result, or undefined when this screenshot was never analyzed.
     */
    cachedReporterScreenshotResult(artifactId: string): Record<string, unknown> | undefined;

    /**
     * Retain the first successful analysis of one reporter screenshot for the rest of the run.
     *
     * @param artifactId - Reporter screenshot artifact identity.
     * @param analysis - Non-empty analysis text returned by the vision provider.
     * @param result - Complete tool result to cache for a repeated request.
     */
    recordReporterScreenshotAnalysis(
        artifactId: string,
        analysis: string,
        result: Record<string, unknown>,
    ): void;

    /**
     * Credit one screenshot artifact as inspected by the vision model.
     *
     * @param artifactId - Screenshot artifact identity.
     */
    recordScreenshotAnalysis(artifactId: string): void;

    /**
     * Browser session that produced one screenshot artifact.
     *
     * @param artifactId - Screenshot artifact identity.
     * @returns Session identity, or undefined for a reporter attachment.
     */
    screenshotSessionId(artifactId: string): string | undefined;

    /**
     * Read one browser session's retained state.
     *
     * @param sessionId - Session identity.
     * @returns Session state, or undefined when the session is unknown.
     */
    sessionState(sessionId: string): AgentRuntimeSessionState | undefined;

    /**
     * Spend one bounded technical attempt on a page vision saw withheld behind a wall.
     *
     * @param targetUrl - Exact prompt-safe target selected for the run.
     * @param sessionId - Session that observed the wall.
     * @param obstruction - The wall vision saw in place of the page.
     * @param observation - Bounded prompt-safe description of the wall evidence.
     * @param result - Successful tool result augmented with the budget state in place.
     */
    countWithheldPage(
        targetUrl: string,
        sessionId: string,
        obstruction: WithheldPageObstruction,
        observation: string,
        result: Record<string, unknown>,
    ): void;

    /**
     * Inspect the active session's latest full-page capture with bounded vision batches.
     *
     * @param signal - Deadline signal the inspection threads into every vision request of the
     *   batch, so an expired deadline cancels the in-flight completion and stops the batch instead
     *   of paying for the remaining images.
     * @returns Compact model-facing coverage result or typed retry guidance.
     */
    inspectLatestFullPageCapture(signal?: AbortSignal): Promise<Record<string, unknown>>;

    /**
     * Start one isolated browser session for the model-selected target and profile.
     *
     * @param args - Model-supplied `launch_browser` arguments.
     * @param signal - Deadline signal the launch threads into its application session, so an
     *   expired deadline aborts the session instead of letting it spend turns in the background.
     * @returns The tool result.
     */
    launchBrowser(
        args: Record<string, unknown>,
        signal?: AbortSignal,
    ): Promise<Record<string, unknown>>;

    /**
     * Close the active browser session.
     */
    dispose(): Promise<void>;
}

/**
 * Register the issue, extension, and browser lifecycle tools the runtime owns.
 *
 * @param registry - Registry the model's tool calls dispatch into.
 * @param host - Runtime seam the handlers act through.
 */
export function registerLifecycleTools(
    registry: ToolRegistry,
    host: RuntimeLifecycleToolsHost,
): void {
    registry.register({
        definition: {
            type: 'function',
            function: {
                name: 'fetch_issue',
                description:
                    'Read the prompt-safe raw issue and stable user screenshot indices. Use ' +
                    'issueScreenshotIndex with analyze_screenshot; opaque artifact IDs are not ' +
                    'exposed. Extract extension version, manifest, filters, and settings ' +
                    'yourself.',
                parameters: registeredParameters(ToolName.FetchIssue),
            },
        },
        handler: async (args) => {
            if (args.issueNumber !== host.issue.number) {
                return {
                    error: `This run is restricted to issue ${host.issue.number}.`,
                    errorKind: 'issue_mismatch',
                    retryable: true,
                };
            }
            host.recordFetchedIssue();
            return {
                issue: host.issue,
                capabilities: host.capabilities(),
                issueScreenshots: host.issueAttachmentArtifactIds.map((_, index) => ({
                    issueScreenshotIndex: index + 1,
                })),
            };
        },
    });
    host.markBaseTool('fetch_issue');

    const guidanceDefinition = registry
        .getDefinitions()
        .find((definition) => definition.function.name === 'lookup_rule_guidance');
    if (guidanceDefinition) {
        registry.register({
            definition: guidanceDefinition,
            handler: async (args) => {
                // The proxy registered during create is replaced below by a direct dispatch
                // snapshot, so capture its result before replacing it.
                const proxy = await host.dispatchBaseTool('lookup_rule_guidance', args);
                if (proxy.error === undefined) {
                    host.recordGuidanceConsulted();
                }
                return proxy;
            },
        });
    }

    registerReporterScreenshotTool(registry, {
        issueAttachmentArtifactIds: host.issueAttachmentArtifactIds,
        dispatchBaseTool: (name, args) => host.dispatchBaseTool(name, args),
        cachedReporterScreenshotResult: (artifactId) =>
            host.cachedReporterScreenshotResult(artifactId),
        recordReporterScreenshotAnalysis: (artifactId, analysis, result) =>
            host.recordReporterScreenshotAnalysis(artifactId, analysis, result),
        recordScreenshotAnalysis: (artifactId) => host.recordScreenshotAnalysis(artifactId),
        noteWithheldPageCapture: (artifactId, obstruction, result) => {
            const captureSessionId = host.screenshotSessionId(artifactId);
            const captureState = captureSessionId ? host.sessionState(captureSessionId) : undefined;
            if (captureState && captureSessionId) {
                host.countWithheldPage(
                    captureState.targetUrl,
                    captureSessionId,
                    obstruction,
                    `vision classified capture ${artifactId} as ${obstruction}`,
                    result,
                );
            }
        },
    });

    registry.register({
        definition: {
            type: 'function',
            function: {
                name: 'inspect_full_page_capture',
                description:
                    'Inspect the latest screenshot(captureTiles=true) from the active browser ' +
                    'session. The runner sends its full-page overview and ordered original-' +
                    'resolution tiles to the dedicated vision model in bounded batches, ' +
                    'returns one compact typed inventory, and reports exact artifact IDs for ' +
                    'any batch that needs a focused analyze_screenshot retry.',
                parameters: registeredParameters(ToolName.InspectFullPageCapture),
            },
        },
        handler: async () =>
            await withToolDeadline(
                ToolName.InspectFullPageCapture,
                (signal) => host.inspectLatestFullPageCapture(signal),
                VISION_TOOL_DEADLINE_MS,
            ),
    });
    host.markBaseTool('inspect_full_page_capture');

    registry.register({
        definition: {
            type: 'function',
            function: {
                name: 'launch_browser',
                description: host.launchBrowserAdvertisement.description,
                parameters: toAdvertisedSchema(
                    host.launchBrowserAdvertisement.parameters,
                    'launch_browser',
                ),
            },
        },
        handler: async (args) =>
            await withToolDeadline(
                'launch_browser',
                (signal) => host.launchBrowser(args, signal),
                BROWSER_LAUNCH_DEADLINE_MS,
            ),
    });
    host.markBaseTool('launch_browser');

    registry.register({
        definition: {
            type: 'function',
            function: {
                name: 'close_browser',
                description: 'Close the active browser before ending or changing environment.',
                parameters: registeredParameters(ToolName.CloseBrowser),
            },
        },
        handler: async () =>
            await withToolDeadline(
                'close_browser',
                async () => {
                    await host.dispose();
                    return { closed: true };
                },
                BROWSER_TOOL_DEADLINE_MS,
            ),
    });
    host.markBaseTool('close_browser');
}
