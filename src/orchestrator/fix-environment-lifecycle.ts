/**
 * Finalising a fix result once the filtering environment it ran in has been torn down: the
 * lifecycle handle the core hands back, and the projection that folds the cleanup receipt into the
 * result without letting a superseded environment's artifacts survive into it.
 */
import { candidateScreenshotPathList } from '../types/candidate-screenshot-paths';
import {
    type FilteringEnvironmentAdapter,
    type FilteringEnvironmentExecution,
    type ProvisionalEnvironmentDisposition,
} from '../environment/filtering-environment';
import { projectEnvironmentExecution } from '../environment/environment-result-projection';
import { EnvironmentDispositionStatus } from '../environment/environment-vocabulary';
import { type EnvironmentProjectionRefusal } from '../types/environment-projection-refusal';
import {
    FixRunStatus,
    VerificationStatus,
    type AgentBrowserSessionEvidence,
    type AgentCandidateValidationEvidence,
    type FixRunArtifactPaths,
    type FixRunResult,
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

    /**
     * Run status assembled before projection; only a proposed patch fails on a refused projection.
     */
    runStatus?: FixRunStatus;
}

/**
 * The fields that fail a run whose canonical environment evidence cannot back its decision: an
 * incomplete cleanup and a refused projection end the run the same way, with no patch and no
 * verification claim.
 */
const ENVIRONMENT_FAILURE_FIELDS = {
    runStatus: FixRunStatus.Failed,
    infrastructureFailureReason: InfrastructureFailureReason.EnvironmentUnavailable,
    verificationStatus: VerificationStatus.Unavailable,
    candidatePatch: null,
} as const;

/**
 * Decide whether a refused projection is what failed the run.
 *
 * A refusal fails only a proposed patch, and fails it with `environment_unavailable`; the agent
 * runtime never fails a run with that reason itself. Any other run that carries a refusal kept its
 * own status, so a failure there has its own cause.
 *
 * @param result - A sealed run result.
 * @returns True when the run carries a refusal and the refusal set its failure.
 */
export function projectionRefusalFailedRun(
    result: Pick<FixRunResult, 'environmentProjectionRefusal' | 'infrastructureFailureReason'>,
): boolean {
    return (
        result.environmentProjectionRefusal !== undefined &&
        result.infrastructureFailureReason ===
            ENVIRONMENT_FAILURE_FIELDS.infrastructureFailureReason
    );
}

/**
 * Fold a refused projection into the provisional result.
 *
 * Every refusal is named on the result. A proposed patch whose verified decision the canonical
 * evidence cannot back has lost its evidence, so the run fails and the candidate binding and its
 * verified screenshots go with the patch. Any other run proposed no verified patch: a run whose
 * last experiment verified a candidate it did not propose, or one that has already failed and keeps
 * its own reason, stays as the agent runtime assembled it.
 *
 * @param provisionalResult - Result data accumulated before outer cleanup.
 * @param refusal - The invariant that refused the projection.
 * @param disposition - The decision the canonical execution was asked to back.
 * @returns The result naming the refusal, with no canonical execution attached.
 */
function refusedProjectionResult(
    provisionalResult: object,
    refusal: EnvironmentProjectionRefusal,
    disposition: ProvisionalEnvironmentDisposition,
): object {
    const compatibility = provisionalResult as ProvisionalCompatibilityResult;
    if (
        disposition.status !== EnvironmentDispositionStatus.Verified ||
        compatibility.runStatus !== FixRunStatus.PatchProposed
    ) {
        return { ...provisionalResult, environmentProjectionRefusal: refusal };
    }
    const { candidateValidationEvidence: _binding, artifactPaths, ...rest } = compatibility;
    void _binding;
    const result: Record<string, unknown> = {
        ...rest,
        ...ENVIRONMENT_FAILURE_FIELDS,
        environmentProjectionRefusal: refusal,
    };
    if (artifactPaths) {
        const { verifiedCandidateScreenshots: _verified, ...paths } = artifactPaths;
        void _verified;
        result.artifactPaths = paths;
    }
    return result;
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
    const verified = compatibility.artifactPaths?.verifiedCandidateScreenshots;
    return new Set([
        ...sessionPaths,
        ...(binding
            ? candidateScreenshotPathList({
                  before: binding.beforeViewport.path,
                  after: binding.afterViewport.path,
                  beforeFullPage: binding.beforeFullPage?.path,
                  afterFullPage: binding.afterFullPage?.path,
              })
            : []),
        ...(verified ? candidateScreenshotPathList(verified) : []),
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
        // A refusal is a defect in our own result assembly, never something a page or a model
        // causes. The result names it rather than throwing, so the run that hit the defect is the
        // one that diagnoses it.
        lifecycle.onProjectionRefused?.(outcome.refusal);
        return refusedProjectionResult(
            provisionalResult,
            outcome.refusal,
            lifecycle.disposition,
        ) as T;
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
        Object.assign(completedResult, ENVIRONMENT_FAILURE_FIELDS);
    }
    return completedResult as unknown as T & FixResultEnvironmentExecution;
}
