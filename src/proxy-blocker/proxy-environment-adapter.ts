import { createHash } from 'node:crypto';
import type { IBrowserSession } from '../browser/browser-interfaces';
import {
    nodeBaselineFileSystem,
    type BaselineFileSystemPort,
} from '../environment/baseline-file-lock';
import {
    CandidateOperation,
    EnvironmentAdapterLimitationCode,
    EnvironmentLimitationStage,
    type AdapterPhaseLease,
    type EnvironmentAdapterLimitation,
    type EnvironmentCandidate,
    type EnvironmentCleanupReceipt,
    type EnvironmentHandleDrainReceipt,
    type EnvironmentPhaseOpenResult,
    type EnvironmentPhaseRequest,
    type EnvironmentPreparationRequest,
    type EnvironmentPreparationResult,
    type FilteringEnvironmentAdapter,
    type FilteringEnvironmentAdapterState,
} from '../environment/filtering-environment';
import { EnvironmentLifecycle } from '../environment/environment-lifecycle';
import {
    EnvironmentFilteringState,
    type CliAdapterProof,
    type EnvironmentPhase,
    type PublishedBaselineProvenance,
} from '../environment/environment-proofs';
import { EnvironmentCapability } from '../environment/environment-vocabulary';
import {
    adguardListKey,
    parseAdguardListKey,
    requestedListsToRegistryIds,
    resolveAdguardListKey,
} from '../environment/filter-list-ref';
import {
    BaselineHostAction,
    type BaselineEditOutcome,
    type BaselineEditReceipt,
    type CandidateReceipt,
} from '../local/evidence-route-contract';
import type { ExecutorName } from '../environment/executor-name';
import { readProxyBlockerFilterList, type ProxyBlockerCatalogRow } from './catalog-table';
import {
    describeDiagnosticError,
    recordPreflightDiagnostic,
} from '../local/preflight-diagnostic-log';
import {
    prepareProxyBlockerPublishedBaseline,
    type ProxyBlockerBaselineHostPort,
} from './published-baseline';
import { BrowserDisplayName } from '../types/browser-display-name';
import { PhaseLabel } from '../types/validation';
import {
    CliPhaseRejection,
    PHASE_LIMITATIONS,
    PhaseRejectionError,
    reject,
} from './cli-phase-rejection';

/**
 * Compare two ascending catalog identity sets.
 *
 * @param left - First identity list.
 * @param right - Second identity list.
 * @returns Whether both lists hold the same members in the same order.
 */
function sameIds(left: readonly number[], right: readonly number[]): boolean {
    return left.length === right.length && left.every((id, index) => id === right[index]);
}

/**
 * Everything one phase observed, kept for the local diagnostic record.
 */
interface CliPhaseObservation {
    /**
     * Exact phase the adapter was asked to establish.
     */
    phase: EnvironmentPhase;

    /**
     * Official IDs the Host requested for the locked baseline.
     */
    requestedFilterIds: readonly number[];

    /**
     * Official subset this phase was asked to enable, or null when it asked for the whole baseline.
     */
    targetFilterIds: readonly number[] | null;

    /**
     * Catalog rows displayed after this phase's filter commands ran.
     */
    rows: readonly ProxyBlockerCatalogRow[] | null;

    /**
     * Catalog IDs displayed as enabled after those commands.
     */
    enabledCatalogIds: readonly number[] | null;

    /**
     * Enabled catalog IDs the Host never requested, in this phase.
     */
    coenabledFilterIds: readonly number[] | null;

    /**
     * Enabled catalog IDs the Host never requested, as the control phase recorded them.
     */
    controlCoenabledFilterIds: readonly number[] | null;

    /**
     * Official filtering state the published baseline phase proved, when it had opened.
     */
    baselinePhaseState: CliPhaseFilteringState | null;

    /**
     * Receipt the isolated installation returned for the applied candidate, when one was applied.
     */
    candidateReceipt: ProxyBlockerCandidateReceipt | null;

    /**
     * Receipt the isolated installation returned for a replaced published line, when one was made.
     */
    baselineEditReceipt: ProxyBlockerBaselineEditReceipt | null;
}

/**
 * Filtering state read off one complete native catalog listing.
 */
interface CliCatalogState {
    /**
     * Every readable catalog row, in displayed order.
     */
    rows: readonly ProxyBlockerCatalogRow[];

    /**
     * Enabled catalog IDs, ascending, without the built-in user pseudo-row.
     */
    enabledCatalogIds: number[];

    /**
     * Whether the built-in user-rules pseudo-row is enabled.
     */
    userFilterEnabled: boolean;
}

/**
 * One open phase resource retained until a successful close.
 */
interface OpenCliLease {
    /**
     * Exact lease identity.
     */
    leaseId: string;

    /**
     * Common browser session to close.
     */
    session: IBrowserSession;
}

/**
 * Request for one controlled browser session bound to an established phase.
 */
export interface ProxyBlockerPhaseSessionRequest {
    /**
     * Exact phase the session belongs to.
     */
    phase: EnvironmentPhase;

    /**
     * Canonical target URL used by the controlled browser.
     */
    targetUrl: string;
}

/**
 * Controlled browser session opened for one phase.
 */
export interface ProxyBlockerPhaseSession {
    /**
     * Common browser surface exposed to validators.
     */
    session: IBrowserSession;

    /**
     * Stable session identity bound into the phase proof.
     */
    sessionId: string;
}

/**
 * Receipt proving one exact candidate line is the only agent-authored content the installation
 * executes; the shape lives in the src-owned evidence-route contract.
 */
export type ProxyBlockerCandidateReceipt = CandidateReceipt;

/**
 * Receipt proving one exact published line was replaced or deleted inside the locked baseline and
 * nothing else; the shape lives in the src-owned evidence-route contract.
 */
export type ProxyBlockerBaselineEditReceipt = BaselineEditReceipt;

/**
 * Receipt of a mutated published line, or the refusal to mutate it; the shape lives in the
 * src-owned evidence-route contract.
 */
export type ProxyBlockerBaselineEditOutcome = BaselineEditOutcome;

/**
 * Official filtering state one established phase proved, retained for the next phase to match.
 */
interface CliPhaseFilteringState {
    /**
     * Requested official IDs the phase proved enabled, ascending.
     */
    enabledFilterIds: number[];

    /**
     * Enabled catalog IDs the Host never requested, ascending.
     */
    coenabledFilterIds: number[];

    /**
     * Whether the built-in user-rules pseudo-row was enabled.
     */
    userFilterEnabled: boolean;
}

/**
 * Ports one CLI filtering environment needs beyond the already-prepared installation.
 */
export interface ProxyBlockerEnvironmentOptions {
    /**
     * Executor name the adapter reports as its kind: the blocker module's own.
     */
    executor: ExecutorName;

    /**
     * Exact engine version, reported as the actual product version; null when the executing build
     * does not know one.
     */
    cliVersion: string | null;

    /**
     * Exact executing product label, reported as the actual product. Defaults to the 'AdGuard CLI'
     * label.
     */
    product?: string;

    /**
     * Digest of the verified installation provenance, folded into the adapter state digest.
     */
    installationDigest: string;

    /**
     * Bounded command and storage boundary for the isolated installation.
     */
    baselineHost: ProxyBlockerBaselineHostPort;

    /**
     * Open one browser session already routed through the CLI's loopback proxy.
     *
     * @param request - Exact phase and canonical target URL.
     * @returns Ready session and its stable identity.
     */
    createSession(request: ProxyBlockerPhaseSessionRequest): Promise<ProxyBlockerPhaseSession>;

    /**
     * Install exactly one agent-authored rule beside the locked official baseline and reload.
     *
     * @param rule - Exact single candidate line.
     * @returns Receipt describing what the isolated installation now executes.
     */
    applyCandidate?(rule: string): Promise<ProxyBlockerCandidateReceipt>;

    /**
     * Remove the agent-authored source and reload, leaving only the locked official baseline.
     *
     * @returns Nothing once the installation executes the locked baseline alone.
     */
    revokeCandidate?(): Promise<void>;

    /**
     * Replace one exact line inside the locked published baseline and reload.
     *
     * The implementation must locate the line across the attributed baseline resources, refuse
     * rather than guess when it does not occur exactly once, and leave every other byte untouched.
     *
     * @param originalRule - Exact published line to replace.
     * @param replacementRule - Complete replacement line.
     * @returns Receipt describing what the isolated installation now executes, or the refusal.
     */
    applyBaselineEdit?(
        originalRule: string,
        replacementRule: string,
    ): Promise<ProxyBlockerBaselineEditOutcome>;

    /**
     * Delete one exact published line from the locked baseline and reload.
     *
     * The implementation must locate the line across the attributed baseline resources, refuse
     * rather than guess when it does not occur exactly once, and leave every other byte untouched.
     *
     * @param originalRule - Exact published line to delete.
     * @returns Receipt describing what the isolated installation now executes, or the refusal.
     */
    applyBaselineRemoval?(originalRule: string): Promise<ProxyBlockerBaselineEditOutcome>;

    /**
     * Restore the locked published baseline bytes and reload.
     *
     * @returns SHA-256 of the restored resource, which must equal the digest locked at preparation,
     *   or null when no mutation was in effect.
     */
    revokeBaselineEdit?(): Promise<string | null>;

    /**
     * Optional deterministic clock seam.
     *
     * @returns Current instant as an ISO timestamp.
     */
    now?: () => string;

    /**
     * Optional deterministic lease-identity seam.
     *
     * @param phase - Phase owning the lease.
     * @returns Unique lease identity.
     */
    createLeaseId?: (phase: EnvironmentPhase) => string;

    /**
     * Optional no-follow filesystem boundary used for byte locking.
     */
    fileSystem?: BaselineFileSystemPort;

    /**
     * Optional host-owned finalizer; CLI reset and sandbox removal stay outside the adapter.
     *
     * @returns Nothing after the host-owned finalizer completes.
     */
    finalize?: () => Promise<void>;
}

/**
 * AdGuard CLI implementation of the common filtering environment contract.
 *
 * Phase A differs from phase B by filter enablement only: the CLI keeps intercepting in both, which
 * is what makes the difference between them attributable to the requested filters rather than to
 * the proxy. Phase C differs from phase B by one agent-authored rule installed beside the locked
 * official baseline, and it is refused unless the official catalog state is proven identical to the
 * baseline phase's, so the same attribution holds for the candidate.
 */
export class ProxyBlockerEnvironmentAdapter implements FilteringEnvironmentAdapter {
    readonly kind: ExecutorName;

    /**
     * Adapter-authored context derived from the verified installation and its browser family.
     */
    private readonly actualContext: FilteringEnvironmentAdapterState['actualContext'];

    /**
     * Exact executed baseline locked during preparation.
     */
    private baseline: PublishedBaselineProvenance | null = null;

    /**
     * Official IDs the locked baseline was requested with, ascending.
     */
    private requestedFilterIds: number[] = [];

    /**
     * Enabled catalog IDs the Host never requested, as the control phase observed them.
     */
    private controlCoenabledFilterIds: number[] | null = null;

    /**
     * Official filtering state the published baseline phase proved, or null before it opened.
     */
    private baselinePhaseState: CliPhaseFilteringState | null = null;

    /**
     * Whether an agent-authored candidate source is currently installed.
     */
    private candidateApplied = false;

    /**
     * Whether one line of the locked published baseline is currently replaced.
     */
    private baselineEditApplied = false;

    /**
     * Digest the edited baseline resource must return to, or null before one was proven.
     */
    private baselineEditBeforeSha256: string | null = null;

    /**
     * Preparation proof retained for the adapter snapshot.
     */
    private preparation: FilteringEnvironmentAdapterState['preparation'] = null;

    /**
     * Stable adapter state digest bound into every phase proof.
     */
    private stateDigest: string;

    /**
     * Current lifecycle state.
     */
    private lifecycle: FilteringEnvironmentAdapterState['lifecycle'] =
        EnvironmentLifecycle.Unprepared;

    /**
     * Every opened session retained until a successful close.
     */
    private readonly openLeases = new Map<string, OpenCliLease>();

    /**
     * Final idempotent cleanup receipt.
     */
    private cleanupReceipt: EnvironmentCleanupReceipt | null = null;

    /**
     * Deterministic adapter clock.
     */
    private readonly now: () => string;

    /**
     * Deterministic lease identity factory.
     */
    private readonly createLeaseId: (phase: EnvironmentPhase) => string;

    /**
     * No-follow filesystem boundary used for byte locking.
     */
    private readonly fileSystem: BaselineFileSystemPort;

    /**
     * Create one unprepared adapter over a verified isolated installation.
     *
     * @param options - Verified installation identity, command, browser, and lifecycle seams.
     */
    constructor(private readonly options: ProxyBlockerEnvironmentOptions) {
        this.kind = options.executor;
        this.actualContext = {
            kind: this.kind,
            product: options.product ?? 'AdGuard CLI',
            browser: BrowserDisplayName.CloakBrowserChromium,
            productVersion: options.cliVersion,
        };
        this.now = options.now ?? (() => new Date().toISOString());
        this.createLeaseId =
            options.createLeaseId ??
            ((phase) =>
                `${phase.toLowerCase()}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        this.fileSystem = options.fileSystem ?? nodeBaselineFileSystem;
        this.stateDigest = createHash('sha256')
            .update(
                JSON.stringify({
                    installationDigest: options.installationDigest,
                    actualContext: this.actualContext,
                    baseline: null,
                }),
            )
            .digest('hex');
    }

    /**
     * Return the common capabilities implemented by the CLI adapter.
     *
     * Candidate application is advertised when either complete port pair is present, so a run that
     * cannot apply any candidate says so before it starts instead of failing at the candidate
     * phase. Which of the two kinds a given candidate needs is decided when the phase is opened,
     * because the capability vocabulary is common to every environment and does not name them.
     *
     * @returns Fresh capability list.
     */
    capabilities(): FilteringEnvironmentAdapterState['capabilities'] {
        const capabilities: FilteringEnvironmentAdapterState['capabilities'] = [
            EnvironmentCapability.BrowserNavigation,
            EnvironmentCapability.FilteringControl,
            EnvironmentCapability.CliFiltering,
            EnvironmentCapability.BaselineIntegrity,
            EnvironmentCapability.PhaseProof,
        ];
        if (
            this.candidatePortsPresent() ||
            this.baselineEditPortsPresent() ||
            this.baselineRemovalPortsPresent()
        ) {
            capabilities.push(EnvironmentCapability.CandidateApplication);
        }
        return capabilities;
    }

    /**
     * Apply and integrity-lock the requested official baseline in the isolated installation.
     *
     * @param request - Exact official filter selection.
     * @returns Ready adapter state or a typed limitation.
     */
    async prepare(request: EnvironmentPreparationRequest): Promise<EnvironmentPreparationResult> {
        if (this.lifecycle === EnvironmentLifecycle.Ready) {
            return { ready: true, state: this.snapshot() };
        }
        if (this.cleanupReceipt) {
            return {
                ready: false,
                limitation: {
                    code: EnvironmentAdapterLimitationCode.PhaseOpenFailed,
                    stage: EnvironmentLimitationStage.Preparation,
                    detail: 'The AdGuard CLI environment has already been cleaned up.',
                },
            };
        }
        const resolvedRequestedIds = requestedListsToRegistryIds(request.requestedLists);
        if (resolvedRequestedIds === null) {
            // Preparation derives the baseline manifest from the requested lists, so an
            // unresolvable requested key is a preparation-stage manifest-validation failure —
            // the same fail-closed contract the Extension adapter applies.
            const unresolvable = request.requestedLists.find(
                (ref) => resolveAdguardListKey(ref.key) === null,
            );
            this.lifecycle = EnvironmentLifecycle.Limited;
            return {
                ready: false,
                limitation: {
                    code: EnvironmentAdapterLimitationCode.BaselineManifestInvalid,
                    stage: EnvironmentLimitationStage.Preparation,
                    detail:
                        `The requested filter list ${unresolvable?.key ?? 'key'} does not resolve ` +
                        'to an official AdGuard list.',
                },
            };
        }
        // oxlint-disable-next-line unicorn/no-array-sort -- ES2023 toSorted is outside this target.
        const requestedFilterIds = [...resolvedRequestedIds].sort((left, right) => left - right);
        const prepared = await prepareProxyBlockerPublishedBaseline(
            { environment: this.kind, requestedFilterIds, acquiredAt: this.now() },
            this.options.baselineHost,
            this.fileSystem,
        );
        if (!prepared.ready) {
            this.lifecycle = EnvironmentLifecycle.Limited;
            return prepared;
        }
        this.requestedFilterIds = requestedFilterIds;
        this.baseline = prepared.baseline;
        this.preparation = {
            preparedAt: this.now(),
            buildDigest: this.options.installationDigest,
            extensionRootDigest: null,
        };
        this.stateDigest = createHash('sha256')
            .update(
                JSON.stringify({
                    installationDigest: this.options.installationDigest,
                    actualContext: this.actualContext,
                    baseline: prepared.baseline,
                }),
            )
            .digest('hex');
        this.lifecycle = EnvironmentLifecycle.Ready;
        return { ready: true, state: this.snapshot() };
    }

    /**
     * Establish the filtering-disabled control or the locked published baseline.
     *
     * @param request - Phase, target, and optional candidate.
     * @returns Common browser lease or typed limitation.
     */
    async openPhase(request: EnvironmentPhaseRequest): Promise<EnvironmentPhaseOpenResult> {
        const observed: CliPhaseObservation = {
            phase: request.phase,
            requestedFilterIds: this.requestedFilterIds,
            targetFilterIds: null,
            rows: null,
            enabledCatalogIds: null,
            coenabledFilterIds: null,
            controlCoenabledFilterIds: this.controlCoenabledFilterIds,
            baselinePhaseState: this.baselinePhaseState,
            candidateReceipt: null,
            baselineEditReceipt: null,
        };
        try {
            if (this.lifecycle !== EnvironmentLifecycle.Ready || !this.baseline) {
                reject(CliPhaseRejection.EnvironmentNotReady);
            }
            if (request.phase !== PhaseLabel.C && request.candidate !== null) {
                reject(CliPhaseRejection.CandidateNotApplicable);
            }
            if (request.phase === PhaseLabel.B && this.controlCoenabledFilterIds === null) {
                reject(CliPhaseRejection.ControlPhaseAbsent);
            }
            // Every candidate refusal precedes the first port call, so a phase this environment
            // cannot honour never installs an agent-authored rule it would then have to remove.
            if (request.phase === PhaseLabel.C) {
                if (request.candidate === null) {
                    reject(CliPhaseRejection.CandidateNotApplicable);
                }
                if (!this.candidateShapeSupported(request.candidate)) {
                    reject(CliPhaseRejection.CandidateUnsupported);
                }
                if (this.baselinePhaseState === null) {
                    reject(CliPhaseRejection.BaselinePhaseAbsent);
                }
            }
            const lease =
                request.phase !== PhaseLabel.C
                    ? await this.establishPhase(request, observed)
                    : request.candidate!.operation === CandidateOperation.Edit ||
                        request.candidate!.operation === CandidateOperation.Remove
                      ? await this.establishBaselineMutationPhase(
                            request.candidate!,
                            request,
                            observed,
                        )
                      : await this.establishCandidatePhase(
                            request.candidate!.rule,
                            request,
                            observed,
                        );
            recordPreflightDiagnostic('cli_phase', { outcome: 'accepted', observed });
            return { ready: true, handle: lease };
        } catch (error) {
            const reason =
                error instanceof PhaseRejectionError
                    ? error.reason
                    : CliPhaseRejection.CatalogUnreadable;
            // Recorded before the outcome collapses to a finite code: the catalog rows and both
            // co-enabled sets are the only evidence that can say which invariant refused the phase.
            recordPreflightDiagnostic('cli_phase', {
                outcome: 'rejected',
                reason,
                observed,
                error: error instanceof PhaseRejectionError ? null : describeDiagnosticError(error),
            });
            return { ready: false, limitation: { ...PHASE_LIMITATIONS[reason] } };
        }
    }

    /**
     * Close every registered phase session while continuing after individual failures.
     *
     * @returns Complete stable drain receipt.
     */
    async drainOpenHandles(): Promise<EnvironmentHandleDrainReceipt> {
        let closed = 0;
        let failed = 0;
        const failures: EnvironmentAdapterLimitation[] = [];
        const resources = [...this.openLeases.values()];
        for (const resource of resources) {
            try {
                await resource.session.close();
                this.openLeases.delete(resource.leaseId);
                closed += 1;
            } catch {
                failed += 1;
                failures.push({
                    code: EnvironmentAdapterLimitationCode.CleanupFailed,
                    stage: EnvironmentLimitationStage.Cleanup,
                    detail: 'A controlled browser session could not be closed.',
                });
            }
        }
        return { attempted: resources.length, closed, failed, failures };
    }

    /**
     * Return fresh adapter-only state without validator evidence.
     *
     * @returns Immutable-data state snapshot.
     */
    snapshot(): FilteringEnvironmentAdapterState {
        return structuredClone({
            kind: this.kind,
            lifecycle: this.lifecycle,
            stateDigest: this.stateDigest,
            actualContext: this.actualContext,
            capabilities: this.capabilities(),
            preparation: this.preparation,
            baseline: this.baseline,
            openLeaseIds: [...this.openLeases.keys()],
            cleanup: this.cleanupReceipt,
        });
    }

    /**
     * Drain remaining handles and finish adapter cleanup exactly once.
     *
     * @returns Idempotent complete cleanup receipt.
     */
    async cleanup(): Promise<EnvironmentCleanupReceipt> {
        if (this.cleanupReceipt) {
            return structuredClone(this.cleanupReceipt);
        }
        const drain = await this.drainOpenHandles();
        const failures = [...drain.failures];
        try {
            await this.revokeCandidate();
        } catch (error) {
            this.recordNativeFailure('candidate_revoke_failed', error);
            failures.push({
                code: EnvironmentAdapterLimitationCode.CleanupFailed,
                stage: EnvironmentLimitationStage.Cleanup,
                detail: 'The agent-authored candidate source could not be removed.',
            });
        }
        try {
            await this.revokeBaselineEdit();
        } catch (error) {
            this.recordNativeFailure('baseline_edit_revoke_failed', error);
            failures.push({
                code: EnvironmentAdapterLimitationCode.CleanupFailed,
                stage: EnvironmentLimitationStage.Cleanup,
                detail: 'The locked published baseline could not be restored.',
            });
        }
        let finalizerAttempts = 0;
        let finalizerCompleted = 0;
        let finalizerFailed = 0;
        if (this.options.finalize) {
            finalizerAttempts = 1;
            try {
                await this.options.finalize();
                finalizerCompleted = 1;
            } catch {
                finalizerFailed = 1;
                failures.push({
                    code: EnvironmentAdapterLimitationCode.CleanupFailed,
                    stage: EnvironmentLimitationStage.Cleanup,
                    detail: 'The AdGuard CLI adapter finalizer did not complete.',
                });
            }
        }
        this.cleanupReceipt = {
            attempted: true,
            completed: failures.length === 0 && this.openLeases.size === 0,
            finalizerAttempts,
            finalizerCompleted,
            finalizerFailed,
            failures,
        };
        this.lifecycle = this.cleanupReceipt.completed
            ? EnvironmentLifecycle.Cleaned
            : EnvironmentLifecycle.CleanupFailed;
        return structuredClone(this.cleanupReceipt);
    }

    /**
     * Apply, prove, and open one A or B phase.
     *
     * @param request - Phase and canonical target already accepted for execution.
     * @param observed - Mutable record collecting the facts a refusal would need.
     * @returns Ready adapter lease carrying the exact phase proof.
     */
    private async establishPhase(
        request: EnvironmentPhaseRequest,
        observed: CliPhaseObservation,
    ): Promise<AdapterPhaseLease> {
        const control = request.phase === PhaseLabel.A;
        const requested = new Set(this.requestedFilterIds);
        // The control has nothing enabled, so only the published baseline can be narrowed to the
        // subset one isolation probe is testing. Keys parse back to the registry ids the native
        // enable/disable commands need; a key outside the pinned catalog simply never matches.
        const narrowedKeys = control ? null : (request.enabledListKeys ?? null);
        const narrowed =
            narrowedKeys === null
                ? null
                : narrowedKeys.map((listKey): number => parseAdguardListKey(listKey) ?? Number.NaN);
        // Recorded before the subset is validated, so a refused probe's diagnostic still names the
        // subset it attempted rather than only the whole locked baseline.
        observed.targetFilterIds = narrowed === null ? null : [...narrowed];
        if (
            narrowed !== null &&
            (narrowed.length === 0 || narrowed.some((id) => !requested.has(id)))
        ) {
            reject(CliPhaseRejection.IsolationSubsetInvalid);
        }
        const targetIds = control
            ? []
            : // oxlint-disable-next-line unicorn/no-array-sort -- ES2023 toSorted is outside this target.
              (narrowed?.slice().sort((left, right) => left - right) ?? this.requestedFilterIds);
        const targets = new Set(targetIds);
        // Iterated over the whole locked baseline so the command order stays deterministic and
        // every filter outside the subset is proven disabled rather than merely left alone.
        for (const filterId of this.requestedFilterIds) {
            await this.runFilterAction(
                targets.has(filterId)
                    ? BaselineHostAction.EnableFilter
                    : BaselineHostAction.DisableFilter,
                filterId,
            );
        }
        const catalog = await this.readCatalog();
        observed.rows = catalog.rows;
        observed.enabledCatalogIds = catalog.enabledCatalogIds;
        const enabledFilterIds = catalog.enabledCatalogIds.filter((id) => requested.has(id));
        const coenabledFilterIds = catalog.enabledCatalogIds.filter((id) => !requested.has(id));
        observed.coenabledFilterIds = coenabledFilterIds;
        if (control) {
            if (enabledFilterIds.length > 0) {
                reject(CliPhaseRejection.ControlStateUnproven);
            }
        } else {
            // Set equality, not a count: an adapter is credited with the subset it proved, never
            // with the subset it was asked for, so a narrowing that did not take refuses the phase.
            if (!sameIds(enabledFilterIds, targetIds)) {
                reject(CliPhaseRejection.BaselineStateUnproven);
            }
            // The co-enabled set must be identical on both sides, so the only difference between
            // the control and the baseline is the requested filters themselves. The CLI enables a
            // filter of its own accord when its proxy starts, and a phase pair that ignored that
            // would credit the requested set for a difference it may not own.
            if (!sameIds(this.controlCoenabledFilterIds ?? [], coenabledFilterIds)) {
                reject(CliPhaseRejection.CoenabledSetChanged);
            }
        }
        const created = await this.createPhaseSession(request);
        const leaseId = this.createLeaseId(request.phase);
        this.openLeases.set(leaseId, { leaseId, session: created.session });
        if (control) {
            this.controlCoenabledFilterIds = coenabledFilterIds;
        } else if (narrowed === null) {
            // Only a whole-baseline phase may bind the state the candidate phase is proven against:
            // a probe that rebound it would leave the candidate compared to a partial baseline.
            this.baselinePhaseState = {
                enabledFilterIds,
                coenabledFilterIds,
                userFilterEnabled: catalog.userFilterEnabled,
            };
        }
        const cli: CliAdapterProof = {
            cliVersion: this.options.cliVersion,
            enabledListKeys: enabledFilterIds.map(adguardListKey),
            coenabledListKeys: coenabledFilterIds.map(adguardListKey),
            userFilterEnabled: catalog.userFilterEnabled,
        };
        return {
            session: created.session,
            adapterProof: {
                leaseId,
                adapterStateDigest: this.stateDigest,
                phase: request.phase,
                filteringState: control
                    ? EnvironmentFilteringState.Disabled
                    : EnvironmentFilteringState.PublishedBaseline,
                sessionId: created.sessionId,
                actualContext: this.actualContext,
                baselineDigest: control ? null : this.baseline!.aggregateDigest,
                candidateDigest: null,
                extension: null,
                cli,
            },
            close: async (): Promise<void> => {
                const resource = this.openLeases.get(leaseId);
                if (!resource) {
                    return;
                }
                await resource.session.close();
                this.openLeases.delete(leaseId);
            },
        };
    }

    /**
     * Apply, prove, and open the candidate phase beside the locked published baseline.
     *
     * The candidate is marked applied before the port is called, so a rejected application is
     * revoked too: a partially installed agent-authored source would silently poison every later
     * phase of the isolated installation.
     *
     * @param rule - Exact single candidate line to install.
     * @param request - Phase and canonical target already accepted for execution.
     * @param observed - Mutable record collecting the facts a refusal would need.
     * @returns Ready adapter lease carrying the exact candidate phase proof.
     */
    private async establishCandidatePhase(
        rule: string,
        request: EnvironmentPhaseRequest,
        observed: CliPhaseObservation,
    ): Promise<AdapterPhaseLease> {
        this.candidateApplied = true;
        try {
            let receipt: ProxyBlockerCandidateReceipt;
            try {
                receipt = await this.options.applyCandidate!(rule);
            } catch (error) {
                this.recordNativeFailure('candidate_apply_failed', error);
                reject(CliPhaseRejection.CandidateApplyFailed);
            }
            observed.candidateReceipt = receipt;
            const candidateDigest = createHash('sha256').update(rule).digest('hex');
            if (
                receipt.contentDigest !== candidateDigest ||
                receipt.ruleCount !== 1 ||
                receipt.extraSourceCount !== 1
            ) {
                reject(CliPhaseRejection.CandidateReceiptInvalid);
            }
            return await this.openCandidateLease(request, observed, candidateDigest, () =>
                this.revokeCandidate(),
            );
        } catch (error) {
            await this.revokeCandidateQuietly();
            throw error;
        }
    }

    /**
     * Mutate one exact published line inside the locked baseline, prove it, and open the phase.
     *
     * Both mutations this environment can express — replacing one published line, and deleting one
     * — share every invariant after the port call, so they share this body and differ only in which
     * port is asked to make the change.
     *
     * The mutation is marked applied before the port is called for the same reason the additive
     * path marks the candidate applied: a partially written baseline resource would silently poison
     * every later phase, and here it would also leave the operator's installation executing
     * agent-authored published content.
     *
     * @param candidate - Exact mutation and, for a replacement, the published line it replaces.
     * @param request - Phase and canonical target already accepted for execution.
     * @param observed - Mutable record collecting the facts a refusal would need.
     * @returns Ready adapter lease carrying the exact candidate phase proof.
     */
    private async establishBaselineMutationPhase(
        candidate: EnvironmentCandidate,
        request: EnvironmentPhaseRequest,
        observed: CliPhaseObservation,
    ): Promise<AdapterPhaseLease> {
        this.baselineEditApplied = true;
        try {
            let outcome: ProxyBlockerBaselineEditOutcome;
            try {
                outcome =
                    candidate.operation === CandidateOperation.Remove
                        ? await this.options.applyBaselineRemoval!(candidate.rule)
                        : await this.options.applyBaselineEdit!(
                              candidate.originalRule!,
                              candidate.rule,
                          );
            } catch (error) {
                this.recordNativeFailure('baseline_edit_apply_failed', error);
                reject(CliPhaseRejection.CandidateApplyFailed);
            }
            if (!outcome.applied) {
                // The route refused before it changed anything, so there is nothing to restore.
                this.baselineEditApplied = false;
                reject(outcome.refusal);
            }
            const receipt = outcome.receipt;
            observed.baselineEditReceipt = receipt;
            const locked = this.baseline!.resources.find(
                (resource) => resource.listKey === adguardListKey(receipt.filterId),
            );
            // The locked digest is what makes the mutation provable and reversible: an edit whose
            // preimage is not the resource this run locked is an edit to something else.
            if (
                receipt.replacedLineCount !== 1 ||
                receipt.extraSourceCount !== 0 ||
                receipt.afterSha256 === receipt.beforeSha256 ||
                locked?.sha256 !== receipt.beforeSha256
            ) {
                reject(CliPhaseRejection.CandidateReceiptInvalid);
            }
            this.baselineEditBeforeSha256 = receipt.beforeSha256;
            const candidateDigest = createHash('sha256').update(candidate.rule).digest('hex');
            return await this.openCandidateLease(request, observed, candidateDigest, () =>
                this.revokeBaselineEdit(),
            );
        } catch (error) {
            await this.revokeBaselineEditQuietly();
            throw error;
        }
    }

    /**
     * Prove the candidate phase differs from the published baseline by the candidate alone, and
     * open its lease.
     *
     * Shared by the added rule and the baseline mutation: once the port has applied either, the
     * official filtering state must match the baseline phase exactly, so a changed page can only be
     * attributed to that one rule or line.
     *
     * @param request - Phase and canonical target already accepted for execution.
     * @param observed - Mutable record collecting the facts a refusal would need.
     * @param candidateDigest - SHA-256 of the candidate rule the proof binds.
     * @param revoke - Undoes the applied candidate when the lease closes.
     * @returns Ready adapter lease carrying the exact candidate phase proof.
     */
    private async openCandidateLease(
        request: EnvironmentPhaseRequest,
        observed: CliPhaseObservation,
        candidateDigest: string,
        revoke: () => Promise<void>,
    ): Promise<AdapterPhaseLease> {
        const baseline = this.baselinePhaseState!;
        const catalog = await this.readCatalog();
        observed.rows = catalog.rows;
        observed.enabledCatalogIds = catalog.enabledCatalogIds;
        const requested = new Set(this.requestedFilterIds);
        const enabledFilterIds = catalog.enabledCatalogIds.filter((id) => requested.has(id));
        const coenabledFilterIds = catalog.enabledCatalogIds.filter((id) => !requested.has(id));
        observed.coenabledFilterIds = coenabledFilterIds;
        if (
            !sameIds(baseline.enabledFilterIds, enabledFilterIds) ||
            !sameIds(baseline.coenabledFilterIds, coenabledFilterIds) ||
            baseline.userFilterEnabled !== catalog.userFilterEnabled
        ) {
            reject(CliPhaseRejection.CandidateStateDiverged);
        }
        const created = await this.createPhaseSession(request);
        const leaseId = this.createLeaseId(request.phase);
        this.openLeases.set(leaseId, { leaseId, session: created.session });
        return {
            session: created.session,
            adapterProof: {
                leaseId,
                adapterStateDigest: this.stateDigest,
                phase: request.phase,
                filteringState: EnvironmentFilteringState.PublishedBaselinePlusCandidate,
                sessionId: created.sessionId,
                actualContext: this.actualContext,
                baselineDigest: this.baseline!.aggregateDigest,
                candidateDigest,
                extension: null,
                cli: {
                    cliVersion: this.options.cliVersion,
                    enabledListKeys: baseline.enabledFilterIds.map(adguardListKey),
                    coenabledListKeys: baseline.coenabledFilterIds.map(adguardListKey),
                    userFilterEnabled: baseline.userFilterEnabled,
                },
            },
            close: async (): Promise<void> => {
                const resource = this.openLeases.get(leaseId);
                if (resource) {
                    await resource.session.close();
                    this.openLeases.delete(leaseId);
                }
                await revoke();
            },
        };
    }

    /**
     * Restore the locked published baseline bytes exactly once.
     *
     * A failure, including a restore that reports different bytes from the locked ones, leaves the
     * edit marked applied so cleanup retries it and reports it: the operator's installation must
     * not be left quietly executing an agent-authored baseline.
     *
     * @returns Nothing once the installation executes the locked baseline alone.
     */
    private async revokeBaselineEdit(): Promise<void> {
        if (!this.baselineEditApplied) {
            return;
        }
        const restored = await this.options.revokeBaselineEdit!();
        if (this.baselineEditBeforeSha256 !== null && restored !== this.baselineEditBeforeSha256) {
            throw new Error('The locked published baseline was not restored.');
        }
        this.baselineEditApplied = false;
    }

    /**
     * Restore the baseline on a failure path without replacing the failure being reported.
     *
     * @returns Nothing once the restoration was attempted.
     */
    private async revokeBaselineEditQuietly(): Promise<void> {
        try {
            await this.revokeBaselineEdit();
        } catch (error) {
            this.recordNativeFailure('baseline_edit_revoke_failed', error);
        }
    }

    /**
     * Remove the agent-authored candidate source exactly once.
     *
     * A failure leaves the candidate marked applied so cleanup retries it and reports it.
     *
     * @returns Nothing once the installation executes the locked baseline alone.
     */
    private async revokeCandidate(): Promise<void> {
        if (!this.candidateApplied) {
            return;
        }
        await this.options.revokeCandidate!();
        this.candidateApplied = false;
    }

    /**
     * Revoke the candidate on a failure path without replacing the failure being reported.
     *
     * @returns Nothing once the revocation was attempted.
     */
    private async revokeCandidateQuietly(): Promise<void> {
        try {
            await this.revokeCandidate();
        } catch (error) {
            this.recordNativeFailure('candidate_revoke_failed', error);
        }
    }

    /**
     * Report whether both candidate ports are available.
     *
     * @returns Whether this adapter can apply and remove an agent-authored candidate.
     */
    private candidatePortsPresent(): boolean {
        return Boolean(this.options.applyCandidate && this.options.revokeCandidate);
    }

    /**
     * Report whether both baseline-edit ports are available.
     *
     * @returns Whether this adapter can replace and restore one locked published line.
     */
    private baselineEditPortsPresent(): boolean {
        return Boolean(this.options.applyBaselineEdit && this.options.revokeBaselineEdit);
    }

    /**
     * Report whether both baseline-removal ports are available.
     *
     * @returns Whether this adapter can delete and restore one locked published line.
     */
    private baselineRemovalPortsPresent(): boolean {
        return Boolean(this.options.applyBaselineRemoval && this.options.revokeBaselineEdit);
    }

    /**
     * Decide whether this environment can execute the exact candidate shape it was handed.
     *
     * An addition and a correction are different C states, not two spellings of one, so each is
     * accepted only with the port pair that can establish it and only when the candidate carries
     * exactly the fields that state needs. Every other shape is refused before the first port
     * call.
     *
     * @param candidate - Exact candidate the phase request carried.
     * @returns Whether the candidate phase may be attempted at all.
     */
    private candidateShapeSupported(candidate: EnvironmentCandidate): boolean {
        if (candidate.operation === CandidateOperation.Add) {
            return this.candidatePortsPresent() && candidate.originalRule === undefined;
        }
        if (candidate.operation === CandidateOperation.Edit) {
            return (
                this.baselineEditPortsPresent() &&
                candidate.originalRule !== undefined &&
                candidate.originalRule.length > 0
            );
        }
        // A removal names no replacement, so a candidate carrying one is a shape this adapter
        // refuses before any port call rather than a deletion it silently reinterprets.
        return this.baselineRemovalPortsPresent() && candidate.originalRule === undefined;
    }

    /**
     * Open one controlled browser session for an already-proven phase.
     *
     * @param request - Phase and canonical target URL.
     * @returns Ready session and its stable identity.
     */
    private async createPhaseSession(
        request: EnvironmentPhaseRequest,
    ): Promise<ProxyBlockerPhaseSession> {
        try {
            return await this.options.createSession({
                phase: request.phase,
                targetUrl: request.targetUrl,
            });
        } catch (error) {
            this.recordNativeFailure('session_creation_failed', error);
            reject(CliPhaseRejection.SessionUnavailable);
        }
    }

    /**
     * Run one enable or disable command for a pinned official filter.
     *
     * @param action - Exact native filter action.
     * @param filterId - Pinned official catalog ID.
     */
    private async runFilterAction(
        action: typeof BaselineHostAction.EnableFilter | typeof BaselineHostAction.DisableFilter,
        filterId: number,
    ): Promise<void> {
        try {
            await this.options.baselineHost.runBaselineAction(action, filterId);
        } catch (error) {
            this.recordNativeFailure(`${action}_failed`, error);
            reject(CliPhaseRejection.FilterCommandFailed);
        }
    }

    /**
     * Read the complete native catalog through the shared list contract.
     *
     * @returns Enabled catalog identities and the built-in user-filter state.
     */
    private async readCatalog(): Promise<CliCatalogState> {
        let stdout: string;
        try {
            stdout = await this.options.baselineHost.runBaselineAction(
                BaselineHostAction.ListAllFilters,
                null,
            );
        } catch (error) {
            this.recordNativeFailure('list_command_failed', error);
            reject(CliPhaseRejection.CatalogUnreadable);
        }
        const reading = readProxyBlockerFilterList(stdout, (listRejection, observed) => {
            recordPreflightDiagnostic('cli_phase', {
                note: 'filter_list_unreadable',
                listRejection,
                observed,
            });
            reject(CliPhaseRejection.CatalogUnreadable);
        });
        return {
            rows: reading.rows,
            enabledCatalogIds: reading.rows
                .filter((row) => row.id > 0 && row.enabled)
                .map((row) => row.id)
                // oxlint-disable-next-line unicorn/no-array-sort -- ES2023 toSorted is outside this target.
                .sort((left, right) => left - right),
            // Recorded rather than gated on: whether the built-in user filter is always enabled is
            // a question only a licensed run can answer, and gating on it now would refuse every
            // phase if the answer is yes.
            userFilterEnabled: reading.rows.some((row) => row.id < 0 && row.enabled),
        };
    }

    /**
     * Preserve one native failure before it collapses into a finite local reason.
     *
     * @param note - Which boundary produced the failure.
     * @param error - Arbitrary value the boundary rejected with.
     */
    private recordNativeFailure(note: string, error: unknown): void {
        recordPreflightDiagnostic('cli_phase', { note, error: describeDiagnosticError(error) });
    }
}
