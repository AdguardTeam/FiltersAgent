import type { withPreparedFiltersCheckout } from '../../src/local/filters-preparer';
import { basename, resolve } from 'node:path';
import type { Logger } from 'pino';
import type { ExtensionBuildPin } from '../local/run-config';
import { prepareHistoricalExtensionBuild } from '../local/historical-extension-build';
import {
    extensionCodeLine,
    findHistoricalReleaseForVersion,
} from '../local/historical-extension-releases';
import {
    GoldenRunSchemaVersion,
    loadGoldenHumanOracle,
    loadGoldenRunCase,
    loadLegacyGoldenRunCase,
    readGoldenRunSchemaVersion,
    writeGoldenRunDocument,
    type GoldenE2ERun,
} from './golden-case';
import { readHumanCommitRuleLines } from './human-commit-reader';
import { checkHistoricalHumanFixAbsent, HumanFixPresentError } from './human-fix-build-guard';

export const GoldenCaseCheckStatus = {
    /**
     * The existing document and build passed the guard without changes.
     */
    Passed: 'passed',
    /**
     * A migrated or refreshed document passed the guard and was saved.
     */
    Updated: 'updated',
    /**
     * Checking failed and the run document was left untouched.
     */
    Refused: 'refused',
} as const;

/**
 * Outcome of checking one historical case.
 */
export type GoldenCaseCheckStatus =
    (typeof GoldenCaseCheckStatus)[keyof typeof GoldenCaseCheckStatus];

/**
 * Result suitable for the command's per-case summary.
 */
export interface GoldenCaseCheckResult {
    /**
     * Directory name of the checked case.
     */
    caseName: string;
    /**
     * Whether the existing document passed, changed, or was refused.
     */
    status: GoldenCaseCheckStatus;
    /**
     * Human-readable result or refusal reason.
     */
    detail: string;
    /**
     * Selected build pin, or null when no valid build could be selected.
     */
    extensionBuild: ExtensionBuildPin | null;
}

/**
 * Host paths and optional reporter version used to check a case.
 */
export interface GoldenCaseCheckOptions {
    /**
     * Print one removed rule absent from the build as an advisory warning.
     */
    onWarning?: (rule: string) => void;

    /**
     * Explicit reporter version to resolve for migration or a refreshed pin.
     */
    extensionVersion?: string;
    /**
     * Cache outside the agent-visible case inputs.
     */
    cacheRoot: string;
    /**
     * Structured logger for build diagnostics and refusal errors.
     */
    logger: Logger;
}

/**
 * External reads used by case checking, replaceable with offline fixtures.
 */
export interface GoldenCaseCheckDependencies {
    /**
     * Existing historical filters checkout lifecycle, injectable for offline tests.
     */
    withPreparedFiltersCheckout?: typeof withPreparedFiltersCheckout;

    /**
     * Resolve the official autobuild tag of an explicitly supplied version.
     */
    resolveAutobuildCommit: (version: string) => Promise<string>;
    /**
     * Build assembler, using the production implementation when omitted.
     */
    prepareHistoricalExtensionBuild?: typeof prepareHistoricalExtensionBuild;
    /**
     * Human rule reader, using the production git reader when omitted.
     */
    readHumanCommitRuleLines?: typeof readHumanCommitRuleLines;
}

/**
 * Check a reporter build against the human fix before atomically saving a migrated run document.
 *
 * @param caseDirectory - Existing case directory; issue and oracle files remain untouched.
 * @param options - Cache, diagnostics, and optional explicitly supplied reporter version.
 * @param dependencies - Autobuild resolver and optional offline build and human-rule readers.
 * @returns Per-case outcome, retaining the original run document on any refusal.
 */
export async function checkGoldenCase(
    caseDirectory: string,
    options: GoldenCaseCheckOptions,
    dependencies: GoldenCaseCheckDependencies,
): Promise<GoldenCaseCheckResult> {
    const caseName = basename(resolve(caseDirectory));
    let extensionBuild: ExtensionBuildPin | null = null;
    try {
        const schemaVersion = readGoldenRunSchemaVersion(caseDirectory);
        const current =
            schemaVersion === GoldenRunSchemaVersion.Current
                ? loadGoldenRunCase(caseDirectory).config
                : null;
        const original = current ?? loadLegacyGoldenRunCase(caseDirectory).config;
        const version = options.extensionVersion ?? current?.extensionBuild.version;
        if (version === undefined) {
            throw new Error('A legacy case requires --extension-version <version>.');
        }
        const release = findHistoricalReleaseForVersion(version);
        if (release === undefined) {
            throw new Error(
                `No historical release for code line ${extensionCodeLine(version)} (version ${version}).`,
            );
        }
        extensionBuild = {
            version,
            releaseTag: release.tag,
            autobuildCommit:
                options.extensionVersion === undefined
                    ? current!.extensionBuild.autobuildCommit
                    : await dependencies.resolveAutobuildCommit(version),
        };
        const build = await (
            dependencies.prepareHistoricalExtensionBuild ?? prepareHistoricalExtensionBuild
        )({
            build: extensionBuild,
            cacheRoot: options.cacheRoot,
            logger: options.logger,
        });
        const oracle = loadGoldenHumanOracle(caseDirectory);
        const humanRules = await (
            dependencies.readHumanCommitRuleLines ?? readHumanCommitRuleLines
        )(oracle.humanFixCommit);
        const { violations, warnings } = await checkHistoricalHumanFixAbsent(
            build.extensionDir,
            humanRules,
            original.filtersBaseSha,
            dependencies.withPreparedFiltersCheckout,
        );
        for (const warning of warnings) {
            options.onWarning?.(warning);
        }
        if (violations.length > 0) {
            throw new HumanFixPresentError(violations);
        }
        const document: GoldenE2ERun = {
            ...original,
            schemaVersion: GoldenRunSchemaVersion.Current,
            extensionBuild,
        };
        const unchanged =
            current !== null &&
            current.extensionBuild.version === extensionBuild.version &&
            current.extensionBuild.releaseTag === extensionBuild.releaseTag &&
            current.extensionBuild.autobuildCommit === extensionBuild.autobuildCommit;
        if (!unchanged) {
            writeGoldenRunDocument(caseDirectory, document);
        }
        return {
            caseName,
            status: unchanged ? GoldenCaseCheckStatus.Passed : GoldenCaseCheckStatus.Updated,
            detail: 'Reporter build passed the human-fix absence check.',
            extensionBuild,
        };
    } catch (error) {
        options.logger.error(
            { err: error, caseName, extensionBuild },
            'Historical case check refused',
        );
        return {
            caseName,
            status: GoldenCaseCheckStatus.Refused,
            detail: error instanceof Error ? error.message : String(error),
            extensionBuild,
        };
    }
}
