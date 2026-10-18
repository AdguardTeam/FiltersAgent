import * as v from 'valibot';
import { BrowserDisplayName } from '../types/browser-display-name';
import type { IssueFacts } from '../types/issue-facts';
import { type ExecutorName } from './executor-name';
import {
    ExecutorPreparationState,
    ExecutorPreparationOutcomeSchema,
    type ExecutorPreparationOutcome,
} from './executor-preparation';
import { type SelectionFilterBaseline } from './declared-filter-baseline';
import { decideExecutableFilters } from './official-filter-catalog';
import { declaredIssueContext } from './declared-issue-context';
import { FilterBaselineStatus } from './filter-baseline-status';
import {
    EnvironmentCapability,
    EnvironmentLimitationCode,
    EnvironmentPreparationState,
    EnvironmentSelectionReservedCase,
    EnvironmentSelectionState,
    FilteringEnvironmentDescriptor,
    FilteringEnvironmentDescriptorSchema,
} from './environment-vocabulary';
import {
    ActualExecutionContextInput,
    ActualExecutionContextInputSchema,
    AgentEnvironmentSelectionRequest,
    AgentEnvironmentSelectionRequestSchema,
    AgentIntentAssessmentSchema,
    CapabilityLimitInput,
    CapabilityLimitInputSchema,
    EnvironmentSelectionRejectionReason,
    EnvironmentSelectionResponse,
    EnvironmentSelectionSnapshot,
    EnvironmentSelectionSnapshotSchema,
    FidelityLimitationCode,
    FidelityLimitationSchema,
    IntentIssueType,
    IntentUpdateRejectionReason,
    IntentUpdateResponse,
    MAX_CAPABILITY_LIMITS,
    MAX_SELECTION_HISTORY,
    ReportedExecutionContextSchema,
    RouteFidelityLimitationCode,
    type EnvironmentSelectionHostOptions,
} from './environment-selection-contract';
import {
    EVIDENCE_ROUTE_CAPABILITIES,
    SOLE_EXECUTOR_INTENT_RATIONALE,
    SOLE_EXECUTOR_RATIONALE,
    boundedContext,
    cloneSnapshot,
    fidelityLimitationsFor,
    filterBaselineLimitDetail,
    lockedStateFor,
    validationDetail,
} from './environment-selection-support';

/**
 * Own the agent's first environment choice and all provenance attached to that immutable lock.
 */
export class EnvironmentSelectionHost {
    /**
     * Immutable host-owned capability descriptors indexed by executor name.
     */
    private readonly descriptors: Map<ExecutorName, FilteringEnvironmentDescriptor>;

    /**
     * Clock used for durable audit timestamps.
     */
    private readonly now: () => string;

    /**
     * Host-owned declared issue signals.
     */
    private readonly declared: EnvironmentSelectionSnapshot['declared'];

    /**
     * Host-owned reported product and browser context.
     */
    private readonly reported: EnvironmentSelectionSnapshot['reported'];

    /**
     * The run's executable filter baseline: the offline verdict on the reported selection, or the
     * selection the run's own instruction declared.
     */
    private readonly filterBaseline: SelectionFilterBaseline;

    /**
     * The first accepted selection, mutated only through bounded host methods.
     */
    private selected: EnvironmentSelectionSnapshot | null = null;

    /**
     * Approximations reported by the executing route, retained across fidelity recomputation.
     */
    private readonly routeFidelityLimitations: EnvironmentSelectionSnapshot['fidelityLimitations'] =
        [];

    /**
     * Create one undecided host from immutable issue facts and the run's capability descriptors.
     *
     * @param facts - Parser-owned issue facts used only as evidence and reported context.
     * @param descriptors - Host-owned descriptors for the run's executor set. At least one is
     *   required and every kind must name a different executor.
     * @param options - Deterministic clock seam for tests.
     */
    constructor(
        facts: IssueFacts,
        descriptors: readonly FilteringEnvironmentDescriptor[],
        options: EnvironmentSelectionHostOptions = {},
    ) {
        const parsedDescriptors = v.parse(v.array(FilteringEnvironmentDescriptorSchema), [
            ...descriptors,
        ]);
        if (parsedDescriptors.length === 0) {
            throw new Error('At least one filtering environment descriptor is required.');
        }
        this.descriptors = new Map(
            parsedDescriptors.map((descriptor) => [descriptor.kind, descriptor]),
        );
        if (this.descriptors.size !== parsedDescriptors.length) {
            const seen = new Set<ExecutorName>();
            const duplicate = parsedDescriptors.find(
                (descriptor) => seen.has(descriptor.kind) || (seen.add(descriptor.kind), false),
            );
            throw new Error(`Duplicate executor descriptor for "${duplicate?.kind}".`);
        }
        this.now = options.now ?? (() => new Date().toISOString());
        this.declared = declaredIssueContext(facts);
        this.reported = v.parse(ReportedExecutionContextSchema, {
            product: boundedContext(facts.product),
            os: boundedContext(facts.os),
            browser: boundedContext(facts.browser),
        });
        this.filterBaseline =
            options.filterBaseline ?? decideExecutableFilters(facts.enabledFilters);
    }

    /**
     * Return fresh copies of the host-owned descriptors advertised to the agent.
     *
     * @returns Schema-validated descriptors with no runtime secrets or model-authored fields.
     */
    capabilities(): FilteringEnvironmentDescriptor[] {
        return v.parse(v.array(FilteringEnvironmentDescriptorSchema), [
            ...this.descriptors.values(),
        ]);
    }

    /**
     * Return the executor names the run's descriptor set advertises.
     *
     * @returns Registration-order executor names, fresh copies of the host-owned set.
     */
    advertisedExecutorNames(): ExecutorName[] {
        return [...this.descriptors.keys()];
    }

    /**
     * Lock the first valid model selection and reject every later request without fallback.
     *
     * @param request - Untrusted model tool arguments.
     * @returns Accepted lock metadata or a stable rejection.
     */
    select(request: unknown): EnvironmentSelectionResponse {
        const parsed = v.safeParse(AgentEnvironmentSelectionRequestSchema, request);
        if (!parsed.success) {
            return {
                accepted: false,
                errorKind: EnvironmentSelectionRejectionReason.InvalidEnvironmentSelection,
                error: validationDetail(parsed.issues),
            };
        }
        if (this.selected) {
            if (this.selected.rejectedRequests.length < MAX_SELECTION_HISTORY) {
                this.selected.rejectedRequests.push({
                    requestedKind: parsed.output.kind,
                    rationale: parsed.output.rationale,
                    confidence: parsed.output.confidence,
                    rejectedAt: this.now(),
                    errorKind: EnvironmentSelectionRejectionReason.EnvironmentLocked,
                });
                this.selected = v.parse(EnvironmentSelectionSnapshotSchema, this.selected);
            }
            return {
                accepted: false,
                errorKind: EnvironmentSelectionRejectionReason.EnvironmentLocked,
                selectedKind: this.selected.selectedKind,
            };
        }
        if (
            parsed.output.kind !== EnvironmentSelectionReservedCase.UnsupportedProductCase &&
            !this.descriptors.has(parsed.output.kind)
        ) {
            return {
                accepted: false,
                errorKind: EnvironmentSelectionRejectionReason.InvalidEnvironmentSelection,
                error:
                    `Unknown executor "${parsed.output.kind}". Advertised executors: ` +
                    `${[...this.descriptors.keys()].join(', ')}.`,
            };
        }
        return this.lock(parsed.output);
    }

    /**
     * Lock the run's sole executor without a model turn.
     *
     * Used when the run's executor set has exactly one member: there is nothing to choose, so the
     * host locks the executor deterministically with the same snapshot shape a model selection
     * would produce.
     *
     * @param name - Executor name that must be one of the advertised descriptors.
     * @returns Accepted lock metadata or a stable rejection naming the advertised set.
     */
    lockSoleExecutor(name: ExecutorName): EnvironmentSelectionResponse {
        const descriptor = this.descriptors.get(name);
        if (!descriptor) {
            return {
                accepted: false,
                errorKind: EnvironmentSelectionRejectionReason.InvalidEnvironmentSelection,
                error:
                    `Unknown executor "${name}". Advertised executors: ` +
                    `${[...this.descriptors.keys()].join(', ')}.`,
            };
        }
        if (this.selected) {
            return {
                accepted: false,
                errorKind: EnvironmentSelectionRejectionReason.EnvironmentLocked,
                selectedKind: this.selected.selectedKind,
            };
        }
        return this.lock({
            kind: name,
            requiredCapabilities: [],
            intent: {
                issueType: IntentIssueType.Unknown,
                rationale: SOLE_EXECUTOR_INTENT_RATIONALE,
                confidence: 1,
                evidence: [],
                conflicts: [],
            },
            rationale: SOLE_EXECUTOR_RATIONALE,
            confidence: 1,
        });
    }

    /**
     * Build the immutable lock for one accepted request.
     *
     * Every accepted path — the model selection and the deterministic sole-executor lock — flows
     * through here, so both produce byte-identical snapshot shapes.
     *
     * @param request - Validated selection request naming the resolver's executor set.
     * @returns Accepted lock metadata for the named executor or the reserved case.
     */
    private lock(request: AgentEnvironmentSelectionRequest): EnvironmentSelectionResponse {
        const descriptor =
            request.kind === EnvironmentSelectionReservedCase.UnsupportedProductCase
                ? null
                : (this.descriptors.get(request.kind) ?? null);
        const {
            advertisedCapabilities,
            missingCapabilities,
            capabilityLimits,
            state: lockedState,
            limitationCode: lockedLimitationCode,
        } = lockedStateFor(request, descriptor);
        let state = lockedState;
        let limitationCode = lockedLimitationCode;

        const filterBaseline =
            request.kind === EnvironmentSelectionReservedCase.UnsupportedProductCase
                ? null
                : this.filterBaseline;
        if (filterBaseline?.status === FilterBaselineStatus.NotExecutable) {
            state = EnvironmentSelectionState.CapabilityLimited;
            limitationCode = EnvironmentLimitationCode.FilterSelectionNotExecutable;
            capabilityLimits.push({
                kind: request.kind,
                code: EnvironmentLimitationCode.FilterSelectionNotExecutable,
                capability: EnvironmentCapability.BaselineIntegrity,
                detail: filterBaselineLimitDetail(filterBaseline.code),
            });
        }

        const fidelityLimitations: EnvironmentSelectionSnapshot['fidelityLimitations'] = [];
        // An executor that does not browse the reported page itself can only approximate the
        // reported product's own filtering; the extension descriptor browses, so it never
        // records this approximation.
        if (
            descriptor !== null &&
            !descriptor.capabilities.includes(EnvironmentCapability.BrowserNavigation) &&
            this.reported.product !== null
        ) {
            fidelityLimitations.push({
                code: FidelityLimitationCode.ProductApproximation,
                detail: 'The selected executor approximates the reported desktop filtering behavior.',
            });
        }
        this.selected = v.parse(EnvironmentSelectionSnapshotSchema, {
            selectedKind: request.kind,
            state,
            rationale: request.rationale,
            confidence: request.confidence,
            requiredCapabilities: [...new Set(request.requiredCapabilities)],
            advertisedCapabilities,
            missingCapabilities: [...new Set(missingCapabilities)],
            descriptor,
            lockedAt: this.now(),
            declared: this.declared,
            reported: this.reported,
            observed: request.intent,
            intentHistory: [request.intent],
            rejectedRequests: [],
            actual: null,
            fidelityLimitations,
            capabilityLimits,
            filterBaseline,
            cliPreparation: null,
        });
        return {
            accepted: true,
            kind: this.selected.selectedKind,
            locked: true,
            state: this.selected.state,
            limitationCode,
            filterBaseline: this.selected.filterBaseline ?? null,
        };
    }

    /**
     * Bind one prepared executor's durable preparation result to the locked preparable selection.
     *
     * @param outcome - Ready path-free provenance, or a stable stage-bound limitation.
     */
    attachExecutorPreparation(outcome: ExecutorPreparationOutcome): void {
        if (
            !this.selected ||
            this.selected.descriptor === null ||
            this.selected.descriptor.preparationState !== EnvironmentPreparationState.Preparable
        ) {
            throw new Error(
                'Executor preparation requires a locked preparable environment selection.',
            );
        }
        if (this.selected.cliPreparation != null) {
            throw new Error('Executor preparation is already bound to this environment selection.');
        }
        const parsed = v.parse(ExecutorPreparationOutcomeSchema, structuredClone(outcome));
        if (parsed.ready) {
            // The outcome schema already parsed and cloned the provenance it embeds.
            const provenance = parsed.provenance;
            this.selected.cliPreparation = { state: ExecutorPreparationState.Ready, provenance };
            this.selected.actual = {
                kind: this.selected.selectedKind,
                product: provenance.product,
                browser: BrowserDisplayName.CloakBrowserChromium,
                productVersion: provenance.version,
            };
            // What the evidence route grants is pending, not missing: the route's first session
            // grants it (`attachCliEvidenceRouteReady`). Counting it as missing told the model the
            // prepared CLI could not navigate or apply a candidate, and the model repeated that in
            // its reports although the route then worked.
            this.selected.missingCapabilities = this.selected.missingCapabilities.filter(
                (capability) => !EVIDENCE_ROUTE_CAPABILITIES.includes(capability),
            );
            if (this.selected.missingCapabilities.length === 0) {
                this.selected.state = EnvironmentSelectionState.Ready;
            } else {
                this.selected.state = EnvironmentSelectionState.CapabilityLimited;
                for (const capability of this.selected.missingCapabilities) {
                    if (this.selected.capabilityLimits.length >= MAX_CAPABILITY_LIMITS) {
                        break;
                    }
                    this.selected.capabilityLimits.push({
                        kind: this.selected.selectedKind,
                        code: EnvironmentLimitationCode.RequiredCapabilityUnavailable,
                        capability,
                        detail: 'The prepared executor does not advertise a required capability.',
                    });
                }
            }
            this.refreshFidelityLimitations();
        } else {
            this.selected.cliPreparation = {
                state: ExecutorPreparationState.Limited,
                limitation: parsed.limitation,
            };
            this.selected.state = EnvironmentSelectionState.CapabilityLimited;
            this.selected.capabilityLimits.push({
                kind: this.selected.selectedKind,
                code: EnvironmentLimitationCode.EnvironmentPreparationFailed,
                capability: EnvironmentCapability.CliInstallation,
                detail: 'Executor preparation did not become ready.',
            });
        }
        this.selected = v.parse(EnvironmentSelectionSnapshotSchema, this.selected);
    }

    /**
     * Replace only the model-owned observed intent after new evidence is collected.
     *
     * @param assessment - Untrusted model-authored classification update.
     * @returns Update result that retains the original locked environment.
     */
    updateObservedIntent(assessment: unknown): IntentUpdateResponse {
        if (!this.selected) {
            return {
                accepted: false,
                errorKind: IntentUpdateRejectionReason.EnvironmentSelectionRequired,
            };
        }
        const parsed = v.safeParse(AgentIntentAssessmentSchema, assessment);
        if (!parsed.success) {
            return {
                accepted: false,
                selectedKind: this.selected.selectedKind,
                errorKind: IntentUpdateRejectionReason.InvalidIntentAssessment,
                error: validationDetail(parsed.issues),
            };
        }
        const history = this.selected.intentHistory;
        this.selected.observed = parsed.output;
        this.selected.intentHistory =
            history.length < MAX_SELECTION_HISTORY
                ? [...history, parsed.output]
                : [history[0], ...history.slice(2 - MAX_SELECTION_HISTORY), parsed.output];
        this.selected = v.parse(EnvironmentSelectionSnapshotSchema, this.selected);
        return { accepted: true, selectedKind: this.selected.selectedKind };
    }

    /**
     * Replace the actual execution context with what the run really executed.
     *
     * A prepared CLI route binds a context from its own provenance because that is normally what
     * filters. An executor that measures its engine differently than the product CLI makes that
     * assumption wrong: the engine, not the product CLI, does the filtering, and it says so with a
     * different version. The report must name the thing that ran, so the executing adapter is
     * allowed to correct the earlier assumption — once, and only for the locked environment.
     *
     * @param kind - Locked environment the context belongs to.
     * @param context - Adapter-owned actual product and browser values.
     */
    rebindActualContext(kind: ExecutorName, context: ActualExecutionContextInput): void {
        if (!this.selected || this.selected.selectedKind !== kind) {
            throw new Error(
                `Actual context must name the locked environment ${String(this.selected?.selectedKind)}.`,
            );
        }
        this.selected.actual = null;
        this.bindActualContext(kind, context);
    }

    /**
     * Bind the adapter-reported execution context to the locked environment.
     *
     * @param kind - Locked environment the context belongs to.
     * @param context - Adapter-owned actual product and browser values.
     */
    bindActualContext(kind: ExecutorName, context: ActualExecutionContextInput): void {
        if (!this.selected || this.selected.selectedKind !== kind) {
            throw new Error(
                `Actual context must name the locked environment ${String(this.selected?.selectedKind)}.`,
            );
        }
        const parsed = v.parse(ActualExecutionContextInputSchema, context);
        const actual = {
            kind,
            product: parsed.product,
            browser: parsed.browser,
            productVersion: parsed.productVersion ?? null,
        };
        if (this.selected.actual !== null) {
            if (JSON.stringify(this.selected.actual) !== JSON.stringify(actual)) {
                throw new Error('Actual execution context is already bound to different values.');
            }
            return;
        }
        this.selected.actual = actual;
        this.refreshFidelityLimitations();
        this.selected = v.parse(EnvironmentSelectionSnapshotSchema, this.selected);
    }

    /**
     * Mark the proxied CLI evidence route ready and grant the capabilities it executes.
     *
     * The proof is the run's own: preparation activated the route only after an HTTPS request to
     * the run's target went through the proxy's filter under the proxy's own authority, and a
     * session now runs on that route.
     *
     * @param kind - Locked environment the route belongs to.
     */
    attachCliEvidenceRouteReady(kind: ExecutorName): void {
        if (!this.selected || this.selected.selectedKind !== kind) {
            throw new Error(
                `Evidence route must name the locked environment ${String(this.selected?.selectedKind)}.`,
            );
        }
        if (this.selected.state === EnvironmentSelectionState.Unsupported) {
            return;
        }
        this.selected.advertisedCapabilities = [
            ...new Set([...this.selected.advertisedCapabilities, ...EVIDENCE_ROUTE_CAPABILITIES]),
        ];
        const advertised = this.selected.advertisedCapabilities;
        this.selected.missingCapabilities = this.selected.requiredCapabilities.filter(
            (capability) => !advertised.includes(capability),
        );
        // The route grants only its own capabilities: a requirement it cannot supply keeps the
        // selection limited.
        this.selected.state =
            this.selected.missingCapabilities.length === 0
                ? EnvironmentSelectionState.Ready
                : EnvironmentSelectionState.CapabilityLimited;
        // A limit recorded for a capability the route now grants no longer holds.
        this.selected.capabilityLimits = this.selected.capabilityLimits.filter(
            (limit) =>
                limit.code !== EnvironmentLimitationCode.RequiredCapabilityUnavailable ||
                limit.capability === null ||
                !advertised.includes(limit.capability),
        );
        this.selected = v.parse(EnvironmentSelectionSnapshotSchema, this.selected);
    }

    /**
     * Record how closely the executed run reproduced the reporter's own filter selection.
     *
     * Unlike a capability limit this never degrades the locked state: browsing with a filter the
     * catalog could not offer is weaker evidence, not a missing capability, and the terminal
     * decision stays available with the gap stated in the report.
     *
     * One record per code: a relaunch reports the same catalog degradation again and must not
     * repeat it, while a different limitation of the same run (the set fitting the catalog but not
     * the browser's MV3 limits) is a second fact the report carries beside the first.
     *
     * @param kind - Locked environment the approximation belongs to.
     * @param detail - Bounded human-readable description of the difference.
     * @param code - Which approximation the route reports; the catalog one by default.
     */
    recordFilterSelectionApproximation(
        kind: ExecutorName,
        detail: string,
        code: RouteFidelityLimitationCode = FidelityLimitationCode.FilterSelectionApproximation,
    ): void {
        if (!this.selected || this.selected.selectedKind !== kind) {
            throw new Error(
                `Filter approximation must name the locked environment ${String(this.selected?.selectedKind)}.`,
            );
        }
        if (this.routeFidelityLimitations.some((limitation) => limitation.code === code)) {
            return;
        }
        this.routeFidelityLimitations.push(v.parse(FidelityLimitationSchema, { code, detail }));
        this.refreshFidelityLimitations();
        this.selected = v.parse(EnvironmentSelectionSnapshotSchema, this.selected);
    }

    /**
     * Record one capability limit against the locked environment.
     *
     * @param kind - Locked environment the limit belongs to.
     * @param limitation - Capability the route could not honor.
     */
    recordCapabilityLimitation(kind: ExecutorName, limitation: CapabilityLimitInput): void {
        if (!this.selected || this.selected.selectedKind !== kind) {
            throw new Error(
                `Capability limit must name the locked environment ${String(this.selected?.selectedKind)}.`,
            );
        }
        const parsed = v.parse(CapabilityLimitInputSchema, limitation);
        if (this.selected.capabilityLimits.length < MAX_CAPABILITY_LIMITS) {
            this.selected.capabilityLimits.push({
                kind,
                code: parsed.code,
                capability: parsed.capability ?? null,
                detail: parsed.detail,
            });
        }
        this.selected.state = EnvironmentSelectionState.CapabilityLimited;
        this.selected = v.parse(EnvironmentSelectionSnapshotSchema, this.selected);
    }

    /**
     * Return an independent durable snapshot of the current lock.
     *
     * @returns Schema-validated selection snapshot or null before the first accepted choice.
     */
    snapshot(): EnvironmentSelectionSnapshot | null {
        return this.selected ? cloneSnapshot(this.selected) : null;
    }

    /**
     * Recompute product and browser approximation notes from reported and actual host context.
     */
    private refreshFidelityLimitations(): void {
        if (!this.selected?.actual) {
            return;
        }
        this.selected.fidelityLimitations = fidelityLimitationsFor(
            this.routeFidelityLimitations,
            this.reported,
            this.selected.actual,
        );
    }
}
