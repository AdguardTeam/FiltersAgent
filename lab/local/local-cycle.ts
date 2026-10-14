import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import type { CoreConfig } from '../../src/config/config';
import type { ExecutorName } from '../../src/environment/executor-name';
import type { BlockerModuleRunDependencies } from '../../src/proxy-blocker/blocker-module-executor';
import {
    blockerModuleRunDependencies,
    type EnabledBlockerModule,
} from '../../src/proxy-blocker/blocker-module-run-issue';
import { reservePrivateWorkspace } from '../../src/proxy-blocker/private-workspace';
import { sanitizeFailureMessage } from '../../src/tracer/redactor';
import {
    FixRunResultSchema,
    FixRunStatusSchema,
    InfrastructureFailureReasonSchema,
    type BrowserMode,
} from '../../src/types/fix-run-result';
import {
    LocalCycleOutcomeSchema,
    classifyLocalExecutionError,
    deriveLocalCycleOutcome,
    deriveLocalCycleOutcomeFields,
    LocalInfrastructureFailureCategory,
    LocalProductOutcomeCategory,
} from './cycle-outcome';
import { readLocalRunOutput, type LocalRunOutputPaths } from '../../src/local/run-output';
import {
    loadVerifiedExportedIssueRevision,
    type VerifiedIssueRevision,
} from '../../src/local/issue-revision';
import { clearLocalRunOutputDir } from '../../src/local/output-directory';
import { runLocalFixFromRevision } from './local-fix-runner';
import { labFilterCacheDir } from './blocker-modules';
import {
    installPreflightDiagnosticLog,
    openPreflightDiagnosticLog,
} from '../../src/local/preflight-diagnostic-log';
import { type ExtensionEnvironmentKind } from '../../src/types/extension-environment-kind';
import { INPUT_ORIGIN_VALUES } from '../../src/types/input-origin';
import type { UsageRatesTable } from '../../src/types/usage-summary';

export const LocalCycleRevisionSchema = v.strictObject({
    repository: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u)),
    issueNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
    sourceUpdatedAt: v.pipe(v.string(), v.isoTimestamp()),
    sourceIntegrityDigest: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u)),
    sourcePromptIntegrityDigest: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u)),
    revisionDigest: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u)),
    promptDigest: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u)),
    inputOrigin: v.picklist(INPUT_ORIGIN_VALUES),
});

export const LocalCycleFailureSchema = v.strictObject({
    code: v.picklist([
        'invalid_snapshot',
        'runtime_failed',
        'investigation_failed',
        'live_intake_failed',
        'invalid_live_revision',
    ]),
    message: v.pipe(v.string(), v.minLength(1), v.maxLength(1_000)),
});

export const LocalCycleSelectionSchema = v.variant('kind', [
    v.strictObject({
        kind: v.literal('exported_snapshot'),
        issueFile: v.pipe(v.string(), v.minLength(1)),
    }),
    v.strictObject({
        kind: v.literal('live_issue'),
        issueNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
    }),
]);

/**
 * Object shape shared by the persisted cycle schema and its compact public type annotation.
 */
const LocalCycleResultObjectSchema = v.strictObject({
    schemaVersion: v.literal(1),
    cycleId: v.pipe(v.string(), v.uuid()),
    startedAt: v.pipe(v.string(), v.isoTimestamp()),
    completedAt: v.pipe(v.string(), v.isoTimestamp()),
    selection: LocalCycleSelectionSchema,
    status: v.picklist([
        'completed',
        'invalid_snapshot',
        'failed',
        'live_intake_failed',
        'invalid_live_revision',
    ]),
    revision: v.nullable(LocalCycleRevisionSchema),
    investigationResultPath: v.nullable(v.pipe(v.string(), v.minLength(1))),
    recoveryInvestigationResult: v.optional(FixRunResultSchema),
    outcome: v.nullable(LocalCycleOutcomeSchema),
    failure: v.nullable(LocalCycleFailureSchema),
});

export const LocalCycleResultSchema: v.BaseSchema<
    v.InferInput<typeof LocalCycleResultObjectSchema>,
    v.InferOutput<typeof LocalCycleResultObjectSchema>,
    v.BaseIssue<unknown>
> = v.pipe(
    LocalCycleResultObjectSchema,
    v.check(
        (result) =>
            result.status !== 'completed' ||
            (result.revision !== null &&
                (result.investigationResultPath !== null ||
                    result.recoveryInvestigationResult !== undefined) &&
                result.failure === null),
        'A completed cycle must bind a verified revision and investigation result.',
    ),
    v.check(
        (result) =>
            result.recoveryInvestigationResult === undefined ||
            (result.status === 'completed' &&
                result.investigationResultPath === null &&
                result.outcome?.kind === 'product' &&
                result.outcome.category === LocalProductOutcomeCategory.CleanupFailed &&
                result.recoveryInvestigationResult.runStatus === 'cleanup_failed'),
        'A recovery investigation result is reserved for a terminal cleanup-failed cycle.',
    ),
    v.check(
        (result) =>
            result.status !== 'invalid_snapshot' ||
            (result.revision === null &&
                result.investigationResultPath === null &&
                result.failure?.code === 'invalid_snapshot'),
        'An invalid snapshot cannot claim verified revision or investigation output.',
    ),
    v.check(
        (result) => result.status !== 'failed' || result.failure !== null,
        'A failed cycle must contain a bounded failure.',
    ),
    v.check(
        (result) =>
            !['live_intake_failed', 'invalid_live_revision'].includes(result.status) ||
            (result.revision === null &&
                result.investigationResultPath === null &&
                result.outcome === null),
        'A pre-handler cycle result cannot claim revision or investigation output.',
    ),
    v.check(
        (result) => !['completed', 'failed'].includes(result.status) || result.outcome !== null,
        'A started cycle must contain a bounded product or infrastructure outcome.',
    ),
    v.check(
        (result) =>
            result.outcome?.kind !== 'product' ||
            (result.status === 'completed' && result.failure === null),
        'A product outcome must complete without an infrastructure failure.',
    ),
    v.check(
        (result) =>
            result.outcome?.kind !== 'infrastructure' ||
            (result.status === 'failed' && result.failure !== null),
        'An infrastructure outcome must retain a bounded failure.',
    ),
);

/**
 * Persisted terminal result for one manually invoked local cycle.
 */
export type LocalCycleResult = v.InferOutput<typeof LocalCycleResultSchema>;

/**
 * Serializable selection provenance retained by a local cycle result.
 */
export type LocalCycleSelection = v.InferOutput<typeof LocalCycleSelectionSchema>;

/**
 * Runtime options shared with the verified local investigation handler.
 */
export interface ExportedSnapshotCycleOptions {
    /**
     * Issue number expected in the verified envelope.
     */
    issueNumber: number;

    /**
     * Path to a version-two exported `issue.json`.
     */
    issueFile: string;

    /**
     * Dedicated root for the cycle result and nested investigation.
     */
    outputDir: string;

    /**
     * Current or historical source environment.
     */
    environment: ExtensionEnvironmentKind;

    /**
     * Optional historical run configuration.
     */
    runConfig?: string;

    /**
     * Whether temporary extension preparation should be retained.
     */
    keepTemporaryFiles: boolean;

    /**
     * Browser-first execution policy.
     */
    browserMode: BrowserMode;

    /**
     * Stop the investigation right after the environment selection is accepted.
     */
    routingCheck?: boolean;

    /**
     * Optional reasoning model override.
     */
    model?: string;

    /**
     * Whether verbose operational logging is enabled.
     */
    verbose: boolean;

    /**
     * Frozen per-model rates the fix runner prices its LLM usage from; when absent every cost is
     * reported as unknown.
     */
    pricingSnapshot?: UsageRatesTable;

    /**
     * Optional merged command cancellation signal.
     */
    signal?: AbortSignal;

    /**
     * Validated executor set this run locks, already checked against the registered names; absent
     * locks the browser extension and every module in `blockerModules`.
     */
    executors?: readonly string[];

    /**
     * The blocker modules this run's locked selections start; absent starts none.
     */
    blockerModules?: readonly EnabledBlockerModule[];

    /**
     * The repository's own lint command line, run over each candidate in the local filters source
     * (the clone when there is none); absent runs no lint.
     */
    lintCommand?: string;
}

/**
 * Narrow options supplied to the common verified-revision handler.
 */
export interface CycleRevisionHandlerOptions {
    /**
     * Issue number bound by the cycle.
     */
    issueNumber: number;

    /**
     * Current or historical source environment.
     */
    environment: ExtensionEnvironmentKind;

    /**
     * Dedicated nested investigation output directory.
     */
    outputDir: string;

    /**
     * Optional historical run configuration.
     */
    runConfig?: string;

    /**
     * Whether temporary extension preparation should be retained.
     */
    keepTemporaryFiles: boolean;

    /**
     * Browser-first execution policy.
     */
    browserMode: BrowserMode;

    /**
     * Stop the investigation right after the environment selection is accepted.
     */
    routingCheck?: boolean;

    /**
     * Optional reasoning model override.
     */
    model?: string;

    /**
     * Whether verbose operational logging is enabled.
     */
    verbose: boolean;

    /**
     * Frozen per-model rates the fix runner prices its LLM usage from; when absent every cost is
     * reported as unknown.
     */
    pricingSnapshot?: UsageRatesTable;

    /**
     * Cancellation signal raised when the exact automatic lease is lost.
     */
    signal?: AbortSignal;

    /**
     * The blocker modules this run's locked selections start; absent starts none.
     */
    blockerModules?: readonly EnabledBlockerModule[];

    /**
     * The started modules' dependencies, keyed by executor name; the cycle builds them from
     * `blockerModules` inside its private workspace.
     */
    executorDependencies?: Readonly<Record<ExecutorName, BlockerModuleRunDependencies>>;

    /**
     * Validated executor set this run locks, already checked against the registered names; absent
     * locks the browser extension and every module in `blockerModules`.
     */
    executors?: readonly string[];

    /**
     * The repository's own lint command line, run over each candidate in the local filters source
     * (the clone when there is none); absent runs no lint.
     */
    lintCommand?: string;
}

/**
 * Outcome of reconciling a durable exact-certificate trust obligation before provider or CLI work.
 */
export const LocalCycleTrustReconciliationStatus = {
    /**
     * No trust reconciliation obligation existed for this cycle.
     */
    None: 'none',

    /**
     * A trust reconciliation obligation existed and cleanup completed.
     */
    Cleaned: 'cleaned',

    /**
     * A trust reconciliation obligation existed but cleanup did not complete.
     */
    CleanupFailed: 'cleanup_failed',
} as const;

/**
 * LocalCycleTrustReconciliationStatus value.
 */
export type LocalCycleTrustReconciliationStatus =
    (typeof LocalCycleTrustReconciliationStatus)[keyof typeof LocalCycleTrustReconciliationStatus];

/**
 * Path-free startup trust-reconciliation status.
 */
export interface LocalCycleTrustReconciliationResult {
    /**
     * Whether there was no obligation, cleanup succeeded, or cleanup remains unresolved.
     */
    status: LocalCycleTrustReconciliationStatus;
}

/**
 * Injectable coordinator seams that deliberately contain no GitHub capability.
 */
export interface LocalCycleDependencies {
    /**
     * Reconcile any durable exact-certificate trust obligation before provider or CLI work.
     */
    reconcileAdguardCliTrust?: () => Promise<LocalCycleTrustReconciliationResult>;

    /**
     * Lazily resolve the explicit provider configuration.
     */
    loadLocalCoreConfig?: () => CoreConfig;

    /**
     * Execute the common handler from an opaque verified revision.
     */
    runLocalFixFromRevision?: (
        coreConfig: CoreConfig,
        revision: VerifiedIssueRevision,
        options: CycleRevisionHandlerOptions,
    ) => Promise<LocalRunOutputPaths>;

    /**
     * Generate a fresh cycle UUID.
     */
    createCycleId?: () => string;

    /**
     * Return the current ISO timestamp.
     */
    now?: () => string;
}

/**
 * Inputs for common execution after any selector has produced an opaque revision.
 */
export interface VerifiedLocalCycleExecutionOptions {
    /**
     * Opaque integrity-verified issue revision.
     */
    revision: VerifiedIssueRevision;

    /**
     * Selector provenance retained in the terminal result.
     */
    selection: LocalCycleSelection;

    /**
     * Agent-owned cycle output directory.
     */
    outputDir: string;

    /**
     * Unique cycle UUID.
     */
    cycleId: string;

    /**
     * Fixed cycle start timestamp.
     */
    startedAt: string;

    /**
     * Common handler options excluding selector-derived identity and output paths.
     */
    handlerOptions: Omit<CycleRevisionHandlerOptions, 'issueNumber' | 'outputDir'>;

    /**
     * Host-only secrets already available before provider loading.
     */
    exactSecrets?: readonly string[];
}

export const LOCAL_CYCLE_RESULT_FILENAME = 'cycle-result.json';

/**
 * Convert one verified revision into the serializable cycle identity.
 *
 * @param revision - Opaque verified exported revision.
 * @returns Public immutable revision identity.
 */
function cycleRevision(
    revision: VerifiedIssueRevision,
): v.InferOutput<typeof LocalCycleRevisionSchema> {
    return {
        repository: revision.repository,
        issueNumber: revision.issueNumber,
        sourceUpdatedAt: revision.sourceUpdatedAt,
        sourceIntegrityDigest: revision.sourceIntegrityDigest,
        sourcePromptIntegrityDigest: revision.sourcePromptIntegrityDigest,
        revisionDigest: revision.revisionDigest,
        promptDigest: revision.promptDigest,
        inputOrigin: revision.inputOrigin,
    };
}

/**
 * Atomically publish one terminal cycle result.
 *
 * @param outputDir - Agent-owned cycle root.
 * @param result - Validated terminal result.
 * @returns Same parsed result after successful persistence.
 */
export function writeLocalCycleResult(
    outputDir: string,
    result: LocalCycleResult,
): LocalCycleResult {
    const parsed = v.parse(LocalCycleResultSchema, result);
    const temporaryPath = join(outputDir, '.cycle-result.json.tmp');
    const resultPath = join(outputDir, LOCAL_CYCLE_RESULT_FILENAME);
    writeFileSync(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
    });
    renameSync(temporaryPath, resultPath);
    return parsed;
}

/**
 * Read and classify the bounded fields from one locked investigation result.
 *
 * @param resultPath - Handler-produced `run-result.json` path.
 * @param manifestPath - Handler-produced integrity manifest path, or an empty test fixture marker.
 * @returns Trusted terminal product or infrastructure outcome.
 */
function readInvestigationOutcome(
    resultPath: string,
    manifestPath: string,
): v.InferOutput<typeof LocalCycleOutcomeSchema> {
    if (manifestPath.length > 0) {
        return deriveLocalCycleOutcome(readLocalRunOutput(resultPath).result);
    }
    const source = JSON.parse(readFileSync(resultPath, 'utf8')) as unknown;
    if (!source || typeof source !== 'object') {
        throw new Error('Locked investigation result must be an object.');
    }
    const result = (source as Record<string, unknown>).result;
    if (!result || typeof result !== 'object') {
        throw new Error('Locked investigation result is missing its result object.');
    }
    const record = result as Record<string, unknown>;
    const runStatus = v.parse(FixRunStatusSchema, record.runStatus);
    const infrastructureFailureReason =
        record.infrastructureFailureReason === undefined
            ? undefined
            : v.parse(InfrastructureFailureReasonSchema, record.infrastructureFailureReason);
    const artifactPaths = record.artifactPaths;
    const rejectedCandidate =
        artifactPaths !== null &&
        typeof artifactPaths === 'object' &&
        (artifactPaths as Record<string, unknown>).rejectedCandidateScreenshots !== undefined;
    return deriveLocalCycleOutcomeFields(runStatus, infrastructureFailureReason, rejectedCandidate);
}

/**
 * Execute one verified revision through the selector-independent local handler.
 *
 * @param options - Verified revision, selection, output, identity, and common handler options.
 * @param dependencies - Injectable provider, handler, and clock seams without GitHub writes.
 * @returns Validated terminal result ready for publication.
 */
export async function executeVerifiedLocalCycle(
    options: VerifiedLocalCycleExecutionOptions,
    dependencies: LocalCycleDependencies = {},
): Promise<LocalCycleResult> {
    // The ownership marker can only be written into an empty directory, so the investigation
    // leaf must be claimed before the preserved `runs`/`collections` roots are created below.
    const investigationDir = clearLocalRunOutputDir(
        join(options.outputDir, 'investigation'),
        process.cwd(),
        ['runs', 'collections'],
    );
    const rawCollectionRoot = join(investigationDir, 'collections');
    const publicationAndReviewRoot = join(investigationDir, 'runs');
    mkdirSync(rawCollectionRoot, { recursive: true, mode: 0o700 });
    mkdirSync(publicationAndReviewRoot, { recursive: true, mode: 0o700 });
    // Without an installed sink every recordPreflightDiagnostic call made below this point —
    // published-baseline attribution detail, phase observation failures, native command errors —
    // is silently dropped, and a failed cycle can only say its finite public code.
    const diagnosticLog = openPreflightDiagnosticLog(options.outputDir);
    installPreflightDiagnosticLog(diagnosticLog);
    const forbiddenCliRoots = [
        process.cwd(),
        options.outputDir,
        investigationDir,
        rawCollectionRoot,
        publicationAndReviewRoot,
    ];
    const now = dependencies.now ?? (() => new Date().toISOString());
    const base = {
        schemaVersion: 1 as const,
        cycleId: options.cycleId,
        startedAt: options.startedAt,
        selection: v.parse(LocalCycleSelectionSchema, options.selection),
    };
    let coreConfig: CoreConfig | null = null;
    let privateCliCycleRoot: string | null = null;
    try {
        privateCliCycleRoot = reservePrivateWorkspace(forbiddenCliRoots);
        const executorDependencies = blockerModuleRunDependencies(
            options.handlerOptions.blockerModules ?? [],
            privateCliCycleRoot,
            labFilterCacheDir(process.cwd()),
        );
        const loadConfig = dependencies.loadLocalCoreConfig;
        if (!loadConfig) {
            throw new Error('An explicit local provider configuration loader is required.');
        }
        coreConfig = loadConfig();
        const execute = dependencies.runLocalFixFromRevision ?? runLocalFixFromRevision;
        const paths = await execute(coreConfig, options.revision, {
            ...options.handlerOptions,
            issueNumber: options.revision.issueNumber,
            outputDir: investigationDir,
            executorDependencies,
        });
        let outcome: v.InferOutput<typeof LocalCycleOutcomeSchema>;
        try {
            outcome = readInvestigationOutcome(paths.runResultPath, paths.manifestPath);
        } catch {
            outcome = {
                kind: 'infrastructure',
                category: LocalInfrastructureFailureCategory.InvestigationOutput,
            };
        }
        const investigationFailed = outcome.kind === 'infrastructure';
        let failure: v.InferOutput<typeof LocalCycleFailureSchema> | null = null;
        if (investigationFailed) {
            failure = {
                code: 'investigation_failed',
                message: 'The locked local investigation reported a failed outcome.',
            };
        }
        return v.parse(LocalCycleResultSchema, {
            ...base,
            completedAt: now(),
            status: investigationFailed ? 'failed' : 'completed',
            revision: cycleRevision(options.revision),
            investigationResultPath:
                outcome.category === LocalInfrastructureFailureCategory.InvestigationOutput
                    ? null
                    : paths.runResultPath,
            outcome,
            failure,
        });
    } catch (error) {
        const outcome = coreConfig
            ? classifyLocalExecutionError(error)
            : {
                  kind: 'infrastructure' as const,
                  category: LocalInfrastructureFailureCategory.Provider,
              };
        return v.parse(LocalCycleResultSchema, {
            ...base,
            completedAt: now(),
            status: 'failed',
            revision: cycleRevision(options.revision),
            investigationResultPath: null,
            outcome,
            failure: {
                code: 'runtime_failed',
                message: sanitizeFailureMessage(
                    error,
                    [
                        ...(options.exactSecrets ?? []),
                        ...(coreConfig ? [coreConfig.llm.apiKey] : []),
                    ],
                    1_000,
                ),
            },
        });
    } finally {
        // The run stopped the blocker when it ended; what is left in the private root is files.
        if (privateCliCycleRoot) {
            rmSync(privateCliCycleRoot, { recursive: true, force: true });
        }
        diagnosticLog.close({ cycleId: options.cycleId });
        installPreflightDiagnosticLog(null);
    }
}

/**
 * Run one immutable exported issue revision through the local production-shaped boundary.
 *
 * Input verification completes before provider configuration or investigation work. Every terminal
 * path publishes one local typed result and exposes no GitHub write dependency.
 *
 * @param options - Exported snapshot selection and local runtime options.
 * @param dependencies - Injectable deterministic config, handler, clock, and identity seams.
 * @returns Persisted terminal cycle result.
 */
export async function runExportedSnapshotCycle(
    options: ExportedSnapshotCycleOptions,
    dependencies: LocalCycleDependencies = {},
): Promise<LocalCycleResult> {
    const outputDir = clearLocalRunOutputDir(options.outputDir, process.cwd());
    const createCycleId = dependencies.createCycleId ?? randomUUID;
    const now = dependencies.now ?? (() => new Date().toISOString());
    const cycleId = createCycleId();
    const startedAt = now();
    const base = {
        schemaVersion: 1 as const,
        cycleId,
        startedAt,
        selection: {
            kind: 'exported_snapshot' as const,
            issueFile: options.issueFile,
        },
    };

    let revision: VerifiedIssueRevision;
    try {
        revision = loadVerifiedExportedIssueRevision(options.issueFile);
        if (revision.issueNumber !== options.issueNumber) {
            throw new Error(
                `Exported issue revision is #${revision.issueNumber}, expected ` +
                    `#${options.issueNumber}.`,
            );
        }
    } catch (error) {
        return writeLocalCycleResult(outputDir, {
            ...base,
            completedAt: now(),
            status: 'invalid_snapshot',
            revision: null,
            investigationResultPath: null,
            outcome: null,
            failure: {
                code: 'invalid_snapshot',
                message: sanitizeFailureMessage(error, []),
            },
        });
    }

    const result = await executeVerifiedLocalCycle(
        {
            revision,
            selection: base.selection,
            outputDir,
            cycleId,
            startedAt,
            handlerOptions: {
                environment: options.environment,
                runConfig: options.runConfig,
                keepTemporaryFiles: options.keepTemporaryFiles,
                browserMode: options.browserMode,
                routingCheck: options.routingCheck,
                model: options.model,
                verbose: options.verbose,
                pricingSnapshot: options.pricingSnapshot,
                signal: options.signal,
                executors: options.executors,
                blockerModules: options.blockerModules,
                lintCommand: options.lintCommand,
            },
        },
        dependencies,
    );
    return writeLocalCycleResult(outputDir, result);
}
