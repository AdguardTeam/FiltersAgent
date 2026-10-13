import { FixOutcomeKind, type FixOutcome } from '../types/fix-outcome';
import type { FixRunResult } from '../types/fix-run-result';
import { parseAdguardListKey } from '../environment/filter-list-ref';
import { type PublicationOutcome } from '../types/publication-outcome';
import type { LocalRunRecord } from './run-output';
import {
    renderCandidate,
    renderCandidateForReview,
    renderCandidateVisualReview,
    renderKnowledgeBaseProvenance,
    renderProfileScreenshots,
    renderRejectedPairs,
    renderSettingsProfiles,
} from './run-report-candidate-render';
import { renderEnvironmentSelection } from './run-report-environment-render';
import { renderBlockerProvenance } from './run-report-extension-provenance';
import { renderOptional, renderPathList } from './run-report-values';

/**
 * The Markdown projections of a local run: the agent report a human reads beside the evidence, and
 * the append-only publication report a published generation carries.
 *
 * The two entry points and the run-wide sections — the model's terminal decision, the run status,
 * source provenance, pending publication — are here. The two largest sections are their own
 * modules: `run-report-environment-render` for the locked filtering environment and
 * `run-report-candidate-render` for the candidate, its evidence and its provenance. Both are called
 * from here and call nothing back; the primitives all three share are in `run-report-values`.
 *
 * Rendering only. The record's schemas, its reader and its writer live in `run-output.ts`, which
 * validates a record before handing it here — so nothing in this module parses, reads or writes,
 * and the dependency runs one way: the writer calls the renderer, the renderer knows only the
 * record's types.
 */

/**
 * Render the exact model-owned terminal decision without replacing it with Host-derived status.
 *
 * @param decision - Schema-validated payload accepted by `finish_fix`, or null when unavailable.
 * @returns Human-readable Markdown lines for the model decision.
 */
function renderAgentDecision(decision: FixOutcome | null): string[] {
    if (!decision) {
        return [
            '## Agent decision',
            '',
            'No model-authored `finish_fix` decision was accepted. See the Host result below.',
        ];
    }

    const lines = [
        '## Agent decision',
        '',
        `- Outcome: \`${decision.outcome}\``,
        '',
        decision.reasoning,
    ];
    if ('evidenceSummary' in decision) {
        lines.push('', `- Evidence summary: ${decision.evidenceSummary}`);
    }
    if (decision.outcome === FixOutcomeKind.ProposeRule) {
        lines.push('', '- Proposed rule:', '', '```adblock', decision.ruleProposal.rule, '```');
    }
    return lines;
}

/**
 * Render the run status with its runner-owned explanatory suffix.
 *
 * @param result - Validated core result.
 * @returns One Markdown status line.
 */
function renderRunStatus(result: FixRunResult): string {
    let suffix = '';
    if (result.runStatus === 'target_url_unavailable') {
        suffix = ' — target URL unavailable from this runner';
    } else if (result.runStatus === 'browser_unavailable') {
        // Family-neutral: the controlled browser is Chromium for the AdGuard route and Firefox
        // for a signed-XPI blocker, and the status line must not name the wrong one.
        suffix = ' — the controlled browser could not be started or configured';
    } else if (result.runStatus === 'cleanup_failed') {
        suffix = ' — environment cleanup failed';
    } else if (result.runStatus === 'fixed_in_source_pending_publication') {
        suffix = ' — fixed in source, pending publication';
    }
    return `- Status: \`${result.runStatus}\`${suffix}`;
}

/**
 * Status of one upstream-vs-pinned-commit drift observation.
 *
 * Mirrors the inline picklist backing `UpstreamSourceDriftSchema.status` in
 * `types/upstream-source-drift.ts`; kept local here because that module does not export a named
 * set.
 */
const UpstreamSourceDriftStatus = {
    /**
     * No drift record exists for this run.
     */
    Unobserved: 'unobserved',

    /**
     * The pinned commit matched the upstream commit when observed.
     */
    InSync: 'in_sync',

    /**
     * Upstream had moved past the pinned commit when observed.
     */
    UpstreamAhead: 'upstream_ahead',
} as const;

/**
 * Render the source identity a run is bound to beside the published state it executed against.
 *
 * The two are separate facts and belong to every report, not only to a pending-publication one: the
 * pinned commit is what every source operation read, while the executed baseline is what the
 * browser actually filtered with. Upstream is reported as it stood when the report was written — a
 * run that observed nothing says so rather than implying it is current.
 *
 * The per-resource `path` is deliberately not rendered: it is relative to the disposable CLI data
 * root and says nothing a reader needs, while the filter identity, version, and content digest are
 * exactly the published-state facts an outcome rests on.
 *
 * @param result - Locked core run result.
 * @returns Markdown lines naming both provenances.
 */
function renderSourceProvenance(result: FixRunResult): string[] {
    const baseline = result.environmentExecution?.baseline;
    const drift = result.sourceDrift;
    const upstream = drift?.upstreamCommit ? ` at \`${drift.upstreamCommit}\`` : '';
    const driftStatus = drift?.status ?? UpstreamSourceDriftStatus.Unobserved;
    return [
        `- Pinned source repository: \`${renderOptional(result.filtersRepository ?? null)}\``,
        `- Pinned source commit: \`${renderOptional(result.filtersBaseSha ?? null)}\``,
        `- Upstream source: \`${driftStatus}\`${upstream}`,
        ...(baseline
            ? [
                  ...baseline.resources.map(
                      (resource) =>
                          `- Published filter \`${parseAdguardListKey(resource.listKey) ?? resource.listKey}\` version ` +
                          `\`${resource.version ?? 'unknown'}\` content \`${resource.sha256}\``,
                  ),
                  `- Published baseline digest: \`${baseline.aggregateDigest}\``,
                  `- Published baseline acquired: \`${baseline.acquiredAt}\``,
              ]
            : []),
    ];
}

/**
 * Render what a pending-publication outcome means for the reader.
 *
 * Both provenances behind the claim are rendered once, by {@link renderSourceProvenance}; this
 * section adds only the consequence that is specific to this status.
 *
 * @param result - Locked core run result.
 * @returns Markdown lines for a pending-publication result, else no lines.
 */
function renderPendingPublication(result: FixRunResult): string[] {
    if (result.runStatus !== 'fixed_in_source_pending_publication') {
        return [];
    }
    return [
        '',
        '### Pending publication',
        '',
        '- No candidate patch, canonical patch, or review checkout was produced: the pinned ' +
            'source already carries this fix.',
    ];
}

/**
 * Render an optional browser failure without a formatter-sensitive conditional spread.
 *
 * @param detail - Optional browser failure detail.
 * @returns Zero or one Markdown line.
 */
function renderBrowserFailure(detail: string | null): string[] {
    return detail ? [`- Browser failure: ${detail}`] : [];
}

/**
 * Render a deterministic agent-first report without access to any human reference.
 *
 * Takes an ALREADY validated record: the schema and the parse that produces one belong to
 * `run-output.ts`, and keeping them there is what stops the writer and the renderer importing each
 * other. `renderLocalAgentReport` there is the validating entry point every caller uses.
 *
 * @param parsed - Schema-validated local core result, provenance, evidence, and artifact links.
 * @param decision - Exact model-owned terminal decision, when one was accepted.
 * @returns Markdown ending in one newline.
 */
export function renderValidatedLocalAgentReport(
    parsed: LocalRunRecord,
    decision: FixOutcome | null = null,
): string {
    const extension = parsed.provenance.extension;
    const artifactLines =
        parsed.artifacts.length === 0
            ? ['None.']
            : parsed.artifacts.map((artifact) => `- ${artifact.label}: \`${artifact.path}\``);
    const lines = [
        `# Agent run — issue #${parsed.result.issueNumber}`,
        '',
        ...renderAgentDecision(decision),
        '',
        '## Host result',
        '',
        renderRunStatus(parsed.result),
        `- Domain: \`${parsed.result.domain}\``,
        `- Effective mode: \`${parsed.result.effectiveMode}\``,
        `- Verification: \`${parsed.result.verificationStatus}\``,
        `- Fallback reason: \`${renderOptional(parsed.result.fallbackReason)}\``,
        ...renderBrowserFailure(parsed.result.fallbackDetail),
        '',
        parsed.result.reasoning,
        '',
        ...renderEnvironmentSelection(parsed.result.environmentSelection),
        '',
        ...renderCandidate(parsed.result),
        ...renderCandidateForReview(parsed.result),
        ...renderPendingPublication(parsed.result),
        '',
        ...renderCandidateVisualReview(parsed.result),
        '',
        '## Provenance',
        '',
        `- Source/extension horizon: \`${parsed.provenance.environment}\``,
        `- Headless: \`${parsed.provenance.headless ? 'yes' : 'no'}\``,
        ...renderBlockerProvenance(extension),
        ...renderSourceProvenance(parsed.result),
        ...renderKnowledgeBaseProvenance(parsed.provenance.knowledgeBase),
        '',
        ...renderSettingsProfiles(parsed.provenance.settingsProfiles),
        '',
        '## Evidence',
        '',
        parsed.evidence.summary,
        '',
        ...renderPathList('User screenshots', parsed.evidence.userScreenshots),
        '',
        ...renderPathList('Unfiltered control', parsed.evidence.unfilteredScreenshots),
        '',
        ...renderProfileScreenshots(parsed.evidence.profileScreenshots),
        ...renderPathList('Verified before — viewport', parsed.evidence.beforeScreenshots),
        '',
        ...renderPathList('Verified after — viewport', parsed.evidence.afterScreenshots),
        '',
        ...renderPathList('Verified before — full page', parsed.evidence.beforeFullPageScreenshots),
        '',
        ...renderPathList('Verified after — full page', parsed.evidence.afterFullPageScreenshots),
        '',
        ...renderPathList('Rejected candidates', parsed.evidence.rejectedScreenshots),
        '',
        ...renderRejectedPairs(parsed.evidence.rejectedPairs ?? []),
        '',
        '## Artifacts',
        '',
        ...artifactLines,
        '',
    ];
    return lines.join('\n');
}

/**
 * Stable fields used by the append-only local publication report.
 */
export interface LocalPublicationReportInput {
    /**
     * Opaque publication generation UUID.
     */
    publicationId: string;

    /**
     * Durable normal or evidence-only disposition.
     */
    outcome: PublicationOutcome;

    /**
     * Source issue identity.
     */
    issueNumber: number;

    /**
     * Immutable issue revision digest.
     */
    revisionDigest: string;

    /**
     * Exact locked source commit.
     */
    sourceCommit: string;

    /**
     * Bound, legitimate no-candidate, or failed binding disposition.
     */
    candidateDisposition: string;

    /**
     * Stable sanitized publication failure code, when evidence-only.
     */
    failureCode: string | null;

    /**
     * SHA-256 binding the canonical run record.
     */
    runRecordSha256: string;

    /**
     * Number of published sanitized evidence artifacts.
     */
    evidenceArtifacts: number;

    /**
     * Number of typed image omissions.
     */
    imageOmissions: number;

    /**
     * Publication-relative detached review checkout, when present.
     */
    reviewCheckout: string | null;
}

/**
 * Render one deterministic human-readable append-only local publication report.
 *
 * @param input - Stable publication identity, provenance and disposition fields.
 * @returns Markdown report ending in one newline.
 */
export function renderLocalPublicationReport(input: LocalPublicationReportInput): string {
    return [
        '# AdGuard Filters Agent Local Publication',
        '',
        `- Publication: \`${input.publicationId}\``,
        `- Outcome: \`${input.outcome}\``,
        `- Issue: \`#${input.issueNumber}\``,
        `- Revision digest: \`${input.revisionDigest}\``,
        `- Source commit: \`${input.sourceCommit}\``,
        `- Candidate disposition: \`${input.candidateDisposition}\``,
        `- Failure code: \`${input.failureCode ?? 'none'}\``,
        `- Run record SHA-256: \`${input.runRecordSha256}\``,
        `- Sanitized evidence artifacts: \`${input.evidenceArtifacts}\``,
        `- Image omissions: \`${input.imageOmissions}\``,
        `- Review checkout: \`${input.reviewCheckout ?? 'none'}\``,
        '',
        'This local output is evidence for human review. It is not staged, committed, pushed, or',
        'published to GitHub.',
        '',
    ].join('\n');
}
