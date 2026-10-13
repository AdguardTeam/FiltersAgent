/**
 * The host-side extension preparation a fix run performs before its fix session starts.
 *
 * In order:
 *
 * 1. The instruction carries a `## Preparation` section — a short-lived preparation session performs
 *    the blocker steps and names its result; the payload's extension directory is validated to
 *    resolve inside the session workdir and to hold a loadable manifest. Provenance `Instruction`.
 * 2. No instruction, or none with the section — the host downloads the operator-pinned prebuilt
 *    release (the module's own verified constant, injected as this module's default). Provenance
 *    `PinnedRelease`. A missing section never fails the run.
 *
 * A custom build for local testing goes through the instruction's `## Preparation` section (step 1)
 * rather than a preloaded-directory channel.
 *
 * Contract for every failure: there is NO second attempt — a failed download, digest, unpack, or
 * placement throws the typed error with the full captured output, and the fix run fails named. The
 * pinned release's digest marker is the only retry mechanism, across runs.
 */
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { CoreConfig } from '../config/config';
import { PreparedExtensionSource } from '../environment/extension-preparation';
import type { LoadedInstruction } from '../knowledge/instruction-loader';
import { extractPreparationSection } from '../knowledge/instruction-preparation';
import {
    loadPreparedExtensionFromDirectory,
    loadPreparedFirefoxExtension,
    type PreparedExtension,
} from '../local/prepared-extension';
import {
    downloadPinnedExtensionRelease,
    type PinnedExtensionRelease,
} from '../local/pinned-extension-release';
import type { Logger } from '../logger/logger';
import type { PiRuntime } from '../pi/runtime';
import type { RunUsageCollector } from '../pi/usage-collector';
import type { TraceRecorder } from '../tracer/trace-recorder';
import { runPreparationSession, type PreparationSessionResult } from './preparation-session';

/**
 * Directory under the system temp dir where the pinned prebuilt release caches across runs.
 *
 * Why this root: the plan's pinned-release layout is `tmp/cache/extensions/prebuilt/<tag>/`, and it
 * must live outside the per-run artifacts dir — the digest marker's idempotency is load-bearing
 * across runs, and the release itself is run-independent. The system temp dir persists per machine
 * and CI job; the release bytes are public assets verified by digest.
 */
const PINNED_RELEASE_CACHE_ROOT = join(tmpdir(), 'cache');

/**
 * The run artifacts' subdirectory that hosts the model preparation session's workdir.
 *
 * Why this path: the plan's storage contract — run artifacts under the artifacts dir, the extension
 * workdir at `artifactsDir/preparation`. The session's tools are locked to it, so the result
 * directory always resolves inside one owned tree.
 */
export const PREPARATION_WORKDIR_NAME = 'preparation';

/**
 * Stable failure classes of the host-side preparation.
 */
export const PreRunPreparationFailureKind = {
    /**
     * The preparation session accepted a done payload whose extensionDir names a directory that
     * does not exist (or is not loadable).
     */
    PlacementMissing: 'prepared_extension_dir_missing',

    /**
     * The payload's extensionDir resolves outside the preparation session workdir.
     */
    PlacementEscapes: 'prepared_extension_dir_escapes_workdir',

    /**
     * A Firefox-family payload names a signed XPI the host cannot launch: the file is missing, or
     * it resolves outside the preparation session workdir.
     */
    XpiPlacementInvalid: 'prepared_extension_xpi_invalid',

    /**
     * The pinned-release download, digest, unpack, or manifest placement failed; the message
     * carries the error's full captured output.
     */
    PinnedReleaseFailed: 'pinned_release_failed',
} as const;

/**
 * PreRunPreparationFailureKind value.
 */
export type PreRunPreparationFailureKind =
    (typeof PreRunPreparationFailureKind)[keyof typeof PreRunPreparationFailureKind];

/**
 * Typed named failure of the host-side preparation; the fix run fails with the message, which
 * carries the full captured output of the failed step.
 */
export class PreRunPreparationError extends Error {
    /**
     * Stable public failure classification.
     */
    readonly kind: PreRunPreparationFailureKind;

    /**
     * Underlying cause observed at preparation time, when one exists.
     */
    override readonly cause?: unknown;

    /**
     * Create one named preparation failure.
     *
     * @param kind - Stable public failure classification.
     * @param message - Full diagnostic, carrying whatever output the failed step captured.
     * @param cause - Underlying error, when one exists.
     */
    constructor(kind: PreRunPreparationFailureKind, message: string, cause?: unknown) {
        super(message);
        this.name = 'PreRunPreparationError';
        this.kind = kind;
        this.cause = cause;
    }
}

/**
 * Everything the preparation runs on — the fix run's recording and provider surfaces, created
 * before the fix runtime exists.
 */
export interface PreRunPreparationContext {
    /**
     * The run's trace recorder; the preparation session records every turn into it.
     */
    recorder: TraceRecorder;

    /**
     * The validated LLM provider configuration.
     */
    llm: CoreConfig['llm'];

    /**
     * The run's already-built pi runtime for the preparation session.
     */
    piRuntime: PiRuntime;

    /**
     * Application logger receiving the preparation milestones.
     */
    logger: Logger;

    /**
     * Optional run-scoped usage collector.
     */
    usageCollector?: RunUsageCollector;
}

/**
 * What varies per run.
 */
export interface PreRunPreparationOptions {
    /**
     * The run artifacts directory; hosts the preparation workdir.
     */
    artifactsDir: string;

    /**
     * The run instruction loaded at run start, when this run carries one.
     */
    instruction?: LoadedInstruction;

    /**
     * Caller cancellation.
     */
    signal?: AbortSignal;
}

/**
 * Injectable seams of the host-side preparation; production passes none.
 */
export interface PreRunPreparationDependencies {
    /**
     * The preparation-session implementation; injectable so fix-core tests drive the whole flow
     * with a stubbed session.
     */
    runPreparationSession?: typeof runPreparationSession;

    /**
     * The pinned-release fetcher; injectable so tests stand in for the network. Production callers
     * inject nothing, which selects the module's own verified pin.
     */
    downloadPinnedExtensionRelease?: typeof downloadPinnedExtensionRelease;
}

/**
 * Describe why a non-done preparation-session ending failed.
 *
 * @param result - The session result that did not accept a done payload.
 * @returns Bounded model-and-operator-facing detail of the failed phase.
 */
function preparationSessionFailureDetail(result: PreparationSessionResult): string {
    if (result.detail !== undefined) {
        return result.detail;
    }
    return `The preparation session sealed with status ${result.status} without a build.`;
}

/**
 * Test whether one resolved path names a position inside the preparation workdir.
 *
 * @param resolved - Absolute path resolved from the payload.
 * @param workDir - The session's workdir the payload path must resolve inside.
 * @returns Whether the path is the workdir itself or a position below it.
 */
function insideWorkdir(resolved: string, workDir: string): boolean {
    return resolved === workDir || resolved.startsWith(`${workDir}/`);
}

/**
 * Load the Firefox-family declaration of one preparation result as this run's extension.
 *
 * The signed XPI is the build, so the same containment rule the Chromium directory obeys applies to
 * it: a payload naming an XPI outside the session workdir is refused before any browser launches
 * with it.
 *
 * @param launch - The validated Firefox launch declaration the session sealed.
 * @param workDir - The session's workdir the XPI must resolve inside.
 * @param sectionSha256 - The preparation section digest, pinning the extension's source content.
 * @returns The validated PreparedExtension with `Instruction` provenance.
 * @throws When the XPI escapes the workdir, is missing, or is otherwise unlaunchable.
 */
async function loadInstructionPreparedFirefoxExtension(
    launch: NonNullable<PreparationSessionResult['firefoxLaunch']>,
    workDir: string,
    sectionSha256: string,
): Promise<PreparedExtension> {
    if (!insideWorkdir(launch.xpiPath, workDir)) {
        throw new PreRunPreparationError(
            PreRunPreparationFailureKind.XpiPlacementInvalid,
            `The preparation session's xpiPath "${launch.xpiPath}" resolves outside the ` +
                `preparation workdir ${workDir}.`,
        );
    }
    try {
        return await loadPreparedFirefoxExtension(
            launch,
            PreparedExtensionSource.Instruction,
            sectionSha256,
        );
    } catch (error) {
        throw new PreRunPreparationError(
            PreRunPreparationFailureKind.XpiPlacementInvalid,
            `The preparation session's Firefox launch declaration is not launchable: ` +
                `${error instanceof Error ? error.message : String(error)}`,
            error,
        );
    }
}

/**
 * Validate the preparation result and load what it named as this run's extension.
 *
 * @param result - The sealed preparation-session result.
 * @param workDir - The session's workdir the payload path must resolve inside.
 * @param sectionSha256 - The preparation section digest, pinning the extension's source content.
 * @returns The validated PreparedExtension with `Instruction` provenance.
 * @throws When the result names neither a directory nor a Firefox launch declaration.
 * @throws When the named directory or XPI resolves outside the workdir.
 * @throws When the directory is missing or unloadable, or the XPI is not launchable.
 */
async function loadInstructionPreparedExtension(
    result: PreparationSessionResult,
    workDir: string,
    sectionSha256: string,
): Promise<PreparedExtension> {
    if (result.firefoxLaunch !== undefined) {
        return await loadInstructionPreparedFirefoxExtension(
            result.firefoxLaunch,
            workDir,
            sectionSha256,
        );
    }
    if (result.extensionDir === undefined) {
        throw new PreRunPreparationError(
            PreRunPreparationFailureKind.PlacementMissing,
            `The preparation session did not name an extensionDir in its result: ` +
                `${preparationSessionFailureDetail(result)} Captured failure command: ` +
                `${result.failedCommand ?? 'none'}.`,
        );
    }
    const resolved = resolve(result.extensionDir);
    if (!insideWorkdir(resolved, workDir)) {
        throw new PreRunPreparationError(
            PreRunPreparationFailureKind.PlacementEscapes,
            `The preparation session's extensionDir "${result.extensionDir}" resolves outside ` +
                `the preparation workdir ${workDir}.`,
        );
    }
    try {
        return await loadPreparedExtensionFromDirectory(
            resolved,
            PreparedExtensionSource.Instruction,
            sectionSha256,
        );
    } catch (error) {
        throw new PreRunPreparationError(
            PreRunPreparationFailureKind.PlacementMissing,
            `The preparation session's extensionDir "${result.extensionDir}" is not loadable: ` +
                `${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

/**
 * Map one verified pinned-release download onto the run's PreparedExtension.
 *
 * @param download - The verified download (unpacked, digest-checked, manifest-checked).
 * @returns The prepared extension with `PinnedRelease` provenance.
 * @throws When the unpacked manifest disagrees with the pin, or is otherwise unloadable.
 */
async function loadPinnedRelease(download: PinnedExtensionRelease): Promise<PreparedExtension> {
    return await loadPreparedExtensionFromDirectory(
        download.extensionDir,
        PreparedExtensionSource.PinnedRelease,
        download.sha256,
        download.tag,
    );
}

/**
 * Host one run's extension preparation and return its provenance record.
 *
 * @param context - The recorder, provider, and runtime the preparation runs on.
 * @param options - Per-run inputs: artifacts dir, instruction.
 * @param dependencies - Injectable seams; production passes none.
 * @returns The prepared extension for `AgentRuntimeOptions.preparedExtension`.
 * @throws {@link PreRunPreparationError} When a step or placement fails, with the full captured
 *   output in the message and no second attempt anywhere.
 */
export async function prepareRunExtension(
    context: PreRunPreparationContext,
    options: PreRunPreparationOptions,
    dependencies: PreRunPreparationDependencies = {},
): Promise<PreparedExtension> {
    const preparationSection = options.instruction
        ? extractPreparationSection(options.instruction.content)
        : undefined;
    if (preparationSection) {
        const workDir = resolve(join(options.artifactsDir, PREPARATION_WORKDIR_NAME));
        mkdirSync(workDir, { recursive: true });
        context.logger.info(
            { workDir, sectionSha256: preparationSection.sha256 },
            'Instruction carries a preparation section; running the preparation session',
        );
        const result = await (dependencies.runPreparationSession ?? runPreparationSession)({
            runtime: context.piRuntime,
            llm: context.llm,
            recorder: context.recorder,
            workDir,
            preparationSection: preparationSection.content,
            signal: options.signal,
            logger: context.logger,
            usageCollector: context.usageCollector,
        });
        return await loadInstructionPreparedExtension(result, workDir, preparationSection.sha256);
    }
    context.logger.info(
        { hasInstruction: options.instruction !== undefined },
        'No preparation section in the instruction; downloading the pinned prebuilt release',
    );
    let download: PinnedExtensionRelease;
    try {
        download = await (
            dependencies.downloadPinnedExtensionRelease ?? downloadPinnedExtensionRelease
        )({
            destinationRoot: PINNED_RELEASE_CACHE_ROOT,
            logger: context.logger,
        });
    } catch (error) {
        throw new PreRunPreparationError(
            PreRunPreparationFailureKind.PinnedReleaseFailed,
            error instanceof Error ? error.message : String(error),
            error,
        );
    }
    return await loadPinnedRelease(download);
}
