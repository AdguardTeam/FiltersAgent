import { createHash } from 'node:crypto';
import * as nodePath from 'node:path';
import * as v from 'valibot';
import type { IBrowserSession } from '../browser/browser-interfaces';
import {
    hashStream,
    nodeBaselineFileSystem,
    sameMetadata,
    type BaselineFileMetadata,
    type BaselineFileSystemPort,
} from './baseline-file-lock';
import { lockMv2ExtensionBaseline } from './browser-extension-mv2-baseline';
import { BrowserExtensionExecutorName } from './executor-name';
import { ExtensionManifestVersion } from './extension-preparation';
import {
    EnvironmentAdapterLimitationCode,
    EnvironmentLimitationStage,
    EnvironmentLifecycle,
    type AdapterPhaseLease,
    type EnvironmentCleanupReceipt,
    type EnvironmentAdapterLimitation,
    type EnvironmentHandleDrainReceipt,
    type EnvironmentPhaseOpenResult,
    type EnvironmentPhaseRequest,
    type EnvironmentPreparationRequest,
    type EnvironmentPreparationResult,
    type FilteringEnvironmentAdapter,
    type FilteringEnvironmentAdapterState,
} from './filtering-environment';
import {
    EnvironmentFilteringState,
    BlockerVerificationMethod,
    type ActionLogEntry,
    PublishedBaselineProvenanceSchema,
    type PublishedBaselineProvenance,
} from './environment-proofs';
import type { ApplicationInstructionGap } from './application-instruction-gap';
import {
    describeOfficialFilterSetDisagreement,
    officialFilterSetDisagreement,
} from './official-filter-set-agreement';
import {
    adguardListKey,
    requestedListsToRegistryIds,
    resolveAdguardListKey,
    type FilterListKey,
} from './filter-list-ref';
import { BrowserDisplayName } from '../types/browser-display-name';
import { PhaseLabel } from '../types/validation';
import { normalizeRulesContent, observedRulesDigest, sha256OfContent } from './rules-content';
import { type SettingsProfileKind } from '../types/settings-profile-kind';
import type { SettingsLimitation } from './settings-limitation';

export const MAX_EXTENSION_MANIFEST_BYTES = 2 * 1024 * 1024;
export const MAX_EXTENSION_RULESET_RESOURCES = 128;
export const MAX_EXTENSION_RULESET_BYTES = 64 * 1024 * 1024;
export const MAX_EXTENSION_BASELINE_BYTES = 256 * 1024 * 1024;

/**
 * Browser-observed filter identities and catalog versions used to lock a baseline.
 */
export interface ExtensionBaselineSettings {
    /**
     * Exact filter IDs enabled in final settings.
     */
    enabledFilterIds: number[];

    /**
     * Filter IDs independently observed in options metadata.
     */
    optionsEnabledFilterIds: number[];

    /**
     * Filter IDs reported by the Extension runtime.
     */
    runtimeEnabledFilterIds: number[];

    /**
     * Filter IDs whose DNR rulesets Chromium reports as active.
     */
    activeRulesetFilterIds: number[];

    /**
     * Optional published versions indexed by official filter ID.
     */
    versions: ReadonlyMap<number, string>;
}

/**
 * Input for exact executable baseline locking.
 */
export interface ExtensionBaselineLockRequest {
    /**
     * Trusted unpacked Extension root.
     */
    extensionRoot: string;

    /**
     * Browser-observed settings and active-ruleset proof.
     */
    settings: ExtensionBaselineSettings;

    /**
     * Deterministic acquisition timestamp.
     */
    acquiredAt: string;
}

/**
 * Successfully locked executable Extension baseline.
 */
export interface ReadyExtensionBaselineLock {
    /**
     * Discriminator for a locked baseline.
     */
    ready: true;

    /**
     * Exact executable baseline provenance.
     */
    baseline: PublishedBaselineProvenance;
}

/**
 * Baseline lock stopped by a stable limitation.
 */
export interface LimitedExtensionBaselineLock {
    /**
     * Discriminator for an unavailable baseline.
     */
    ready: false;

    /**
     * Stable baseline limitation.
     */
    limitation: EnvironmentAdapterLimitation;
}

/**
 * Ready exact baseline or stable public limitation.
 */
export type ExtensionBaselineLockResult = ReadyExtensionBaselineLock | LimitedExtensionBaselineLock;

/**
 * Raw MV3 ruleset resource parsed from the bounded manifest.
 */
interface ManifestRulesetResource {
    /**
     * Chromium DNR resource identity.
     */
    id: string;

    /**
     * Whether the resource is declared initially enabled.
     */
    enabled: boolean;

    /**
     * Manifest-relative JSON path.
     */
    path: string;
}

/**
 * Bounded subset of the MV3 manifest used by the locker.
 */
interface ParsedExtensionManifest {
    /**
     * Declared manifest format version.
     */
    manifestVersion: number;

    /**
     * Declared declarative-net-request resources.
     */
    resources: ManifestRulesetResource[];
}

/**
 * Manifest resource matched to one official filter identity.
 */
interface SelectedManifestResource {
    /**
     * Official filter identity.
     */
    filterId: number;

    /**
     * Expected MV3 ruleset identity.
     */
    expectedId: string;

    /**
     * Every manifest resource carrying the expected identity.
     */
    matches: ManifestRulesetResource[];
}

/**
 * Resource identity captured before its bytes are streamed.
 */
interface PreflightBaselineResource {
    /**
     * Official filter identity.
     */
    filterId: number;

    /**
     * Exact MV3 ruleset identity.
     */
    rulesetId: string;

    /**
     * Portable manifest-relative path.
     */
    portablePath: string;

    /**
     * Resolved local resource path.
     */
    path: string;

    /**
     * No-follow metadata captured before streaming.
     */
    metadata: BaselineFileMetadata;
}

/**
 * Build a bounded stable public limitation.
 *
 * @param code - Stable public failure category.
 * @param stage - Stable lifecycle stage.
 * @param detail - Constant public detail without filesystem identity.
 * @returns Schema-compatible public limitation.
 */
function limitation(
    code: EnvironmentAdapterLimitation['code'],
    stage: EnvironmentAdapterLimitation['stage'],
    detail: string,
): EnvironmentAdapterLimitation {
    return { code, stage, detail: detail.slice(0, 500) };
}

/**
 * Return one sorted de-duplicated numeric ID list or null for malformed input.
 *
 * @param values - Candidate filter IDs.
 * @returns Canonical IDs or null.
 */
function canonicalIds(values: readonly number[]): number[] | null {
    if (values.some((value) => !Number.isInteger(value) || value < 1)) {
        return null;
    }
    const ids = [...new Set(values)].reduce<number[]>((ordered, value) => {
        const insertionIndex = ordered.findIndex((existing) => existing > value);
        if (insertionIndex === -1) {
            return [...ordered, value];
        }
        return [...ordered.slice(0, insertionIndex), value, ...ordered.slice(insertionIndex)];
    }, []);
    return ids.length === values.length ? ids : null;
}

/**
 * Require exact agreement among all runtime filter identity proofs.
 *
 * @param settings - Browser-observed settings proof.
 * @returns Canonical enabled IDs or null on disagreement.
 */
function agreedFilterIds(settings: ExtensionBaselineSettings): number[] | null {
    const sets = [
        settings.enabledFilterIds,
        settings.optionsEnabledFilterIds,
        settings.runtimeEnabledFilterIds,
        settings.activeRulesetFilterIds,
    ].map(canonicalIds);
    if (sets.some((ids) => ids === null)) {
        return null;
    }
    const serialized = sets.map((ids) => JSON.stringify(ids));
    return serialized.every((value) => value === serialized[0]) ? sets[0] : null;
}

/**
 * Read only the manifest generation needed to dispatch to the matching baseline locker.
 *
 * @param source - Bounded manifest JSON.
 * @returns Declared manifest generation.
 */
function parseManifestVersion(source: string): number {
    const value: unknown = JSON.parse(source);
    if (!value || typeof value !== 'object') {
        throw new Error('manifest object required');
    }
    return Number((value as Record<string, unknown>).manifest_version);
}

/**
 * Parse only the bounded MV3 rule-resource structure needed for executable locking.
 *
 * @param source - Bounded manifest JSON.
 * @returns Parsed resources and manifest version.
 */
function parseManifest(source: string): ParsedExtensionManifest {
    const value: unknown = JSON.parse(source);
    if (!value || typeof value !== 'object') {
        throw new Error('manifest object required');
    }
    const manifest = value as Record<string, unknown>;
    const dnr = manifest.declarative_net_request;
    if (!dnr || typeof dnr !== 'object') {
        throw new Error('DNR manifest block required');
    }
    const rawResources = (dnr as Record<string, unknown>).rule_resources;
    if (!Array.isArray(rawResources)) {
        throw new Error('DNR resources required');
    }
    if (rawResources.length > MAX_EXTENSION_RULESET_RESOURCES) {
        return {
            manifestVersion: Number(manifest.manifest_version),
            resources: rawResources as ManifestRulesetResource[],
        };
    }
    const resources = rawResources.map((resource) => {
        if (!resource || typeof resource !== 'object') {
            throw new Error('invalid resource');
        }
        const record = resource as Record<string, unknown>;
        if (
            typeof record.id !== 'string' ||
            typeof record.enabled !== 'boolean' ||
            typeof record.path !== 'string'
        ) {
            throw new Error('invalid resource');
        }
        return { id: record.id, enabled: record.enabled, path: record.path };
    });
    return { manifestVersion: Number(manifest.manifest_version), resources };
}

/**
 * Check whether text contains a prohibited ASCII control character.
 *
 * @param value - Text to inspect.
 * @returns Whether at least one prohibited code point is present.
 */
function hasControlCharacter(value: string): boolean {
    return [...value].some((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
    });
}

/**
 * Validate an already-normalized POSIX manifest-relative path.
 *
 * @param path - Manifest-owned resource path.
 * @returns Whether the path is safe and canonical.
 */
function isSafeManifestPath(path: string): boolean {
    if (
        path.length === 0 ||
        path.length > 1_024 ||
        nodePath.isAbsolute(path) ||
        path.includes('\\') ||
        hasControlCharacter(path) ||
        nodePath.posix.normalize(path) !== path
    ) {
        return false;
    }
    const segments = path.split('/');
    return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

/**
 * Test whether a canonical resource path remains under the canonical Extension root.
 *
 * @param root - Canonical Extension root.
 * @param target - Canonical resource path.
 * @returns Whether target is a strict descendant of root.
 */
function isContained(root: string, target: string): boolean {
    const child = nodePath.relative(root, target);
    return (
        child.length > 0 &&
        child !== '..' &&
        !child.startsWith(`..${nodePath.sep}`) &&
        !nodePath.isAbsolute(child)
    );
}

/**
 * Integrity-lock exact executable MV3 ruleset bytes selected by browser-observed settings.
 *
 * @param request - Extension root, observed settings, and acquisition timestamp.
 * @param fileSystem - Optional deterministic filesystem boundary.
 * @returns Exact baseline provenance or a stable path-free limitation.
 */
export async function lockBrowserExtensionBaseline(
    request: ExtensionBaselineLockRequest,
    fileSystem: BaselineFileSystemPort = nodeBaselineFileSystem,
): Promise<ExtensionBaselineLockResult> {
    const manifestPath = nodePath.resolve(request.extensionRoot, 'manifest.json');
    try {
        const manifestMetadata = await fileSystem.inspect(manifestPath);
        if (
            manifestMetadata.symbolicLink ||
            !manifestMetadata.regular ||
            manifestMetadata.size > MAX_EXTENSION_MANIFEST_BYTES
        ) {
            return {
                ready: false,
                limitation: limitation(
                    EnvironmentAdapterLimitationCode.BaselineManifestInvalid,
                    'baseline',
                    'The Extension manifest is not a bounded regular file.',
                ),
            };
        }
        const source = await fileSystem.readBounded(manifestPath, MAX_EXTENSION_MANIFEST_BYTES);
        if (Buffer.byteLength(source) > MAX_EXTENSION_MANIFEST_BYTES) {
            return {
                ready: false,
                limitation: limitation(
                    EnvironmentAdapterLimitationCode.BaselineManifestInvalid,
                    'baseline',
                    'The Extension manifest exceeds the accepted byte limit.',
                ),
            };
        }
        if (parseManifestVersion(source) === 2) {
            return await lockMv2ExtensionBaseline(request, fileSystem);
        }
        const filterIds = agreedFilterIds(request.settings);
        if (!filterIds || filterIds.length === 0) {
            return {
                ready: false,
                limitation: limitation(
                    EnvironmentAdapterLimitationCode.SettingsMismatch,
                    'baseline',
                    'The Extension settings and active ruleset identities do not agree.',
                ),
            };
        }
        const manifest = parseManifest(source);
        if (manifest.manifestVersion !== ExtensionManifestVersion.Mv3) {
            return {
                ready: false,
                limitation: limitation(
                    EnvironmentAdapterLimitationCode.BaselineManifestInvalid,
                    'baseline',
                    'The prepared Extension does not declare Manifest V3.',
                ),
            };
        }
        if (manifest.resources.length > MAX_EXTENSION_RULESET_RESOURCES) {
            return {
                ready: false,
                limitation: limitation(
                    EnvironmentAdapterLimitationCode.BaselineResourceLimitExceeded,
                    'baseline',
                    'The Extension declares too many ruleset resources.',
                ),
            };
        }
        const selected: SelectedManifestResource[] = filterIds.map((filterId) => {
            const expectedId = `ruleset_${filterId}`;
            const matches = manifest.resources.filter((resource) => resource.id === expectedId);
            return { filterId, expectedId, matches };
        });
        // Only resource existence and uniqueness are provable from the manifest: the static
        // enabled flags are the build defaults (the shipped build enables only ruleset_2), while
        // the actually enabled set is toggled at runtime through the DNR API and is already
        // proven exact by the settings identity agreement above. Reading the static flags made
        // every non-default reporter set fail baseline_integrity_unavailable.
        if (selected.some(({ matches }) => matches.length !== 1)) {
            return {
                ready: false,
                limitation: limitation(
                    EnvironmentAdapterLimitationCode.BaselineIntegrityUnavailable,
                    'baseline',
                    'A requested filter has no unique ruleset resource in the Extension manifest.',
                ),
            };
        }
        if (selected.some(({ matches }) => !isSafeManifestPath(matches[0].path))) {
            return {
                ready: false,
                limitation: limitation(
                    EnvironmentAdapterLimitationCode.BaselineResourceUnsafe,
                    'baseline',
                    'A selected ruleset path is not a safe normalized relative path.',
                ),
            };
        }
        const canonicalRoot = await fileSystem.realpath(nodePath.resolve(request.extensionRoot));
        const preflight: PreflightBaselineResource[] = [];
        let totalBytes = 0;
        for (const item of selected) {
            const resource = item.matches[0];
            const path = nodePath.resolve(request.extensionRoot, resource.path);
            const metadata = await fileSystem.inspect(path);
            const canonicalPath = await fileSystem.realpath(path);
            if (
                metadata.symbolicLink ||
                !metadata.regular ||
                !isContained(canonicalRoot, canonicalPath)
            ) {
                return {
                    ready: false,
                    limitation: limitation(
                        EnvironmentAdapterLimitationCode.BaselineResourceUnsafe,
                        'baseline',
                        'A selected ruleset is not a regular file inside the Extension root.',
                    ),
                };
            }
            if (metadata.size > MAX_EXTENSION_RULESET_BYTES) {
                return {
                    ready: false,
                    limitation: limitation(
                        EnvironmentAdapterLimitationCode.BaselineResourceLimitExceeded,
                        'baseline',
                        'A selected ruleset exceeds the accepted byte limit.',
                    ),
                };
            }
            totalBytes += metadata.size;
            if (totalBytes > MAX_EXTENSION_BASELINE_BYTES) {
                return {
                    ready: false,
                    limitation: limitation(
                        EnvironmentAdapterLimitationCode.BaselineResourceLimitExceeded,
                        'baseline',
                        'The selected ruleset aggregate exceeds the accepted byte limit.',
                    ),
                };
            }
            preflight.push({
                filterId: item.filterId,
                rulesetId: item.expectedId,
                portablePath: resource.path,
                path,
                metadata,
            });
        }
        const resources: PublishedBaselineProvenance['resources'] = [];
        for (const resource of preflight) {
            const opened = await fileSystem.openNoFollow(resource.path);
            let sha256: string | null = null;
            let descriptorBefore: BaselineFileMetadata | null = null;
            let descriptorAfter: BaselineFileMetadata | null = null;
            let postflight: BaselineFileMetadata | null = null;
            try {
                descriptorBefore = await opened.stat();
                sha256 = await hashStream(resource.metadata.size, opened);
                descriptorAfter = await opened.stat();
                postflight = await fileSystem.inspect(resource.path);
            } finally {
                await opened.close();
            }
            if (
                !sha256 ||
                !descriptorBefore ||
                !descriptorAfter ||
                !postflight ||
                !sameMetadata(resource.metadata, descriptorBefore) ||
                !sameMetadata(descriptorBefore, descriptorAfter) ||
                !sameMetadata(descriptorAfter, postflight)
            ) {
                return {
                    ready: false,
                    limitation: limitation(
                        EnvironmentAdapterLimitationCode.BaselineResourceChanged,
                        'baseline',
                        'A selected ruleset changed while its executable bytes were locked.',
                    ),
                };
            }
            resources.push({
                listKey: adguardListKey(resource.filterId),
                rulesetId: resource.rulesetId,
                path: resource.portablePath,
                version: request.settings.versions.get(resource.filterId) ?? null,
                byteCount: resource.metadata.size,
                sha256,
            });
        }
        const aggregateDigest = createHash('sha256')
            .update(JSON.stringify(resources))
            .digest('hex');
        return {
            ready: true,
            baseline: v.parse(PublishedBaselineProvenanceSchema, {
                environment: BrowserExtensionExecutorName,
                acquiredAt: request.acquiredAt,
                enabledListKeys: filterIds.map(adguardListKey),
                resources,
                aggregateDigest,
            }),
        };
    } catch {
        return {
            ready: false,
            limitation: limitation(
                EnvironmentAdapterLimitationCode.BaselineIntegrityUnavailable,
                'baseline',
                'The exact Extension ruleset bytes could not be integrity-locked.',
            ),
        };
    }
}

/**
 * Adapter-owned request to one concrete Extension session factory.
 */
export interface BrowserExtensionSessionRequest {
    /**
     * Exact A/B/C phase.
     */
    phase: EnvironmentPhaseRequest['phase'];

    /**
     * Canonical target URL.
     */
    targetUrl: string;

    /**
     * Extension root for B/C or null for A.
     */
    extensionRoot: string | null;
}

/**
 * The blocker-state read one application session left behind, exactly as the host read it back.
 *
 * The digest and enabled-set credit of a phase comes from this read only — never from a launch-time
 * piece and never from the application model's self-report.
 */
export interface EnvironmentPhaseStateRead {
    /**
     * Exact user-rule content the state carries, one line per rule.
     */
    rulesContent?: string;

    /**
     * SHA-256 over the exact rule content, when the state exposes its digest directly.
     */
    rulesContentSha256?: string;

    /**
     * Enabled filter list keys the state reports. The host read-back converts the adapter's own
     * native identity into these keys, so the read-back credit never speaks registry numbers.
     */
    enabledFilterIds?: readonly FilterListKey[];

    /**
     * Filter list keys the state reports as active DNR rulesets, when it can observe them (MV3).
     */
    activeRulesetFilterIds?: readonly FilterListKey[];

    /**
     * Whether the state reports MV3 filter or rule limits exceeded, when it can observe them (MV3).
     */
    limitsExceeded?: boolean;

    /**
     * Tracking-protection state the live settings carry.
     */
    stealthEnabled?: boolean;
}

/**
 * What one between-phases configuration is asked to bring the blocker to.
 */
export const EnvironmentPhaseConfigurationOutcome = {
    /**
     * The host read the state back and it contains exactly the expected content.
     */
    Applied: 'applied',

    /**
     * The instruction's application contract is missing or unsupported: no model turn was made.
     */
    Refused: 'refused',

    /**
     * The steps ran but the state read back does not contain the expected content.
     */
    Unverified: 'unverified',
} as const;

/**
 * EnvironmentPhaseConfigurationOutcome value.
 */
export type EnvironmentPhaseConfigurationOutcome =
    (typeof EnvironmentPhaseConfigurationOutcome)[keyof typeof EnvironmentPhaseConfigurationOutcome];

/**
 * Request to configure one established phase session by the run instruction's application steps.
 *
 * The adapter forwards it verbatim to the option's implementation (the run's application
 * procedure); it consumes only the outcome.
 */
export interface EnvironmentPhaseConfigurationRequest {
    /**
     * Exact A/B/C phase the session was opened for.
     */
    phase: EnvironmentPhaseRequest['phase'];

    /**
     * Canonical target URL the phase observes.
     */
    targetUrl: string;

    /**
     * Exact candidate rule for C, null for the B plugging goal.
     */
    candidateRule: string | null;

    /**
     * The run's application instruction content whose contract the application performs.
     */
    application: string;

    /**
     * Enabled filter list key set the environment prepared and B must return to.
     */
    baselineEnabledFilterIds: readonly FilterListKey[];

    /**
     * Caller cancellation when the outer deadline provides one.
     */
    signal?: AbortSignal;
}

/**
 * Result of one between-phases configuration of an established phase session.
 */
export type EnvironmentPhaseConfigurationResult =
    | {
          /**
           * Discriminator: the state read back contains exactly the expected content.
           */
          kind: typeof EnvironmentPhaseConfigurationOutcome.Applied;

          /**
           * The verification method whose read-back credited the goal.
           */
          method: BlockerVerificationMethod;

          /**
           * The blocker state the host read back itself.
           */
          readBack: EnvironmentPhaseStateRead;

          /**
           * Host-assembled tool trace of the application session.
           */
          actionLog: ActionLogEntry[];

          /**
           * What the credit could not observe, as the application procedure recorded it (a
           * file-backed read-back cannot report the enabled filter set); carried into the phase
           * proof so the run record says how the phase was credited.
           */
          detail?: string;

          /**
           * The session the phase must be observed over, when the application replaced the one it
           * was handed. A host-performed file-backed application relaunches the browser so it reads
           * the rebuilt enterprise policies at startup, and the session it was handed is closed by
           * then. Absent when the application left that session running.
           */
          session?: IBrowserSession;
      }
    | {
          /**
           * Discriminator: the application contract refused before any model turn.
           */
          kind: typeof EnvironmentPhaseConfigurationOutcome.Refused;

          /**
           * The stable refusal class recording what the instruction is missing.
           */
          gap: ApplicationInstructionGap;

          /**
           * Bounded detail naming what is missing.
           */
          detail: string;
      }
    | {
          /**
           * Discriminator: steps ran, but the read-back does not contain the expectation.
           */
          kind: typeof EnvironmentPhaseConfigurationOutcome.Unverified;

          /**
           * Bounded detail naming the mismatch or the failure the read-back hit.
           */
          detail: string;

          /**
           * The browser limit that made the expectation unreachable, when the application's credit
           * diagnosed one.
           */
          settingsLimitation?: SettingsLimitation;

          /**
           * The session that is live now, when the application replaced the one it was handed
           * before failing to verify: the phase never opens, but the environment must still close
           * the session that is actually running rather than the one already closed.
           */
          session?: IBrowserSession;
      };

/**
 * Concrete session produced for one adapter phase.
 */
export interface BrowserExtensionCreatedSession {
    /**
     * Common browser surface exposed to validators.
     */
    session: IBrowserSession;
}

/**
 * Deterministic construction seams for the Browser Extension adapter.
 */
export interface BrowserExtensionEnvironmentOptions {
    /**
     * Verified unpacked Extension root.
     */
    extensionRoot: string;

    /**
     * Exact package version from verified build provenance.
     */
    packageVersion: string;

    /**
     * Exact manifest version from verified build provenance.
     */
    manifestVersion: string;

    /**
     * Settings profile kind the run's sessions were launched with, recorded in every extension
     * proof.
     */
    profileKind: SettingsProfileKind;

    /**
     * The run's application instruction content whose contract the between-phases application
     * performs (the run instruction, or the built-in AdGuard document for runs without one).
     */
    application: string;

    /**
     * Complete verified cache/build provenance projected into durable Extension results.
     */
    extensionProvenance?: v.InferOutput<
        typeof import('./environment-proofs').ExtensionAdapterProofSchema
    >['provenance'];

    /**
     * Immutable verified build digest.
     */
    buildDigest: string;

    /**
     * Obtain browser-verified settings for preparation and every B/C recheck.
     *
     * @param requestedFilterIds - Exact official filter IDs requested for the baseline.
     * @returns Browser-observed settings evidence.
     */
    settingsProvider(requestedFilterIds: number[]): Promise<ExtensionBaselineSettings>;

    /**
     * Create a concrete phase session in the exact requested filtering state.
     *
     * @param request - Adapter-owned session request.
     * @returns The created session.
     */
    createSession(request: BrowserExtensionSessionRequest): Promise<BrowserExtensionCreatedSession>;

    /**
     * Configure one established phase session by the run instruction's application steps.
     *
     * Implemented by the run's application procedure: the model performs the instruction's steps
     * over the lease session and the host reads the blocker state back itself. The adapter credits
     * the phase from the returned read-back and outcome only.
     *
     * @param session - The created phase lease session the application tools act on.
     * @param request - Phase, target, candidate, instruction, and the prepared baseline set.
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
     * Injectable exact baseline locker.
     */
    lockBaseline?: typeof lockBrowserExtensionBaseline;

    /**
     * Optional final adapter-specific cleanup.
     *
     * @returns Nothing after cleanup completes.
     */
    finalize?: () => Promise<void>;
}

/**
 * One open phase resource retained until successful close.
 */
interface OpenBrowserExtensionLease {
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
 * Browser Extension implementation of the common filtering environment contract.
 */
export class BrowserExtensionEnvironmentAdapter implements FilteringEnvironmentAdapter {
    readonly kind = BrowserExtensionExecutorName;

    /**
     * Adapter-authored context derived from its verified build and controlled session family.
     */
    private readonly actualContext: FilteringEnvironmentAdapterState['actualContext'];

    /**
     * Browser-verified settings locked during preparation.
     */
    private preparedSettings: ExtensionBaselineSettings | null = null;

    /**
     * Registry ids of the locked baseline, ascending — the exact numeric input the native settings
     * recheck receives.
     */
    private preparedFilterIds: readonly number[] = [];

    /**
     * Exact executable baseline locked during preparation.
     */
    private baseline: PublishedBaselineProvenance | null = null;

    /**
     * Stable adapter state digest bound into every phase proof.
     */
    private stateDigest: string;

    /**
     * Current lifecycle state.
     */
    private lifecycle: FilteringEnvironmentAdapterState['lifecycle'] = 'unprepared';

    /**
     * Every opened session retained until a successful close.
     */
    private readonly openLeases = new Map<string, OpenBrowserExtensionLease>();

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
    private readonly createLeaseId: (phase: EnvironmentPhaseRequest['phase']) => string;

    /**
     * Exact baseline locker.
     */
    private readonly lockBaseline: typeof lockBrowserExtensionBaseline;

    /**
     * Create one unprepared adapter over verified Extension production seams.
     *
     * @param options - Verified build, settings, browser, and lifecycle dependencies.
     */
    constructor(private readonly options: BrowserExtensionEnvironmentOptions) {
        this.actualContext = {
            kind: this.kind,
            product: 'AdGuard Browser Extension',
            browser: BrowserDisplayName.CloakBrowserChromium,
            productVersion: options.packageVersion,
        };
        this.now = options.now ?? (() => new Date().toISOString());
        this.createLeaseId =
            options.createLeaseId ??
            ((phase) =>
                `${phase.toLowerCase()}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        this.lockBaseline = options.lockBaseline ?? lockBrowserExtensionBaseline;
        this.stateDigest = createHash('sha256')
            .update(
                JSON.stringify({
                    buildDigest: options.buildDigest,
                    packageVersion: options.packageVersion,
                    manifestVersion: options.manifestVersion,
                    actualContext: this.actualContext,
                }),
            )
            .digest('hex');
    }

    /**
     * Return the common capabilities implemented by the Extension adapter.
     *
     * @returns Fresh capability list.
     */
    capabilities(): FilteringEnvironmentAdapterState['capabilities'] {
        return [
            'browser_navigation',
            'filtering_control',
            'extension_filtering',
            'candidate_application',
            'baseline_integrity',
            'phase_proof',
        ];
    }

    /**
     * Obtain browser settings and lock exact MV3 ruleset bytes.
     *
     * @param request - Exact official filter selection.
     * @returns Ready adapter state or a typed limitation.
     */
    async prepare(request: EnvironmentPreparationRequest): Promise<EnvironmentPreparationResult> {
        if (this.lifecycle === 'ready') {
            return { ready: true, state: this.snapshot() };
        }
        if (this.cleanupReceipt) {
            return {
                ready: false,
                limitation: limitation(
                    EnvironmentAdapterLimitationCode.PhaseOpenFailed,
                    'preparation',
                    'The Extension environment has already been cleaned up.',
                ),
            };
        }
        try {
            const requestedFilterIds = requestedListsToRegistryIds(request.requestedLists);
            if (requestedFilterIds === null) {
                // Preparation derives the baseline manifest from the requested lists, so an
                // unresolvable requested key is a preparation-stage manifest-validation failure:
                // refusing here keeps the baseline from being silently reduced.
                const unresolvable = request.requestedLists.find(
                    (ref) => resolveAdguardListKey(ref.key) === null,
                );
                this.lifecycle = 'limited';
                return {
                    ready: false,
                    limitation: limitation(
                        EnvironmentAdapterLimitationCode.BaselineManifestInvalid,
                        EnvironmentLimitationStage.Preparation,
                        `The requested filter list ${unresolvable?.key ?? 'key'} does not resolve ` +
                            'to an official AdGuard list.',
                    ),
                };
            }
            const settings = await this.options.settingsProvider([...requestedFilterIds]);
            const disagreement = officialFilterSetDisagreement(
                requestedFilterIds,
                settings.enabledFilterIds,
            );
            if (disagreement) {
                this.lifecycle = 'limited';
                return {
                    ready: false,
                    limitation: limitation(
                        EnvironmentAdapterLimitationCode.SettingsMismatch,
                        'preparation',
                        describeOfficialFilterSetDisagreement(disagreement),
                    ),
                };
            }
            const locked = await this.lockBaseline({
                extensionRoot: this.options.extensionRoot,
                settings,
                acquiredAt: this.now(),
            });
            if (!locked.ready) {
                this.lifecycle = 'limited';
                return locked;
            }
            this.preparedSettings = settings;
            this.preparedFilterIds = requestedFilterIds;
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
        } catch {
            this.lifecycle = 'limited';
            return {
                ready: false,
                limitation: limitation(
                    EnvironmentAdapterLimitationCode.BaselineIntegrityUnavailable,
                    'preparation',
                    'The Extension baseline could not be prepared.',
                ),
            };
        }
    }

    /**
     * Establish one true A/B/C session and retain it before post-create validation.
     *
     * @param request - Phase, target, and optional candidate.
     * @returns Common browser lease or typed limitation.
     */
    async openPhase(request: EnvironmentPhaseRequest): Promise<EnvironmentPhaseOpenResult> {
        if (this.lifecycle !== 'ready' || !this.baseline || !this.preparedSettings) {
            return {
                ready: false,
                limitation: limitation(
                    EnvironmentAdapterLimitationCode.PhaseOpenFailed,
                    'phase',
                    'The Extension environment is not ready for phase execution.',
                ),
            };
        }
        if (
            (request.phase !== PhaseLabel.C && request.candidate !== null) ||
            (request.phase === PhaseLabel.C && request.candidate?.operation !== 'add')
        ) {
            return {
                ready: false,
                limitation: limitation(
                    EnvironmentAdapterLimitationCode.CandidateOperationUnsupported,
                    'candidate',
                    'The selected environment cannot apply this candidate operation.',
                ),
            };
        }
        // A narrowed enabled set is a different settings profile and so a different aggregate
        // digest, which this adapter has no way to lock. It reports the limitation rather than
        // running the whole baseline and letting a probe read that as the subset it asked for.
        if (request.enabledListKeys != null) {
            return {
                ready: false,
                limitation: limitation(
                    EnvironmentAdapterLimitationCode.SettingsMismatch,
                    'phase',
                    'The Extension environment cannot narrow the enabled official filter set.',
                ),
            };
        }
        if (request.phase !== PhaseLabel.A) {
            const currentSettings = await this.options
                .settingsProvider([...this.preparedFilterIds])
                .catch(() => null);
            if (!currentSettings) {
                return {
                    ready: false,
                    limitation: limitation(
                        EnvironmentAdapterLimitationCode.SettingsMismatch,
                        'phase',
                        'The Extension settings could not be reverified for this phase.',
                    ),
                };
            }
            const relocked = await this.lockBaseline({
                extensionRoot: this.options.extensionRoot,
                settings: currentSettings,
                acquiredAt: this.baseline.acquiredAt,
            });
            if (
                !relocked.ready ||
                relocked.baseline.aggregateDigest !== this.baseline.aggregateDigest
            ) {
                return {
                    ready: false,
                    limitation: limitation(
                        EnvironmentAdapterLimitationCode.BaselineResourceChanged,
                        'phase',
                        'The Extension baseline changed before the requested phase.',
                    ),
                };
            }
        }
        const candidateDigest =
            request.phase === PhaseLabel.C && request.candidate
                ? sha256OfContent(normalizeRulesContent(request.candidate.rule))
                : null;
        const sessionRequest: BrowserExtensionSessionRequest = {
            phase: request.phase,
            targetUrl: request.targetUrl,
            extensionRoot: request.phase === PhaseLabel.A ? null : this.options.extensionRoot,
        };
        let created: BrowserExtensionCreatedSession;
        try {
            created = await this.options.createSession(sessionRequest);
        } catch (error) {
            // The native failure text rides the bounded limitation detail: without it every
            // session-create fault collapses into one constant string and bootstrap timeouts
            // cannot be told apart from any other establishment failure.
            return {
                ready: false,
                limitation: limitation(
                    EnvironmentAdapterLimitationCode.PhaseOpenFailed,
                    'phase',
                    'The controlled browser session could not be established: ' +
                        (error instanceof Error ? error.message : String(error)),
                ),
            };
        }
        const leaseId = this.createLeaseId(request.phase);
        this.openLeases.set(leaseId, { leaseId, session: created.session });

        // The candidate rule and the enabled set are applied by the run instruction's steps over
        // the established lease; the host reads the blocker state back itself and credits the
        // phase only from that read-back.
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
                // The locked baseline names every list the blocker activated, third-party rulesets
                // included; the requested ids name only the pinned official part of it, and a
                // phase session configured from those would run a narrower set than the one the
                // investigation ran on.
                baselineEnabledFilterIds: [...this.baseline.enabledListKeys],
                // Forwarded from the phase request so an experiment timeout aborts this B/C
                // application session instead of letting it run out its own per-session budget
                // after the parent deadline already fired.
                ...(request.signal === undefined ? {} : { signal: request.signal }),
            });
            // An application that had to relaunch the browser (the host-performed file-backed
            // application: Firefox reads enterprise policies only at startup) hands back the
            // session that is live now. It replaces the established one everywhere the phase uses
            // it — the lease the validators observe and the registry that closes it — including on
            // the failure paths below, where the session handed in is already closed.
            const configured =
                application.kind !== EnvironmentPhaseConfigurationOutcome.Refused &&
                application.session !== undefined
                    ? application.session
                    : created.session;
            if (configured !== created.session) {
                created = { session: configured };
                this.openLeases.set(leaseId, { leaseId, session: configured });
            }
            if (application.kind === EnvironmentPhaseConfigurationOutcome.Refused) {
                const phaseName = request.phase === PhaseLabel.C ? 'C' : 'B';
                return {
                    ready: false,
                    limitation: limitation(
                        EnvironmentAdapterLimitationCode.ApplicationInstructionRefused,
                        request.phase === PhaseLabel.C ? 'candidate' : 'phase',
                        `The phase ${phaseName} application was refused ` +
                            `[${application.gap}]: ${application.detail}`,
                    ),
                };
            }
            if (application.kind === EnvironmentPhaseConfigurationOutcome.Unverified) {
                return {
                    ready: false,
                    limitation: limitation(
                        request.phase === PhaseLabel.C
                            ? EnvironmentAdapterLimitationCode.CandidateApplicationFailed
                            : EnvironmentAdapterLimitationCode.PhaseProofUnavailable,
                        request.phase === PhaseLabel.C ? 'candidate' : 'phase',
                        request.phase === PhaseLabel.C
                            ? `The candidate user-rule application did not converge: ${application.detail}`
                            : `The baseline plugging did not return to the prepared set: ${application.detail}`,
                    ),
                };
            }
        }
        // The application procedure is the one gate for phases B and C: it read the blocker state
        // back itself, compared the rules content and the enabled filter set, and answered Applied
        // only on an exact match (the refused and unverified answers returned above). The proof
        // below records that read-back; it does not judge it a second time.
        const readBack = application?.readBack ?? null;
        const userRulesDigest =
            request.phase === PhaseLabel.C && readBack
                ? (observedRulesDigest(readBack) ?? null)
                : null;
        const enabledFilterIds = readBack?.enabledFilterIds;
        let filteringState: AdapterPhaseLease['adapterProof']['filteringState'];
        if (request.phase === PhaseLabel.A) {
            filteringState = EnvironmentFilteringState.Disabled;
        } else if (request.phase === PhaseLabel.B) {
            filteringState = 'published_baseline';
        } else {
            filteringState = 'published_baseline_plus_candidate';
        }
        let extension: AdapterPhaseLease['adapterProof']['extension'] = null;
        if (request.phase !== PhaseLabel.A && readBack) {
            extension = {
                packageVersion: this.options.packageVersion,
                manifestVersion: this.options.manifestVersion,
                profileKind: this.options.profileKind,
                // A file-backed read-back sees neither the enabled set nor the compiled DNR
                // rulesets: both stay null so the proof never states "no lists enabled" or "no
                // rulesets active" where the truth is "not observed" — an MV2 route has no DNR
                // inventory to read either. The seam is already keyed, so the proof takes the
                // read-back sets as they arrived, and an observed empty set stays empty.
                enabledListKeys: enabledFilterIds === undefined ? null : [...enabledFilterIds],
                activeRulesetListKeys:
                    readBack.activeRulesetFilterIds === undefined
                        ? null
                        : [...readBack.activeRulesetFilterIds],
                stealthEnabled: readBack.stealthEnabled ?? null,
                userRulesDigest: userRulesDigest ?? null,
                application: {
                    method: application!.method,
                    // Phase B's plugging applies no user rule by definition; phase C's carries the
                    // exact candidate line whose digest the application procedure proved, in the
                    // same normalized form the read-back digest was taken over.
                    appliedRules:
                        request.phase === PhaseLabel.C && request.candidate
                            ? [normalizeRulesContent(request.candidate.rule)]
                            : [],
                    actionLog: application!.actionLog,
                    ...(application?.detail === undefined ? {} : { detail: application.detail }),
                },
                ...(this.options.extensionProvenance
                    ? { provenance: this.options.extensionProvenance }
                    : {}),
            };
        }
        const lease: AdapterPhaseLease = {
            session: created.session,
            adapterProof: {
                leaseId,
                adapterStateDigest: this.stateDigest,
                phase: request.phase,
                filteringState,
                sessionId: leaseId,
                actualContext: this.actualContext,
                baselineDigest:
                    request.phase === PhaseLabel.A ? null : this.baseline.aggregateDigest,
                candidateDigest,
                extension,
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
        return { ready: true, handle: lease };
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
                failures.push(
                    limitation(
                        EnvironmentAdapterLimitationCode.CleanupFailed,
                        'cleanup',
                        'A controlled browser session could not be closed.',
                    ),
                );
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
        let preparation: FilteringEnvironmentAdapterState['preparation'] = null;
        if (this.baseline) {
            preparation = {
                preparedAt: this.baseline.acquiredAt,
                buildDigest: this.options.buildDigest,
                extensionRootDigest: this.options.buildDigest,
            };
        }
        return structuredClone({
            kind: this.kind,
            lifecycle: this.lifecycle,
            stateDigest: this.stateDigest,
            actualContext: this.actualContext,
            capabilities: this.capabilities(),
            preparation,
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
                failures.push(
                    limitation(
                        EnvironmentAdapterLimitationCode.CleanupFailed,
                        'cleanup',
                        'The Extension adapter finalizer did not complete.',
                    ),
                );
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
}
