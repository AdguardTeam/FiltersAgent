import * as v from 'valibot';
import type { EnvironmentSelectionHost } from './environment-selection';
import {
    EnvironmentAdapterLimitationCode,
    EnvironmentLimitationStage,
    EnvironmentPhaseEvidenceSchema,
    EnvironmentCleanupReceiptSchema,
    EnvironmentHandleDrainReceiptSchema,
    FilteringEnvironmentAdapterStateSchema,
    FilteringEnvironmentExecutionSchema,
    ProvisionalEnvironmentDispositionSchema,
    ValidatorPhaseCompletionSchema,
    type AdapterPhaseLease,
    type BeginEnvironmentPhaseRequest,
    type BoundEnvironmentPhaseHandle,
    type EnvironmentAdapterLimitation,
    type EnvironmentArtifactReference,
    type EnvironmentPhaseEvidence,
    type EnvironmentPhaseToken,
    type FilteringEnvironmentAdapterState,
    type FilteringEnvironmentExecution,
    type FinalEnvironmentCleanupInput,
    type ProvisionalEnvironmentDisposition,
    type ValidatorPhaseCompletion,
    type ValidatorObservedPhaseCompletion,
} from './filtering-environment';
import { EnvironmentPhaseStateProofSchema } from './environment-proofs';
import { PhaseLabel } from '../types/validation';

/**
 * Internal state for one recorder-issued phase token.
 */
interface PhaseLedgerEntry {
    /**
     * Immutable token returned to the orchestrator.
     */
    token: EnvironmentPhaseToken;

    /**
     * Adapter lease accepted for this token.
     */
    lease: AdapterPhaseLease | null;

    /**
     * Canonical evidence produced exactly once.
     */
    evidence: EnvironmentPhaseEvidence | null;
}

/**
 * Clone one schema-owned value before crossing a mutable boundary.
 *
 * @param schema - Valibot schema used to validate the cloned value.
 * @param value - Value to clone and validate.
 * @returns Independent validated value.
 */
function cloneParsed<TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
    schema: TSchema,
    value: unknown,
): v.InferOutput<TSchema> {
    return v.parse(schema, structuredClone(value));
}

/**
 * Retain bounded stable failures once while preserving their first-seen order.
 *
 * @param failures - Investigation, drain, and finalizer failures in precedence order.
 * @returns At most 128 unique public failures.
 */
function uniqueFailures(
    failures: readonly (EnvironmentAdapterLimitation | null)[],
): EnvironmentAdapterLimitation[] {
    const seen = new Set<string>();
    const result: EnvironmentAdapterLimitation[] = [];
    for (const failure of failures) {
        if (!failure) {
            continue;
        }
        const key = JSON.stringify(failure);
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        result.push(failure);
        if (result.length === 128) {
            break;
        }
    }
    return result;
}

/**
 * One canonical artifact and the recorder token that owns it.
 */
interface ArtifactOwnership {
    /**
     * Exact phase token that introduced the artifact.
     */
    token: EnvironmentPhaseToken;

    /**
     * Immutable artifact reference accepted for that phase.
     */
    artifact: EnvironmentArtifactReference;
}

/**
 * Host-owned sole aggregate for phase evidence and final environment execution.
 */
export class FilteringEnvironmentExecutionRecorder {
    /**
     * Registered immutable adapter state.
     */
    private adapterState: FilteringEnvironmentAdapterState | null = null;

    /**
     * Recorder-issued token ledger.
     */
    private readonly ledger = new Map<string, PhaseLedgerEntry>();

    /**
     * Phase keys issued at most once per experiment.
     */
    private readonly phaseKeys = new Set<string>();

    /**
     * Artifact identities accepted by exactly one phase.
     */
    private readonly artifactOwners = new Map<string, ArtifactOwnership>();

    /**
     * Completed cleanup input.
     */
    private cleanupInput: FinalEnvironmentCleanupInput | null = null;

    /**
     * Whether final execution has already been emitted.
     */
    private finalized = false;

    /**
     * Monotonic token counter scoped to this run.
     */
    private tokenCounter = 0;

    /**
     * Create one recorder bound to a run and immutable selection host.
     *
     * @param runId - Host-owned run identity.
     * @param selectionHost - Already-selected environment host.
     */
    constructor(
        private readonly runId: string,
        private readonly selectionHost: EnvironmentSelectionHost,
    ) {
        if (runId.length === 0 || runId.length > 256) {
            throw new Error('Recorder run ID is invalid.');
        }
    }

    /**
     * Register one adapter and bind its actual context to the selection host.
     *
     * @param state - Adapter-only state after selection.
     */
    registerAdapter(state: FilteringEnvironmentAdapterState): void {
        this.ensureWritable();
        const parsed = cloneParsed(FilteringEnvironmentAdapterStateSchema, state);
        const selection = this.selectionHost.snapshot();
        if (!selection || selection.selectedKind !== parsed.kind) {
            throw new Error('Adapter kind does not match the locked environment selection.');
        }
        if (this.adapterState) {
            if (JSON.stringify(this.adapterState) !== JSON.stringify(parsed)) {
                throw new Error('A different adapter state is already registered.');
            }
            return;
        }
        this.selectionHost.bindActualContext(parsed.kind, {
            product: parsed.actualContext.product,
            browser: parsed.actualContext.browser,
            ...(parsed.actualContext.productVersion === null
                ? {}
                : { productVersion: parsed.actualContext.productVersion }),
        });
        const bound = this.selectionHost.snapshot()?.actual;
        if (JSON.stringify(bound) !== JSON.stringify(parsed.actualContext)) {
            throw new Error('Adapter actual context does not equal the selection-host context.');
        }
        this.adapterState = parsed;
    }

    /**
     * Issue one opaque token bound to the recorder run, experiment, and phase.
     *
     * @param request - Requested token boundary.
     * @returns Fresh opaque phase token.
     */
    beginPhase(request: BeginEnvironmentPhaseRequest): EnvironmentPhaseToken {
        this.ensureWritable();
        if (!this.adapterState) {
            throw new Error('Adapter must be registered before a phase begins.');
        }
        if (request.runId !== this.runId) {
            throw new Error('Phase token names another run.');
        }
        if (![PhaseLabel.A, PhaseLabel.B, PhaseLabel.C].includes(request.phase)) {
            throw new Error('Unknown phase.');
        }
        if (request.experimentId.length === 0 || request.experimentId.length > 256) {
            throw new Error('Experiment ID is invalid.');
        }
        const phaseKey = `${request.experimentId}:${request.phase}`;
        if (this.phaseKeys.has(phaseKey)) {
            throw new Error('Phase token was already issued.');
        }
        this.phaseKeys.add(phaseKey);
        this.tokenCounter += 1;
        const token = Object.freeze({
            tokenId: `${this.runId}:${this.tokenCounter}`,
            runId: this.runId,
            experimentId: request.experimentId,
            phase: request.phase,
        });
        this.ledger.set(token.tokenId, { token, lease: null, evidence: null });
        return token;
    }

    /**
     * Bind one ready adapter lease to its recorder-issued token.
     *
     * @param token - Exact token returned by beginPhase.
     * @param lease - Adapter lease proposed for validator use.
     * @param state - Adapter state observed with the lease.
     * @returns Recorder-bound handle.
     */
    bindPhaseLease(
        token: EnvironmentPhaseToken,
        lease: AdapterPhaseLease,
        state: FilteringEnvironmentAdapterState,
    ): BoundEnvironmentPhaseHandle {
        this.ensureWritable();
        const entry = this.requireEntry(token);
        if (entry.lease) {
            throw new Error('Phase lease is already bound.');
        }
        if (entry.evidence) {
            throw new Error('Phase is already completed.');
        }
        if (!this.adapterState) {
            throw new Error('Adapter is not registered.');
        }
        const parsedState = cloneParsed(FilteringEnvironmentAdapterStateSchema, state);
        const proof = cloneParsed(EnvironmentPhaseStateProofSchema, lease.adapterProof);
        if (
            parsedState.kind !== this.adapterState.kind ||
            parsedState.stateDigest !== this.adapterState.stateDigest ||
            proof.adapterStateDigest !== this.adapterState.stateDigest ||
            proof.phase !== token.phase ||
            proof.actualContext.kind !== this.adapterState.kind ||
            JSON.stringify(proof.actualContext) !== JSON.stringify(this.adapterState.actualContext)
        ) {
            throw new Error('Phase lease proof does not match its recorder boundary.');
        }
        entry.lease = { ...lease, adapterProof: proof };
        return Object.freeze({ token: entry.token, lease: entry.lease });
    }

    /**
     * Accept one complete validator outcome and construct canonical phase evidence.
     *
     * @param token - Bound recorder token.
     * @param completion - Complete observed or failed outcome.
     * @returns Canonical immutable phase evidence.
     */
    completePhase(
        token: EnvironmentPhaseToken,
        completion: ValidatorPhaseCompletion,
    ): EnvironmentPhaseEvidence {
        this.ensureWritable();
        const entry = this.requireEntry(token);
        if (entry.evidence) {
            throw new Error('Phase is already completed.');
        }
        if (!entry.lease) {
            throw new Error('Phase lease must be bound before completion.');
        }
        const parsed = cloneParsed(ValidatorPhaseCompletionSchema, completion);
        if (parsed.sessionId !== entry.lease.adapterProof.sessionId) {
            throw new Error('Phase completion names another browser session.');
        }
        if (parsed.kind === 'observed') {
            const localArtifacts = this.validateObservedArtifacts(entry, parsed);
            if (
                parsed.candidateValidation &&
                parsed.candidateValidation.candidateDigest !==
                    entry.lease.adapterProof.candidateDigest
            ) {
                throw new Error('Candidate validation does not match the phase proof.');
            }
            for (const artifact of localArtifacts.values()) {
                this.artifactOwners.set(artifact.artifactId, {
                    token: entry.token,
                    artifact,
                });
            }
        }
        entry.evidence = cloneParsed(EnvironmentPhaseEvidenceSchema, {
            runId: this.runId,
            experimentId: entry.token.experimentId,
            phase: entry.token.phase,
            proof: entry.lease.adapterProof,
            completion: parsed,
        });
        return structuredClone(entry.evidence);
    }

    /**
     * Record final adapter-only state and fully awaited cleanup receipts.
     *
     * @param input - Final state plus drain and cleanup receipts.
     */
    recordCleanup(input: FinalEnvironmentCleanupInput): void {
        this.ensureWritable();
        if (!this.adapterState) {
            throw new Error('Adapter is not registered.');
        }
        if (this.cleanupInput) {
            throw new Error('Cleanup is already recorded.');
        }
        const parsedState = cloneParsed(FilteringEnvironmentAdapterStateSchema, input.adapterState);
        const parsedDrain = cloneParsed(EnvironmentHandleDrainReceiptSchema, input.drain);
        const parsedCleanup = cloneParsed(EnvironmentCleanupReceiptSchema, input.cleanup);
        if (
            parsedState.kind !== this.adapterState.kind ||
            parsedState.stateDigest !== this.adapterState.stateDigest ||
            JSON.stringify(parsedState.cleanup) !== JSON.stringify(parsedCleanup) ||
            (parsedCleanup.completed &&
                (parsedState.lifecycle !== 'cleaned' || parsedState.openLeaseIds.length > 0)) ||
            (!parsedCleanup.completed && parsedState.lifecycle !== 'cleanup_failed')
        ) {
            throw new Error('Final adapter snapshot does not match its cleanup receipt.');
        }
        this.cleanupInput = {
            adapterState: parsedState,
            drain: parsedDrain,
            cleanup: parsedCleanup,
        };
    }

    /**
     * Emit the only canonical execution snapshot after cleanup.
     *
     * @param disposition - Provisional investigation result adjusted for cleanup precedence.
     * @returns Complete post-cleanup execution.
     */
    finalize(disposition: ProvisionalEnvironmentDisposition): FilteringEnvironmentExecution {
        this.ensureWritable();
        if (!this.adapterState) {
            throw new Error('Adapter is not registered.');
        }
        if (!this.cleanupInput) {
            throw new Error('Environment cleanup must complete before finalize.');
        }
        const unsettled = [...this.ledger.values()].filter(
            (entry) => entry.lease !== null && entry.evidence === null,
        );
        if (unsettled.length > 0) {
            const detail = unsettled
                .map((entry) => `${entry.token.phase}(${entry.token.experimentId})`)
                .join(', ');
            throw new Error(`Every bound phase must be completed. Unsettled: ${detail}.`);
        }
        const investigationDisposition = cloneParsed(
            ProvisionalEnvironmentDispositionSchema,
            disposition,
        );
        const cleanupFailed =
            !this.cleanupInput.cleanup.completed || this.cleanupInput.drain.failed > 0;
        const cleanupFailure = {
            code: EnvironmentAdapterLimitationCode.CleanupFailed,
            stage: EnvironmentLimitationStage.Cleanup,
            detail: 'The filtering environment did not clean up completely.',
        };
        const finalDisposition = cleanupFailed
            ? { status: 'failed' as const, candidateDigest: null, failure: cleanupFailure }
            : investigationDisposition;
        let secondaryFailures = uniqueFailures([]);
        if (cleanupFailed) {
            secondaryFailures = uniqueFailures([
                investigationDisposition.failure,
                ...this.cleanupInput.drain.failures,
                ...this.cleanupInput.cleanup.failures,
            ]);
        }
        const phases = [...this.ledger.values()]
            .map((entry) => entry.evidence)
            .filter((evidence): evidence is EnvironmentPhaseEvidence => evidence !== null);
        const rejectedCandidates = phases.flatMap((phase) =>
            phase.completion.kind === 'observed' ? phase.completion.rejectedCandidates : [],
        );
        const execution = cloneParsed(FilteringEnvironmentExecutionSchema, {
            recorderVersion: 1,
            runId: this.runId,
            kind: this.adapterState.kind,
            actualContext: this.adapterState.actualContext,
            capabilities: this.adapterState.capabilities,
            preparation: this.adapterState.preparation,
            baseline: this.adapterState.baseline,
            phases,
            rejectedCandidates,
            drain: this.cleanupInput.drain,
            cleanup: this.cleanupInput.cleanup,
            investigationDisposition,
            secondaryFailures,
            disposition: finalDisposition,
        });
        this.finalized = true;
        return structuredClone(execution);
    }

    /**
     * Reject any write after finalization.
     */
    private ensureWritable(): void {
        if (this.finalized) {
            throw new Error('Environment execution is already finalized.');
        }
    }

    /**
     * Validate every artifact and inline reference before assigning phase ownership.
     *
     * @param entry - Recorder ledger entry owning the completion.
     * @param completion - Parsed observed completion.
     * @returns Unique artifacts ready to enter the global ownership index.
     */
    private validateObservedArtifacts(
        entry: PhaseLedgerEntry,
        completion: ValidatorObservedPhaseCompletion,
    ): Map<string, EnvironmentArtifactReference> {
        const local = new Map<string, EnvironmentArtifactReference>();
        for (const artifact of completion.artifacts) {
            if (local.has(artifact.artifactId) || this.artifactOwners.has(artifact.artifactId)) {
                throw new Error(
                    'A phase artifact identity is duplicate or owned by another phase.',
                );
            }
            local.set(artifact.artifactId, artifact);
        }
        if (completion.vision) {
            this.requireArtifact(entry, local, completion.vision.artifactId, 'vision', [
                entry.token.phase,
            ]);
        }
        const capturedIds = new Set<string>();
        for (const capture of completion.captures ?? []) {
            if (
                capture.tileArtifactIds.length !== capture.tiles.length ||
                (capture.viewportArtifactId === null) !== (capture.viewport === null) ||
                (capture.fullPageOverviewArtifactId === null) !==
                    (capture.fullPageOverview === null)
            ) {
                throw new Error('Browser capture artifact references are incomplete.');
            }
            const references: [id: string, path: string][] = [];
            if (capture.viewportArtifactId && capture.viewport) {
                references.push([capture.viewportArtifactId, capture.viewport]);
            }
            if (capture.fullPageOverviewArtifactId && capture.fullPageOverview) {
                references.push([capture.fullPageOverviewArtifactId, capture.fullPageOverview]);
            }
            references.push(
                ...capture.tileArtifactIds.map((artifactId, index): [string, string] => [
                    artifactId,
                    capture.tiles[index]!,
                ]),
            );
            for (const [artifactId, path] of references) {
                if (capturedIds.has(artifactId)) {
                    throw new Error('Browser capture repeats an artifact identity.');
                }
                capturedIds.add(artifactId);
                this.requireArtifact(
                    entry,
                    local,
                    artifactId,
                    'screenshot',
                    [entry.token.phase],
                    path,
                );
            }
        }
        for (const rejected of completion.rejectedCandidates) {
            if (
                rejected.experimentId !== entry.token.experimentId ||
                rejected.phase !== entry.token.phase
            ) {
                throw new Error('Rejected candidate names another phase boundary.');
            }
        }
        this.validateCandidateArtifacts(entry, local, completion);
        return local;
    }

    /**
     * Validate candidate and visual-review references against their exact B/C artifact owners.
     *
     * @param entry - Current phase ledger entry.
     * @param local - Artifacts introduced by the current completion.
     * @param completion - Parsed observed phase completion.
     */
    private validateCandidateArtifacts(
        entry: PhaseLedgerEntry,
        local: Map<string, EnvironmentArtifactReference>,
        completion: ValidatorObservedPhaseCompletion,
    ): void {
        const candidate = completion.candidateValidation;
        if (!candidate) {
            if (completion.visualReview) {
                throw new Error('Visual review lacks a candidate artifact binding.');
            }
            return;
        }
        if (entry.token.phase !== PhaseLabel.C) {
            throw new Error('Candidate validation belongs only to phase C.');
        }
        const references = [
            candidate.validationArtifact,
            candidate.visualReviewArtifact,
            candidate.beforeViewport,
            candidate.afterViewport,
            candidate.beforeFullPage,
            candidate.afterFullPage,
        ];
        if (references.some((reference) => reference === undefined)) {
            throw new Error('Candidate validation artifact references are incomplete.');
        }
        const [
            validationArtifact,
            visualReviewArtifact,
            beforeViewport,
            afterViewport,
            beforeFullPage,
            afterFullPage,
        ] = references as EnvironmentArtifactReference[];
        if (
            candidate.validationArtifactId !== validationArtifact.artifactId ||
            JSON.stringify(candidate.screenshotArtifactIds) !==
                JSON.stringify([
                    beforeViewport.artifactId,
                    afterViewport.artifactId,
                    beforeFullPage.artifactId,
                    afterFullPage.artifactId,
                ]) ||
            new Set(candidate.screenshotArtifactIds).size !== candidate.screenshotArtifactIds.length
        ) {
            throw new Error('Candidate validation artifact identities do not agree.');
        }
        this.requireExactArtifact(entry, local, validationArtifact, 'validation', ['C']);
        this.requireExactArtifact(entry, local, visualReviewArtifact, 'vision', ['C']);
        this.requireExactArtifact(entry, local, beforeViewport, 'screenshot', ['B']);
        this.requireExactArtifact(entry, local, afterViewport, 'screenshot', ['C']);
        this.requireExactArtifact(entry, local, beforeFullPage, 'screenshot', ['B']);
        this.requireExactArtifact(entry, local, afterFullPage, 'screenshot', ['C']);
        const review = completion.visualReview;
        if (!review) {
            throw new Error('Candidate validation lacks its visual review.');
        }
        if (
            review.validationArtifactId !== validationArtifact.artifactId ||
            review.candidateRuleHash !== candidate.candidateDigest ||
            review.beforeViewportArtifactId !== beforeViewport.artifactId ||
            review.afterViewportArtifactId !== afterViewport.artifactId ||
            review.beforeFullPageArtifactId !== beforeFullPage.artifactId ||
            review.afterFullPageArtifactId !== afterFullPage.artifactId
        ) {
            throw new Error('Candidate visual review does not match its exact artifact pairing.');
        }
        for (const instance of review.beforeInstances) {
            this.requireArtifact(entry, local, instance.artifactId, 'screenshot', ['B']);
        }
        for (const instance of review.remainingInstances) {
            this.requireArtifact(entry, local, instance.artifactId, 'screenshot', ['C']);
        }
        if (review.fullPageOverviewEvidence) {
            this.validateOverviewArtifacts(
                entry,
                local,
                review.fullPageOverviewEvidence.before,
                'B',
            );
            this.validateOverviewArtifacts(
                entry,
                local,
                review.fullPageOverviewEvidence.after,
                'C',
            );
        }
        for (const reconciliation of review.inventoryReconciliation?.before ?? []) {
            this.requireArtifact(entry, local, reconciliation.instance.artifactId, 'screenshot', [
                'B',
            ]);
        }
        for (const reconciliation of review.inventoryReconciliation?.after ?? []) {
            this.requireArtifact(entry, local, reconciliation.instance.artifactId, 'screenshot', [
                'C',
            ]);
        }
    }

    /**
     * Validate full-page original and optional vision identities for one review side.
     *
     * @param entry - Current phase ledger entry.
     * @param local - Current completion artifacts.
     * @param evidence - Full-page review provenance.
     * @param phase - Exact phase allowed to own the referenced image.
     */
    private validateOverviewArtifacts(
        entry: PhaseLedgerEntry,
        local: Map<string, EnvironmentArtifactReference>,
        evidence: NonNullable<
            NonNullable<
                ValidatorObservedPhaseCompletion['visualReview']
            >['fullPageOverviewEvidence']
        >['before'],
        phase: typeof PhaseLabel.B | typeof PhaseLabel.C,
    ): void {
        this.requireArtifact(entry, local, evidence.originalArtifactId, 'screenshot', [phase]);
        if (evidence.visionArtifactId) {
            this.requireArtifact(entry, local, evidence.visionArtifactId, 'screenshot', [phase]);
        }
    }

    /**
     * Require an inline artifact object to equal the canonical owned reference exactly.
     *
     * @param entry - Current phase ledger entry.
     * @param local - Current completion artifacts.
     * @param reference - Inline reference to validate.
     * @param kind - Required artifact kind.
     * @param phases - Allowed owning phases in this experiment.
     */
    private requireExactArtifact(
        entry: PhaseLedgerEntry,
        local: Map<string, EnvironmentArtifactReference>,
        reference: EnvironmentArtifactReference,
        kind: EnvironmentArtifactReference['kind'],
        phases: readonly EnvironmentPhaseToken['phase'][],
    ): void {
        const artifact = this.requireArtifact(entry, local, reference.artifactId, kind, phases);
        if (JSON.stringify(artifact) !== JSON.stringify(reference)) {
            throw new Error('Inline artifact reference differs from its canonical owner.');
        }
    }

    /**
     * Resolve one artifact and require exact experiment, phase, kind, and optional path ownership.
     *
     * @param entry - Current phase ledger entry.
     * @param local - Current completion artifacts.
     * @param artifactId - Inline artifact identity.
     * @param kind - Required artifact kind.
     * @param phases - Allowed owning phases in this experiment.
     * @param path - Optional exact path carried by a browser capture.
     * @returns Canonical owned artifact.
     */
    private requireArtifact(
        entry: PhaseLedgerEntry,
        local: Map<string, EnvironmentArtifactReference>,
        artifactId: string,
        kind: EnvironmentArtifactReference['kind'],
        phases: readonly EnvironmentPhaseToken['phase'][],
        path?: string,
    ): EnvironmentArtifactReference {
        const localArtifact = local.get(artifactId);
        const owner = localArtifact
            ? { token: entry.token, artifact: localArtifact }
            : this.artifactOwners.get(artifactId);
        if (
            !owner ||
            owner.token.experimentId !== entry.token.experimentId ||
            !phases.includes(owner.token.phase) ||
            owner.artifact.kind !== kind ||
            (path !== undefined && owner.artifact.path !== path)
        ) {
            throw new Error('Inline artifact reference is unowned or crosses its phase boundary.');
        }
        return owner.artifact;
    }

    /**
     * Resolve an exact recorder-issued token and reject forged boundaries.
     *
     * @param token - Token supplied by the orchestrator.
     * @returns Mutable internal ledger entry.
     */
    private requireEntry(token: EnvironmentPhaseToken): PhaseLedgerEntry {
        const entry = this.ledger.get(token.tokenId);
        if (!entry || entry.token !== token) {
            throw new Error('Unknown or foreign phase token.');
        }
        return entry;
    }
}
