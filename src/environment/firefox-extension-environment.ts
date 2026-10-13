/**
 * The filtering environment of a Firefox-family blocker: uBlock Origin force-installed from a
 * signed XPI, running the list selection its instruction declares.
 *
 * One adapter per family. The Chromium/AdGuard adapter locks an unpacked build's `manifest.json`
 * and its `ruleset_<id>` bytes, re-locks them before every phase, and credits itself from the
 * AdGuard extension's own live settings. A signed XPI has none of those: no unpacked root, no
 * readable manifest generation, and no `moz-extension://` page the host may drive. So this
 * adapter's readiness is a successful launch with the declared policies applied, and its phases
 * are:
 *
 * - **A** — Firefox with no extension at all.
 * - **B** — Firefox with the XPI force-installed, the declaration's lists, and an empty user-filters
 *   file.
 * - **C** — the same, plus exactly the candidate line.
 *
 * B and C are reached through the host-side file application the configuration seam performs: write
 * the declared file, rebuild the enterprise policies, relaunch — Firefox reads `policies.json` only
 * at startup — and read the file back. The phase proof records that read-back; this adapter never
 * judges it a second time. The one thing it adds is the enabled set: a file read-back cannot see
 * it, so the proof carries the template's list keys, observed from the declaration rather than
 * guessed or reported as unobserved.
 */
import { createHash } from 'node:crypto';
import * as v from 'valibot';
import type { IBrowserSession } from '../browser/browser-interfaces';
import { BrowserDisplayName } from '../types/browser-display-name';
import type { SettingsProfileKind } from '../types/settings-profile-kind';
import { PhaseLabel } from '../types/validation';
import {
    EnvironmentPhaseConfigurationOutcome,
    type BrowserExtensionCreatedSession,
    type BrowserExtensionSessionRequest,
    type EnvironmentPhaseConfigurationRequest,
    type EnvironmentPhaseConfigurationResult,
} from './browser-extension-environment';
import {
    EnvironmentFilteringState,
    type ExtensionAdapterProofSchema,
    type PublishedBaselineProvenance,
} from './environment-proofs';
import { firefoxPhaseExtensionProof, lockDeclaredBaseline } from './firefox-phase-evidence';
import { BrowserExtensionExecutorName } from './executor-name';
import type { FilterListKey } from './filter-list-ref';
import {
    EnvironmentAdapterLimitationCode,
    EnvironmentLifecycle,
    EnvironmentLimitationStage,
    type AdapterPhaseLease,
    type EnvironmentCleanupReceipt,
    type EnvironmentHandleDrainReceipt,
    type EnvironmentPhaseOpenResult,
    type EnvironmentPhaseRequest,
    type EnvironmentPreparationRequest,
    type EnvironmentPreparationResult,
    type FilteringEnvironmentAdapter,
    type FilteringEnvironmentAdapterState,
} from './filtering-environment';
import { adapterLimitation, PhaseLeaseRegistry } from './phase-lease-registry';
import { normalizeRulesContent, sha256OfContent } from './rules-content';

/**
 * Deterministic construction seams of the Firefox-family filtering environment.
 */
export interface FirefoxExtensionEnvironmentOptions {
    /**
     * Extension id the enterprise policies force-install, exactly as the extension publishes it.
     */
    extensionId: string;

    /**
     * Absolute path of the signed XPI the browser installs.
     */
    xpiPath: string;

    /**
     * The run's executable baseline: the list keys the instruction's managed-storage declaration
     * selects, user filters included. Every B and C proof reports exactly this set.
     */
    declaredListKeys: readonly FilterListKey[];

    /**
     * Settings profile kind the run's sessions were launched with, recorded in every proof.
     */
    profileKind: SettingsProfileKind;

    /**
     * The run's application instruction content whose contract the between-phases application
     * performs.
     */
    application: string;

    /**
     * Immutable digest of the launch declaration this environment executes.
     */
    buildDigest: string;

    /**
     * Complete prepared-build provenance projected into durable results, when the run recorded one.
     */
    extensionProvenance?: v.InferOutput<typeof ExtensionAdapterProofSchema>['provenance'];

    /**
     * Create one concrete phase session in the exact requested filtering state.
     *
     * @param request - Adapter-owned session request; the extension root is always null here,
     *   because a Firefox session installs its XPI through the policies instead.
     * @returns The created session.
     */
    createSession(request: BrowserExtensionSessionRequest): Promise<BrowserExtensionCreatedSession>;

    /**
     * Bring one established phase session to the requested blocker state.
     *
     * Implemented by the run's host-side file application: it writes the declared user-filters
     * file, rebuilds the policies, relaunches the session and reads the file back, returning the
     * replacement session with its credit.
     *
     * @param session - The established phase session the application acts over.
     * @param request - Phase, target, candidate, instruction and the prepared baseline set.
     * @returns The application outcome with its read-back, refusal, or mismatch detail.
     */
    phaseConfiguration(
        session: IBrowserSession,
        request: EnvironmentPhaseConfigurationRequest,
    ): Promise<EnvironmentPhaseConfigurationResult>;

    /**
     * Deterministic clock used for preparation evidence.
     */
    now?: () => string;

    /**
     * Deterministic lease identity seam.
     *
     * @param phase - Phase owning the lease.
     * @returns Unique lease identity.
     */
    createLeaseId?: (phase: EnvironmentPhaseRequest['phase']) => string;

    /**
     * Optional final adapter-specific cleanup.
     *
     * @returns Nothing after cleanup completes.
     */
    finalize?: () => Promise<void>;
}

/**
 * Firefox-family implementation of the common filtering environment contract.
 */
export class FirefoxExtensionEnvironmentAdapter implements FilteringEnvironmentAdapter {
    readonly kind = BrowserExtensionExecutorName;

    /**
     * The product and browser this environment really executes with: the declared extension id in
     * the real Firefox build. Nothing here names AdGuard or Chromium.
     */
    private readonly actualContext: FilteringEnvironmentAdapterState['actualContext'];

    /**
     * The executable baseline locked at preparation, built from the declaration alone.
     */
    private baseline: PublishedBaselineProvenance | null = null;

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
     * The open phase sessions this adapter owns.
     */
    private readonly leases = new PhaseLeaseRegistry();

    /**
     * Deterministic adapter clock.
     */
    private readonly now: () => string;

    /**
     * Deterministic lease identity factory.
     */
    private readonly createLeaseId: (phase: EnvironmentPhaseRequest['phase']) => string;

    /**
     * Create one unprepared adapter over a Firefox-family launch declaration.
     *
     * @param options - The declaration, the run's profile and instruction, and the session seams.
     */
    constructor(private readonly options: FirefoxExtensionEnvironmentOptions) {
        this.actualContext = {
            kind: this.kind,
            product: options.extensionId,
            browser: BrowserDisplayName.PlaywrightFirefox,
            // A signed XPI's own version is never read (see SIGNED_XPI_BUILD_MARKER), and an
            // unobserved value is null rather than a number nobody saw.
            productVersion: null,
        };
        this.now = options.now ?? (() => new Date().toISOString());
        this.createLeaseId =
            options.createLeaseId ??
            ((phase) =>
                `${phase.toLowerCase()}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        this.stateDigest = createHash('sha256')
            .update(
                JSON.stringify({
                    buildDigest: options.buildDigest,
                    declaredListKeys: [...options.declaredListKeys],
                    actualContext: this.actualContext,
                }),
            )
            .digest('hex');
    }

    /**
     * Return the common capabilities this environment implements.
     *
     * `baseline_integrity` is deliberately absent: a signed XPI's executed bytes are never opened,
     * so no aggregate of them can be proven. Everything else a browser-extension route offers is
     * here.
     *
     * @returns Fresh capability list.
     */
    capabilities(): FilteringEnvironmentAdapterState['capabilities'] {
        return [
            'browser_navigation',
            'filtering_control',
            'extension_filtering',
            'candidate_application',
            'phase_proof',
        ];
    }

    /**
     * Lock the executable baseline the run's instruction declared.
     *
     * The requested lists carry nothing here — a Firefox-family run resolves no list against
     * AdGuard's catalog — so the baseline is the declaration's own selection. Its list files are
     * never opened, so every enabled list is recorded as unattributed: exactly the field that
     * exists for lists which filter but whose bytes no observer can bind.
     *
     * @param request - The executor's list request; a Firefox-family run carries none.
     * @returns Ready adapter state, or a typed limitation.
     */
    async prepare(request: EnvironmentPreparationRequest): Promise<EnvironmentPreparationResult> {
        void request;
        if (this.lifecycle === EnvironmentLifecycle.Ready) {
            return { ready: true, state: this.snapshot() };
        }
        if (this.leases.cleanupReceipt() !== null) {
            return {
                ready: false,
                limitation: adapterLimitation(
                    EnvironmentAdapterLimitationCode.PhaseOpenFailed,
                    EnvironmentLimitationStage.Preparation,
                    'The Firefox blocker environment has already been cleaned up.',
                ),
            };
        }
        const locked = lockDeclaredBaseline({
            environment: this.kind,
            extensionId: this.options.extensionId,
            buildDigest: this.options.buildDigest,
            declaredListKeys: this.options.declaredListKeys,
            acquiredAt: this.now(),
        });
        if (!locked.ready) {
            this.lifecycle = EnvironmentLifecycle.Limited;
            return {
                ready: false,
                limitation: adapterLimitation(
                    EnvironmentAdapterLimitationCode.BaselineManifestInvalid,
                    EnvironmentLimitationStage.Preparation,
                    locked.detail,
                ),
            };
        }
        this.baseline = locked.baseline;
        this.stateDigest = createHash('sha256')
            .update(
                JSON.stringify({
                    buildDigest: this.options.buildDigest,
                    actualContext: this.actualContext,
                    baseline: locked.baseline,
                }),
            )
            .digest('hex');
        this.lifecycle = EnvironmentLifecycle.Ready;
        return { ready: true, state: this.snapshot() };
    }

    /**
     * Establish one real A, B or C phase and prove its exact filtering state.
     *
     * @param request - Phase, target, and the candidate for C.
     * @returns A browser lease carrying the phase proof, or a typed limitation.
     */
    async openPhase(request: EnvironmentPhaseRequest): Promise<EnvironmentPhaseOpenResult> {
        const baseline = this.baseline;
        if (this.lifecycle !== EnvironmentLifecycle.Ready || !baseline) {
            return {
                ready: false,
                limitation: adapterLimitation(
                    EnvironmentAdapterLimitationCode.PhaseOpenFailed,
                    EnvironmentLimitationStage.Phase,
                    'The Firefox blocker environment is not ready for phase execution.',
                ),
            };
        }
        if (
            (request.phase !== PhaseLabel.C && request.candidate !== null) ||
            (request.phase === PhaseLabel.C && request.candidate?.operation !== 'add')
        ) {
            return {
                ready: false,
                limitation: adapterLimitation(
                    EnvironmentAdapterLimitationCode.CandidateOperationUnsupported,
                    EnvironmentLimitationStage.Candidate,
                    'The selected environment cannot apply this candidate operation.',
                ),
            };
        }
        // The enabled set is the declaration's, applied whole at every browser start; there is no
        // channel that would switch part of it off for one phase, so a narrowed request is refused
        // rather than answered with the whole selection.
        if (request.enabledListKeys != null) {
            return {
                ready: false,
                limitation: adapterLimitation(
                    EnvironmentAdapterLimitationCode.SettingsMismatch,
                    EnvironmentLimitationStage.Phase,
                    'The Firefox blocker environment cannot narrow the declared list selection.',
                ),
            };
        }
        const candidateDigest =
            request.phase === PhaseLabel.C && request.candidate
                ? sha256OfContent(normalizeRulesContent(request.candidate.rule))
                : null;
        let created: BrowserExtensionCreatedSession;
        try {
            created = await this.options.createSession({
                phase: request.phase,
                targetUrl: request.targetUrl,
                // A Firefox session installs its blocker through the enterprise policies, so no
                // phase of this family ever names an unpacked root — phase A simply launches with
                // no policies at all.
                extensionRoot: null,
            });
        } catch (error) {
            return {
                ready: false,
                limitation: adapterLimitation(
                    EnvironmentAdapterLimitationCode.PhaseOpenFailed,
                    EnvironmentLimitationStage.Phase,
                    'The controlled Firefox session could not be established: ' +
                        (error instanceof Error ? error.message : String(error)),
                ),
            };
        }
        const leaseId = this.createLeaseId(request.phase);
        this.leases.retain(leaseId, created.session);

        let application: EnvironmentPhaseConfigurationResult | null = null;
        if (request.phase !== PhaseLabel.A) {
            application = await this.options.phaseConfiguration(created.session, {
                phase: request.phase,
                targetUrl: request.targetUrl,
                candidateRule:
                    request.phase === PhaseLabel.C && request.candidate
                        ? request.candidate.rule
                        : null,
                application: this.options.application,
                baselineEnabledFilterIds: baseline.enabledListKeys,
                ...(request.signal === undefined ? {} : { signal: request.signal }),
            });
            // The application relaunched the browser so it would read the rebuilt policies at
            // startup; the session it was handed is closed by now, so the replacement takes its
            // place under the same lease identity — including on the failure paths below.
            const configured =
                application.kind !== EnvironmentPhaseConfigurationOutcome.Refused &&
                application.session !== undefined
                    ? application.session
                    : created.session;
            if (configured !== created.session) {
                created = { session: configured };
                this.leases.retain(leaseId, configured);
            }
            if (application.kind === EnvironmentPhaseConfigurationOutcome.Refused) {
                return {
                    ready: false,
                    limitation: adapterLimitation(
                        EnvironmentAdapterLimitationCode.ApplicationInstructionRefused,
                        request.phase === PhaseLabel.C
                            ? EnvironmentLimitationStage.Candidate
                            : EnvironmentLimitationStage.Phase,
                        `The phase ${request.phase === PhaseLabel.C ? 'C' : 'B'} application was ` +
                            `refused [${application.gap}]: ${application.detail}`,
                    ),
                };
            }
            if (application.kind === EnvironmentPhaseConfigurationOutcome.Unverified) {
                return {
                    ready: false,
                    limitation: adapterLimitation(
                        request.phase === PhaseLabel.C
                            ? EnvironmentAdapterLimitationCode.CandidateApplicationFailed
                            : EnvironmentAdapterLimitationCode.PhaseProofUnavailable,
                        request.phase === PhaseLabel.C
                            ? EnvironmentLimitationStage.Candidate
                            : EnvironmentLimitationStage.Phase,
                        request.phase === PhaseLabel.C
                            ? `The candidate user-filter application did not converge: ${application.detail}`
                            : `The baseline user-filter state did not empty: ${application.detail}`,
                    ),
                };
            }
        }
        const lease: AdapterPhaseLease = {
            session: created.session,
            adapterProof: {
                leaseId,
                adapterStateDigest: this.stateDigest,
                phase: request.phase,
                filteringState:
                    request.phase === PhaseLabel.A
                        ? EnvironmentFilteringState.Disabled
                        : request.phase === PhaseLabel.B
                          ? EnvironmentFilteringState.PublishedBaseline
                          : EnvironmentFilteringState.PublishedBaselinePlusCandidate,
                sessionId: leaseId,
                actualContext: this.actualContext,
                baselineDigest: request.phase === PhaseLabel.A ? null : baseline.aggregateDigest,
                candidateDigest,
                extension: firefoxPhaseExtensionProof({
                    request,
                    application,
                    candidateDigest,
                    declaredListKeys: this.options.declaredListKeys,
                    profileKind: this.options.profileKind,
                    ...(this.options.extensionProvenance
                        ? { extensionProvenance: this.options.extensionProvenance }
                        : {}),
                }),
            },
            close: async (): Promise<void> => {
                await this.leases.close(leaseId);
            },
        };
        return { ready: true, handle: lease };
    }

    /**
     * Close every registered phase session while continuing after individual failures.
     *
     * @returns Complete stable drain receipt.
     */
    async drainOpenHandles(): Promise<EnvironmentHandleDrainReceipt> {
        return await this.leases.drain();
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
            preparation:
                this.baseline === null
                    ? null
                    : {
                          preparedAt: this.baseline.acquiredAt,
                          buildDigest: this.options.buildDigest,
                          // There is no unpacked root to digest: the XPI's own digest is the whole
                          // build identity, already carried by buildDigest.
                          extensionRootDigest: null,
                      },
            baseline: this.baseline,
            openLeaseIds: this.leases.openLeaseIds(),
            cleanup: this.leases.cleanupReceipt(),
        });
    }

    /**
     * Drain remaining handles and finish adapter cleanup exactly once.
     *
     * @returns Idempotent complete cleanup receipt.
     */
    async cleanup(): Promise<EnvironmentCleanupReceipt> {
        const { receipt, lifecycle } = await this.leases.cleanup(
            this.options.finalize,
            'The Firefox blocker adapter finalizer did not complete.',
        );
        this.lifecycle = lifecycle;
        return receipt;
    }
}
