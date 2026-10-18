import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import * as v from 'valibot';
import { ExtensionBuildPinSchema } from '../local/run-config';
import { LocalIssueSnapshotSchema } from '../../src/local/issue-snapshot';

const FullCommitSchema = v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/iu));

const PortableRelativePathSchema = v.pipe(
    v.string(),
    v.minLength(1),
    v.check(
        (path) => !isPortableAbsolutePath(path),
        'Path must be relative to the golden case directory.',
    ),
);

export const GoldenRunSchemaVersion = {
    /**
     * Older cases omit reporter-build provenance and require explicit migration.
     */
    Legacy: 2,
    /**
     * Executable historical cases include the reporter's pinned extension build.
     */
    Current: 3,
} as const;

/**
 * Run document versions supported by execution and migration.
 */
export type GoldenRunSchemaVersion =
    (typeof GoldenRunSchemaVersion)[keyof typeof GoldenRunSchemaVersion];

export const LegacyGoldenE2ERunSchema = v.strictObject({
    schemaVersion: v.literal(GoldenRunSchemaVersion.Legacy),
    issueNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
    issueFile: PortableRelativePathSchema,
    filtersBaseSha: FullCommitSchema,
});

export const GoldenE2ERunSchema = v.strictObject({
    schemaVersion: v.literal(GoldenRunSchemaVersion.Current),
    issueNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
    issueFile: PortableRelativePathSchema,
    filtersBaseSha: FullCommitSchema,
    extensionBuild: ExtensionBuildPinSchema,
});

/**
 * Historical environment document accepted only for migration to an explicit extension build.
 */
export type LegacyGoldenE2ERun = v.InferOutput<typeof LegacyGoldenE2ERunSchema>;

export const GoldenHumanOracleSchema = v.strictObject({
    humanFixCommit: FullCommitSchema,
    issueCreatedAt: v.pipe(v.string(), v.isoTimestamp()),
    fixCommittedAt: v.pipe(v.string(), v.isoTimestamp()),
});

/**
 * Historical environment and input bundle exposed to the local core runner.
 */
export type GoldenE2ERun = v.InferOutput<typeof GoldenE2ERunSchema>;

/**
 * Human fix identity and timestamps loaded only after a locked result passes schema validation.
 */
export type GoldenHumanOracle = v.InferOutput<typeof GoldenHumanOracleSchema>;

/**
 * Resolved run-side files for one golden case, deliberately excluding oracle.json.
 */
export interface LoadedGoldenRunCase {
    /**
     * Validated historical environment configuration.
     */
    config: GoldenE2ERun;

    /**
     * Absolute path to the portable issue snapshot.
     */
    issueFile: string;

    /**
     * Absolute path to run.json, reused by the standard local lifecycle.
     */
    runConfigPath: string;
}

/**
 * Resolved legacy run-side files used only to migrate a golden case.
 */
export interface LoadedLegacyGoldenRunCase extends Omit<LoadedGoldenRunCase, 'config'> {
    /**
     * Validated historical configuration lacking an extension build.
     */
    config: LegacyGoldenE2ERun;
}

/**
 * Parse a JSON document with source-specific diagnostics.
 *
 * @param path - JSON file path.
 * @param label - Human-readable document label.
 * @returns Parsed JSON value.
 */
function readJson(path: string, label: string): unknown {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
        throw new Error(`Unable to read golden ${label} ${path}: ${(error as Error).message}`, {
            cause: error,
        });
    }
}

/**
 * Detect POSIX and Windows absolute paths regardless of the current host platform.
 *
 * @param path - Portable path candidate from a tracked golden document.
 * @returns Whether either supported platform would interpret the path as absolute.
 */
function isPortableAbsolutePath(path: string): boolean {
    return isAbsolute(path) || win32.isAbsolute(path);
}

/**
 * Resolve a portable case path while rejecting traversal outside the case directory.
 *
 * @param caseDirectory - Root directory of one golden case.
 * @param portablePath - Relative path declared by run.json.
 * @returns Absolute path contained by the case directory.
 */
function resolvePortableCasePath(caseDirectory: string, portablePath: string): string {
    const root = resolve(caseDirectory);
    const absolutePath = resolve(root, portablePath.replaceAll('\\', '/'));
    const relativePath = relative(root, absolutePath);
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
        throw new Error(`Golden case path escapes its directory: ${portablePath}`);
    }
    return absolutePath;
}

/**
 * Validate that every golden attachment remains portable inside its issue bundle.
 *
 * The general local snapshot loader keeps backward compatibility with legacy absolute paths. Golden
 * cases deliberately use a stricter contract so a tracked case cannot read arbitrary host files
 * when it reaches the core runner.
 *
 * @param issueFile - Absolute path to the portable issue snapshot.
 */
function validateGoldenAttachmentPaths(issueFile: string): void {
    const snapshot = v.parse(LocalIssueSnapshotSchema, readJson(issueFile, 'issue snapshot'));
    const bundleDirectory = dirname(resolve(issueFile));
    for (const attachment of snapshot.attachments) {
        if (isPortableAbsolutePath(attachment.localPath)) {
            throw new Error(
                `Golden attachment path must be relative to the issue bundle: ` +
                    `${attachment.localPath}`,
            );
        }
        const absolutePath = resolve(bundleDirectory, attachment.localPath.replaceAll('\\', '/'));
        const relativePath = relative(bundleDirectory, absolutePath);
        if (
            relativePath === '..' ||
            relativePath.startsWith(`..${sep}`) ||
            isAbsolute(relativePath)
        ) {
            throw new Error(
                `Golden attachment path escapes the issue bundle: ${attachment.localPath}`,
            );
        }
    }
}

/**
 * Load only the run-side configuration made available before the agent starts.
 *
 * Oracle.json is intentionally not opened by this API.
 *
 * @param caseDirectory - Directory containing run.json and the portable issue bundle.
 * @returns Validated run configuration with resolved input paths.
 */
export function loadGoldenRunCase(caseDirectory: string): LoadedGoldenRunCase {
    const runConfigPath = join(resolve(caseDirectory), 'run.json');
    if (readGoldenRunSchemaVersion(caseDirectory) === GoldenRunSchemaVersion.Legacy) {
        throw new Error(
            `Golden case ${basename(resolve(caseDirectory))} uses a legacy run.json. Migrate with ` +
                `pnpm benchmark:case:check -- ${basename(resolve(caseDirectory))} ` +
                '--extension-version <version>.',
        );
    }
    const config = v.parse(GoldenE2ERunSchema, readJson(runConfigPath, 'run.json'));
    const issueFile = resolvePortableCasePath(caseDirectory, config.issueFile);
    validateGoldenAttachmentPaths(issueFile);
    return {
        config,
        issueFile,
        runConfigPath,
    };
}

/**
 * Load a case's closed human commit oracle; nothing from it may reach the agent's input.
 *
 * @param caseDirectory - Directory containing oracle.json.
 * @returns Validated human fix commit and issue-to-fix timestamps.
 */
export function loadGoldenHumanOracle(caseDirectory: string): GoldenHumanOracle {
    const oraclePath = join(resolve(caseDirectory), 'oracle.json');
    return v.parse(GoldenHumanOracleSchema, readJson(oraclePath, 'oracle.json'));
}

/**
 * Read the declared run format before choosing execution or migration.
 *
 * @param caseDirectory - Directory containing run.json.
 * @returns Supported run schema version.
 */
export function readGoldenRunSchemaVersion(caseDirectory: string): GoldenRunSchemaVersion {
    const document = v.parse(
        v.object({ schemaVersion: v.picklist(Object.values(GoldenRunSchemaVersion)) }),
        readJson(join(resolve(caseDirectory), 'run.json'), 'run.json'),
    );
    return document.schemaVersion;
}

/**
 * Load the legacy run-side configuration for migration while enforcing portable input paths.
 *
 * @param caseDirectory - Directory containing a legacy run.json and issue bundle.
 * @returns Legacy run configuration with resolved input paths.
 */
export function loadLegacyGoldenRunCase(caseDirectory: string): LoadedLegacyGoldenRunCase {
    const runConfigPath = join(resolve(caseDirectory), 'run.json');
    const config = v.parse(LegacyGoldenE2ERunSchema, readJson(runConfigPath, 'run.json'));
    const issueFile = resolvePortableCasePath(caseDirectory, config.issueFile);
    validateGoldenAttachmentPaths(issueFile);
    return { config, issueFile, runConfigPath };
}

/**
 * Atomically replace one run document so readers see only a complete historical configuration.
 *
 * @param caseDirectory - Existing golden case directory receiving run.json.
 * @param run - Current run document with its reporter extension identity.
 * @returns Nothing after atomically saving the document.
 */
export function writeGoldenRunDocument(caseDirectory: string, run: GoldenE2ERun): void {
    const runConfigPath = join(resolve(caseDirectory), 'run.json');
    const temporaryPath = `${runConfigPath}.tmp-${randomUUID()}`;
    try {
        writeFileSync(temporaryPath, `${JSON.stringify(run, null, 4)}\n`, 'utf8');
        renameSync(temporaryPath, runConfigPath);
    } finally {
        rmSync(temporaryPath, { force: true });
    }
}
