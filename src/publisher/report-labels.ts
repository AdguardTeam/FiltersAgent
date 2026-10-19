/**
 * The fixed human wording of the report.
 *
 * Every closed vocabulary a report renders — run statuses, policy verdicts, browser fallbacks,
 * infrastructure failures, agent terminations, symptom observations, extension sources — maps to
 * one host-authored label here. Each of these records is total over its type, so a new value fails
 * to compile until its label lands, and no outcome can post an unfinished report. The provider
 * failure status hints are the one deliberately partial map.
 */

import { PreparedExtensionSource } from '../environment/extension-preparation';
import { AgentTerminationReason } from '../types/agent-termination-reason';
import { BrowserFallbackReason } from '../types/browser-fallback-reason';
import { FixRunStatus, SymptomObservation } from '../types/fix-run-result';
import { InfrastructureFailureReason } from '../types/infrastructure-failure-reason';
import { PolicyDecisionKind } from '../types/policy';

/**
 * Human labels for every run status, in the fixed `FixRunStatus` vocabulary.
 */
export const RUN_STATUS_OUTCOME_LABELS: Record<FixRunStatus, string> = {
    [FixRunStatus.AlreadyFixedCurrent]: 'Already fixed in the current build',
    [FixRunStatus.FixedUpstreamPendingExtension]: 'Fixed upstream, pending the extension release',
    [FixRunStatus.FixedInSourcePendingPublication]:
        'Fixed in the filter source, pending publication',
    [FixRunStatus.PatchProposed]: 'Candidate rule proposed',
    [FixRunStatus.NotReproduced]: 'The reported defect was not reproduced',
    [FixRunStatus.ConfigurationSpecific]: 'The defect depends on reporter-specific configuration',
    [FixRunStatus.AnalysisOnly]: 'Analysis-only findings, no verified change',
    [FixRunStatus.UnsupportedProductCase]: 'Unsupported reported product case',
    [FixRunStatus.CapabilityLimited]: 'Missing environment capability limited the run',
    [FixRunStatus.TargetUrlUnavailable]: 'The reported target URL was unreachable',
    [FixRunStatus.BrowserUnavailable]: 'No usable browser was available',
    [FixRunStatus.CleanupFailed]: 'Environment cleanup did not complete',
    [FixRunStatus.Failed]: 'The run failed',
};

/**
 * A policy verdict that rules out an automatic rule, whatever the run observed.
 */
export type BlockingPolicyVerdict = Exclude<
    PolicyDecisionKind,
    typeof PolicyDecisionKind.AllowRuleGeneration
>;

/**
 * Outcome lines for a run its policy verdict decided.
 *
 * The run-status vocabulary has no status for such a run — it ends analysis-only — so without these
 * the report opened "Analysis-only findings, no verified change" above a summary recommending to
 * close the report.
 */
export const POLICY_VERDICT_OUTCOME_LABELS: Record<BlockingPolicyVerdict, string> = {
    [PolicyDecisionKind.ProposeClose]: 'The filter policy recommends closing without a rule',
    [PolicyDecisionKind.NeedsHumanReview]: 'The filter policy leaves this report to a maintainer',
};

/**
 * Human labels for every browser fallback reason, total per type for the same drift guard.
 */
export const FALLBACK_REASON_LABELS: Record<BrowserFallbackReason, string> = {
    [BrowserFallbackReason.LaunchFailed]: 'Browser launch failed',
    [BrowserFallbackReason.NavigationTimeout]: 'Navigation timed out',
    [BrowserFallbackReason.TargetUnreachable]: 'The page host was unreachable',
    [BrowserFallbackReason.NotFound]: 'The page returned not found',
    [BrowserFallbackReason.HttpBlocked]: 'The page refused to load in the run browser',
    [BrowserFallbackReason.BotChallenge]: 'A bot challenge blocked the page',
    [BrowserFallbackReason.GeoBlocked]: 'Regional restriction blocked the page',
    [BrowserFallbackReason.SignInRequired]: 'A sign-in wall blocked the page',
    [BrowserFallbackReason.EmptyDom]: 'The page returned no usable document',
    [BrowserFallbackReason.NavigationOffOrigin]: 'Navigation left the issue origin',
    [BrowserFallbackReason.UnsafeTargetUrl]: 'The target URL is not openable in the run',
    [BrowserFallbackReason.TargetDnsUnresolved]: 'DNS lookup for the page failed',
    [BrowserFallbackReason.ArtifactCaptureFailed]: 'A required capture could not be taken',
    [BrowserFallbackReason.ExtensionConfigurationFailed]:
        'The extension under test could not be configured',
};

/**
 * Human labels for every infrastructure failure reason, total per type.
 */
export const INFRASTRUCTURE_FAILURE_LABELS: Record<InfrastructureFailureReason, string> = {
    [InfrastructureFailureReason.InputUnavailable]: 'The issue snapshot could not be read',
    [InfrastructureFailureReason.EnvironmentUnavailable]:
        'The locked execution environment could not be prepared',
    [InfrastructureFailureReason.BrowserUnavailable]:
        'The browser stack failed before the target was exercised',
    [InfrastructureFailureReason.LlmUnavailable]: 'The reasoning provider was unreachable',
    [InfrastructureFailureReason.LlmRejected]: 'The reasoning provider rejected the run request',
    [InfrastructureFailureReason.VisionProviderUnavailable]: 'The vision provider was unavailable',
    [InfrastructureFailureReason.OutputUnavailable]: 'The run result could not be persisted',
    [InfrastructureFailureReason.FileBackedApplicationUnsupported]:
        'The run instruction requires file-backed blocker verification, which is not supported yet',
};

/**
 * Human labels for every agent termination reason, total per type.
 */
export const AGENT_TERMINATION_LABELS: Record<AgentTerminationReason, string> = {
    [AgentTerminationReason.LlmError]: 'The provider request failed after retries',
    [AgentTerminationReason.LlmRejected]: 'The provider rejected the exact request',
    [AgentTerminationReason.TerminalNotCalled]: 'The agent loop ended without a terminal decision',
    [AgentTerminationReason.RetryBudgetExhausted]: 'A tool exhausted its failure budget',
    [AgentTerminationReason.MaxIterationsExceeded]: 'The agent loop reached its iteration limit',
    [AgentTerminationReason.WallClockExceeded]:
        'The investigation ran out of its wall-clock budget',
    [AgentTerminationReason.Interrupted]: 'The host aborted the run',
    [AgentTerminationReason.HaltedByCaller]: 'The caller halted the run',
    [AgentTerminationReason.CliInstallationCapabilityUnavailable]:
        'The CLI capability could not be transferred',
    [AgentTerminationReason.CliEnvironmentSelectionUnavailable]:
        'The CLI environment selection could not be retained',
    [AgentTerminationReason.CleanupObligationUnavailable]:
        'Durable cleanup recovery could not be armed',
};

/**
 * Maintainer-actionable hints for the provider HTTP failure statuses that name something a
 * maintainer can address directly: an authentication problem, a billing problem, or a rate limit.
 * Deliberately partial, never total over HTTP statuses: the report can show only the status itself,
 * never the provider's response body, so a status this map does not name renders with the bare
 * number instead of a guessed cause.
 */
export const PROVIDER_FAILURE_STATUS_HINTS: Readonly<Partial<Record<number, string>>> = {
    401: 'the API key was refused — check the key',
    402: "the provider account is out of credits or the key's spending limit is reached",
    403: 'the key lacks access to the model or endpoint',
    429: 'the provider is rate limiting this key',
};

/**
 * Human labels for every symptom observation, total per type.
 */
export const SYMPTOM_OBSERVATION_LABELS: Record<SymptomObservation, string> = {
    [SymptomObservation.Reproduced]: 'Reproduced',
    [SymptomObservation.NotReproduced]: 'Not reproduced',
    [SymptomObservation.Indeterminate]: 'Indeterminate',
    [SymptomObservation.NotAttempted]: 'Not attempted',
};

/**
 * Human labels for every prepared-extension provenance source, total per type.
 */
export const PREPARED_EXTENSION_SOURCE_LABELS: Record<PreparedExtensionSource, string> = {
    [PreparedExtensionSource.PinnedRelease]: 'Pinned prebuilt release',
    [PreparedExtensionSource.HistoricalBuild]: 'Reporter build from release and autobuild lists',
    [PreparedExtensionSource.Preloaded]: 'Preloaded unpacked extension',
    [PreparedExtensionSource.Instruction]: 'Prepared from the instruction',
};
