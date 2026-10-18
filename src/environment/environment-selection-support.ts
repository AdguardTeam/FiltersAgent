/**
 * The pure parts of the environment selection host: its fixed texts and capability sets, and the
 * decisions it derives from a request, a descriptor and the reported context without touching its
 * own state. `environment-selection.ts` holds the host that applies them.
 */
import * as v from 'valibot';
import {
    EnvironmentCapability,
    EnvironmentLimitationCode,
    EnvironmentPreparationState,
    EnvironmentSelectionReservedCase,
    EnvironmentSelectionState,
    FilteringEnvironmentAvailability,
    FilteringEnvironmentDescriptor,
} from './environment-vocabulary';
import {
    AgentEnvironmentSelectionRequest,
    EnvironmentSelectionSnapshot,
    EnvironmentSelectionSnapshotSchema,
    FidelityLimitationCode,
} from './environment-selection-contract';
import { NonExecutableFilterCode } from './official-filter-catalog';
/**
 * Rationale recorded when the host locks the run's sole executor without a model turn.
 */
export const SOLE_EXECUTOR_RATIONALE = 'Sole executor available for this run';

/**
 * Observed-intent rationale recorded alongside the deterministic sole-executor lock.
 */
export const SOLE_EXECUTOR_INTENT_RATIONALE = 'No executor choice was offered for this run.';

/**
 * Capabilities the AdGuard CLI evidence route grants once its first session launches. The route
 * exists only after preparation proved the proxy filters an HTTPS request to the run's target.
 *
 * A prepared executor advertises installation and activation only; these arrive with the route.
 * Preparation therefore treats them as pending rather than missing, and the route grants them.
 */
export const EVIDENCE_ROUTE_CAPABILITIES: readonly EnvironmentCapability[] = [
    EnvironmentCapability.BrowserNavigation,
    EnvironmentCapability.FilteringControl,
    EnvironmentCapability.CliFiltering,
    EnvironmentCapability.BaselineIntegrity,
    EnvironmentCapability.PhaseProof,
    EnvironmentCapability.CandidateApplication,
];

/**
 * Detail recorded when a descriptor ships its adapter as unavailable.
 */
export const UNAVAILABLE_EXECUTOR_DETAIL =
    'The executor adapter is not available in this delivery slice.';

/**
 * Truncate one host-owned context value to its durable schema bound.
 *
 * @param value - Optional issue-derived context value.
 * @returns Trimmed bounded text or null when no text remains.
 */
export function boundedContext(value: string | undefined): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed.slice(0, 200) : null;
}

/**
 * Format a bounded Valibot failure without retaining arbitrary input values.
 *
 * @param issues - Validation issues returned by Valibot.
 * @returns Stable bounded field-path summary.
 */
export function validationDetail(issues: readonly v.BaseIssue<unknown>[]): string {
    const paths = issues
        .map((issue) => issue.path?.map((item) => String(item.key)).join('.'))
        .filter((path): path is string => Boolean(path));
    return `Invalid fields: ${[...new Set(paths)].slice(0, 8).join(', ') || 'request'}`;
}

/**
 * Explain why a reported filter selection yields no executable official baseline.
 *
 * The sentence carries no reporter text: the bounded reporter echo already lives in the durable
 * `filterBaseline` field, and this detail is only the finite classification of the failure.
 *
 * @param code - The finite reason the reported filter selection resolved to no official baseline.
 * @returns One fixed host-authored sentence for the recorded capability limit.
 */
export function filterBaselineLimitDetail(code: NonExecutableFilterCode): string {
    if (code === NonExecutableFilterCode.FilterSelectionMissing) {
        return 'The report names no filter selection, and no default filter baseline is invented.';
    }
    return (
        'Only third-party, custom or unrecognized filter sources were reported, which this run ' +
        'never executes.'
    );
}

/**
 * Clone and validate a durable snapshot so callers cannot mutate host state by reference.
 *
 * @param snapshot - Internal snapshot to expose.
 * @returns Independent schema-validated snapshot.
 */
export function cloneSnapshot(
    snapshot: EnvironmentSelectionSnapshot,
): EnvironmentSelectionSnapshot {
    return v.parse(EnvironmentSelectionSnapshotSchema, structuredClone(snapshot));
}

/**
 * What locking one request decides before the filter baseline and fidelity notes are added.
 */
export interface LockedState {
    /**
     * Capabilities the selected descriptor advertises.
     */
    advertisedCapabilities: EnvironmentCapability[];

    /**
     * Required capabilities the descriptor does not advertise.
     */
    missingCapabilities: EnvironmentCapability[];

    /**
     * Limits recorded for the lock.
     */
    capabilityLimits: EnvironmentSelectionSnapshot['capabilityLimits'];

    /**
     * State of the locked selection.
     */
    state: EnvironmentSelectionState;

    /**
     * Why the selection is limited, or null.
     */
    limitationCode: EnvironmentLimitationCode | null;
}

/**
 * Decide the state a request locks into from the descriptor it selected.
 *
 * @param request - The validated selection request.
 * @param descriptor - The selected executor's descriptor, or null for the reserved case.
 * @returns The capabilities, limits, state and limitation code of the lock.
 */
export function lockedStateFor(
    request: AgentEnvironmentSelectionRequest,
    descriptor: FilteringEnvironmentDescriptor | null,
): LockedState {
    const advertisedCapabilities = descriptor ? [...descriptor.capabilities] : [];
    const missingCapabilities = request.requiredCapabilities.filter(
        (capability) => !advertisedCapabilities.includes(capability),
    );
    const capabilityLimits: EnvironmentSelectionSnapshot['capabilityLimits'] = [];
    let state: EnvironmentSelectionState;
    let limitationCode: EnvironmentLimitationCode | null = null;
    if (request.kind === EnvironmentSelectionReservedCase.UnsupportedProductCase) {
        state = EnvironmentSelectionState.Unsupported;
    } else if (descriptor?.preparationState === EnvironmentPreparationState.Preparable) {
        state = EnvironmentSelectionState.Preparing;
    } else if (descriptor?.availability === FilteringEnvironmentAvailability.Unavailable) {
        state = EnvironmentSelectionState.CapabilityLimited;
        // Fresh descriptors write enum members; the widened code schema exists only so the
        // persisted run-result read-back keeps parsing renamed historical codes.
        limitationCode = descriptor.limitationCode as EnvironmentLimitationCode;
        capabilityLimits.push({
            kind: request.kind,
            code: descriptor.limitationCode ?? EnvironmentLimitationCode.ExecutorUnavailable,
            capability: null,
            detail: UNAVAILABLE_EXECUTOR_DETAIL,
        });
    } else if (missingCapabilities.length > 0) {
        state = EnvironmentSelectionState.CapabilityLimited;
        limitationCode = EnvironmentLimitationCode.RequiredCapabilityUnavailable;
        // Deduped like the snapshot's own capability lists, so a model that repeats one
        // unadvertised capability still fits the bounded limit list instead of throwing.
        for (const capability of new Set(missingCapabilities)) {
            capabilityLimits.push({
                kind: request.kind,
                code: EnvironmentLimitationCode.RequiredCapabilityUnavailable,
                capability,
                detail: 'The locked environment does not advertise a required capability.',
            });
        }
    } else {
        state = EnvironmentSelectionState.Ready;
    }
    return { advertisedCapabilities, missingCapabilities, capabilityLimits, state, limitationCode };
}

/**
 * Recompute product and browser approximation notes from reported and actual host context.
 *
 * Route-reported approximations survive this recomputation: they describe what the run actually
 * executed, which the reported-versus-actual comparison cannot re-derive.
 *
 * @param routeLimitations - Approximations the evidence route reported.
 * @param reported - What the report named.
 * @param actual - What the run actually executed.
 * @returns The fidelity limitations of the snapshot.
 */
export function fidelityLimitationsFor(
    routeLimitations: readonly EnvironmentSelectionSnapshot['fidelityLimitations'][number][],
    reported: EnvironmentSelectionSnapshot['reported'],
    actual: NonNullable<EnvironmentSelectionSnapshot['actual']>,
): EnvironmentSelectionSnapshot['fidelityLimitations'] {
    const limitations: EnvironmentSelectionSnapshot['fidelityLimitations'] = [...routeLimitations];
    if (
        reported.product !== null &&
        reported.product.toLowerCase() !== actual.product.toLowerCase()
    ) {
        limitations.push({
            code: FidelityLimitationCode.ProductApproximation,
            detail: 'The actual filtering product differs from the product named in the report.',
        });
    }
    if (
        reported.browser !== null &&
        reported.browser.toLowerCase() !== actual.browser.toLowerCase()
    ) {
        limitations.push({
            code: FidelityLimitationCode.BrowserApproximation,
            detail: 'The actual controlled browser differs from the browser named in the report.',
        });
    }
    return limitations;
}
