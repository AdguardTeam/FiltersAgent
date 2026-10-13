/**
 * The reporter-aware variant of `analyze_screenshot`: the same vision tool, widened so the model
 * can address a user-reported issue screenshot by its stable one-based `fetch_issue` index instead
 * of transcribing an opaque artifact identity.
 *
 * The plain tool in `analyze-screenshot-tool.ts` owns the vision call itself; this one wraps that
 * registration, resolves a reporter index onto the artifact behind it, caches the first successful
 * reporter analysis, and reports every inspected capture back to its host. It sits here rather than
 * with the runtime lifecycle because it is one tool with two variants, not a lifecycle concern.
 */
import type { ToolDefinition, ToolRegistry } from './tool-registry';
import { ToolName } from './tool-names';
import {
    isWithheldPage,
    type PageObstruction,
    type WithheldPageObstruction,
} from '../types/page-obstruction';

/**
 * The runtime seam the reporter-aware screenshot tool acts through.
 *
 * Deliberately narrower than the lifecycle host: the withheld-page bookkeeping is one call here
 * because resolving a capture to its browser session is the runtime's business, not this tool's.
 */
export interface ReporterScreenshotToolHost {
    /**
     * Reporter screenshot artifact identities, in the one-based order `fetch_issue` advertises.
     */
    readonly issueAttachmentArtifactIds: readonly string[];

    /**
     * Dispatch one base-registry tool through the runtime's own bookkeeping.
     *
     * @param name - Base tool name.
     * @param args - Model-supplied arguments.
     * @returns The tool result.
     */
    dispatchBaseTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;

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
     * Spend the session-bound access budget for a capture vision classified as a withheld page.
     *
     * The vision model, not the reasoning model, made that call. A reporter attachment has no
     * session and must never be charged, which is why the host resolves the capture itself.
     *
     * @param artifactId - Screenshot artifact vision classified as a withheld page.
     * @param obstruction - The wall vision saw in place of the page.
     * @param result - Successful tool result carrying the classification.
     */
    noteWithheldPageCapture(
        artifactId: string,
        obstruction: WithheldPageObstruction,
        result: Record<string, unknown>,
    ): void;
}

/**
 * Add a stable reporter-screenshot index to the generic screenshot-analysis tool definition.
 *
 * Browser screenshots continue to use their returned artifact IDs. Reporter screenshots instead use
 * a short one-based index so the model never needs to transcribe an integrity digest.
 *
 * @param definition - Base screenshot-analysis tool definition.
 * @param issueScreenshotCount - Number of runner-owned reporter screenshots available to the run.
 * @returns Definition accepting either a browser artifact ID or reporter screenshot index.
 */
function reporterAwareScreenshotDefinition(
    definition: ToolDefinition,
    issueScreenshotCount: number,
): ToolDefinition {
    const rawProperties = definition.function.parameters.properties;
    const properties =
        typeof rawProperties === 'object' && rawProperties !== null && !Array.isArray(rawProperties)
            ? (rawProperties as Record<string, unknown>)
            : {};
    return {
        ...definition,
        function: {
            ...definition.function,
            description:
                definition.function.description +
                ' For a user-reported issue screenshot, pass issueScreenshotIndex exactly as ' +
                'returned by fetch_issue; do not copy or invent an opaque artifact ID.',
            parameters: {
                ...definition.function.parameters,
                properties: {
                    ...properties,
                    artifactId: properties.artifactId ?? {
                        type: 'string',
                        description: 'Artifact ID returned by the browser screenshot tool.',
                    },
                    issueScreenshotIndex: {
                        type: 'number',
                        minimum: 1,
                        ...(issueScreenshotCount > 0 ? { maximum: issueScreenshotCount } : {}),
                        description:
                            'One-based user screenshot index returned by fetch_issue. Prefer this ' +
                            'over artifactId for reporter evidence.',
                    },
                    prompt: properties.prompt ?? {
                        type: 'string',
                        description: 'Visual details to inspect.',
                    },
                },
                required: ['prompt'],
            },
        },
    };
}

/**
 * Register the reporter-aware `analyze_screenshot` over the plain one already in the registry.
 *
 * A registry without the base tool gets nothing: the wrapper has no vision call of its own.
 *
 * @param registry - Registry the model's tool calls dispatch into, already holding the base tool.
 * @param host - Runtime seam the handler acts through.
 */
export function registerReporterScreenshotTool(
    registry: ToolRegistry,
    host: ReporterScreenshotToolHost,
): void {
    const analyzeDefinition = registry
        .getDefinitions()
        .find((definition) => definition.function.name === ToolName.AnalyzeScreenshot);
    if (analyzeDefinition) {
        registry.register({
            definition: reporterAwareScreenshotDefinition(
                analyzeDefinition,
                host.issueAttachmentArtifactIds.length,
            ),
            handler: async (args) => {
                const hasArtifactId =
                    typeof args.artifactId === 'string' && args.artifactId.trim().length > 0;
                const hasIssueScreenshotIndex = args.issueScreenshotIndex !== undefined;
                if (hasArtifactId && hasIssueScreenshotIndex) {
                    return {
                        error:
                            'Pass either artifactId or issueScreenshotIndex, not both, to ' +
                            'analyze_screenshot.',
                        errorKind: 'ambiguous_screenshot_reference',
                        retryable: true,
                    };
                }
                let resolvedIssueScreenshotIndex: number | undefined;
                let resolvedArtifactId = hasArtifactId ? String(args.artifactId).trim() : '';
                if (hasIssueScreenshotIndex) {
                    const requestedIndex = args.issueScreenshotIndex;
                    if (
                        typeof requestedIndex !== 'number' ||
                        !Number.isInteger(requestedIndex) ||
                        requestedIndex < 1 ||
                        requestedIndex > host.issueAttachmentArtifactIds.length
                    ) {
                        return {
                            error:
                                `Reporter screenshot index ${String(requestedIndex)} is ` +
                                'unavailable.',
                            errorKind: 'issue_screenshot_index_out_of_range',
                            retryable: true,
                            availableIssueScreenshotIndices: host.issueAttachmentArtifactIds.map(
                                (_, index) => index + 1,
                            ),
                        };
                    }
                    resolvedIssueScreenshotIndex = requestedIndex;
                    resolvedArtifactId = host.issueAttachmentArtifactIds[requestedIndex - 1]!;
                }
                const cachedReporterResult =
                    resolvedIssueScreenshotIndex !== undefined
                        ? host.cachedReporterScreenshotResult(resolvedArtifactId)
                        : undefined;
                if (cachedReporterResult) {
                    return {
                        ...cachedReporterResult,
                        issueScreenshotIndex: resolvedIssueScreenshotIndex,
                        cached: true,
                    };
                }
                const dispatchArgs: Record<string, unknown> = {
                    ...args,
                    artifactId: resolvedArtifactId,
                };
                delete dispatchArgs.issueScreenshotIndex;
                const result = await host.dispatchBaseTool(
                    ToolName.AnalyzeScreenshot,
                    dispatchArgs,
                );
                const analysis = typeof result.analysis === 'string' ? result.analysis.trim() : '';
                const hasAnalysis = analysis.length > 0;
                if (result.error === undefined && !hasAnalysis) {
                    return {
                        error:
                            'The vision provider returned no screenshot observation. Retry ' +
                            'this exact screenshot before treating it as inspected.',
                        errorKind: 'screenshot_analysis_empty',
                        retryable: true,
                        requiredAction: 'retry_screenshot_analysis',
                        requiredTool: 'analyze_screenshot',
                        ...(resolvedIssueScreenshotIndex !== undefined
                            ? { issueScreenshotIndex: resolvedIssueScreenshotIndex }
                            : { artifactId: resolvedArtifactId }),
                    };
                }
                if (host.issueAttachmentArtifactIds.includes(resolvedArtifactId) && hasAnalysis) {
                    host.recordReporterScreenshotAnalysis(resolvedArtifactId, analysis, result);
                }
                if (hasAnalysis) {
                    host.recordScreenshotAnalysis(resolvedArtifactId);
                    // The vision model, not the reasoning model, judged this capture to be a
                    // withheld page. Session-bound captures spend the bounded per-target budget;
                    // reporter attachments have no session and never count. The result is this
                    // run's own analyze_screenshot answer, parsed by its schema.
                    const obstruction = result.pageObstruction as PageObstruction;
                    if (isWithheldPage(obstruction)) {
                        host.noteWithheldPageCapture(resolvedArtifactId, obstruction, result);
                    }
                }
                if (resolvedIssueScreenshotIndex !== undefined) {
                    const publicResult = { ...result };
                    delete publicResult.artifactId;
                    return {
                        ...publicResult,
                        issueScreenshotIndex: resolvedIssueScreenshotIndex,
                    };
                }
                return result;
            },
        });
    }
}
