import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import * as v from 'valibot';
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

export const GoldenE2ERunSchema = v.strictObject({
    schemaVersion: v.literal(2),
    issueNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
    issueFile: PortableRelativePathSchema,
    filtersBaseSha: FullCommitSchema,
});

export const GoldenHumanOracleSchema = v.strictObject({
    humanFixCommit: FullCommitSchema,
});

/**
 * Historical environment and input bundle exposed to the local core runner.
 */
export type GoldenE2ERun = v.InferOutput<typeof GoldenE2ERunSchema>;

/**
 * Full human fix commit loaded only after a locked result passes schema validation.
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
 * Load the closed human commit oracle after the local result has been persisted and validated.
 *
 * @param caseDirectory - Directory containing oracle.json.
 * @returns Validated full human fix commit.
 */
export function loadGoldenHumanOracle(caseDirectory: string): GoldenHumanOracle {
    const oraclePath = join(resolve(caseDirectory), 'oracle.json');
    return v.parse(GoldenHumanOracleSchema, readJson(oraclePath, 'oracle.json'));
}
