/**
 * The outer environment finalization: the drain-and-cleanup gate every canonical execution result
 * passes through before it may escape a run. Split from the agent runtime so the adapter teardown
 * contract and the runtime's candidate loop live beside, not inside, one another.
 */
import type {
    EnvironmentCleanupReceipt,
    EnvironmentHandleDrainReceipt,
    FilteringEnvironmentAdapter,
    FilteringEnvironmentExecution,
    FinalEnvironmentCleanupInput,
    ProvisionalEnvironmentDisposition,
} from '../environment/filtering-environment';
import {
    EnvironmentAdapterLimitationCode,
    EnvironmentLimitationStage,
} from '../environment/filtering-environment';

/**
 * Recorder surface owned by the outer environment lifecycle.
 */
export interface FilteringEnvironmentLifecycleRecorder {
    /**
     * Record final adapter state and completed cleanup receipts.
     *
     * @param input - Final adapter-only cleanup input.
     */
    recordCleanup(input: FinalEnvironmentCleanupInput): void;

    /**
     * Emit the only canonical execution snapshot.
     *
     * @param disposition - Provisional product result after investigation.
     * @returns Complete post-cleanup execution evidence.
     */
    finalize(disposition: ProvisionalEnvironmentDisposition): FilteringEnvironmentExecution;
}

/**
 * Drain and clean one filtering adapter before allowing its execution result to escape.
 *
 * @param adapter - Selected filtering environment adapter.
 * @param recorder - Sole canonical execution recorder.
 * @param disposition - Provisional investigation result.
 * @returns Complete post-cleanup canonical execution.
 */
export async function finalizeFilteringEnvironmentExecution(
    adapter: FilteringEnvironmentAdapter,
    recorder: FilteringEnvironmentLifecycleRecorder,
    disposition: ProvisionalEnvironmentDisposition,
): Promise<FilteringEnvironmentExecution> {
    let drain: EnvironmentHandleDrainReceipt;
    try {
        drain = await adapter.drainOpenHandles();
    } catch {
        drain = {
            attempted: 1,
            closed: 0,
            failed: 1,
            failures: [
                {
                    code: EnvironmentAdapterLimitationCode.CleanupFailed,
                    stage: EnvironmentLimitationStage.Cleanup,
                    detail: 'The environment handle registry could not be drained.',
                },
            ],
        };
    }
    let cleanup: EnvironmentCleanupReceipt;
    try {
        cleanup = await adapter.cleanup();
    } catch {
        cleanup = {
            attempted: true,
            completed: false,
            finalizerAttempts: 1,
            finalizerCompleted: 0,
            finalizerFailed: 1,
            failures: [
                {
                    code: EnvironmentAdapterLimitationCode.CleanupFailed,
                    stage: EnvironmentLimitationStage.Cleanup,
                    detail: 'The environment adapter cleanup did not complete.',
                },
            ],
        };
    }
    const adapterState = adapter.snapshot();
    recorder.recordCleanup({ adapterState, drain, cleanup });
    return recorder.finalize(disposition);
}
