import type { GithubReadConfig, RawIssue } from '../github/fetch-issue';
import { stripBenchmarkIssueMarker } from '../github/benchmark-issue-marker';
import { ToolRegistry } from './tool-registry';
import { ToolName } from './tool-names';
import { registeredParameters } from './registered-parameters';
import { registerRuleSearchTool } from './rule-search-tool';
import { registerAnalyzeScreenshotTool, type VisionToolOptions } from './analyze-screenshot-tool';
import { registerBrowserTools, type BrowserToolOptions } from './browser-tool-bindings';
import { registerGetDetailTool } from './get-detail-tool';
import { generatePlacementMap } from '../repo/placement-map';
import { createLogger } from '../logger/logger';
import { isSingleLineRule } from '../repo/rule-normalizer';
import { runRepositoryLint, type RepositoryLintCommand } from '../rules/repository-lint-command';
import * as v from 'valibot';
import { TraceArtifactStore, type IArtifactStore } from '../tracer/artifact-store';
import type { PlacementMap } from '../types/repo-context';
import {
    KnowledgeGuidanceSession,
    RULE_GUIDANCE_TOPICS,
    RuleGuidanceQuerySchema,
    RuleGuidanceTopicSchema,
    type RuleGuidanceSource,
} from '../knowledge/rule-guidance';

/**
 * Local issue source used by GitHub-independent investigation runs.
 */
export interface LocalIssueToolOptions {
    /**
     * Parser-ready issue snapshot returned verbatim by the fetch_issue tool.
     */
    localIssue: RawIssue;

    /**
     * Runner-bound reported hostname used to rank repository selector inventory offline.
     */
    reportedDomain?: string;
}

/**
 * Everything one run binds into its tool registry.
 */
export interface ToolRegistryOptions {
    /**
     * GitHub read credentials backing fetch_issue; omit when a local snapshot supplies the issue.
     */
    githubConfig?: GithubReadConfig;

    /**
     * The only issue number the model may fetch in this run.
     */
    allowedIssueNumber: number;

    /**
     * Path to the AdguardFilters checkout; enables search_rules.
     */
    checkoutPath?: string;

    /**
     * Browser session and analyzer enabling the live evidence and candidate tools.
     */
    browserTools?: BrowserToolOptions;

    /**
     * Artifact store backing get_detail; derived from the browser or vision options when omitted.
     */
    artifactStore?: IArtifactStore;

    /**
     * Browser-independent screenshot-analysis configuration; derived from the browser options when
     * those carry a vision client and this is omitted.
     */
    visionTools?: VisionToolOptions;

    /**
     * Local issue snapshot that replaces the GitHub fetch dependency.
     */
    localIssueTools?: LocalIssueToolOptions;

    /**
     * This run's rule-guidance source — the pinned KnowledgeBase checkout or the instruction's
     * linked documents — enabling lookup_rule_guidance. Both variants carry the `kind` tag the
     * guidance session dispatches on.
     */
    knowledgeGuidance?: RuleGuidanceSource;

    /**
     * Placement map the runtime already walked for this run's list catalog. Supplied, the factory
     * binds the checkout tools to it and never walks the tree itself; omitted, it walks the
     * checkout as before, keeping the single-walk rule under every caller.
     */
    placementMap?: PlacementMap;

    /**
     * The repository's own lint command, when the run has one; enables `lint_rule`, which runs it
     * over a candidate. Absent, no lint tool is offered.
     */
    repositoryLint?: RepositoryLintCommand;
}

/**
 * Normalize a runner-bound hostname without accepting paths, credentials, or ports.
 *
 * @param domain - Trusted hostname candidate supplied by the core runtime.
 * @returns Canonical lowercase hostname, or undefined when invalid.
 */
function normalizeTrustedReportedDomain(domain: string | undefined): string | undefined {
    if (!domain) {
        return undefined;
    }
    const normalized = domain.trim().toLowerCase().replace(/\.$/u, '');
    try {
        const parsed = new URL(`https://${normalized}`);
        return parsed.hostname === normalized && parsed.port.length === 0 ? normalized : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Derive the trusted issue hostname used by deterministic risk scoring.
 *
 * The browser origin is bound by the runner outside the model trust boundary. Tool arguments are
 * deliberately excluded so the model cannot lower risk by claiming a different reported domain.
 *
 * @param browserTools - Optional runner-owned browser configuration.
 * @returns The normalized reported hostname, or undefined when no valid browser URL is bound.
 */
function trustedReportedDomainFromBrowser(
    browserTools: BrowserToolOptions | undefined,
): string | undefined {
    if (!browserTools) {
        return undefined;
    }
    try {
        return new URL(browserTools.allowedOrigin).hostname.toLowerCase().replace(/\.$/u, '');
    } catch {
        return undefined;
    }
}

/**
 * Derive the screenshot-analysis configuration this run should use.
 *
 * An explicit `visionTools` wins; otherwise a browser configuration carrying a vision client
 * supplies the same artifact registry and late-bound symptom accessors.
 *
 * @param options - The run's registry options.
 * @returns The vision configuration, or undefined when the run has no vision client.
 */
function resolveVisionTools(options: ToolRegistryOptions): VisionToolOptions | undefined {
    if (options.visionTools) {
        return options.visionTools;
    }
    const browserTools = options.browserTools;
    if (!browserTools?.vision) {
        return undefined;
    }
    return {
        artifactsDir: browserTools.artifactsDir,
        recorder: browserTools.recorder,
        vision: browserTools.vision,
        reporterSymptom: browserTools.reporterSymptom,
        reporterSymptomKind: browserTools.reporterSymptomKind,
    };
}

/**
 * Derive the artifact store `get_detail` reads and the rule inventory persists through.
 *
 * An explicit store wins; otherwise the browser or vision configuration's artifacts directory and
 * recorder back a trace-registering store, so persisted detail stays reachable from the trace.
 *
 * @param options - The run's registry options.
 * @param visionTools - The resolved screenshot-analysis configuration, when the run has one.
 * @returns The artifact store, or undefined when the run persists nothing.
 */
function resolveArtifactStore(
    options: ToolRegistryOptions,
    visionTools: VisionToolOptions | undefined,
): IArtifactStore | undefined {
    if (options.artifactStore) {
        return options.artifactStore;
    }
    if (options.browserTools) {
        return new TraceArtifactStore(
            options.browserTools.artifactsDir,
            options.browserTools.recorder,
        );
    }
    if (visionTools) {
        return new TraceArtifactStore(visionTools.artifactsDir, visionTools.recorder);
    }
    return undefined;
}

/**
 * Create a ToolRegistry pre-populated with all agent tools.
 *
 * Always registers the pure `fetch_issue` tool. When the run binds the repository's own lint
 * command, registers `lint_rule` over it. When `checkoutPath` is provided, additionally registers
 * `search_rules` against the checkout. When `browserTools` is provided, additionally registers
 * browser evidence and validation tools. If vision configuration is present, it also registers
 * `analyze_screenshot`.
 *
 * Every caller registers its tools through this factory, so registration is never duplicated.
 *
 * @param options - Everything this run binds into its registry.
 * @returns A fully registered ToolRegistry ready for the agent loop.
 */
export async function createToolRegistry(options: ToolRegistryOptions): Promise<ToolRegistry> {
    const { allowedIssueNumber, githubConfig, checkoutPath, browserTools, localIssueTools } =
        options;
    if (!Number.isInteger(allowedIssueNumber) || allowedIssueNumber < 1) {
        throw new Error(`Invalid allowed issue number: ${allowedIssueNumber}`);
    }
    const registry = new ToolRegistry();
    const trustedReportedDomain =
        trustedReportedDomainFromBrowser(browserTools) ??
        normalizeTrustedReportedDomain(localIssueTools?.reportedDomain);
    const guidanceSession = options.knowledgeGuidance
        ? new KnowledgeGuidanceSession(options.knowledgeGuidance)
        : undefined;
    const requireGuidanceBeforeCandidate = (): Record<string, unknown> | undefined =>
        guidanceSession && !guidanceSession.hasConsultedGuidance()
            ? {
                  error:
                      'Call lookup_rule_guidance before evaluating or validating the first ' +
                      'candidate rule.',
                  requiredTool: ToolName.LookupRuleGuidance,
                  allowedTopics: RULE_GUIDANCE_TOPICS,
              }
            : undefined;
    const resolvedVisionTools = resolveVisionTools(options);
    const resolvedArtifactStore = resolveArtifactStore(options, resolvedVisionTools);

    if (guidanceSession) {
        registry.register({
            definition: {
                type: 'function',
                function: {
                    name: ToolName.LookupRuleGuidance,
                    description:
                        "Read one bounded topic from this run's rule-guidance documents. This must " +
                        'be called before evaluating the first candidate. Prefer domain-scoped ' +
                        'element hiding for removable ads and leftovers; consult CSS injection ' +
                        'only when ordinary hiding is proven insufficient. A document too long to ' +
                        'return whole comes back as the sections matching the topic plus an index ' +
                        'of every heading it has; pass `query` with the words naming what you need ' +
                        'to narrow it to those sections, and call again for another part.',
                    parameters: registeredParameters(ToolName.LookupRuleGuidance),
                },
            },
            handler: async (args) => {
                const parsed = v.safeParse(RuleGuidanceTopicSchema, args.topic);
                if (!parsed.success) {
                    return {
                        error: `Unsupported guidance topic: ${String(args.topic)}`,
                        allowedTopics: RULE_GUIDANCE_TOPICS,
                    };
                }
                const query = v.safeParse(RuleGuidanceQuerySchema, args.query);
                return guidanceSession.lookup(
                    parsed.output,
                    query.success ? query.output : undefined,
                ) as unknown as Record<string, unknown>;
            },
        });
    }

    // ── fetch_issue (always) ───────────────────────────────────────────────
    registry.register({
        definition: {
            type: 'function',
            function: {
                name: ToolName.FetchIssue,
                description:
                    'Fetch the current issue snapshot by number. Returns the issue body, labels, ' +
                    'state, assignee, and prompt-safe comments.',
                parameters: registeredParameters(ToolName.FetchIssue),
            },
        },
        handler: async (args) => {
            const num =
                typeof args.issueNumber === 'number' ? args.issueNumber : Number(args.issueNumber);
            if (!Number.isInteger(num) || num < 1) {
                throw new Error(`Invalid issue number: ${args.issueNumber}`);
            }
            if (num !== allowedIssueNumber) {
                throw new Error(
                    `fetch_issue is restricted to issue ${allowedIssueNumber} for this run`,
                );
            }
            let raw: RawIssue;
            if (localIssueTools) {
                raw = {
                    ...localIssueTools.localIssue,
                    body: stripBenchmarkIssueMarker(localIssueTools.localIssue.body),
                };
                if (raw.number !== allowedIssueNumber) {
                    throw new Error(
                        `Local issue snapshot ${raw.number} does not match allowed issue ` +
                            allowedIssueNumber,
                    );
                }
            } else {
                if (!githubConfig) {
                    throw new Error('GitHub credentials or a local issue snapshot are required');
                }
                const { fetchIssue } = await import('../github/fetch-issue');
                raw = await fetchIssue(githubConfig, num);
            }
            return { raw };
        },
    });

    // ── lint_rule (only with the repository's own lint command) ────────────
    const repositoryLint = options.repositoryLint;
    if (repositoryLint !== undefined) {
        const lintLogger = createLogger();
        registry.register({
            definition: {
                type: 'function',
                function: {
                    name: ToolName.LintRule,
                    description:
                        "Run the repository's own lint command over a candidate rule placed in " +
                        'the directory of the list file it goes into. Returns status, exitCode and ' +
                        'the bounded output.',
                    parameters: registeredParameters(ToolName.LintRule),
                },
            },
            handler: async (args) => {
                const guidanceRequirement = requireGuidanceBeforeCandidate();
                if (guidanceRequirement) {
                    return guidanceRequirement;
                }
                if (typeof args.rule !== 'string' || args.rule.trim().length === 0) {
                    return { error: 'Invalid input: rule must be a non-empty string' };
                }
                if (!isSingleLineRule(args.rule)) {
                    return { error: 'Invalid input: rule must be a single line' };
                }
                if (typeof args.filePath !== 'string' || args.filePath.trim().length === 0) {
                    return { error: 'Invalid input: filePath must be a non-empty string' };
                }
                return {
                    ...(await runRepositoryLint(
                        repositoryLint,
                        { rule: args.rule, filePath: args.filePath },
                        lintLogger,
                    )),
                };
            },
        });
    }

    // ── Checkout-dependent tools ───────────────────────────────────────────
    if (checkoutPath) {
        // The runtime's catalog walk supplies its map when one exists, so a run walks the filter
        // tree exactly once.
        const map = options.placementMap ?? generatePlacementMap(checkoutPath);
        registerRuleSearchTool(registry, {
            checkoutPath,
            map,
            trustedReportedDomain,
            artifactStore: resolvedArtifactStore,
        });
    }

    if (browserTools) {
        await registerBrowserTools(registry, browserTools);
    }

    if (resolvedVisionTools) {
        registerAnalyzeScreenshotTool(registry, resolvedVisionTools);
    }

    if (resolvedArtifactStore) {
        registerGetDetailTool(registry, resolvedArtifactStore);
    }

    return registry;
}
