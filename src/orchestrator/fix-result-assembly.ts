/**
 * The last step of a local fix core: turning one run's candidate verdict and artifact registry into
 * the serialized {@link FixRunResult}.
 *
 * The assembly filters the screenshot artifacts, prefers the Phase C HAR and DOM over the run's
 * first ones, chooses whose visual review the result carries, and hands the lot to
 * `makeCoreResult`. The core supplies only the values it genuinely owns.
 */
import type { CandidateValidationSelection } from './candidate-validation-selection';
import type { CoreBrowserState, CoreResultContext } from './fix-core-context';
import { makeCoreResult } from './pre-agent-artifacts';
import { AgentTerminationReason } from '../types/agent-termination-reason';
import type { CandidateVisualReview } from '../types/candidate-visual-review';
import {
    CurrentRulesResolutionStatus,
    FixRunStatus,
    SymptomObservation,
    VerificationStatus,
    type CandidatePatch,
    type FixRunArtifactPaths,
    type FixRunResult,
    type RejectedCandidateScreenshotPaths,
    type VerifiedCandidateScreenshotPaths,
} from '../types/fix-run-result';
import { InfrastructureFailureReason } from '../types/infrastructure-failure-reason';
import type { MissingInformationEntry } from '../types/missing-information';
import type { ArtifactRef } from '../types/trace';

/**
 * Artifact types the serialized result lists as this run's screenshots.
 *
 * A result that silently drops one kind of capture reads as evidence the run never took.
 */
const RESULT_SCREENSHOT_ARTIFACT_TYPES = [
    'screenshot',
    'screenshot-full-page',
    'screenshot-tile',
    'issue-screenshot',
];

/**
 * Everything a fix core hands the shared assembly to produce its terminal result.
 */
export interface FixRunResultAssembly {
    /**
     * Stable run metadata the result is stamped with.
     */
    context: CoreResultContext;

    /**
     * Product outcome the core derived for this run.
     */
    runStatus: FixRunStatus;

    /**
     * Effective browser state behind that outcome.
     */
    browserState: CoreBrowserState;

    /**
     * Strength of browser verification the core derived.
     */
    verificationStatus: VerificationStatus;

    /**
     * Human-readable terminal explanation, already carrying any omission note.
     */
    reasoning: string;

    /**
     * Browser observation of the issue-defined defect.
     */
    symptomObservation: SymptomObservation;

    /**
     * Independent current-checkout Phase B resolution state.
     */
    currentRulesResolutionStatus: CurrentRulesResolutionStatus;

    /**
     * Explicit unavailable runtime dependency, when the core proved one.
     */
    infrastructureFailureReason?: InfrastructureFailureReason;

    /**
     * Typed Host termination without an accepted model decision, when one applies.
     */
    agentTerminationReason?: AgentTerminationReason;

    /**
     * The provider's HTTP status of the final failed request, when the run ended in a provider
     * failure whose message named one.
     */
    providerFailureStatus?: number;

    /**
     * Every artifact the recorder registered during the run.
     */
    artifacts: readonly ArtifactRef[];

    /**
     * The candidate this run may publish, or null once a gate refused it.
     */
    candidatePatch: CandidatePatch | null;

    /**
     * Whether the runner-bound review verified the candidate with complete evidence.
     */
    candidateVerified: boolean;

    /**
     * Screenshot set backing a verified candidate, or undefined when incomplete.
     */
    verifiedScreenshots: VerifiedCandidateScreenshotPaths | undefined;

    /**
     * Runner-bound validation selected for the exact candidate, when the run produced one.
     */
    selectedValidation: CandidateValidationSelection | undefined;

    /**
     * Representative evidence for a candidate the review refused, when the core selected one.
     */
    rejectedCandidateScreenshots: RejectedCandidateScreenshotPaths | undefined;

    /**
     * Whether the result's visual review comes from the verified selection rather than the rejected
     * representative.
     *
     * The core decides it and the assembly only obeys.
     */
    visualReviewFromVerifiedCandidate: boolean;

    /**
     * Persisted trace path.
     */
    tracePath: string;

    /**
     * Persisted browser console log, or null when no session produced one.
     */
    browserLogPath: string | null;

    /**
     * Persisted extension settings proof, or null when the run applied no profile.
     */
    settingsProofPath: string | null;

    /**
     * Persisted pre-agent live symptom comparison, or null when the run made none.
     */
    symptomObservationEvidencePath?: string | null;

    /**
     * Persisted pre-candidate full-page vision inventory, or null when the run made none.
     */
    preCandidateVisualInventoryPath?: string | null;

    /**
     * Capped missing-information records the run recorded, when the harvest found any.
     */
    missingInformation?: readonly MissingInformationEntry[];
}

/**
 * Resolve the Phase C artifact of one type, falling back to the run's first of that type.
 *
 * A candidate validation records the exact HAR and DOM captured beside its Phase C screenshots, and
 * those are the ones the result must carry. A run without a selected validation still publishes
 * whatever single capture it made.
 *
 * @param artifacts - Runner-owned artifact registry.
 * @param type - Artifact type to resolve.
 * @param phaseArtifactId - Phase C identity from the selected validation, when one exists.
 * @returns The artifact's local path, or undefined when the run captured none.
 */
function phaseBoundArtifactPath(
    artifacts: readonly ArtifactRef[],
    type: string,
    phaseArtifactId: string | undefined,
): string | undefined {
    return (
        phaseArtifactId
            ? artifacts.find(
                  (artifact) => artifact.type === type && artifact.id === phaseArtifactId,
              )
            : artifacts.find((artifact) => artifact.type === type)
    )?.path;
}

/**
 * Build the artifact paths the serialized result carries.
 *
 * @param assembly - The run's evidence and the paths its core persisted.
 * @returns Schema-compatible artifact paths for the terminal result.
 */
function assembleArtifactPaths(assembly: FixRunResultAssembly): FixRunArtifactPaths {
    const {
        artifacts,
        candidatePatch,
        candidateVerified,
        rejectedCandidateScreenshots,
        selectedValidation,
        verifiedScreenshots,
    } = assembly;
    const visualReviewArtifactPath = assembly.visualReviewFromVerifiedCandidate
        ? selectedValidation?.visualReviewArtifactPath
        : rejectedCandidateScreenshots?.visualReviewArtifactPath;
    return {
        screenshots: artifacts
            .filter((artifact) => RESULT_SCREENSHOT_ARTIFACT_TYPES.includes(artifact.type))
            .map((artifact) => artifact.path),
        domSnapshot:
            phaseBoundArtifactPath(artifacts, 'dom', selectedValidation?.phaseCDomArtifactId) ??
            null,
        har:
            phaseBoundArtifactPath(artifacts, 'har', selectedValidation?.phaseCHarArtifactId) ??
            null,
        trace: assembly.tracePath,
        settingsProof: assembly.settingsProofPath,
        browserLog: assembly.browserLogPath,
        ...(assembly.symptomObservationEvidencePath !== undefined
            ? { symptomObservationEvidence: assembly.symptomObservationEvidencePath }
            : {}),
        ...(assembly.preCandidateVisualInventoryPath !== undefined
            ? { preCandidateVisualInventory: assembly.preCandidateVisualInventoryPath }
            : {}),
        candidateVisualReview: visualReviewArtifactPath ?? null,
        ...(candidatePatch && candidateVerified && verifiedScreenshots
            ? { verifiedCandidateScreenshots: verifiedScreenshots }
            : {}),
        ...(rejectedCandidateScreenshots ? { rejectedCandidateScreenshots } : {}),
    };
}

/**
 * Choose the visual review the serialized result carries.
 *
 * @param assembly - The run's evidence and the core's choice of source.
 * @returns The verified or rejected review, or undefined when the run produced neither.
 */
function assembleCandidateVisualReview(
    assembly: FixRunResultAssembly,
): CandidateVisualReview | undefined {
    return assembly.visualReviewFromVerifiedCandidate
        ? assembly.selectedValidation?.visualReview
        : assembly.rejectedCandidateScreenshots?.visualReview;
}

/**
 * Assemble one fix run's terminal result from its verdict, artifacts and persisted paths.
 *
 * @param assembly - The run's evidence and the paths its core persisted.
 * @returns The serialized, GitHub-independent fix result.
 */
export function assembleFixRunResult(assembly: FixRunResultAssembly): FixRunResult {
    return makeCoreResult(
        assembly.context,
        assembly.runStatus,
        assembly.browserState,
        assembly.verificationStatus,
        assembly.reasoning,
        assembly.runStatus === FixRunStatus.PatchProposed ? assembly.candidatePatch : null,
        assembleArtifactPaths(assembly),
        assembly.symptomObservation,
        assembly.currentRulesResolutionStatus,
        assembleCandidateVisualReview(assembly),
        assembly.infrastructureFailureReason,
        assembly.agentTerminationReason,
        assembly.missingInformation,
        assembly.providerFailureStatus,
    );
}
