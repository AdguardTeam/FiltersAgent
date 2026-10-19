import { createHash } from 'node:crypto';
import { BrowserMode } from '../types/browser-mode';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { parseCandidateValidationArtifactId } from '../types/candidate-artifact-identity';
import type { RawIssue } from '../github/fetch-issue';
import { selectPromptSafeReporterComments } from '../github/prompt-safety';
import {
    EnvironmentDispositionStatus,
    EnvironmentSelectionState,
} from '../environment/environment-vocabulary';
import { type EnvironmentSelectionSnapshot } from '../environment/environment-selection-contract';
import { type ProvisionalEnvironmentDisposition } from '../environment/filtering-environment';
import type { TraceRecorder } from '../tracer/trace-recorder';
import {
    EffectiveMode,
    FixRunStatus,
    ReproductionSettingsStatus,
    VerificationStatus,
    type FixRunResult,
    type ReporterSettingsSnapshot,
} from '../types/fix-run-result';
import type { IssueFacts } from '../types/issue-facts';
import type { MatchedIssueScreenshot } from '../types/site-analysis';
import { stripBenchmarkIssueMarker } from '../github/benchmark-issue-marker';
import { IssueAttachmentKind } from '../types/issue-attachment-kind';
import { BrowserFallbackReason } from '../types/browser-fallback-reason';
import type { FixCoreIssueAttachment, FixCoreIssueInput } from './fix-core-inputs';
/**
 * The fix core's shared result vocabulary: the run budgets a core is bounded by, the environment
 * and verification labels a finished run is described with, the context and browser state a core
 * result is assembled from, the issue normalization and screenshot materialization every core
 * performs before the model sees anything, and the finalize-time contract failure. Kept as a leaf
 * module so the fix core, the result assembly and the run entry can all share it.
 */

/**
 * Wall-clock budget for one agentic investigation loop.
 */
export const AGENTIC_INVESTIGATION_BUDGET_MS = 60 * 60_000;

/**
 * Runaway backstop on tool-enabled turns, set far above any real investigation so the wall-clock
 * budget above is what actually ends a run.
 */
export const AGENTIC_ITERATION_BACKSTOP = 1_000;

/**
 * Derive the browser verification label for one model-driven terminal result.
 *
 * @param browserUsable - Whether browser evidence was collected successfully.
 * @param candidateVerified - Whether a proposed patch has complete visual proof.
 * @param runStatus - Final typed run status.
 * @param noPatchEvidenceComplete - Whether the required complete no-patch environments exist.
 * @returns Public verification status consistent with the evidence publisher contract.
 */
export function deriveAgenticVerificationStatus(
    browserUsable: boolean,
    candidateVerified: boolean,
    runStatus: FixRunStatus,
    noPatchEvidenceComplete: boolean,
): VerificationStatus {
    if (!browserUsable) {
        return VerificationStatus.Unavailable;
    }
    if (candidateVerified) {
        return VerificationStatus.Verified;
    }
    if (
        noPatchEvidenceComplete &&
        (runStatus === 'not_reproduced' ||
            runStatus === 'already_fixed_current' ||
            runStatus === 'configuration_specific')
    ) {
        return VerificationStatus.Verified;
    }
    return VerificationStatus.Partial;
}

/**
 * Map a locked non-ready environment choice to its explicit terminal product status.
 *
 * @param selection - Runtime-owned immutable selection audit.
 * @returns Explicit unsupported/limited status, or undefined for a ready environment.
 */
export function environmentSelectionRunStatus(
    selection: EnvironmentSelectionSnapshot | null,
): FixRunStatus | undefined {
    if (selection?.state === EnvironmentSelectionState.Unsupported) {
        return FixRunStatus.UnsupportedProductCase;
    }
    if (selection?.state === EnvironmentSelectionState.CapabilityLimited) {
        return FixRunStatus.CapabilityLimited;
    }
    return undefined;
}

/**
 * Metadata shared by every terminal result in a single core run.
 */
export interface CoreResultContext {
    /**
     * Issue number from the trusted local snapshot.
     */
    issueNumber: number;

    /**
     * Sanitized reported domain.
     */
    domain: string;

    /**
     * Browser mode requested by the caller.
     */
    requestedBrowserMode: BrowserMode;

    /**
     * Optional publication repository identity.
     */
    repository: string | null;

    /**
     * Optional publication repository baseline SHA.
     */
    baseSha: string | null;

    /**
     * Optional AdguardFilters repository identity.
     */
    filtersRepository: string | null;

    /**
     * Optional exact AdguardFilters checkout SHA.
     */
    filtersBaseSha: string | null;

    /**
     * Whether reporter settings were represented by the browser.
     */
    reproductionSettingsStatus: ReproductionSettingsStatus;

    /**
     * Human-readable settings-fidelity explanation.
     */
    reproductionSettingsDetail: string;

    /**
     * Reporter settings snapshot stamped into every terminal result, sourced from the required
     * intake facts so the publisher can gate on the run's own extraction; absent only when the run
     * ended before the facts existed (a skipped extraction).
     */
    reporterSettings?: ReporterSettingsSnapshot;
}

/**
 * Mutable state resolved by browser preflight.
 */
export interface CoreBrowserState {
    /**
     * Mode supplied to the reasoning loop after preflight.
     */
    effectiveMode: EffectiveMode;

    /**
     * Whether deterministic browser preflight produced usable evidence.
     */
    usable: boolean;

    /**
     * Technical failure category for an unavailable browser.
     */
    fallbackReason: BrowserFallbackReason | null;

    /**
     * Diagnostic browser failure detail.
     */
    fallbackDetail: string | null;
}

/**
 * Normalized prompt-safe issue and local attachment input.
 */
interface NormalizedCoreIssue {
    /**
     * RawIssue-compatible value exposed to parser and tool registry.
     */
    rawIssue: RawIssue;

    /**
     * Facts the caller already parsed before invoking the core.
     */
    facts: IssueFacts;

    /**
     * Snapshotted attachments available without network access.
     */
    attachments: readonly FixCoreIssueAttachment[];
}

/**
 * Normalize wrapper and direct AgentIssueInput-compatible values into one core representation.
 *
 * @param issue - Direct or wrapped prompt-safe issue input.
 * @returns A RawIssue without attachment paths plus separate attachment metadata.
 */
export function normalizeCoreIssue(issue: FixCoreIssueInput): NormalizedCoreIssue {
    const isPromptSafeDirectInput = !('rawIssue' in issue);
    const source = isPromptSafeDirectInput ? issue : issue.rawIssue;
    const reporterAuthor = source.reporterAuthor?.trim();
    let comments: RawIssue['comments'] = [];
    if (isPromptSafeDirectInput) {
        comments = source.comments.map((comment) => ({ ...comment }));
    } else if (reporterAuthor) {
        comments = selectPromptSafeReporterComments(source.comments, reporterAuthor);
    }
    return {
        rawIssue: {
            number: source.number,
            ...(reporterAuthor ? { reporterAuthor } : {}),
            url: source.url,
            title: source.title,
            body: stripBenchmarkIssueMarker(source.body),
            state: source.state,
            labels: [...source.labels],
            assignee: source.assignee,
            comments,
        },
        facts: issue.facts,
        attachments: issue.attachments ?? [],
    };
}

/**
 * Verify and copy snapshotted issue screenshots under the run artifact root.
 *
 * Copying makes the paths compatible with the vision tool's artifact-root containment check and
 * prevents a later snapshot mutation from changing evidence during the run.
 *
 * @param attachments - Integrity-addressed local attachments from the exporter.
 * @param artifactsDir - Per-run local artifact root.
 * @param recorder - Trace recorder whose artifact registry gates vision access.
 * @returns Screenshot records that prevent SiteAnalyzer from downloading the same URLs again.
 */
export function materializeIssueScreenshots(
    attachments: readonly FixCoreIssueAttachment[],
    artifactsDir: string,
    recorder: TraceRecorder,
): MatchedIssueScreenshot[] {
    const screenshotAttachments = attachments.filter(
        (attachment) => attachment.kind === IssueAttachmentKind.IssueScreenshot,
    );
    const destinationDir = join(artifactsDir, 'issue-screenshots');
    const registeredDigests = new Map<string, string>();
    const preloaded: MatchedIssueScreenshot[] = [];

    for (const attachment of screenshotAttachments) {
        const expectedDigest = attachment.sha256.toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(expectedDigest)) {
            throw new Error(`Invalid issue screenshot SHA-256: ${attachment.sha256}`);
        }
        const bytes = readFileSync(attachment.localPath);
        const actualDigest = createHash('sha256').update(bytes).digest('hex');
        if (actualDigest !== expectedDigest) {
            throw new Error(
                `Issue screenshot digest mismatch for ${attachment.localPath}: expected ` +
                    `${expectedDigest}, received ${actualDigest}`,
            );
        }
        const extension = extname(attachment.localPath).toLowerCase();
        if (!['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extension)) {
            throw new Error(`Unsupported issue screenshot extension: ${extension || '(none)'}`);
        }
        mkdirSync(destinationDir, { recursive: true });
        let artifactId = registeredDigests.get(expectedDigest);
        if (!artifactId) {
            artifactId = `issue-screenshot-${expectedDigest}`;
            const destinationPath = join(destinationDir, `${expectedDigest}${extension}`);
            copyFileSync(attachment.localPath, destinationPath);
            recorder.addArtifact({
                id: artifactId,
                path: destinationPath,
                type: 'issue-screenshot',
                bytes: bytes.byteLength,
            });
            registeredDigests.set(expectedDigest, artifactId);
        }
        if (attachment.sourceUrl) {
            preloaded.push({
                issueScreenshotUrl: attachment.sourceUrl,
                liveArtifactId: artifactId,
                description: `Local issue screenshot verified by SHA-256 ${expectedDigest}.`,
            });
        }
    }
    return preloaded;
}

/**
 * Typed failure for a finalized result that violates its own schema contract.
 *
 * Every field the schema found missing is named, so a failing run diagnoses from its own log
 * instead of requiring the evidence archive.
 */
export class FixRunResultContractError extends Error {
    /**
     * Create one bounded contract violation.
     *
     * @param issues - Schema issue messages, bounded for logs.
     */
    constructor(readonly issues: readonly string[]) {
        super(
            `The finalized fix result violated its own schema contract: ${issues
                .slice(0, 4)
                .join('; ')}`,
        );
        this.name = 'FixRunResultContractError';
    }
}

/**
 * Pin the finalize-time environment disposition to the accepted candidate, when one exists.
 *
 * The runtime disposition records the LATEST experiment's verdict, overwritten after every
 * apply_rule. A run that verifies its candidate and then honestly investigates further — a second
 * reported element whose probe ends baseline_symptom_absent, a re-validation whose factual probe
 * stays not_probed — leaves an inconclusive disposition behind, and the canonical projection then
 * strips the accepted candidate's evidence while runStatus patch_proposed survives, so the result
 * dies on its own schema. The accepted patch is what the run proposes; the projection must answer
 * for that candidate's experiment, not for whichever experiment happened to run last.
 *
 * The pinned digest must equal the digest hashed at experiment time — the validation artifact id
 * embeds its first twelve characters, so any mismatch (for example rule normalization drift) falls
 * back to the runtime disposition instead of pinning a digest no phase proof carries.
 *
 * @param result - Provisional result assembled from the accepted terminal decision.
 * @returns Verified disposition naming the accepted candidate, or undefined to keep the runtime
 *   disposition.
 */
export function acceptedCandidateDisposition(
    result: FixRunResult,
): ProvisionalEnvironmentDisposition | undefined {
    if (result.runStatus !== 'patch_proposed' || !result.candidatePatch) {
        return undefined;
    }
    const validationArtifactId = result.candidateValidationEvidence?.validationArtifactId;
    const identity = validationArtifactId
        ? parseCandidateValidationArtifactId(validationArtifactId)
        : null;
    if (!identity) {
        return undefined;
    }
    const candidateDigest = createHash('sha256').update(result.candidatePatch.rule).digest('hex');
    if (!candidateDigest.startsWith(identity.candidateShortHash)) {
        return undefined;
    }
    return { status: EnvironmentDispositionStatus.Verified, candidateDigest, failure: null };
}
