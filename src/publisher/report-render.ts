/**
 * Report rendering of the Publisher.
 *
 * One run outcome is turned into the fixed fill record every report template renders against (see
 * `report-template.ts`), with model-authored text escaped, flattened to one line, and bounded by
 * the shared untrusted-text machinery (see `untrusted-text.ts`) so a verbose or hostile run can
 * never break the comment structure. Comment bodies on GitHub sanitize most HTML, but the escape is
 * defense in depth: one reader-dependent renderer decides what `{{tokens}}` in a template become.
 * The `rule` fill is repository content rather than model prose, and renders through the same
 * module's inline-code-span renderer instead: Markdown reads a rule's own syntax (`*.../*`, say) as
 * formatting unless the whole value stays inside a code span.
 */

import {
    ExtensionManifestVersion,
    PreparedExtensionSource,
} from '../environment/extension-preparation';
import type { PreparedExtensionProvenance } from '../environment/environment-proofs';
import {
    extractPlaceholders,
    PromptRenderError,
    PromptRenderErrorKind,
    renderTemplate,
} from '../prompts/template';
import { removeEmptySections } from './report-empty-sections';
import type { PolicyDecision } from '../types/policy';
import { AgentTerminationReason } from '../types/agent-termination-reason';
import { BrowserFallbackReason } from '../types/browser-fallback-reason';
import { FixRunStatus, SymptomObservation } from '../types/fix-run-result';
import { InfrastructureFailureReason } from '../types/infrastructure-failure-reason';
import type { MissingInformationEntry } from '../types/missing-information';
import { renderVersionUpdateHint } from './report-version-decision';
import type { ReportTemplateValues } from './report-template';
import { composeListPlace, type ReportRepositoryEdit } from './report-list-place';
import { composeRepositoryLint } from './report-repository-lint';
import type { RepositoryLintNote } from '../types/repository-lint';
import { renderUntrustedRuleCodeSpan, renderUntrustedText } from './untrusted-text';

/**
 * Label identifying the report comment in template-render errors.
 *
 * A stable label, not the prompt-document defaults: a comment body that fails to render must be
 * traceable to the publisher without looking like a prompt failure.
 */
const REPORT_COMMENT_SOURCE_LABEL = 'report comment template';

/**
 * Human labels for every run status, in the fixed `FixRunStatus` vocabulary. Total over
 * `FIX_RUN_STATUS_VALUES` by type: a new status fails this record until its label lands, so no
 * outcome can post an unfinished report.
 */
const RUN_STATUS_OUTCOME_LABELS: Record<FixRunStatus, string> = {
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
 * Human labels for every browser fallback reason, total per type for the same drift guard.
 */
const FALLBACK_REASON_LABELS: Record<BrowserFallbackReason, string> = {
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
const INFRASTRUCTURE_FAILURE_LABELS: Record<InfrastructureFailureReason, string> = {
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
const AGENT_TERMINATION_LABELS: Record<AgentTerminationReason, string> = {
    [AgentTerminationReason.LlmError]: 'The provider request failed after retries',
    [AgentTerminationReason.LlmRejected]: 'The provider rejected the exact request',
    [AgentTerminationReason.TerminalNotCalled]: 'The agent loop ended without a terminal decision',
    [AgentTerminationReason.RetryBudgetExhausted]: 'A tool exhausted its failure budget',
    [AgentTerminationReason.MaxIterationsExceeded]: 'The agent loop reached its iteration limit',
    [AgentTerminationReason.RequestDeadlineExceeded]:
        'A provider response stalled past the per-request deadline',
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
const PROVIDER_FAILURE_STATUS_HINTS: Readonly<Partial<Record<number, string>>> = {
    401: 'the API key was refused — check the key',
    402: "the provider account is out of credits or the key's spending limit is reached",
    403: 'the key lacks access to the model or endpoint',
    429: 'the provider is rate limiting this key',
};

/**
 * Render the host-authored clause naming the provider's HTTP failure status.
 *
 * @param status - The provider's HTTP failure status.
 * @returns The clause to append to the outcome reason.
 */
function providerFailureStatusClause(status: number): string {
    const hint = PROVIDER_FAILURE_STATUS_HINTS[status];
    return hint === undefined
        ? `The provider responded with HTTP ${status}`
        : `The provider responded with HTTP ${status} — ${hint}`;
}

/**
 * Human labels for every symptom observation, total per type.
 */
const SYMPTOM_OBSERVATION_LABELS: Record<SymptomObservation, string> = {
    [SymptomObservation.Reproduced]: 'Reproduced',
    [SymptomObservation.NotReproduced]: 'Not reproduced',
    [SymptomObservation.Indeterminate]: 'Indeterminate',
    [SymptomObservation.NotAttempted]: 'Not attempted',
};

/**
 * Human labels for every prepared-extension provenance source, total per type.
 */
const PREPARED_EXTENSION_SOURCE_LABELS: Record<PreparedExtensionSource, string> = {
    [PreparedExtensionSource.PinnedRelease]: 'Pinned prebuilt release',
    [PreparedExtensionSource.Preloaded]: 'Preloaded unpacked extension',
    [PreparedExtensionSource.Instruction]: 'Prepared from the instruction',
};

/**
 * The unverified candidate an analysis-only run hands to a reviewer, as the report reads it.
 */
export interface ReportCandidateForReview {
    /**
     * The filter rule the run found and could not verify.
     */
    rule: string;

    /**
     * The filter file the rule would belong in, when the run resolved one.
     */
    placement?: {
        /**
         * Checkout-relative filter file path.
         */
        filePath: string;
    };

    /**
     * Why validation did not confirm the rule.
     */
    unverifiedReason: string;
}

/**
 * One symptom instance the vision review still saw after the candidate, as the report reads it.
 *
 * Narrow on purpose: the report names where it is and what it looks like, never the runner artifact
 * it was cited from — an artifact ID means nothing to a maintainer reading the issue.
 */
export interface ReportRemainingInstance {
    /**
     * Page landmark locating the instance, as the review recorded it.
     */
    landmark: string;

    /**
     * What the review saw there.
     */
    description: string;
}

/**
 * The verified candidate fields the report shows, narrow so tests pass plain partial shapes.
 */
export interface ReportCandidatePatch {
    /**
     * The filter rule as proposed.
     */
    rule: string;

    /**
     * The filter file the rule lands in — the agreed "place in the list" reading.
     */
    filePath: string;

    /**
     * The host-planned edit, when the run planned one: it names the place inside the file.
     */
    repositoryEdit?: ReportRepositoryEdit;
}

/**
 * The verified run-result fields the outcome summary reads, kept narrow so the publisher never
 * depends on incidental `FixRunResult` invariants — the assembled result is assignable as a whole,
 * while publisher tests pass plain partial shapes.
 */
export interface ReportRunResultInput {
    /**
     * Terminal status of the run.
     */
    runStatus: FixRunStatus;

    /**
     * Why a browser phase produced no conclusive observation, or null when none applies.
     */
    fallbackReason?: BrowserFallbackReason | null;

    /**
     * Host detail for the fallback, or null when the run carries none.
     */
    fallbackDetail?: string | null;

    /**
     * Why one of our own boundaries failed, when the run ended in infrastructure failure.
     */
    infrastructureFailureReason?: InfrastructureFailureReason;

    /**
     * Why the agent loop ended without an accepted model decision, when it did.
     */
    agentTerminationReason?: AgentTerminationReason;

    /**
     * The provider's HTTP status of the final failed request, when the run ended in a provider
     * failure whose message named one. Never the provider's response body — the report can show
     * only this number and the host's own fixed wording for it, since the body can carry account
     * identifiers and URLs.
     */
    providerFailureStatus?: number;

    /**
     * Browser observation of the exact defect, when one was attempted.
     */
    symptomObservation?: SymptomObservation;

    /**
     * The proposed candidate and the filter file it lands in, or null when none was proposed.
     */
    candidatePatch?: ReportCandidatePatch | null;

    /**
     * The candidate an analysis-only run found and could not verify, when it carried one.
     */
    candidateForReview?: ReportCandidateForReview;

    /**
     * What the repository's own lint command said about the published rule, when it objected or
     * could not run.
     */
    repositoryLint?: RepositoryLintNote;

    /**
     * The parts of the runner-bound vision review the report speaks to: whether the verified
     * candidate left advertising layout behind, and what the review still saw on the page after a
     * candidate it did not verify.
     */
    candidateVisualReview?: {
        /**
         * The review's leftover-layout judgment (`present`, `absent` or `unclear`).
         */
        adLayoutResidue?: string;

        /**
         * Symptom instances the review still found after the candidate, in review order. Empty for
         * a verified candidate: a remaining instance is one of the things that rejects one.
         */
        remainingInstances?: readonly ReportRemainingInstance[];
    };

    /**
     * Provenance of the one extension build the run loaded, when it ran the prepared extension.
     */
    extensionProvenance?: PreparedExtensionProvenance;

    /**
     * The run's environment-selection snapshot, narrowed to the one field the version-update hint
     * compares against: the observed product version, a dotted-numeric manifest `version` (e.g.
     * `4.6.0`) — distinct from `extensionProvenance`'s tag-or-manifest-generation display value
     * (`v5.5.2.3`, `MV3`), which a version comparison can never parse.
     */
    environmentSelection?: {
        /**
         * The environment actually bound for the run, or null while unresolved.
         */
        actual: {
            /**
             * The observed product's manifest version, or null when unobserved.
             */
            productVersion: string | null;
        } | null;
    };

    /**
     * What the run instruction lacked, when the agent reported gaps.
     */
    missingInformation?: MissingInformationEntry[];
}

/**
 * The model-authored decision fields the outcome summary reads, narrow over `FixOutcome` variants.
 */
export interface ReportDecisionInput {
    /**
     * Model summary of the run for a human reviewer, when the decision carried one.
     */
    summary?: string;

    /**
     * Model reasoning behind the outcome, when the variant carries it.
     */
    reasoning?: string;

    /**
     * Deterministic policy verdict with its reasons, when the variant carries one.
     */
    policyDecision?: PolicyDecision;
}

/**
 * What the report says beside a verified rule that left advertising layout behind.
 *
 * Only a block of a third-party host is verified with residue present: it stops the advertising
 * from loading and cannot collapse space the page reserves for it. The maintainer reading the
 * report decides whether that space is worth a cosmetic rule; the report only says it is there.
 */
const LEFTOVER_LAYOUT_NOTE =
    'Leftover layout: the page still reserves space where the advertising was. A network rule ' +
    'cannot collapse it; add a cosmetic rule if the gap matters.';

/**
 * The outcome-level fields one report render is built from, before escaping.
 */
export interface ReportOutcomeSummary {
    /**
     * Outcome line for the run, from the total run-status label map.
     */
    outcome: string;

    /**
     * Why the run ended as it did — infrastructure failure, agent termination, or fallback detail.
     */
    outcomeReason: string;

    /**
     * Fixed one-line version-update hint, empty when the run outcome carries no update suggestion.
     */
    versionUpdateHint: string;

    /**
     * Symptom observation combined with the model summary, when the run observed the defect.
     */
    symptom: string;

    /**
     * The candidate rule as proposed, or the empty string when none was proposed.
     */
    rule: string;

    /**
     * Host-authored note rendered under the rule, when the verified review left one to make.
     */
    ruleNote?: string;

    /**
     * The repository lint note for the rule, when the lint objected or could not run.
     */
    repositoryLint?: RepositoryLintNote;

    /**
     * The unverified candidate an analysis-only run asks a reviewer to look at, absent when the run
     * carried none.
     */
    candidateForReview?: ReportCandidateForReview;

    /**
     * What the vision review still saw on the page after the candidate, absent when it saw nothing.
     */
    remainingInstances?: readonly ReportRemainingInstance[];

    /**
     * The filter file the rule lands in — the agreed "place in the list" reading.
     */
    listPlace: string;

    /**
     * The run's executor: the source of the prepared extension build, or the empty string.
     */
    executor: string;

    /**
     * The executor version: the provenance tag, or the manifest generation.
     */
    executorVersion: string;

    /**
     * Deterministic policy rationale: policy reasons, else the decision reasoning.
     */
    policyRationale: string;

    /**
     * Gaps in the run instruction, exactly as reported.
     */
    missingInformation: MissingInformationEntry[];

    /**
     * Link to the run artifacts, provided by the caller.
     */
    artifactsLink: string;
}

/**
 * The infrastructure-failure label to render, adjusted for a provider failure whose status is
 * known.
 *
 * `INFRASTRUCTURE_FAILURE_LABELS[LlmUnavailable]` says "unreachable", which is only true when the
 * request got no response at all. A known status proves the opposite — the provider answered and
 * refused — so that one label is swapped for wording that holds for an answered request; every
 * other reason's fixed label already avoids "unreachable" and is used unchanged.
 *
 * @param reason - The infrastructure failure reason the run carries.
 * @param providerFailureStatus - The provider's HTTP failure status, when the seal's message named
 *   one.
 * @returns The label text for the "Infrastructure failure: " clause.
 */
function infrastructureFailureLabel(
    reason: InfrastructureFailureReason,
    providerFailureStatus: number | undefined,
): string {
    if (
        providerFailureStatus !== undefined &&
        reason === InfrastructureFailureReason.LlmUnavailable
    ) {
        return 'The reasoning provider answered but refused the request';
    }
    return INFRASTRUCTURE_FAILURE_LABELS[reason];
}

/**
 * Compose the outcome reason from the verified failure fields, in a fixed order.
 *
 * @param result - Verified run-result fields under projection.
 * @returns Semicolon-joined reason text, or the empty string when the run carries no failure
 *   reason.
 */
function composeOutcomeReason(result: ReportRunResultInput): string {
    const pieces: string[] = [];
    if (result.infrastructureFailureReason !== undefined) {
        const label = infrastructureFailureLabel(
            result.infrastructureFailureReason,
            result.providerFailureStatus,
        );
        pieces.push(`Infrastructure failure: ${label}`);
    }
    if (result.agentTerminationReason !== undefined) {
        pieces.push(
            `Agent loop ended — ${AGENT_TERMINATION_LABELS[result.agentTerminationReason]}`,
        );
    }
    if (result.fallbackReason !== null && result.fallbackReason !== undefined) {
        const detail = (result.fallbackDetail ?? '').trim();
        pieces.push(
            `Fallback — ${FALLBACK_REASON_LABELS[result.fallbackReason]}${detail.length > 0 ? `: ${detail}` : ''}`,
        );
    }
    if (result.providerFailureStatus !== undefined) {
        pieces.push(providerFailureStatusClause(result.providerFailureStatus));
    }
    return pieces.join('; ');
}

/**
 * Render one missing-information record as a bounded block line.
 *
 * @param entry - The record as reported by the run.
 * @returns The `- subject: detail` line with both halves escaped and bounded.
 */
function renderMissingInformationLine(entry: MissingInformationEntry): string {
    return `- ${renderUntrustedText(entry.subject)}: ${renderUntrustedText(entry.detail)}`;
}

/**
 * Render the unverified candidate as the block its report section carries.
 *
 * The rule goes through the same code-span renderer the verified rule fill uses — it is repository
 * content whose own syntax Markdown would otherwise read as formatting — while the placement path
 * and the model-authored reason are escaped as untrusted text. The empty string when the run
 * carried no such candidate is what lets the section drop out of the rendered body entirely.
 *
 * @param candidate - The candidate the run could not verify, or undefined when it carried none.
 * @returns The block to fill the section with, or the empty string.
 */
function composeCandidateForReview(candidate: ReportCandidateForReview | undefined): string {
    if (candidate === undefined) {
        return '';
    }
    const lines = [renderUntrustedRuleCodeSpan(candidate.rule)];
    if (candidate.placement !== undefined) {
        lines.push('', renderUntrustedText(candidate.placement.filePath));
    }
    lines.push('', `Not verified: ${renderUntrustedText(candidate.unverifiedReason)}`);
    return lines.join('\n');
}

/**
 * Remaining instances the report lists before summarizing the rest as a count.
 *
 * The review may record up to fifty, and a maintainer deciding whether the candidate is worth
 * widening needs the shape of what is left, not an inventory: five locations show whether the
 * leftovers repeat the same unit or sit somewhere the rule never reached, and the count line keeps
 * the report honest about the ones it did not print.
 */
const MAX_REPORTED_REMAINING_INSTANCES = 5;

/**
 * Render what the vision review still saw after the candidate as the block its section carries.
 *
 * This is the runner-bound review record, not model prose about it: without it a report reads as a
 * complete fix while the page still shows a header banner the reporter named, or placeholder bands
 * between its sections, because nothing in the report says what the review saw after the rule. An
 * empty list renders the empty string, which is what drops the section out of the body.
 *
 * @param instances - Instances the review still found, or undefined when it recorded none.
 * @returns The block to fill the section with, or the empty string.
 */
function composeStillVisible(instances: readonly ReportRemainingInstance[] | undefined): string {
    const recorded = instances ?? [];
    if (recorded.length === 0) {
        return '';
    }
    const lines = recorded
        .slice(0, MAX_REPORTED_REMAINING_INSTANCES)
        .map(
            (instance) =>
                `- ${renderUntrustedText(instance.landmark)} — ` +
                renderUntrustedText(instance.description),
        );
    const omitted = recorded.length - lines.length;
    if (omitted > 0) {
        lines.push(`- and ${omitted} more of the same, in the run artifacts`);
    }
    return lines.join('\n');
}

/**
 * Combine the symptom observation with the model-authored summary.
 *
 * @param result - Verified run-result fields under projection.
 * @param decision - Model-authored decision fields under projection.
 * @returns The combined symptom text, or the empty string when neither half exists.
 */
function composeSymptom(result: ReportRunResultInput, decision: ReportDecisionInput): string {
    const observation =
        result.symptomObservation === undefined
            ? ''
            : SYMPTOM_OBSERVATION_LABELS[result.symptomObservation];
    const authored = (decision.summary ?? '').trim();
    return [observation, authored].filter((half) => half.length > 0).join(' — ');
}

/**
 * Compose the policy rationale: deterministic policy reasons when the decision carries them, else
 * the model-authored reasoning.
 *
 * @param decision - Model-authored decision fields under projection.
 * @returns The rationale text, or the empty string when neither source exists.
 */
function composePolicyRationale(decision: ReportDecisionInput): string {
    const reasons = decision.policyDecision?.reasons ?? [];
    if (reasons.length > 0) {
        return reasons.join('; ');
    }
    return (decision.reasoning ?? '').trim();
}

/**
 * Compose the executor version: the provenance source tag when it exists, else the manifest
 * generation spelled as a version string.
 *
 * @param provenance - Prepared-extension provenance, or undefined when the run ran no extension.
 * @returns The version text, or the empty string when the run carried no provenance or its build
 *   records no manifest generation (a Firefox signed XPI, whose manifest the host never reads).
 */
function composeExecutorVersion(provenance: PreparedExtensionProvenance | undefined): string {
    if (provenance === undefined) {
        return '';
    }
    if (provenance.extensionSourceTag !== undefined) {
        return provenance.extensionSourceTag;
    }
    if (provenance.manifestVersion === undefined) {
        return '';
    }
    return provenance.manifestVersion === ExtensionManifestVersion.Mv3 ? 'MV3' : 'MV2';
}

/**
 * Project one run outcome into the narrow summary a report render is built from.
 *
 * @param result - Verified run-result fields under projection; a complete `FixRunResult` is
 *   assignable, and tests pass plain partial shapes.
 * @param decision - Model-authored decision fields under projection; a complete `FixOutcome` is
 *   assignable.
 * @param artifactsLink - Link to the run artifacts, provided by the caller that owns artifact URLs.
 * @param reportedVersion - The blocker version the report declares, verbatim from `Report` →
 *   `environment.version`, when the run carried the intake extraction.
 * @returns The outcome summary with raw text — escaping happens at fill-build time.
 */
export function summarizeReportOutcome(
    result: ReportRunResultInput,
    decision: ReportDecisionInput,
    artifactsLink: string,
    reportedVersion?: string,
): ReportOutcomeSummary {
    const executorVersion = composeExecutorVersion(result.extensionProvenance);
    return {
        outcome: RUN_STATUS_OUTCOME_LABELS[result.runStatus],
        outcomeReason: composeOutcomeReason(result),
        versionUpdateHint: renderVersionUpdateHint({
            reportedVersion,
            // Compared against the manifest's own dotted-numeric version, not the display
            // `executorVersion` above: a pinned release's tag (`v5.5.2.3`) or the bare `MV3`/`MV2`
            // label never parses as a version, so the hint could never fire against it.
            currentExecutorVersion:
                result.environmentSelection?.actual?.productVersion ?? undefined,
            symptomObservation: result.symptomObservation,
        }),
        symptom: composeSymptom(result, decision),
        rule: result.candidatePatch?.rule ?? '',
        ...(result.candidatePatch && result.candidateVisualReview?.adLayoutResidue === 'present'
            ? { ruleNote: LEFTOVER_LAYOUT_NOTE }
            : {}),
        ...(result.repositoryLint === undefined ? {} : { repositoryLint: result.repositoryLint }),
        ...(result.candidateForReview === undefined
            ? {}
            : { candidateForReview: result.candidateForReview }),
        // No condition on the run status: a verified review cannot carry a remaining instance —
        // one is enough to reject the candidate — so a non-empty list is exactly the rejected or
        // analysis-only case the maintainer has to see.
        ...(result.candidateVisualReview?.remainingInstances === undefined
            ? {}
            : { remainingInstances: result.candidateVisualReview.remainingInstances }),
        listPlace: composeListPlace(
            result.candidatePatch?.filePath,
            result.candidatePatch?.repositoryEdit,
        ),
        executor:
            result.extensionProvenance === undefined
                ? ''
                : PREPARED_EXTENSION_SOURCE_LABELS[result.extensionProvenance.source],
        executorVersion,
        policyRationale: composePolicyRationale(decision),
        missingInformation: result.missingInformation ?? [],
        artifactsLink,
    };
}

/**
 * Build one report render's fill values from the projected outcome.
 *
 * Every fill is computed — model-adjacent text goes through the bounded untrusted renderer, while
 * host-owned fields (outcome labels, artifact links, repository paths) pass through as written. The
 * screenshots fill starts empty: the images get an address only once the publisher decides to post
 * (see `report-screenshots.ts`).
 *
 * @param summary - Projected outcome summary.
 * @returns Fill values covering every key of `REPORT_TEMPLATE_FILL`.
 */
export function buildReportTemplateValues(summary: ReportOutcomeSummary): ReportTemplateValues {
    return {
        outcome: summary.outcome,
        outcomeReason: renderUntrustedText(summary.outcomeReason),
        versionUpdateHint: renderUntrustedText(summary.versionUpdateHint),
        symptom: renderUntrustedText(summary.symptom),
        rule:
            summary.ruleNote === undefined
                ? renderUntrustedRuleCodeSpan(summary.rule)
                : `${renderUntrustedRuleCodeSpan(summary.rule)}\n\n${summary.ruleNote}`,
        repositoryLint: composeRepositoryLint(summary.repositoryLint),
        candidateForReview: composeCandidateForReview(summary.candidateForReview),
        stillVisible: composeStillVisible(summary.remainingInstances),
        executor: summary.executor,
        executorVersion: summary.executorVersion,
        policyRationale: renderUntrustedText(summary.policyRationale),
        listPlace: summary.listPlace,
        artifactsLink: summary.artifactsLink,
        missingInformation: (summary.missingInformation ?? [])
            .map(renderMissingInformationLine)
            .join('\n'),
        screenshots: '',
    };
}

/**
 * Render one report comment body from a resolved template and the computed fill values.
 *
 * Fills are filtered down to `extractPlaceholders(template)` first, so a custom template using any
 * subset of the fixed set renders fine and unused fills are ignored. A token outside the fixed set
 * throws named — no fill can ever appear for it, and the strict render would otherwise misreport
 * the unknown token as merely "not filled". Every section whose body renders blank is then omitted,
 * on every outcome: a heading with nothing under it promises the reader a rule, a rationale or an
 * artifact the report does not have. The outcome itself carries no heading and always stays.
 *
 * @param template - Report template text; the instruction section or the built-in template.
 * @param values - Fill values covering every key of `REPORT_TEMPLATE_FILL`.
 * @returns The rendered comment body.
 */
export function renderReportComment(template: string, values: ReportTemplateValues): string {
    const declares = extractPlaceholders(template, REPORT_COMMENT_SOURCE_LABEL);
    const fills: Record<string, string> = values;
    const outsideFillSet = declares.filter((name) => !Object.hasOwn(fills, name));
    if (outsideFillSet.length > 0) {
        throw new PromptRenderError(
            PromptRenderErrorKind.UnknownPlaceholder,
            `${REPORT_COMMENT_SOURCE_LABEL}: placeholder(s) ${outsideFillSet.join(', ')} outside the report fill set — ` +
                `the fill set spells only: ${Object.keys(fills).join(', ')}`,
        );
    }
    const subset: Record<string, string> = {};
    for (const name of declares) {
        subset[name] = fills[name] ?? '';
    }
    return removeEmptySections(renderTemplate(template, subset, REPORT_COMMENT_SOURCE_LABEL));
}
