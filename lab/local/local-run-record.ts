/**
 * The local run record: the typed, agent-first report payload the local cycle publishes, assembled
 * from the ordered core executions and the verified provenance of everything the run pinned.
 *
 * Pure over its inputs — no run state, no side effects beyond reading artifacts the run already
 * wrote — so the runner composes it once the executions are locked.
 */
import { readFileSync } from 'node:fs';
import type { AdGuardExtensionSettingsProfile } from '../../src/browser/adguard-extension-settings';
import { ExtensionMode, type FixRunResult } from '../../src/types/fix-run-result';
import { ActivationProof } from '../../src/types/activation-proof';
import { CheckoutSource } from '../../src/types/checkout-source';
import { ExtensionEnvironmentKind } from '../../src/types/extension-environment-kind';
import { FilterEngine } from '../../src/types/filter-engine';
import { ProvenanceSource } from '../../src/types/provenance-source';
import { SettingsApplicationStatus } from '../../src/types/settings-application-status';
import { SettingsProfileKind } from '../../src/types/settings-profile-kind';
import { BrowserFallbackReason } from '../../src/types/browser-fallback-reason';
import { RULE_GUIDANCE_TOPICS, type RuleGuidanceTopic } from '../../src/knowledge/rule-guidance';
import type { PreparedFiltersCheckout } from '../../src/local/filters-preparer';
import type { PreparedKnowledgeBase } from './knowledge-base-preparer';
import {
    LOCAL_CITATION_REPOSITORY_PATTERN,
    type LocalInstructionProvenance,
    type LocalKnowledgeGuidanceCitation,
} from '../../src/local/run-record-guidance-schemas';
import type { LocalRunRecord, LocalSettingsProfileEvidence } from '../../src/local/run-output';
import { readSettingsProof } from '../../src/local/settings-proof';

/**
 * One local core execution consumed by the report adapter.
 */
export interface LocalCoreExecution {
    /**
     * Stable profile name shown in artifact labels.
     */
    name:
        | 'unfiltered'
        | typeof SettingsProfileKind.DefaultsPlusRequired
        | typeof SettingsProfileKind.ReportedOnCurrent
        | typeof SettingsProfileKind.ReportExact
        | 'agentic';

    /**
     * Applied extension profile, or null for the unfiltered control.
     */
    settingsProfile: AdGuardExtensionSettingsProfile | null;

    /**
     * Locked profile result.
     */
    result: FixRunResult;
}

/**
 * Core execution with a proven extension settings profile.
 */
interface SettingsProfileExecution extends LocalCoreExecution {
    /**
     * Applied extension settings profile.
     */
    settingsProfile: AdGuardExtensionSettingsProfile;
}

/**
 * Convert runner settings proof to human-readable metadata-plus-DNR evidence.
 *
 * @param result - Locked core result.
 * @param expectedProfileKind - Profile kind requested by the local wrapper, used when the run wrote
 *   no proof.
 * @returns One typed profile evidence record.
 */
function buildSettingsEvidence(
    result: FixRunResult,
    expectedProfileKind: AdGuardExtensionSettingsProfile['kind'],
): LocalSettingsProfileEvidence {
    const proof = readSettingsProof(result.artifactPaths.settingsProof);
    if (!proof) {
        return {
            name: expectedProfileKind,
            status:
                result.fallbackReason === BrowserFallbackReason.ExtensionConfigurationFailed
                    ? SettingsApplicationStatus.Failed
                    : SettingsApplicationStatus.Partial,
            detail:
                result.fallbackDetail ??
                'The requested profile did not produce complete metadata and runtime proof.',
            activationProof: ActivationProof.Unavailable,
            // No proof means the read-back never observed the enabled set: the record carries null
            // so the report says "not observed" instead of listing no filters.
            enabledFilters: null,
        };
    }
    const metadataIds = new Set(proof.optionsEnabledFilterIds);
    const runtimeIds = new Set(proof.runtimeEnabledFilterIds);
    return {
        name: proof.profileKind,
        status: SettingsApplicationStatus.Applied,
        detail:
            proof.filterEngine === FilterEngine.WebRequest
                ? 'MV2 has no DNR rulesets; enabled IDs were verified through the background runtime.'
                : null,
        activationProof:
            proof.filterEngine === FilterEngine.WebRequest
                ? ActivationProof.Mv2BackgroundRuntime
                : ActivationProof.DnrRulesets,
        enabledFilters: proof.enabledFilters.map((filter) => ({
            id: filter.filterId,
            name: filter.name ?? `Filter ${filter.filterId}`,
            group:
                filter.groupName ??
                (filter.groupId === undefined ? null : `Group ${filter.groupId}`),
            version: filter.version ?? null,
            metadataEnabled: metadataIds.has(filter.filterId),
            runtimeEnabled: runtimeIds.has(filter.filterId),
        })),
    };
}

/**
 * Build stable report artifact links from the locked core result.
 *
 * @param executions - Ordered core executions whose paths are local-only.
 * @returns Named non-null artifact links.
 */
function buildArtifactLinks(executions: LocalCoreExecution[]): LocalRunRecord['artifacts'] {
    return executions.flatMap((execution) =>
        [
            ['Trace', execution.result.artifactPaths.trace],
            ['DOM snapshot', execution.result.artifactPaths.domSnapshot],
            ['HAR', execution.result.artifactPaths.har],
            ['Settings proof', execution.result.artifactPaths.settingsProof ?? null],
            ['Browser console', execution.result.artifactPaths.browserLog ?? null],
            [
                'Live symptom observation',
                execution.result.artifactPaths.symptomObservationEvidence ?? null,
            ],
            [
                'Candidate vision review',
                execution.result.artifactPaths.candidateVisualReview ?? null,
            ],
        ]
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
            .map(([label, path]) => ({ label: `${execution.name} — ${label}`, path })),
    );
}

/**
 * Select one bounded viewport/full-page pair from an exact browser session.
 *
 * @param session - Session-bound captures in chronological order.
 * @returns The latest fully inspected pair, or the latest diagnostic pair when none was verified.
 */
function browserSessionOverviewPaths(
    session: NonNullable<FixRunResult['browserSessions']>[number],
): string[] {
    let capture = session.captures.at(-1);
    for (let index = session.captures.length - 1; index >= 0; index -= 1) {
        const candidate = session.captures[index];
        if (candidate?.visionVerified) {
            capture = candidate;
            break;
        }
    }
    if (!capture) {
        return [];
    }
    return [capture.viewport, capture.fullPageOverview].filter(
        (path): path is string => path !== null,
    );
}

/**
 * Select one autonomous set of integrity-checked issue screenshot copies from profile artifacts.
 *
 * Each isolated profile copies the same reporter images into its own artifact directory. The report
 * needs only the first complete set and must not depend on the source case bundle after the run
 * finishes.
 *
 * @param executions - Ordered isolated profile executions.
 * @returns Copied issue screenshot paths from the first profile that persisted them.
 */
function copiedIssueScreenshotPaths(executions: LocalCoreExecution[]): string[] {
    for (const execution of executions) {
        const paths = execution.result.artifactPaths.screenshots.filter((path) =>
            path.includes('/issue-screenshots/'),
        );
        if (paths.length > 0) {
            return [...new Set(paths)];
        }
    }
    return [];
}

/**
 * One trace citation candidate: the fields the harvested record reads.
 */
interface TraceCitation {
    /**
     * Value as it appeared in the trace result.
     */
    [key: string]: unknown;
}

/**
 * Whether a trace citation candidate names a real locator.
 *
 * A citation must name a repository, a path, an anchor, and a parseable URL. A checkout-origin
 * instruction document has no citation at all — its locator is a moving local path and its identity
 * is the source digest — so an entry without a full locator names nothing citable and is dropped
 * rather than fabricated from the local machine.
 *
 * @param record - Candidate citation fields from the trace result.
 * @returns Whether the candidate is a citable locator.
 */
function isCitableLocator(record: TraceCitation): boolean {
    if (
        typeof record.repository !== 'string' ||
        !LOCAL_CITATION_REPOSITORY_PATTERN.test(record.repository) ||
        typeof record.filePath !== 'string' ||
        typeof record.anchor !== 'string' ||
        typeof record.url !== 'string'
    ) {
        return false;
    }
    let locatorParsesAsHttpUrl = false;
    try {
        // Parsed for validation only: a citation's locator must name a real http(s) URL.
        const parsedUrl = new URL(record.url);
        locatorParsesAsHttpUrl = parsedUrl.protocol === 'https:' || parsedUrl.protocol === 'http:';
    } catch {
        locatorParsesAsHttpUrl = false;
    }
    if (!locatorParsesAsHttpUrl) {
        return false;
    }
    // The commit may be absent (URL-sourced instruction documents) but must be an exact 40-hex
    // digest when present.
    return (
        record.commit === undefined ||
        (typeof record.commit === 'string' && /^[0-9a-f]{40}$/iu.test(record.commit))
    );
}

/**
 * Collect immutable lookup_rule_guidance citations from locked profile traces.
 *
 * KnowledgeBase citations carry their exact 40-hex commit. Instruction citations cite whole
 * documents fetched by URL and name no commit. Checkout-origin instruction documents never carry a
 * citation, and a trace entry missing its locator is ignored rather than fabricated (see
 * {@link isCitableLocator}). The collection is deduplicated on topic + url.
 *
 * @param executions - Ordered isolated profile results.
 * @returns Deduplicated citations actually returned to the agent.
 */
export function collectKnowledgeGuidanceCitations(
    executions: LocalCoreExecution[],
): LocalKnowledgeGuidanceCitation[] {
    const citations: LocalKnowledgeGuidanceCitation[] = [];
    for (const execution of executions) {
        const tracePath = execution.result.artifactPaths.trace;
        if (!tracePath) {
            continue;
        }
        let trace: unknown;
        try {
            trace = JSON.parse(readFileSync(tracePath, 'utf8'));
        } catch {
            continue;
        }
        if (!trace || typeof trace !== 'object') {
            continue;
        }
        const events = (trace as Record<string, unknown>).events;
        if (!Array.isArray(events)) {
            continue;
        }
        for (const event of events) {
            if (!event || typeof event !== 'object') {
                continue;
            }
            const eventRecord = event as Record<string, unknown>;
            const payload = eventRecord.payload;
            if (eventRecord.type !== 'tool_result' || !payload) {
                continue;
            }
            if (typeof payload !== 'object') {
                continue;
            }
            const toolPayload = payload as Record<string, unknown>;
            if (toolPayload.tool !== 'lookup_rule_guidance') {
                continue;
            }
            if (!toolPayload.result || typeof toolPayload.result !== 'object') {
                continue;
            }
            const result = toolPayload.result as Record<string, unknown>;
            if (
                typeof result.topic !== 'string' ||
                !RULE_GUIDANCE_TOPICS.includes(result.topic as RuleGuidanceTopic) ||
                !Array.isArray(result.citations)
            ) {
                continue;
            }
            for (const citation of result.citations) {
                if (!citation || typeof citation !== 'object') {
                    continue;
                }
                const record = citation as TraceCitation;
                if (!isCitableLocator(record)) {
                    continue;
                }
                citations.push({
                    topic: result.topic as LocalKnowledgeGuidanceCitation['topic'],
                    repository: record.repository as string,
                    commit: record.commit as string | undefined,
                    filePath: record.filePath as string,
                    anchor: record.anchor as string,
                    url: record.url as string,
                });
            }
        }
    }
    return citations.filter(
        (citation, index, all) =>
            all.findIndex(
                (candidate) => candidate.topic === citation.topic && candidate.url === citation.url,
            ) === index,
    );
}

/**
 * Build the typed agent-first local run record.
 *
 * @param environment - Selected product horizon.
 * @param filters - Verified disposable filter checkout.
 * @param knowledgeBase - Verified disposable documentation checkout; null for instruction-driven
 *   runs, whose linked documents replace it and whose provenance block is therefore omitted.
 * @param executions - Ordered isolated profile results.
 * @param issueScreenshots - Integrity-checked user screenshot paths.
 * @param result - Locked core result.
 * @param instruction - Instruction and linked-document roster of an instruction-driven run; the
 *   built-in KnowledgeBase path leaves the block absent.
 * @returns Validated-by-writer local report payload.
 */
export function buildLocalRunRecord(
    environment: ExtensionEnvironmentKind,
    filters: PreparedFiltersCheckout,
    knowledgeBase: PreparedKnowledgeBase | null,
    executions: LocalCoreExecution[],
    issueScreenshots: string[],
    result: FixRunResult,
    instruction?: LocalInstructionProvenance,
): LocalRunRecord {
    const verified = result.artifactPaths.verifiedCandidateScreenshots;
    const rejected = result.artifactPaths.rejectedCandidateScreenshots;
    const rejectedScreenshots = rejected
        ? [rejected.before, rejected.after, rejected.beforeFullPage, rejected.afterFullPage]
        : [];
    const rejectedPairs: NonNullable<LocalRunRecord['evidence']['rejectedPairs']> = [];
    if (rejected) {
        rejectedPairs.push({
            reason: rejected.rejectionReasons.join(', '),
            beforeScreenshots: [rejected.before],
            afterScreenshots: [rejected.after],
            beforeFullPageScreenshots: [rejected.beforeFullPage],
            afterFullPageScreenshots: [rejected.afterFullPage],
        });
    }
    const copiedIssueScreenshots = copiedIssueScreenshotPaths(executions);
    // The locked result's extension provenance is already the single-source serialization every
    // provenance block shares; the record re-publishes it verbatim.
    const extensionProvenance: LocalRunRecord['provenance']['extension'] =
        result.extensionProvenance ?? null;
    const agentSettingsProfiles: LocalRunRecord['provenance']['settingsProfiles'] = [];
    if (result.settingsEvidence) {
        // The builder reads only the profile kind; the enabled set and Stealth state live in the
        // locked result's settings evidence, which carries null for anything not observed.
        agentSettingsProfiles.push(
            buildSettingsEvidence(result, SettingsProfileKind.AgentSelected),
        );
    }
    return {
        result,
        provenance: {
            environment,
            headless: true,
            extension: extensionProvenance,
            ...(instruction ? { instruction } : {}),
            ...(knowledgeBase
                ? {
                      knowledgeBase: {
                          environment: knowledgeBase.provenance.environment,
                          source:
                              knowledgeBase.provenance.source === CheckoutSource.LocalSharedClone
                                  ? ProvenanceSource.Local
                                  : ProvenanceSource.Remote,
                          sourceLocation: knowledgeBase.provenance.sourceLocation,
                          requestedRevision: knowledgeBase.provenance.requestedRevision,
                          commit: knowledgeBase.provenance.commit,
                          filtersCommit: knowledgeBase.provenance.filtersCommit,
                          documents: knowledgeBase.provenance.documents,
                          citations: collectKnowledgeGuidanceCitations(executions),
                      },
                  }
                : {}),
            settingsProfiles: [
                ...executions
                    .filter(
                        (execution): execution is SettingsProfileExecution =>
                            execution.settingsProfile !== null,
                    )
                    .map((execution) =>
                        buildSettingsEvidence(execution.result, execution.settingsProfile.kind),
                    ),
                ...agentSettingsProfiles,
            ],
        },
        evidence: {
            summary: result.reasoning,
            userScreenshots:
                copiedIssueScreenshots.length > 0 ? copiedIssueScreenshots : issueScreenshots,
            unfilteredScreenshots: executions
                .flatMap((execution) => execution.result.browserSessions ?? [])
                .filter((session) => session.extensionMode === ExtensionMode.None)
                .flatMap(browserSessionOverviewPaths),
            profileScreenshots: executions.flatMap((execution) =>
                (execution.result.browserSessions ?? [])
                    .filter((session) => session.extensionMode === ExtensionMode.Prepared)
                    .map((session) => ({
                        name:
                            session.settingsEvidence?.profileKind ??
                            SettingsProfileKind.AgentSelected,
                        screenshots: browserSessionOverviewPaths(session),
                    })),
            ),
            beforeScreenshots: verified ? [verified.before] : [],
            afterScreenshots: verified ? [verified.after] : [],
            beforeFullPageScreenshots: verified ? [verified.beforeFullPage] : [],
            afterFullPageScreenshots: verified ? [verified.afterFullPage] : [],
            rejectedScreenshots,
            rejectedPairs,
        },
        artifacts: buildArtifactLinks(executions),
    };
}
