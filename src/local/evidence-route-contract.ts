import type { Logger } from 'pino';
import type { ReproProfile } from '../types/repro-profile';
import type { BrowserSession } from '../browser/browser-session';
import type { AppliedRulesLog } from '../environment/applied-rules';

/**
 * The command and storage contract of one isolated filtering installation, pinned to the product
 * CLI version this baseline contract was written against. The producing route reads the native
 * catalog itself and binds these argv forms; src owns the contract and an implementation outside
 * this tree provides it.
 */
export const BASELINE_ACTION_CONTRACT = Object.freeze({
    cliVersion: '1.4.13',
    actions: Object.freeze([
        'add_filter',
        'enable_filter',
        'disable_filter',
        'list_all_filters',
    ] as const),
});

/**
 * Exact native action the route's baseline port may ask the isolated installation to perform.
 */
export type BaselineHostAction = (typeof BASELINE_ACTION_CONTRACT.actions)[number];

/**
 * Storage and command boundary the executing adapter drives on one isolated installation.
 */
export interface BaselineHostPort {
    /**
     * Run one baseline action and return its complete bounded stdout.
     *
     * @param action - Named baseline action.
     * @param filterId - Pinned official catalog ID, or null for the list action.
     * @returns Bounded stdout; rejects on any nonzero exit, timeout, or output overflow.
     */
    runBaselineAction(action: BaselineHostAction, filterId: number | null): Promise<string>;

    /**
     * List every regular file the installation currently holds under its own data root.
     *
     * @returns Absolute paths, bounded; rejects rather than truncating when the bound is exceeded.
     */
    listStorageFiles(): Promise<readonly string[]>;

    /**
     * Canonical installation data root, used for containment checks and portable relative paths.
     */
    readonly cliDataRoot: string;
}

/**
 * Receipt proving one exact candidate line is the only agent-authored content the installation
 * executes.
 */
export interface CandidateReceipt {
    /**
     * SHA-256 of the exact rule line the agent-authored source holds, without a terminal newline.
     */
    contentDigest: string;

    /**
     * Number of rule lines in that source.
     */
    ruleCount: number;

    /**
     * Number of configured filter sources beyond the official filter manager.
     */
    extraSourceCount: number;
}

/**
 * Receipt proving one exact published line was replaced or deleted inside the locked baseline and
 * nothing else.
 */
export interface BaselineEditReceipt {
    /**
     * Official catalog ID whose attributed baseline resource carried the line.
     */
    filterId: number;

    /**
     * SHA-256 of that resource before the mutation, which must be the digest locked at preparation.
     */
    beforeSha256: string;

    /**
     * SHA-256 of that resource after the mutation.
     */
    afterSha256: string;

    /**
     * Number of lines the mutation changed or deleted inside that resource.
     */
    replacedLineCount: number;

    /**
     * Number of configured filter sources beyond the official filter manager.
     */
    extraSourceCount: number;
}

/**
 * Stable path-free failure classifications for the CLI evidence route.
 */
export const EvidenceRouteFailureCode = {
    /**
     * The route could not describe the blocker or download the filters it runs.
     */
    ConfigurationFailed: 'configuration_failed',

    /**
     * The blocker's filtering foreground did not start.
     */
    ForegroundFailed: 'foreground_failed',

    /**
     * The route was asked for a session before it was configured, or after it stopped.
     */
    RouteUnavailable: 'route_unavailable',

    /**
     * The proxied browser session could not be launched.
     */
    BrowserLaunchFailed: 'browser_launch_failed',
} as const;

/**
 * EvidenceRouteFailureCode value.
 */
export type EvidenceRouteFailureCode =
    (typeof EvidenceRouteFailureCode)[keyof typeof EvidenceRouteFailureCode];

/**
 * Lifecycle states of the CLI evidence route host.
 */
export const EvidenceRouteState = {
    /**
     * Created, nothing prepared yet.
     */
    New: 'new',

    /**
     * The blocker is described and the filters are downloaded.
     */
    Configured: 'configured',

    /**
     * The blocker's filtering foreground is running.
     */
    ForegroundRunning: 'foreground_running',

    /**
     * Stopped on the run's terminal path.
     */
    Stopped: 'stopped',

    /**
     * A step failed; the snapshot carries the first failure code.
     */
    Failed: 'failed',
} as const;

/**
 * EvidenceRouteState value.
 */
export type EvidenceRouteState = (typeof EvidenceRouteState)[keyof typeof EvidenceRouteState];

/**
 * Optional cause carrier for an evidence route failure.
 */
interface EvidenceRouteErrorOptions {
    /**
     * The underlying engine or browser error, when one exists.
     */
    cause?: unknown;
}

/**
 * Stable non-echoing failure raised by the evidence route host.
 *
 * The message stays path-free for public evidence; the underlying engine or browser error rides
 * along as `cause` so runtime diagnostics (for example the fatal-signal extraction that classifies
 * deterministic launch crashes) can still read the full chain.
 */
export class EvidenceRouteError extends Error {
    /**
     * Create one path-free evidence route failure.
     *
     * @param code - Stable public failure classification.
     * @param options - Optional cause chain retaining the underlying failure for diagnostics.
     */
    constructor(
        readonly code: EvidenceRouteFailureCode,
        options?: EvidenceRouteErrorOptions,
    ) {
        super(`AdGuard CLI evidence route failed: ${code}.`, options);
        this.name = 'EvidenceRouteError';
    }
}

/**
 * Path-free evidence route lifecycle snapshot retained for run evidence.
 */
export interface EvidenceRouteSnapshot {
    /**
     * Current host state.
     */
    state: EvidenceRouteState;
    /**
     * Loopback proxy port after the foreground started, or null.
     */
    port: number | null;
    /**
     * Whether the official Base Filter (ID 2) was enabled for the session.
     */
    baseFilterEnabled: boolean;

    /**
     * Official filter identifiers the reporter had enabled and the CLI accepted.
     */
    reproducedFilterIds: readonly number[];

    /**
     * Reporter identifiers the CLI catalog did not accept, kept as an evidence fidelity gap.
     */
    unavailableFilterIds: readonly number[];
    /**
     * First terminal failure classification, or null.
     */
    failureCode: EvidenceRouteFailureCode | null;
}

/**
 * Exact inputs for one proxied evidence browser session.
 */
export interface EvidenceSessionRequest {
    /**
     * Exact locked HTTPS target the session may open.
     */
    targetUrl: string;
    /**
     * Reporter-derived reproduction profile.
     */
    reproProfile: ReproProfile;
    /**
     * Existing artifacts directory for session captures.
     */
    artifactsDir: string;
    /**
     * Headless launch flag.
     */
    headless: boolean;
    /**
     * Chromium sandbox opt-out.
     */
    noSandbox: boolean;
    /**
     * Run logger.
     */
    logger: Logger;
}

/**
 * Command and candidate ports the executing environment adapter drives.
 */
export interface EvidenceRoutePorts {
    /**
     * Exact engine version the adapter binds into its proof, or null when the executing build does
     * not know one.
     */
    cliVersion: string | null;

    /**
     * Exact executing product label the adapter reports as its actual context.
     */
    product: string;

    /**
     * Verified installation provenance digest.
     */
    installationDigest: string;

    /**
     * Bounded command and storage boundary for the isolated installation.
     */
    baselineHost: BaselineHostPort;

    /**
     * Install exactly one agent-authored rule beside the locked official baseline.
     *
     * @param rule - Exact single candidate line.
     * @returns Receipt describing what the isolated installation now executes.
     */
    applyCandidate(rule: string): Promise<CandidateReceipt>;

    /**
     * Remove the agent-authored source, leaving only the locked official baseline.
     */
    revokeCandidate(): Promise<void>;

    /**
     * Replace one exact line inside the locked published baseline.
     *
     * The route locates the line across the lists it executes and refuses rather than guesses when
     * the line does not occur exactly once; every other byte stays untouched.
     *
     * @param originalRule - Exact published line to replace.
     * @param replacementRule - Complete replacement line.
     * @returns Receipt describing what the isolated installation now executes.
     */
    applyBaselineEdit(originalRule: string, replacementRule: string): Promise<BaselineEditReceipt>;

    /**
     * Delete one exact line from the locked published baseline, under the same uniqueness rule.
     *
     * @param originalRule - Exact published line to delete.
     * @returns Receipt describing what the isolated installation now executes.
     */
    applyBaselineRemoval(originalRule: string): Promise<BaselineEditReceipt>;

    /**
     * Restore the locked published baseline bytes.
     *
     * @returns SHA-256 of the restored resource, or null when no mutation was in effect.
     */
    revokeBaselineEdit(): Promise<string | null>;
}

/**
 * Host-owned CLI evidence route: pinned configuration, filtering foreground, and a strict-route
 * browser session whose traffic is filtered by the activated AdGuard CLI proxy.
 */
export interface EvidenceRouteHost {
    /**
     * Write the pinned release configuration before the first licensed CLI command.
     */
    prepareConfiguration(): Promise<void>;
    /**
     * Start the filtering foreground once and launch one proxied evidence browser session.
     *
     * @param request - Exact target, profile, and launch facts.
     * @returns Live browser session owned by the caller.
     */
    launchEvidenceSession(request: EvidenceSessionRequest): Promise<BrowserSession>;
    /**
     * Build the command and candidate ports the common CLI environment adapter drives.
     *
     * Exposed by the route because it already owns the verified installation: the adapter needs the
     * same isolated boundary the evidence sessions run through, not a second one.
     *
     * @returns Ports bound to this run's installation.
     */
    environmentPorts(): EvidenceRoutePorts;

    /**
     * Start the applied-rules log of the session launched last: what the route's filtering engine
     * reports from this moment on, in its own logs and inside the session's pages. The runtime
     * opens it right after the session launches, before the session navigates anywhere.
     *
     * @param session - The session launched last.
     * @param logger - Run logger for whatever the log cannot read.
     * @returns The session's applied-rules log.
     */
    openAppliedRulesLog(session: BrowserSession, logger: Logger): Promise<AppliedRulesLog>;

    /**
     * Stop whatever the route itself owns. Idempotent, and absent for routes that own nothing.
     *
     * The AdGuard CLI route implements no teardown: its foreground child is registered with the
     * same-activation lifecycle, which owns terminal stop, reap, and licence reset, and a second
     * path here would race it. A CLI proxy route has no such owner — the proxy is its own process
     * and nothing else will end it — so that route does implement this.
     */
    stop?(): Promise<void>;

    /**
     * Read the path-free route snapshot.
     *
     * @returns Immutable evidence route state.
     */
    snapshot(): EvidenceRouteSnapshot;
}
