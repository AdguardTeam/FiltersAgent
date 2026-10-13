/**
 * The bookkeeping every filtering environment adapter does around its open phase sessions.
 *
 * An adapter's own work is deciding what a phase means and proving it; retaining the sessions it
 * opened, replacing one that an application relaunched under the same lease identity, and emitting
 * the bounded drain and cleanup receipts the run record carries is the same work in every family.
 * It lives here so a new family's adapter is its proof logic and nothing else.
 */
import type { IBrowserSession } from '../browser/browser-interfaces';
import {
    EnvironmentAdapterLimitationCode,
    EnvironmentLifecycle,
    EnvironmentLimitationStage,
    type EnvironmentAdapterLimitation,
    type EnvironmentCleanupReceipt,
    type EnvironmentHandleDrainReceipt,
} from './filtering-environment';

/**
 * Maximum characters one public limitation detail carries, matching `PublicDetailSchema`.
 */
const PUBLIC_DETAIL_MAX_LENGTH = 500;

/**
 * Build one bounded stable public adapter limitation.
 *
 * @param code - Stable public failure category.
 * @param stage - Stable lifecycle stage the failure was raised at.
 * @param detail - Public detail, truncated to the durable bound.
 * @returns Schema-compatible public limitation.
 */
export function adapterLimitation(
    code: EnvironmentAdapterLimitation['code'],
    stage: EnvironmentAdapterLimitation['stage'],
    detail: string,
): EnvironmentAdapterLimitation {
    return { code, stage, detail: detail.slice(0, PUBLIC_DETAIL_MAX_LENGTH) };
}

/**
 * One open phase resource retained until a successful close.
 */
interface OpenPhaseLease {
    /**
     * Exact lease identity the adapter proof is bound to.
     */
    leaseId: string;

    /**
     * The browser session this lease closes.
     */
    session: IBrowserSession;
}

/**
 * The open phase sessions one adapter instance owns, with its drain and cleanup receipts.
 */
export class PhaseLeaseRegistry {
    /**
     * Every opened session retained under its lease identity until a successful close.
     */
    private readonly leases = new Map<string, OpenPhaseLease>();

    /**
     * Final idempotent cleanup receipt, once cleanup has run.
     */
    private receipt: EnvironmentCleanupReceipt | null = null;

    /**
     * Retain one session under a lease identity, replacing whatever that identity held.
     *
     * A between-phases application that had to relaunch the browser hands back the session that is
     * live now; it replaces the established one under the same identity, so the proof, the
     * validators and this registry all speak of one lease.
     *
     * @param leaseId - Lease identity the phase proof is bound to.
     * @param session - The session that is live now.
     */
    retain(leaseId: string, session: IBrowserSession): void {
        this.leases.set(leaseId, { leaseId, session });
    }

    /**
     * Close one lease's session, if it is still open.
     *
     * @param leaseId - Lease identity to close.
     * @returns Nothing once the session is closed and the lease dropped.
     */
    async close(leaseId: string): Promise<void> {
        const lease = this.leases.get(leaseId);
        if (!lease) {
            return;
        }
        await lease.session.close();
        this.leases.delete(leaseId);
    }

    /**
     * Lease identities still open, in retention order.
     *
     * @returns Fresh list of open lease identities.
     */
    openLeaseIds(): string[] {
        return [...this.leases.keys()];
    }

    /**
     * Whether every retained session has been closed.
     *
     * @returns True when no lease is open.
     */
    get drained(): boolean {
        return this.leases.size === 0;
    }

    /**
     * The cleanup receipt this registry already produced, when cleanup has run.
     *
     * @returns A fresh copy of the receipt, or null when cleanup has not run.
     */
    cleanupReceipt(): EnvironmentCleanupReceipt | null {
        return this.receipt === null ? null : structuredClone(this.receipt);
    }

    /**
     * Close every retained session, continuing after individual failures.
     *
     * @returns Complete bounded drain receipt.
     */
    async drain(): Promise<EnvironmentHandleDrainReceipt> {
        let closed = 0;
        let failed = 0;
        const failures: EnvironmentAdapterLimitation[] = [];
        const leases = [...this.leases.values()];
        for (const lease of leases) {
            try {
                await lease.session.close();
                this.leases.delete(lease.leaseId);
                closed += 1;
            } catch {
                failed += 1;
                failures.push(
                    adapterLimitation(
                        EnvironmentAdapterLimitationCode.CleanupFailed,
                        EnvironmentLimitationStage.Cleanup,
                        'A controlled browser session could not be closed.',
                    ),
                );
            }
        }
        return { attempted: leases.length, closed, failed, failures };
    }

    /**
     * Drain the remaining sessions and finish adapter cleanup exactly once.
     *
     * @param finalize - Adapter-specific final cleanup, when the adapter has any.
     * @param finalizeFailureDetail - Public detail recorded when that finalizer does not complete.
     * @returns The idempotent complete cleanup receipt and the lifecycle it implies.
     */
    async cleanup(
        finalize: (() => Promise<void>) | undefined,
        finalizeFailureDetail: string,
    ): Promise<{
        /**
         * The complete cleanup receipt, fresh on every call.
         */
        receipt: EnvironmentCleanupReceipt;

        /**
         * The lifecycle the receipt implies: cleaned, or cleanup-failed.
         */
        lifecycle: typeof EnvironmentLifecycle.Cleaned | typeof EnvironmentLifecycle.CleanupFailed;
    }> {
        if (this.receipt === null) {
            const drain = await this.drain();
            const failures = [...drain.failures];
            let finalizerAttempts = 0;
            let finalizerCompleted = 0;
            let finalizerFailed = 0;
            if (finalize) {
                finalizerAttempts = 1;
                try {
                    await finalize();
                    finalizerCompleted = 1;
                } catch {
                    finalizerFailed = 1;
                    failures.push(
                        adapterLimitation(
                            EnvironmentAdapterLimitationCode.CleanupFailed,
                            EnvironmentLimitationStage.Cleanup,
                            finalizeFailureDetail,
                        ),
                    );
                }
            }
            this.receipt = {
                attempted: true,
                completed: failures.length === 0 && this.drained,
                finalizerAttempts,
                finalizerCompleted,
                finalizerFailed,
                failures,
            };
        }
        return {
            receipt: structuredClone(this.receipt),
            lifecycle: this.receipt.completed
                ? EnvironmentLifecycle.Cleaned
                : EnvironmentLifecycle.CleanupFailed,
        };
    }
}
