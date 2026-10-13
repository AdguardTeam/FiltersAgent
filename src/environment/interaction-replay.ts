import type { IBrowserSession } from '../browser/browser-interfaces';
import {
    persistSafeInteractionRecord,
    runSafeInteractionSequence,
} from '../browser/safe-interaction-runner';
import { createLogger } from '../logger/logger';
import type { TraceRecorder } from '../tracer/trace-recorder';
import { PhaseLabel } from '../types/validation';
import type { EnvironmentPhase } from './environment-proofs';
import type { EnvironmentArtifactReference } from './filtering-environment';
import {
    compareSafeInteractionRecords,
    SafeInteractionRecordStatus,
    type NormalizedSafeInteractionPlan,
    type SafeInteractionComparison,
    type SafeInteractionRecord,
    type SafeInteractionRefusalReason,
} from './safe-interaction';

/**
 * Everything the host needs to replay the model's reveal steps across every phase.
 */
export interface InteractionReplayOptions {
    /**
     * Exact normalized plan every phase replays, accepted once before the experiment started.
     */
    plan: NormalizedSafeInteractionPlan;

    /**
     * Canonical origin of the reported site.
     */
    allowedOrigin: string;

    /**
     * Directory containing all phase artifacts.
     */
    artifactsDir: string;

    /**
     * Trace and artifact owner shared with the fix runtime.
     */
    recorder: TraceRecorder;
}

/**
 * What one phase's replay did, as the reasoning model reads it.
 */
export interface InteractionReplayPhaseSummary {
    /**
     * Finite terminal status of the sequence in this phase.
     */
    status: SafeInteractionRecordStatus;

    /**
     * Category of the refusal that stopped the sequence, else null.
     */
    refusalReason: SafeInteractionRefusalReason | null;

    /**
     * Number of steps the phase attempted.
     */
    executedSteps: number;

    /**
     * Number of pages the site opened during the sequence.
     */
    popupsOpened: number;
}

/**
 * Per-phase view of one replayed reveal sequence, as the reasoning model reads it.
 */
export interface InteractionReplayProjection {
    /**
     * Digest of the plan every phase executed.
     */
    planDigest: string;

    /**
     * Summary of the sequence each phase performed, by phase label.
     */
    phases: Partial<Record<EnvironmentPhase, InteractionReplayPhaseSummary>>;

    /**
     * Whether the candidate phase prepared the page exactly as the baseline phase did.
     */
    identical: boolean;

    /**
     * Every finite preparation difference between the baseline and candidate phases.
     */
    differences: SafeInteractionComparison['differences'];
}

/**
 * Project one record into the summary a phase reports.
 *
 * @param record - Complete record of one phase's sequence.
 * @returns Compact summary of that sequence.
 */
function summarize(record: SafeInteractionRecord): InteractionReplayPhaseSummary {
    return {
        status: record.status,
        refusalReason: record.refusal?.reason ?? null,
        executedSteps: record.steps.length,
        popupsOpened: record.popupsOpened,
    };
}

/**
 * Name every phase whose replay never reached the state the symptom needs.
 *
 * When the reveal steps did not complete, an experiment that saw no symptom is explained by the
 * untouched page rather than by a wrong symptom description, and telling the model to restate the
 * description would send it to fix the one thing that is not broken.
 *
 * @param projection - Per-phase replay projection, or null when no steps were passed.
 * @returns Guidance lines naming each incomplete phase, empty when every phase performed the plan.
 */
export function revealStepsRepairGuidance(
    projection: InteractionReplayProjection | null,
): string[] {
    return Object.entries(projection?.phases ?? {})
        .filter(([, summary]) => summary.status !== SafeInteractionRecordStatus.Completed)
        .map(
            ([phase, summary]) =>
                `The revealSteps did not complete in phase ${phase} ` +
                `(${summary.status}${summary.refusalReason ? `: ${summary.refusalReason}` : ''}), ` +
                'so that phase never reached the state the symptom needs. Rehearse the sequence ' +
                'with interact_page and pass the corrected revealSteps to apply_rule before ' +
                'restating the symptom description.',
        );
}

/**
 * Replay the model's reveal steps identically in every phase of a candidate experiment.
 *
 * The plan is accepted once, before any phase runs, and this coordinator is the only thing that
 * executes it. Improvising per phase would compare pages prepared differently, which proves nothing
 * about the candidate; the shared plan digest recorded with every phase is what makes the
 * comparison auditable afterwards.
 */
export class InteractionReplay {
    private readonly records = new Map<EnvironmentPhase, SafeInteractionRecord>();

    private readonly artifacts = new Map<EnvironmentPhase, EnvironmentArtifactReference>();

    /**
     * @param options - Accepted plan, reported origin, and artifact sink.
     */
    constructor(private readonly options: InteractionReplayOptions) {}

    /**
     * Build the callback one phase invokes after its rules are applied and before it captures.
     *
     * @param phase - Phase about to be prepared.
     * @param session - Browser session the adapter established for that phase.
     * @param artifactIdSuffix - Recorder-token-derived physical execution identity.
     * @returns Callback that performs the plan and retains its evidence.
     */
    replayFor(
        phase: EnvironmentPhase,
        session: IBrowserSession,
        artifactIdSuffix: string,
    ): () => Promise<void> {
        return async () => {
            let record: SafeInteractionRecord;
            try {
                record = await runSafeInteractionSequence({
                    session,
                    plan: this.options.plan,
                    allowedOrigin: this.options.allowedOrigin,
                });
            } catch (error) {
                // The phase itself must survive: a page that died mid-interaction still has
                // captures worth comparing, and a sequence that could not run is exactly the
                // divergence the candidate verdict is withheld for. Aborting here would replace
                // that evidence with an apply_rule failure that blames the tooling instead.
                createLogger().error(
                    { err: error, phase, planDigest: this.options.plan.digest },
                    'reveal steps could not run in this phase',
                );
                record = unperformedRecord(this.options.plan.digest);
            }
            this.records.set(phase, record);
            // Phase C is judged against the repository baseline it adds the candidate to, so its
            // record carries that comparison; A and B stand on their own.
            const baseline =
                phase === PhaseLabel.C ? (this.records.get(PhaseLabel.B) ?? null) : null;
            try {
                this.artifacts.set(
                    phase,
                    persistSafeInteractionRecord({
                        record,
                        baseline,
                        // The publication boundary re-sanitizes every artifact against the real
                        // Host secret list; the runtime never holds one.
                        configuredSecrets: [],
                        artifactsDir: this.options.artifactsDir,
                        recorder: this.options.recorder,
                        artifactIdSuffix: `reveal-${phase}-${artifactIdSuffix}`,
                    }),
                );
            } catch (error) {
                // Losing the retained copy costs a post-mortem, not the comparison: the record the
                // phases are judged on is already held in memory.
                createLogger().error(
                    { err: error, phase, artifactIdSuffix },
                    'reveal steps record could not be retained',
                );
            }
        };
    }

    /**
     * Read the retained evidence reference for one phase.
     *
     * @param phase - Phase whose interaction artifact is wanted.
     * @returns Canonical artifact reference, or undefined when that phase never interacted.
     */
    artifactOf(phase: EnvironmentPhase): EnvironmentArtifactReference | undefined {
        return this.artifacts.get(phase);
    }

    /**
     * Decide whether the baseline and candidate phases reached the same prepared page.
     *
     * Both must have performed every step, and the candidate's sequence must match the baseline's
     * step for step. Otherwise whatever the captures show is explained by the different preparation
     * rather than by the candidate.
     *
     * @returns Whether a candidate verdict may rest on these two phases.
     */
    preparedAlike(): boolean {
        const projection = this.projection();
        if (projection === null) {
            return true;
        }
        return (
            projection.identical &&
            projection.phases[PhaseLabel.B]?.status === SafeInteractionRecordStatus.Completed &&
            projection.phases[PhaseLabel.C]?.status === SafeInteractionRecordStatus.Completed
        );
    }

    /**
     * Project every phase summary and the baseline-to-candidate comparison for the model.
     *
     * @returns Complete projection, or null when no phase replayed the plan.
     */
    projection(): InteractionReplayProjection | null {
        if (this.records.size === 0) {
            return null;
        }
        const phases: InteractionReplayProjection['phases'] = {};
        for (const [phase, record] of this.records) {
            phases[phase] = summarize(record);
        }
        const baseline = this.records.get(PhaseLabel.B);
        const candidate = this.records.get(PhaseLabel.C);
        const comparison =
            baseline && candidate ? compareSafeInteractionRecords(baseline, candidate) : null;
        return {
            planDigest: this.options.plan.digest,
            phases,
            identical: comparison?.identical ?? true,
            differences: comparison?.differences ?? [],
        };
    }
}

/**
 * Build the record standing for a replay that could not run at all in one phase.
 *
 * A failed status with no steps is the honest reading: the plan was never performed, so the phase
 * diverges from any phase that did perform it.
 *
 * @param planDigest - Digest of the plan that was to be replayed.
 * @returns Record naming the failure without inventing a policy reason for it.
 */
function unperformedRecord(planDigest: string): SafeInteractionRecord {
    return {
        planDigest,
        steps: [],
        status: SafeInteractionRecordStatus.Failed,
        refusal: null,
        elapsedMs: 0,
        popupsOpened: 0,
        popups: [],
        dialogs: [],
    };
}
