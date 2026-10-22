import type {
    AgentBrowserSessionEvidence,
    AgentCandidateArtifactEvidence,
    AgentCandidateArtifactEvidenceFields,
    AgentCandidateValidationEvidence,
    AgentExtensionProvenance,
    AgentSettingsEvidence,
    FixRunArtifactPaths,
} from '../types/fix-run-result';
import { ExtensionMode } from '../types/fix-run-result';
import type { CandidateVisualReview } from '../types/candidate-visual-review';
import { mapCandidateOverviews } from '../types/candidate-screenshot-paths';
import type {
    EnvironmentArtifactReference,
    EnvironmentPhaseEvidence,
    FilteringEnvironmentExecution,
    ValidatorObservedPhaseCompletion,
} from './filtering-environment';
import type { PhaseApplicationProof } from './environment-proofs';
import { PhaseLabel } from '../types/validation';
import { EnvironmentProjectionRefusal } from '../types/environment-projection-refusal';
import { EnvironmentDispositionStatus } from './environment-vocabulary';
import { ExtensionLaunchFamily } from './extension-launch';
import { SIGNED_XPI_BUILD_MARKER } from './firefox-phase-evidence';

/**
 * Canonical owner of one globally unique environment artifact.
 */
interface OwnedEnvironmentArtifact {
    /**
     * Artifact identity, kind, and durable path.
     */
    artifact: EnvironmentArtifactReference;

    /**
     * Exact phase which owns the artifact.
     */
    phase: EnvironmentPhaseEvidence;
}

/**
 * Candidate validation after all optional artifact references resolve canonically.
 */
type ResolvedCandidateValidation = NonNullable<
    ValidatorObservedPhaseCompletion['candidateValidation']
> &
    Required<
        Pick<
            NonNullable<ValidatorObservedPhaseCompletion['candidateValidation']>,
            'validationArtifact' | 'visualReviewArtifact' | 'beforeViewport' | 'afterViewport'
        >
    >;

/**
 * Fully resolved candidate evidence spanning baseline B and candidate C.
 */
interface ResolvedCandidateMaterial {
    /**
     * Canonical candidate phase.
     */
    candidate: EnvironmentPhaseEvidence;

    /**
     * Candidate validation embedded in phase C.
     */
    validation: ResolvedCandidateValidation;

    /**
     * Visual decision embedded in phase C.
     */
    visualReview: CandidateVisualReview;
}

/**
 * Every compatibility field derived from one canonical environment execution.
 */
export interface EnvironmentResultProjection {
    /**
     * Final A/B/C browser sessions in phase order.
     */
    browserSessions: AgentBrowserSessionEvidence[];

    /**
     * Exact Extension build shared by filtered phases.
     */
    extensionProvenance?: AgentExtensionProvenance;

    /**
     * Exact Extension settings shared by B/C.
     */
    settingsEvidence?: AgentSettingsEvidence;

    /**
     * Candidate artifacts bound to phase C.
     */
    candidateValidationEvidence?: AgentCandidateValidationEvidence;

    /**
     * The candidate application record the instruction's step session produced, projected from the
     * selected phase C extension proof: the verification method from the instruction, the exact
     * applied rules, and the host-assembled action log. The baseline plug record stays in the
     * canonical execution when the published result attaches it.
     */
    candidateApplicationEvidence?: PhaseApplicationProof;

    /**
     * Candidate vision decision bound to phase C.
     */
    candidateVisualReview?: CandidateVisualReview;

    /**
     * Top-level paths projected from phase-owned artifacts.
     */
    artifactPaths: FixRunArtifactPaths;
}

/**
 * Compare JSON-safe canonical values structurally and in order.
 *
 * @param left - First value.
 * @param right - Second value.
 * @returns Whether the values have the same JSON structure.
 */
function structurallyEqual(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Resolve one observed phase or return null for failed/incomplete evidence.
 *
 * @param phase - Canonical phase evidence.
 * @returns Observed completion or null.
 */
function observedCompletion(
    phase: EnvironmentPhaseEvidence,
): ValidatorObservedPhaseCompletion | null {
    return phase.completion.kind === 'observed' ? phase.completion : null;
}

/**
 * Project a canonical artifact into the compatibility binding shape.
 *
 * @param artifact - Canonical phase-owned artifact.
 * @returns Compatibility artifact identity and path.
 */
function projectArtifact(artifact: EnvironmentArtifactReference): AgentCandidateArtifactEvidence {
    // The reference carries `kind` too, which the strict result schema refuses: the brand cast
    // accepts only this literal of exactly the two schema fields.
    return {
        artifactId: artifact.artifactId,
        path: artifact.path,
    } satisfies AgentCandidateArtifactEvidenceFields as AgentCandidateArtifactEvidence;
}

/**
 * Project common Extension proof into the existing settings evidence shape.
 *
 * @param phase - Filtered canonical phase.
 * @returns Settings in the compatibility evidence shape, or undefined without Extension proof.
 */
function projectPhaseSettings(phase: EnvironmentPhaseEvidence): AgentSettingsEvidence | undefined {
    const extension = phase.proof.extension;
    if (!extension) {
        return undefined;
    }
    return {
        profileKind: extension.profileKind,
        // A null extension set is carried as null, never flattened into "no lists enabled" or
        // "no rulesets active".
        enabledListKeys: extension.enabledListKeys === null ? null : [...extension.enabledListKeys],
        activeRulesetListKeys:
            extension.activeRulesetListKeys === null ? null : [...extension.activeRulesetListKeys],
        stealthEnabled: extension.stealthEnabled,
        limitsExceeded: false,
    };
}

/**
 * Project the selected candidate phase's application record beside the extension proof.
 *
 * The `application` block is exactly what the between-phases procedure recorded — the instruction's
 * verification method, the exact applied rules, and the host-assembled action log — so the
 * projection carries it verbatim rather than re-deriving anything the phase credit already proved.
 *
 * @param candidatePhase - Selected canonical phase C.
 * @returns The candidate application record, or undefined when the phase ran no extension.
 */
function projectCandidateApplication(
    candidatePhase: EnvironmentPhaseEvidence | undefined,
): PhaseApplicationProof | undefined {
    const application = candidatePhase?.proof.extension?.application;
    return application ? structuredClone(application) : undefined;
}

/**
 * Project one canonical phase into the existing browser-session shape.
 *
 * The phase proof decides the shape: a proxy-filtered executor carries the CLI proof (no phase past
 * the control carries an extension), and an extension-filtered executor carries the extension
 * proof. The control phase carries neither and projects identically for both.
 *
 * @param phase - Canonical phase evidence.
 * @returns Session, undefined for a failed phase, or null for incomplete observed evidence.
 */
function projectPhaseSession(
    phase: EnvironmentPhaseEvidence,
): AgentBrowserSessionEvidence | null | undefined {
    const completion = observedCompletion(phase);
    if (!completion) {
        return undefined;
    }
    if (!completion.profile || !completion.captures) {
        return null;
    }
    if (phase.proof.extension?.provenance === undefined) {
        // A proxy-filtered phase session ran no extension: the filtered phases prove their state
        // through the CLI proof instead.
        if (phase.phase !== PhaseLabel.A && !phase.proof.cli) {
            return null;
        }
        return {
            sessionId: phase.proof.sessionId,
            targetUrl: completion.targetUrl,
            extensionMode: ExtensionMode.None,
            profile: completion.profile,
            navigationVerified: completion.navigationVerified,
            fullVisionVerified: completion.captures.some(
                (capture) => capture.visionVerified && capture.coverageComplete,
            ),
            captures: structuredClone(completion.captures),
        };
    }
    if (phase.phase !== PhaseLabel.A && !phase.proof.extension.provenance) {
        return null;
    }
    const settings = projectPhaseSettings(phase);
    // The settings keys are placed here rather than appended, because a retained result is compared
    // with a freshly projected one by exact serialization: a validated result carries its schema's
    // property order, so a projection that appends these would never compare equal to itself.
    return {
        sessionId: phase.proof.sessionId,
        targetUrl: completion.targetUrl,
        extensionMode: phase.phase === PhaseLabel.A ? 'none' : 'prepared',
        profile: completion.profile,
        ...(phase.phase === PhaseLabel.A
            ? {}
            : {
                  selectedSettingsProfileKind: phase.proof.extension!.profileKind,
                  extensionProvenance: phase.proof.extension!.provenance!,
                  settingsEvidence: settings!,
              }),
        navigationVerified: completion.navigationVerified,
        fullVisionVerified: completion.captures.some(
            (capture) => capture.visionVerified && capture.coverageComplete,
        ),
        captures: structuredClone(completion.captures),
    };
}

/**
 * Index every durable artifact and reject duplicate global identities.
 *
 * @param execution - Canonical execution to inspect.
 * @returns Unique artifact ownership index or null for duplicate identities.
 */
function indexExecutionArtifacts(
    execution: FilteringEnvironmentExecution,
): Map<string, OwnedEnvironmentArtifact> | null {
    const artifacts = new Map<string, OwnedEnvironmentArtifact>();
    for (const phase of execution.phases) {
        const completion = observedCompletion(phase);
        if (!completion) {
            continue;
        }
        for (const artifact of completion.artifacts) {
            if (artifacts.has(artifact.artifactId)) {
                return null;
            }
            artifacts.set(artifact.artifactId, { artifact, phase });
        }
    }
    return artifacts;
}

/**
 * Test whether an inline artifact reference resolves to one exact phase-owned artifact.
 *
 * @param artifacts - Global canonical artifact ownership index.
 * @param reference - Inline candidate artifact reference.
 * @param owner - Expected owning phase.
 * @param kind - Expected artifact kind.
 * @returns Whether identity, path, kind, and owner all agree.
 */
function artifactBelongsToPhase(
    artifacts: ReadonlyMap<string, OwnedEnvironmentArtifact>,
    reference: EnvironmentArtifactReference,
    owner: EnvironmentPhaseEvidence,
    kind: EnvironmentArtifactReference['kind'],
): boolean {
    const resolved = artifacts.get(reference.artifactId);
    return (
        resolved?.phase === owner &&
        resolved.artifact.kind === kind &&
        structurallyEqual(resolved.artifact, reference)
    );
}

/**
 * Resolve and validate every cross-phase candidate artifact binding.
 *
 * @param baseline - Selected phase B.
 * @param candidate - Selected phase C.
 * @param artifacts - Global canonical artifact ownership index.
 * @returns Complete candidate material or null for any mismatched reference.
 */
function resolveCandidateMaterial(
    baseline: EnvironmentPhaseEvidence | undefined,
    candidate: EnvironmentPhaseEvidence | undefined,
    artifacts: ReadonlyMap<string, OwnedEnvironmentArtifact>,
): ResolvedCandidateMaterial | null {
    if (
        !baseline ||
        baseline.phase !== PhaseLabel.B ||
        !candidate ||
        candidate.phase !== PhaseLabel.C
    ) {
        return null;
    }
    const completion = observedCompletion(candidate);
    const validation = completion?.candidateValidation;
    const review = completion?.visualReview;
    if (
        !completion ||
        !validation ||
        !review ||
        validation.candidateDigest !== candidate.proof.candidateDigest ||
        !validation.validationArtifact ||
        !validation.visualReviewArtifact ||
        !validation.beforeViewport ||
        !validation.afterViewport
    ) {
        return null;
    }
    // An overview is absent where the browser captured none; the tiles carry that proof.
    const { beforeFullPage, afterFullPage } = validation;
    const screenshots = [
        validation.beforeViewport,
        validation.afterViewport,
        ...(beforeFullPage ? [beforeFullPage] : []),
        ...(afterFullPage ? [afterFullPage] : []),
    ];
    if (
        validation.validationArtifactId !== validation.validationArtifact.artifactId ||
        !structurallyEqual(
            validation.screenshotArtifactIds,
            screenshots.map((artifact) => artifact.artifactId),
        ) ||
        new Set(validation.screenshotArtifactIds).size !== screenshots.length ||
        review.validationArtifactId !== validation.validationArtifactId ||
        review.beforeViewportArtifactId !== validation.beforeViewport.artifactId ||
        review.afterViewportArtifactId !== validation.afterViewport.artifactId ||
        review.beforeFullPageArtifactId !== (beforeFullPage?.artifactId ?? null) ||
        review.afterFullPageArtifactId !== (afterFullPage?.artifactId ?? null) ||
        !artifactBelongsToPhase(artifacts, validation.beforeViewport, baseline, 'screenshot') ||
        (beforeFullPage &&
            !artifactBelongsToPhase(artifacts, beforeFullPage, baseline, 'screenshot')) ||
        !artifactBelongsToPhase(artifacts, validation.afterViewport, candidate, 'screenshot') ||
        (afterFullPage &&
            !artifactBelongsToPhase(artifacts, afterFullPage, candidate, 'screenshot')) ||
        !artifactBelongsToPhase(
            artifacts,
            validation.validationArtifact,
            candidate,
            'validation',
        ) ||
        !artifactBelongsToPhase(artifacts, validation.visualReviewArtifact, candidate, 'vision')
    ) {
        return null;
    }
    return {
        candidate,
        validation: validation as ResolvedCandidateValidation,
        visualReview: review,
    };
}

/**
 * Project verified C-bound candidate artifacts into the existing binding shape.
 *
 * @param material - Fully resolved candidate material.
 * @returns Candidate binding or undefined for a non-verified candidate.
 */
function projectCandidateBinding(
    material: ResolvedCandidateMaterial | null,
): AgentCandidateValidationEvidence | undefined {
    if (!material?.validation.verified) {
        return undefined;
    }
    const { candidate, validation } = material;
    const extension = candidate.proof.extension;
    if (!extension?.provenance) {
        // The desktop executor proves its candidate through the CLI proof: no extension ever ran,
        // so the binding carries that proof instead of fabricated extension evidence.
        const cli = candidate.proof.cli;
        if (!cli) {
            return undefined;
        }
        return {
            validationArtifactId: validation.validationArtifactId,
            sessionId: candidate.proof.sessionId,
            cli: structuredClone(cli),
            validationArtifact: projectArtifact(validation.validationArtifact),
            visualReviewArtifact: projectArtifact(validation.visualReviewArtifact),
            beforeViewport: projectArtifact(validation.beforeViewport),
            afterViewport: projectArtifact(validation.afterViewport),
            ...mapCandidateOverviews(validation, projectArtifact),
        };
    }
    return {
        validationArtifactId: validation.validationArtifactId,
        sessionId: candidate.proof.sessionId,
        extensionProvenance: extension.provenance,
        settingsEvidence: projectPhaseSettings(candidate)!,
        validationArtifact: projectArtifact(validation.validationArtifact),
        visualReviewArtifact: projectArtifact(validation.visualReviewArtifact),
        beforeViewport: projectArtifact(validation.beforeViewport),
        afterViewport: projectArtifact(validation.afterViewport),
        ...mapCandidateOverviews(validation, projectArtifact),
    };
}

/**
 * Group canonical phase evidence by its candidate experiment identity.
 *
 * @param execution - Canonical execution containing zero or more candidate attempts.
 * @returns Candidate experiments in recorder order.
 */
function executionExperiments(
    execution: FilteringEnvironmentExecution,
): EnvironmentPhaseEvidence[][] {
    const groups = new Map<string, EnvironmentPhaseEvidence[]>();
    for (const phase of execution.phases) {
        const group = groups.get(phase.experimentId) ?? [];
        group.push(phase);
        groups.set(phase.experimentId, group);
    }
    return [...groups.values()];
}

/**
 * Select the experiment represented by the final canonical disposition.
 *
 * @param execution - Recorder-finalized execution.
 * @returns Selected A/B/C group or an empty list before any phase completed.
 */
function projectionPhases(execution: FilteringEnvironmentExecution): EnvironmentPhaseEvidence[] {
    if (execution.disposition.candidateDigest) {
        let selectedCandidate: EnvironmentPhaseEvidence | undefined;
        for (let index = execution.phases.length - 1; index >= 0; index -= 1) {
            const phase = execution.phases[index];
            if (
                phase?.phase === PhaseLabel.C &&
                phase.proof.candidateDigest === execution.disposition.candidateDigest
            ) {
                selectedCandidate = phase;
                break;
            }
        }
        if (!selectedCandidate) {
            return [];
        }
        return execution.phases.filter(
            (phase) => phase.experimentId === selectedCandidate.experimentId,
        );
    }
    const experimentId = execution.phases.at(-1)?.experimentId;
    return experimentId
        ? execution.phases.filter((phase) => phase.experimentId === experimentId)
        : [];
}

/**
 * Check whether one selected experiment is exactly the ordered A/B/C sequence.
 *
 * @param phases - Selected experiment phases in recorder order.
 * @returns Whether the experiment contains exactly A, B, and C.
 */
function isExactAbcExperiment(phases: readonly EnvironmentPhaseEvidence[]): boolean {
    return phases.length === 3 && phases.map((phase) => phase.phase).join('') === 'ABC';
}

/**
 * Validate common cross-phase identity and proof invariants required by projections.
 *
 * @param execution - Canonical environment execution.
 * @returns Whether every phase remains bound to one actual context and B/C baseline.
 */
function executionBindingsAgree(execution: FilteringEnvironmentExecution): boolean {
    if (
        execution.phases.some(
            (phase) =>
                phase.runId !== execution.runId ||
                phase.proof.actualContext.kind !== execution.kind ||
                !structurallyEqual(phase.proof.actualContext, execution.actualContext),
        )
    ) {
        return false;
    }
    const seen = new Set<string>();
    for (const phase of execution.phases) {
        const key = `${phase.experimentId}:${phase.phase}`;
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        const completion = observedCompletion(phase);
        if (completion && completion.sessionId !== phase.proof.sessionId) {
            return false;
        }
        if (
            completion?.rejectedCandidates.some(
                (rejected) =>
                    rejected.experimentId !== phase.experimentId ||
                    rejected.phase !== phase.phase ||
                    rejected.candidateDigest !== phase.proof.candidateDigest,
            )
        ) {
            return false;
        }
        if (phase.phase !== PhaseLabel.A) {
            if (
                !execution.baseline ||
                phase.proof.baselineDigest !== execution.baseline.aggregateDigest
            ) {
                return false;
            }
        }
    }
    for (const experiment of executionExperiments(execution)) {
        const baseline = experiment.find((phase) => phase.phase === PhaseLabel.B);
        const candidate = experiment.find((phase) => phase.phase === PhaseLabel.C);
        if (!candidate) {
            continue;
        }
        if (!baseline || baseline.proof.baselineDigest !== candidate.proof.baselineDigest) {
            return false;
        }
        if (baseline.proof.cli !== undefined) {
            // A proxy-filtered experiment must present the same CLI proof except for the
            // candidate source itself, and the run's product version must be the proof's.
            const baselineCli = baseline.proof.cli;
            const candidateCli = candidate.proof.cli;
            if (
                baselineCli === undefined ||
                candidateCli === undefined ||
                baselineCli.cliVersion !== candidateCli.cliVersion ||
                !structurallyEqual(baselineCli.enabledListKeys, candidateCli.enabledListKeys) ||
                !structurallyEqual(baselineCli.coenabledListKeys, candidateCli.coenabledListKeys) ||
                execution.actualContext.productVersion !== baselineCli.cliVersion
            ) {
                return false;
            }
            continue;
        }
        const baselineSettings = projectPhaseSettings(baseline);
        const candidateSettings = projectPhaseSettings(candidate);
        if (!baselineSettings || !structurallyEqual(baselineSettings, candidateSettings)) {
            return false;
        }
        const baselineProvenance = baseline.proof.extension?.provenance;
        const candidateProvenance = candidate.proof.extension?.provenance;
        if (
            baselineProvenance === undefined ||
            !structurallyEqual(baselineProvenance, candidateProvenance) ||
            execution.actualContext.productVersion !==
                boundProductVersion(baseline.proof.extension?.packageVersion, baselineProvenance)
        ) {
            return false;
        }
    }
    const rejectedCandidates = execution.phases.flatMap((phase) => {
        const completion = observedCompletion(phase);
        return completion?.rejectedCandidates ?? [];
    });
    return structurallyEqual(execution.rejectedCandidates, rejectedCandidates);
}

/**
 * The product version an extension experiment's run context must report.
 *
 * A Chromium build binds the one version its own manifest records — the proof's top-level
 * packageVersion, read from the directory the browser loaded. A signed XPI reports no version:
 * Firefox validates the archive itself and the host never reads it, so its proof carries the
 * signed-XPI marker and its run context null, and null is the version bound. The marker counts only
 * on a Firefox-family build, so a Chromium proof that claimed it would still disagree.
 *
 * @param packageVersion - The baseline phase proof's package version.
 * @param provenance - The baseline phase proof's prepared-build provenance.
 * @returns The product version the run context must carry.
 */
function boundProductVersion(
    packageVersion: string | undefined,
    provenance: NonNullable<EnvironmentPhaseEvidence['proof']['extension']>['provenance'],
): string | null | undefined {
    return packageVersion === SIGNED_XPI_BUILD_MARKER &&
        provenance?.launchFamily === ExtensionLaunchFamily.Firefox
        ? null
        : packageVersion;
}

/**
 * Outcome of one projection attempt: the compatibility fields, or the invariant that refused.
 */
export type EnvironmentProjectionOutcome =
    | {
          /**
           * The compatibility fields the projection produced.
           */
          projected: EnvironmentResultProjection;
      }
    | {
          /**
           * The invariant that refused to project this result.
           */
          refusal: EnvironmentProjectionRefusal;
      };

/**
 * Derive every retained Extension compatibility field from one canonical execution.
 *
 * @param execution - Recorder-finalized post-cleanup execution.
 * @returns The projected compatibility fields, or the exact invariant that refused them.
 */
export function projectEnvironmentExecution(
    execution: FilteringEnvironmentExecution,
): EnvironmentProjectionOutcome {
    if (!executionBindingsAgree(execution)) {
        return { refusal: EnvironmentProjectionRefusal.BindingsDisagree };
    }
    const artifactIndex = indexExecutionArtifacts(execution);
    if (!artifactIndex) {
        return { refusal: EnvironmentProjectionRefusal.ArtifactIndexUnavailable };
    }
    const selectedPhases = projectionPhases(execution);
    if (execution.phases.length > 0 && selectedPhases.length === 0) {
        return { refusal: EnvironmentProjectionRefusal.NoProjectablePhases };
    }
    const verified = execution.disposition.status === EnvironmentDispositionStatus.Verified;
    if (verified && !isExactAbcExperiment(selectedPhases)) {
        return { refusal: EnvironmentProjectionRefusal.VerifiedWithoutExactAbc };
    }
    const projectedSessions = selectedPhases.map((phase) => projectPhaseSession(phase));
    if (projectedSessions.some((session) => session === null)) {
        return { refusal: EnvironmentProjectionRefusal.PhaseSessionUnprojectable };
    }
    const sessions = projectedSessions.filter(
        (session): session is AgentBrowserSessionEvidence => session !== undefined,
    );
    if (verified && sessions.length !== 3) {
        return { refusal: EnvironmentProjectionRefusal.VerifiedWithoutThreeSessions };
    }
    const filtered = selectedPhases.filter((phase) => phase.phase !== PhaseLabel.A);
    const extensionProvenance = filtered[0]?.proof.extension?.provenance;
    const settingsEvidence = filtered[0] ? projectPhaseSettings(filtered[0]) : undefined;
    const baselinePhase = selectedPhases.find((phase) => phase.phase === PhaseLabel.B);
    const candidatePhase = selectedPhases.find((phase) => phase.phase === PhaseLabel.C);
    const material = resolveCandidateMaterial(baselinePhase, candidatePhase, artifactIndex);
    const candidateValidationEvidence = verified ? projectCandidateBinding(material) : undefined;
    if (verified && !candidateValidationEvidence) {
        return { refusal: EnvironmentProjectionRefusal.VerifiedWithoutCandidateBinding };
    }
    const candidateApplicationEvidence = projectCandidateApplication(candidatePhase);
    const candidateCompletion = candidatePhase ? observedCompletion(candidatePhase) : null;
    const allArtifacts = selectedPhases.flatMap((phase) => {
        const completion = observedCompletion(phase);
        return completion?.artifacts ?? [];
    });
    const screenshots = allArtifacts
        .filter((artifact) => artifact.kind === 'screenshot')
        .map((artifact) => artifact.path);
    const candidateArtifacts = candidateCompletion?.artifacts ?? [];
    const har =
        candidateArtifacts.find((artifact) => artifact.kind === 'har')?.path ??
        allArtifacts.find((artifact) => artifact.kind === 'har')?.path ??
        null;
    const dom =
        candidateArtifacts.find((artifact) => artifact.kind === 'dom')?.path ??
        allArtifacts.find((artifact) => artifact.kind === 'dom')?.path ??
        null;
    const artifactPaths: FixRunArtifactPaths = {
        screenshots,
        domSnapshot: dom,
        har,
        trace: null,
        candidateVisualReview: material?.validation.visualReviewArtifact.path ?? null,
    };
    if (candidateValidationEvidence) {
        artifactPaths.verifiedCandidateScreenshots = {
            before: candidateValidationEvidence.beforeViewport.path,
            after: candidateValidationEvidence.afterViewport.path,
            ...mapCandidateOverviews(candidateValidationEvidence, (artifact) => artifact.path),
        };
    }
    if (!material?.validation.verified && material?.validation.candidateRule) {
        const rejectedCandidate = candidateCompletion?.rejectedCandidates.find(
            (rejected) => rejected.candidateDigest === material.validation.candidateDigest,
        );
        artifactPaths.rejectedCandidateScreenshots = {
            before: material.validation.beforeViewport.path,
            after: material.validation.afterViewport.path,
            ...mapCandidateOverviews(material.validation, (artifact) => artifact.path),
            validationArtifactId: material.validation.validationArtifactId,
            candidateRule: material.validation.candidateRule,
            rejectionReasons: rejectedCandidate?.reasonCodes ?? [
                'candidate_validation_not_verified',
            ],
            visualReview: material.visualReview,
            visualReviewArtifactPath: material.validation.visualReviewArtifact.path,
        };
    }
    return {
        projected: {
            browserSessions: sessions,
            ...(extensionProvenance ? { extensionProvenance } : {}),
            ...(settingsEvidence ? { settingsEvidence } : {}),
            ...(candidateValidationEvidence ? { candidateValidationEvidence } : {}),
            ...(candidateApplicationEvidence ? { candidateApplicationEvidence } : {}),
            ...(material ? { candidateVisualReview: material.visualReview } : {}),
            artifactPaths,
        },
    };
}

/**
 * Derive every retained Extension compatibility field from one canonical execution.
 *
 * @param execution - Recorder-finalized post-cleanup execution.
 * @returns Deterministic projections, or null when the canonical evidence refuses to project.
 */
export function projectEnvironmentResult(
    execution: FilteringEnvironmentExecution,
): EnvironmentResultProjection | null {
    const outcome = projectEnvironmentExecution(execution);
    return 'projected' in outcome ? outcome.projected : null;
}
