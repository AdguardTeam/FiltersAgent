/**
 * Finalising a fix result once the filtering environment it ran in has been torn down: the
 * lifecycle handle the core hands back, and the projection that folds the cleanup receipt into the
 * result without letting a superseded environment's artifacts survive into it.
 */
import {
    type FilteringEnvironmentAdapter,
    type FilteringEnvironmentExecution,
    type ProvisionalEnvironmentDisposition,
} from '../environment/filtering-environment';
import {
    projectEnvironmentExecution,
    type EnvironmentProjectionRefusal,
} from '../environment/environment-result-projection';
import {
    VerificationStatus,
    type AgentBrowserSessionEvidence,
    type AgentCandidateValidationEvidence,
    type FixRunArtifactPaths,
} from '../types/fix-run-result';
import { InfrastructureFailureReason } from '../types/infrastructure-failure-reason';
import {
    finalizeFilteringEnvironmentExecution,
    type FilteringEnvironmentLifecycleRecorder,
} from './filtering-environment-finalization';

/**
 * Outer lifecycle inputs required to finalize one common environment execution.
 */
export interface FixEnvironmentLifecycle {
    /**
     * Selected adapter whose resources must be drained and cleaned.
     */
    adapter: FilteringEnvironmentAdapter;

    /**
     * Sole canonical execution recorder.
     */
    recorder: FilteringEnvironmentLifecycleRecorder;

    /**
     * Provisional investigation disposition established before cleanup.
     */
    disposition: ProvisionalEnvironmentDisposition;

    /**
     * Observe the exact invariant that stopped canonical execution from being attached.
     *
     * @param refusal - Named projection refusal.
     */
    onProjectionRefused?(refusal: EnvironmentProjectionRefusal): void;
}

/**
 * Canonical environment evidence attached after cleanup.
 */
export interface FixResultEnvironmentExecution {
    /**
     * Complete recorder-finalized environment execution.
     */
    environmentExecution: FilteringEnvironmentExecution;
}

/**
 * Extension compatibility fields that may exist on a provisional result before projection.
 */
interface ProvisionalCompatibilityResult {
    /**
     * Browser sessions assembled by the agent runtime before canonical projection.
     */
    browserSessions?: AgentBrowserSessionEvidence[];

    /**
     * Candidate evidence assembled by the agent runtime before canonical projection.
     */
    candidateValidationEvidence?: AgentCandidateValidationEvidence;

    /**
     * Artifact paths assembled before canonical environment projection.
     */
    artifactPaths?: FixRunArtifactPaths;
}

/**
 * Collect screenshot paths that belonged to the superseded Extension compatibility view.
 *
 * @param provisionalResult - Result assembled from the agent runtime's caches.
 * @returns Paths that must be replaced by canonical phase projections.
 */
function supersededEnvironmentScreenshotPaths(provisionalResult: object): Set<string> {
    const compatibility = provisionalResult as ProvisionalCompatibilityResult;
    const sessionPaths = (compatibility.browserSessions ?? []).flatMap((session) =>
        session.captures.flatMap((capture) =>
            [capture.viewport, capture.fullPageOverview, ...capture.tiles].filter(
                (path): path is string => path !== null,
            ),
        ),
    );
    const binding = compatibility.candidateValidationEvidence;
    const candidatePaths: string[] = [];
    if (binding) {
        candidatePaths.push(
            binding.beforeViewport.path,
            binding.afterViewport.path,
            binding.beforeFullPage.path,
            binding.afterFullPage.path,
        );
    }
    const verified = compatibility.artifactPaths?.verifiedCandidateScreenshots;
    const rejected = compatibility.artifactPaths?.rejectedCandidateScreenshots;
    return new Set([
        ...sessionPaths,
        ...candidatePaths,
        ...(verified
            ? [verified.before, verified.after, verified.beforeFullPage, verified.afterFullPage]
            : []),
        ...(rejected
            ? [rejected.before, rejected.after, rejected.beforeFullPage, rejected.afterFullPage]
            : []),
    ]);
}

/**
 * Merge run-level artifacts with environment-owned paths projected from canonical phase evidence.
 *
 * @param provisionalResult - Result containing trace, issue, and diagnostic artifacts.
 * @param projected - Canonical environment-owned artifact paths.
 * @returns One deterministic artifact view without runtime-assembled environment evidence.
 */
function mergeCanonicalEnvironmentArtifactPaths(
    provisionalResult: object,
    projected: FixRunArtifactPaths,
): FixRunArtifactPaths {
    const previous = (provisionalResult as ProvisionalCompatibilityResult).artifactPaths;
    if (!previous) {
        return projected;
    }
    const superseded = supersededEnvironmentScreenshotPaths(provisionalResult);
    const auxiliaryScreenshots = previous.screenshots.filter((path) => !superseded.has(path));
    // Canonical execution owns the order of the screenshots it projects: a path that appears in
    // both lists must keep its projected position, or the result no longer compares equal to its
    // own projection. Auxiliary captures the environment does not own follow it.
    const screenshots = [...new Set([...projected.screenshots, ...auxiliaryScreenshots])];
    return {
        ...projected,
        screenshots,
        trace: previous.trace,
        ...(previous.settingsProof !== undefined ? { settingsProof: previous.settingsProof } : {}),
        ...(previous.browserLog !== undefined ? { browserLog: previous.browserLog } : {}),
        ...(previous.symptomObservationEvidence !== undefined
            ? { symptomObservationEvidence: previous.symptomObservationEvidence }
            : {}),
        ...(previous.preCandidateVisualInventory !== undefined
            ? { preCandidateVisualInventory: previous.preCandidateVisualInventory }
            : {}),
    };
}

/**
 * Attach canonical environment execution only after all cleanup work has settled.
 *
 * @param provisionalResult - Result data accumulated before outer cleanup.
 * @param lifecycle - Selected adapter, recorder, and provisional disposition.
 * @returns Result extended with one post-cleanup canonical execution.
 */
export async function completeFixResultAfterEnvironmentCleanup<T extends object>(
    provisionalResult: T,
    lifecycle: FixEnvironmentLifecycle,
): Promise<T & Partial<FixResultEnvironmentExecution>> {
    const environmentExecution = await finalizeFilteringEnvironmentExecution(
        lifecycle.adapter,
        lifecycle.recorder,
        lifecycle.disposition,
    );
    const outcome = projectEnvironmentExecution(environmentExecution);
    if (!('projected' in outcome)) {
        // Refusing to attach unprojectable canonical evidence is right; throwing here is not: a run
        // that has already proven a candidate through A/B/C would die on this line and its patch
        // would be discarded with it. The result keeps the evidence the agent runtime recorded and
        // simply carries no canonical execution, which every downstream invariant already tolerates
        // — while the named refusal makes the canonical defect diagnosable from the run that hit
        // it.
        lifecycle.onProjectionRefused?.(outcome.refusal);
        return provisionalResult;
    }
    const projection = outcome.projected;
    const artifactPaths = mergeCanonicalEnvironmentArtifactPaths(
        provisionalResult,
        projection.artifactPaths,
    );
    const compatibilityKeys = new Set([
        'browserSessions',
        'extensionProvenance',
        'settingsEvidence',
        'candidateValidationEvidence',
        'candidateApplicationEvidence',
        'candidateVisualReview',
        'artifactPaths',
        'environmentExecution',
    ]);
    const base = Object.fromEntries(
        Object.entries(provisionalResult).filter(([key]) => !compatibilityKeys.has(key)),
    );
    const cleanupFailed =
        !environmentExecution.cleanup.completed || environmentExecution.drain.failed > 0;
    const completedResult = {
        ...base,
        ...projection,
        artifactPaths,
        environmentExecution,
    };
    if (cleanupFailed) {
        Object.assign(completedResult, {
            runStatus: 'failed',
            infrastructureFailureReason: InfrastructureFailureReason.EnvironmentUnavailable,
            verificationStatus: VerificationStatus.Unavailable,
            candidatePatch: null,
        });
    }
    return completedResult as unknown as T & FixResultEnvironmentExecution;
}
