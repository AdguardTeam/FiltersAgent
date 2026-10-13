/**
 * The candidate sections of the local agent report: the proposed edit and how it was reached, the
 * unverified candidate an analysis-only run asks a reviewer to look at, the screenshot pairs
 * factual validation rejected, the per-profile evidence, the visual review of the candidate, the
 * settings profiles the run applied, and the documentation revisions it cited.
 *
 * All pure `FixRunResult`/record-fragment -> `string[]` projections, called by `run-report-render`
 * and calling nothing back.
 */
import { describeCulpritRemoval } from '../repo/culprit-removal';
import { describeCulpritReplacement } from '../repo/culprit-replacement';
import { describeSharedRuleExtension } from '../repo/shared-rule-extension';
import { NOT_OBSERVED_TEXT } from '../environment/environment-proofs';
import {
    CandidateVisualIntegrityBasis,
    CandidateVisualSymptomBasis,
} from '../types/candidate-visual-review';
import type {
    CandidateNetworkVerification,
    PhaseHostRequests,
} from '../validator/candidate-network-verification';
import type { FixRunResult } from '../types/fix-run-result';
import { RepositoryEditKind } from '../types/repository-edit-kind';
import type {
    LocalKnowledgeBaseProvenance,
    LocalProfileScreenshotEvidence,
    LocalRejectedCandidatePair,
    LocalSettingsProfileEvidence,
} from './run-output';
import { renderItemsOrFallback, renderOptional, renderPathList } from './run-report-values';

/**
 * Render rejected before/after pairs with their vision-review reason.
 *
 * @param pairs - Candidate screenshot pairs rejected during factual validation.
 * @returns Markdown sections that cannot be confused with verified evidence.
 */
export function renderRejectedPairs(pairs: LocalRejectedCandidatePair[]): string[] {
    if (pairs.length === 0) {
        return ['### Rejected before/after pairs', '', 'None.'];
    }
    return pairs.flatMap((pair) => [
        `### Rejected pair — ${pair.reason}`,
        '',
        ...renderPathList('Rejected before — viewport', pair.beforeScreenshots),
        '',
        ...renderPathList('Rejected after — viewport', pair.afterScreenshots),
        '',
        ...renderPathList('Rejected before — full page', pair.beforeFullPageScreenshots),
        '',
        ...renderPathList('Rejected after — full page', pair.afterFullPageScreenshots),
        '',
    ]);
}

/**
 * Render live screenshots grouped by the exact extension settings profile.
 *
 * @param profiles - Ordered profile screenshots captured during the local run.
 * @returns Markdown lines for every applied profile.
 */
export function renderProfileScreenshots(profiles: LocalProfileScreenshotEvidence[]): string[] {
    return profiles.flatMap((profile) => [
        ...renderPathList(`Profile — ${profile.name}`, profile.screenshots),
        '',
    ]);
}

/**
 * Render a candidate rule section for the local report.
 *
 * @param result - Locked core run result.
 * @returns Markdown lines describing the candidate or its absence.
 */
export function renderCandidate(result: FixRunResult): string[] {
    const candidate = result.candidatePatch;
    if (!candidate) {
        return ['### Candidate', '', 'No candidate patch was produced.'];
    }
    const insertionEdit =
        candidate.repositoryEdit?.kind === RepositoryEditKind.Insert
            ? candidate.repositoryEdit
            : undefined;
    const insertionPoint = insertionEdit?.insertionPoint ?? candidate.insertionPoint;
    const repositoryEditLines: string[] = [];
    if (candidate.repositoryEdit?.kind === RepositoryEditKind.ExtendDomains) {
        repositoryEditLines.push(
            `- Extended source line: \`${candidate.repositoryEdit.line}\``,
            `- Replacement rule: \`${candidate.repositoryEdit.replacementRule}\``,
        );
        // The disclosure is derived from the patch rather than from a stored field, so a report can
        // never claim a narrower radius than the patch it describes. A structurally invalid
        // extension renders no disclosure at all rather than a partial one: the run cannot reach
        // publication with such a patch, since `applyRepositoryEdit` and `materializeReviewCheckout`
        // both refuse it.
        const extension = describeSharedRuleExtension(
            candidate.rule,
            candidate.repositoryEdit.originalRule,
            candidate.repositoryEdit.replacementRule,
        );
        if (extension) {
            repositoryEditLines.push(
                `- Verified scope: \`${extension.addedScope}\``,
                `- Also affected, not verified by this run: ${extension.retainedScopes
                    .map((scope) => `\`${scope}\``)
                    .join(', ')}`,
                `- Regression risk: \`${extension.retainedScopes.length > 0 ? 'elevated' : 'scoped'}\``,
            );
        }
    } else if (candidate.repositoryEdit?.kind === RepositoryEditKind.Replace) {
        // Derived from the patch for the same reason the extension disclosure is: a report must not
        // be able to claim a narrower radius than the replacement it describes. A structurally
        // invalid replacement renders no disclosure rather than a partial one, and cannot reach
        // publication anyway, since the gate and the source lock both refuse it.
        const replacement = describeCulpritReplacement(
            candidate.repositoryEdit.originalRule,
            candidate.repositoryEdit.replacementRule,
        );
        if (replacement) {
            repositoryEditLines.push(
                `- Replaced source line: \`${candidate.repositoryEdit.line}\``,
                `- Original rule: \`${candidate.repositoryEdit.originalRule}\``,
                `- Also affected, not verified by this run: ${
                    replacement.affectedScopes.length === 0
                        ? 'every site this rule matches'
                        : replacement.affectedScopes.map((scope) => `\`${scope}\``).join(', ')
                }`,
                '- Regression risk: `elevated` — only the reported site was validated experimentally',
            );
        }
    } else if (candidate.repositoryEdit?.kind === RepositoryEditKind.Remove) {
        // Derived from the patch for the same reason the sibling disclosures are, and it is the
        // only bound this report can offer: a deletion takes the rule away everywhere it reached,
        // so the scope list is the disclosure rather than a proof of containment.
        const removal = describeCulpritRemoval(candidate.repositoryEdit.originalRule);
        if (removal) {
            repositoryEditLines.push(
                `- Removed source line: \`${candidate.repositoryEdit.line}\``,
                `- Removed rule: \`${candidate.repositoryEdit.originalRule}\``,
                `- Also affected, not verified by this run: ${
                    removal.affectedScopes.length === 0
                        ? 'every site this rule matches'
                        : removal.affectedScopes.map((scope) => `\`${scope}\``).join(', ')
                }`,
                '- Regression risk: `elevated` — only the reported site was validated experimentally',
            );
        }
    }
    const anchorLines: string[] = [];
    if (insertionEdit?.anchorRule) {
        anchorLines.push(`- Insert before rule: \`${insertionEdit.anchorRule}\``);
    }
    return [
        '### Candidate',
        '',
        `- Rule type: \`${candidate.ruleType}\``,
        `- Syntax kind: \`${candidate.syntaxKind ?? 'unknown'}\``,
        `- File: \`${candidate.filePath}\``,
        `- Repository edit: \`${candidate.repositoryEdit?.kind ?? 'legacy_insert'}\``,
        ...repositoryEditLines,
        `- Insertion point: \`${insertionPoint ?? 'n/a'}\``,
        ...anchorLines,
        '- Rule:',
        '',
        '```adblock',
        candidate.rule,
        '```',
    ];
}

/**
 * Render the candidate an analysis-only run found and could not verify.
 *
 * Nothing is rendered when the run carried none: the section exists to surface a rule that has no
 * other place in the report, so an empty one would promise a candidate the run never reached.
 *
 * @param result - Locked core run result.
 * @returns Markdown lines for the unverified candidate, or no lines at all.
 */
export function renderCandidateForReview(result: FixRunResult): string[] {
    const candidate = result.candidateForReview;
    if (!candidate) {
        return [];
    }
    return [
        '',
        '### Candidate for review',
        '',
        `- File: \`${candidate.placement?.filePath ?? 'n/a'}\``,
        `- Not verified: ${candidate.unverifiedReason}`,
        '- Rule:',
        '',
        '```adblock',
        candidate.rule,
        '```',
    ];
}

/**
 * What each verified review's page-safety basis says to a maintainer reading the report.
 *
 * A bare `unclear` page integrity beside a verified verdict reads as a contradiction, so the reason
 * the runner accepted it is spelled out next to it rather than left to be reconstructed from the
 * rule text.
 */
const CANDIDATE_VISUAL_INTEGRITY_BASIS_TEXT: Record<CandidateVisualIntegrityBasis, string> = {
    [CandidateVisualIntegrityBasis.Intact]: 'the page was observed intact',
    [CandidateVisualIntegrityBasis.ThirdPartyNetworkCleanBeforeAfter]:
        'third-party host block, clean before/after with no observed damage',
};

/**
 * The reason a verified review's symptom claim rests on what it rests on, spelled out beside the
 * basis: a tracker report verified by requests alone would otherwise read as a review that saw
 * nothing and passed anyway.
 */
const CANDIDATE_VISUAL_SYMPTOM_BASIS_TEXT: Record<CandidateVisualSymptomBasis, string> = {
    [CandidateVisualSymptomBasis.Observed]: 'vision saw the symptom before and gone after',
    [CandidateVisualSymptomBasis.NetworkRequestsBlocked]:
        'nothing visible to judge; the network log proved the requests blocked',
};

/**
 * One phase's requests to the blocked host, by how they ended.
 *
 * @param label - The phase as the report names it.
 * @param counts - The phase's request counts.
 * @returns The indented line.
 */
function renderPhaseHostRequests(label: string, counts: PhaseHostRequests): string {
    return `  - ${label}: ${counts.allowed} allowed, ${counts.blocked} blocked`;
}

/**
 * Say what the phase network logs recorded about the blocked host.
 *
 * @param network - The runner's network verification of the candidate.
 * @returns One line per phase plus the fallback-host observation.
 */
function renderNetworkVerification(network: CandidateNetworkVerification): string[] {
    return [
        `- Network verification: \`${network.verdict}\` — requests to \`${network.blockedHost}\``,
        renderPhaseHostRequests('Unfiltered control', network.phases.A),
        renderPhaseHostRequests('Published baseline', network.phases.B),
        renderPhaseHostRequests('With the candidate', network.phases.C),
        `  - New third-party hosts after the block: ${
            network.newThirdPartyHosts.length === 0
                ? 'none'
                : network.newThirdPartyHosts.map((host) => `\`${host}\``).join(', ')
        }`,
    ];
}

/**
 * Longest omission reason appended to the coverage line, so one page cannot flood the report.
 */
const MAX_OVERVIEW_OMISSION_REASON_CHARS = 400;

/**
 * Say what the vision review actually looked at across the page.
 *
 * A review whose full-page overview was withheld as unreadable saw only the tile window, however
 * complete that window's own coverage proof is. Reporting `complete` there would tell a maintainer
 * the whole page was inspected, so the line says what was inspected instead and carries the plan's
 * reason — which names the inspected document range — beside it.
 *
 * @param review - Runner-bound visual review being rendered.
 * @returns The coverage value rendered after the label.
 */
function renderFullPageCoverage(
    review: NonNullable<FixRunResult['candidateVisualReview']>,
): string {
    const evidence = review.fullPageOverviewEvidence;
    const illegible = [evidence?.before, evidence?.after].filter(
        (side) => side?.mode === 'omitted_illegible',
    );
    if (illegible.length === 0) {
        return `\`${review.coverageComplete ? 'complete' : 'incomplete'}\``;
    }
    const reasons = [...new Set(illegible.map((side) => side?.reason ?? ''))]
        .join(' ')
        .slice(0, MAX_OVERVIEW_OMISSION_REASON_CHARS);
    return `\`tile window only\` — ${reasons}`;
}

/**
 * Render the typed semantic verdict produced by the dedicated vision model.
 *
 * @param result - Locked core run result.
 * @returns Markdown lines describing the visual review or its absence.
 */
export function renderCandidateVisualReview(result: FixRunResult): string[] {
    const review = result.candidateVisualReview;
    if (!review) {
        return ['### Vision review', '', 'No runner-bound candidate vision review was produced.'];
    }

    return [
        '### Vision review',
        '',
        `- Verdict: \`${review.verdict}\``,
        `- Symptom: \`${review.symptom}\``,
        `- Symptom scope: ${review.symptomScope}`,
        `- Full-page coverage: ${renderFullPageCoverage(review)}`,
        `- Ad layout residue: \`${review.adLayoutResidue}\``,
        `- Page integrity: \`${review.pageIntegrity}\``,
        `- Candidate network scope: \`${review.candidateNetworkScope ?? 'n/a'}\``,
        `- Integrity basis: ${
            review.integrityBasis === undefined
                ? '`n/a`'
                : `\`${review.integrityBasis}\` — ${
                      CANDIDATE_VISUAL_INTEGRITY_BASIS_TEXT[review.integrityBasis]
                  }`
        }`,
        `- Symptom basis: ${
            review.symptomBasis === undefined
                ? '`n/a`'
                : `\`${review.symptomBasis}\` — ${
                      CANDIDATE_VISUAL_SYMPTOM_BASIS_TEXT[review.symptomBasis]
                  }`
        }`,
        ...(review.networkVerification === undefined
            ? []
            : renderNetworkVerification(review.networkVerification)),
        `- Model: \`${review.model}\``,
        `- Validation artifact: \`${review.validationArtifactId}\``,
        `- Rationale: ${review.rationale}`,
        '- Before instances:',
        ...renderItemsOrFallback(
            review.beforeInstances,
            (instance) =>
                `  - \`${instance.artifactId}\` — ${instance.landmark}: ${instance.description}`,
            '  - None identified.',
        ),
        '- Remaining instances:',
        ...renderItemsOrFallback(
            review.remainingInstances,
            (instance) =>
                `  - \`${instance.artifactId}\` — ${instance.landmark}: ${instance.description}`,
            '  - None identified.',
        ),
        '- Observed damage:',
        ...renderItemsOrFallback(
            review.observedDamage,
            (damage) => `  - ${damage}`,
            '  - None observed.',
        ),
    ];
}

/**
 * Render settings-profile provenance and its independent proof sources.
 *
 * @param profiles - Settings profiles attempted during the run.
 * @returns Markdown lines for all profiles.
 */
export function renderSettingsProfiles(profiles: LocalSettingsProfileEvidence[]): string[] {
    const lines = ['### Settings profiles', ''];
    if (profiles.length === 0) {
        lines.push('None.');
        return lines;
    }
    for (const profile of profiles) {
        lines.push(
            `#### \`${profile.name}\``,
            '',
            `- Status: \`${profile.status}\``,
            `- Detail: ${renderOptional(profile.detail)}`,
            `- Activation proof: \`${profile.activationProof}\``,
            '',
        );
        if (profile.enabledFilters === null) {
            lines.push(`- Enabled filters: ${NOT_OBSERVED_TEXT}.`, '');
            continue;
        }
        if (profile.enabledFilters.length === 0) {
            lines.push('- None enabled.', '');
            continue;
        }
        lines.push(
            '| ID | Name | Group | Version | Metadata | Runtime |',
            '| --- | --- | --- | --- | --- | --- |',
            ...profile.enabledFilters.map(
                (filter) =>
                    `| ${filter.id} | ${filter.name} | ${renderOptional(filter.group)} | ` +
                    `${renderOptional(filter.version)} | ${filter.metadataEnabled ? 'yes' : 'no'} | ` +
                    `${filter.runtimeEnabled ? 'yes' : 'no'} |`,
            ),
            '',
        );
    }
    if (lines.at(-1) === '') {
        lines.pop();
    }
    return lines;
}

/**
 * Render exact documentation revisions and citations used by the agent.
 *
 * @param knowledge - Optional prepared documentation provenance.
 * @returns Human-readable KnowledgeBase provenance lines.
 */
export function renderKnowledgeBaseProvenance(
    knowledge: LocalKnowledgeBaseProvenance | null | undefined,
): string[] {
    if (!knowledge) {
        return ['- KnowledgeBase: `n/a`'];
    }
    const lines = [
        `- KnowledgeBase source: \`${knowledge.source}\``,
        `- KnowledgeBase source location: \`${knowledge.sourceLocation}\``,
        `- KnowledgeBase requested revision: \`${knowledge.requestedRevision}\``,
        `- KnowledgeBase commit: \`${knowledge.commit}\``,
        `- KnowledgeBase filters commit: \`${knowledge.filtersCommit}\``,
        `- KnowledgeBase allowlisted documents: ${knowledge.documents
            .map((document) => `\`${document}\``)
            .join(', ')}`,
    ];
    if (knowledge.citations.length === 0) {
        lines.push('- KnowledgeBase citations used: none');
        return lines;
    }
    lines.push('- KnowledgeBase citations used:');
    lines.push(
        ...knowledge.citations.map(
            (citation) =>
                `  - \`${citation.topic}\`: [${citation.filePath}#${citation.anchor}]` +
                `(${citation.url})`,
        ),
    );
    return lines;
}
