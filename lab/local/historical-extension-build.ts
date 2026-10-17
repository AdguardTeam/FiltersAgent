import { access, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HistoricalExtensionBuildProvenance } from '../../src/environment/environment-proofs';
import type { ExtensionManifestVersion } from '../../src/environment/extension-preparation';
import type { Logger } from '../../src/logger/logger';
import {
    downloadPinnedExtensionRelease,
    PinnedReleaseError,
} from '../../src/local/pinned-extension-release';
import { fetchAutobuildFilters } from './autobuild-filters-checkout';
import {
    assertBundleParses,
    bundleSourceType,
    spliceLocalScriptRules,
    scriptRuleKeys,
    type HistoricalBackgroundManifest,
} from './background-script-rules';
import {
    autobuildTagFor,
    extensionCodeLine,
    findHistoricalReleaseByTag,
    type HistoricalExtensionRelease,
} from './historical-extension-releases';
import type { ExtensionBuildPin } from './run-config';
import { HistoricalBuildError, HistoricalBuildFailureCode } from './historical-build-error';

/**
 * Official source of the compiled filter trees addressed by autobuild commit.
 */
const AUTOBUILD_REMOTE_URL = 'https://github.com/AdguardTeam/AdguardBrowserExtension.git';

/**
 * Temporary assemblies cannot be mistaken for the completed digest-and-commit cache entry.
 */
const BUILD_TEMP_PREFIX = 'building-';

/**
 * Keep complete historical assemblies separate from release archives and autobuild checkouts.
 */
const HISTORICAL_BUILD_CACHE_SEGMENTS = ['extensions', 'historical'] as const;

/**
 * Extension manifests are both the browser entry point and completed-cache readiness marker.
 */
const MANIFEST_FILE_NAME = 'manifest.json';

/**
 * This supported release line embeds script rules in its background bundle at this path.
 */
const BACKGROUND_BUNDLE_PATH = 'pages/background.js';

/**
 * The compiled filter tree replaces the release tree as one unit.
 */
const FILTERS_DIRECTORY = 'filters';

/**
 * The autobuild source object and key inventory must describe the same script rules.
 */
const SCRIPT_RULES_SOURCE_FILE = 'local_script_rules.js';

/**
 * The compiler's JSON inventory supplies the authoritative rule keys for coverage verification.
 */
const SCRIPT_RULES_INVENTORY_FILE = 'local_script_rules.json';

/**
 * Trusted compiler inventory identifies every script-rule object key.
 */
interface ScriptRulesInventory {
    /**
     * Rule payloads indexed by the same keys as the embedded script-rule object.
     */
    rules: Record<string, unknown>;
}

/**
 * Trusted release manifest fields consumed when assembling a historical extension.
 */
interface HistoricalManifest extends HistoricalBackgroundManifest {
    /**
     * Reporter version installed into the completed build.
     */
    version: string;
    /**
     * Declared browser rulesets whose files must survive filter-tree replacement.
     */
    declarative_net_request: {
        /**
         * Compiled DNR resources referenced by the extension.
         */
        rule_resources: {
            /**
             * Extension-relative path to a compiled ruleset.
             */
            path: string;
        }[];
    };
}

/**
 * Verified release code and autobuild filters ready to load as one reporter build.
 */
export interface HistoricalExtensionBuild {
    /**
     * Complete unpacked extension directory in the host-only cache.
     */
    extensionDir: string;
    /**
     * Browser manifest generation taken from the verified release catalog.
     */
    manifestVersion: ExtensionManifestVersion;
    /**
     * Exact release and autobuild identities used to assemble the extension.
     */
    provenance: HistoricalExtensionBuildProvenance;
}

/**
 * Inputs to deterministic reporter-build preparation.
 */
export interface PrepareHistoricalExtensionBuildOptions {
    /**
     * Reporter version, release code, and exact autobuild commit.
     */
    build: ExtensionBuildPin;
    /**
     * Host-only cache root outside model-visible run directories.
     */
    cacheRoot: string;
    /**
     * Receives assembly stages, identities, paths, and subprocess diagnostics.
     */
    logger: Logger;
    /**
     * Offline fixture transport; production uses the release downloader's global fetch.
     */
    fetchImpl?: typeof fetch;
    /**
     * Verified release catalog, injectable for local fixtures.
     */
    releases?: readonly HistoricalExtensionRelease[];
    /**
     * Alternate local repository for deterministic offline fixtures.
     */
    autobuildRemoteUrl?: string;
}

/**
 * Locate the host-only lab dependency cache within a workspace.
 *
 * @param workspaceRoot - Lab workspace root.
 * @returns Cache directory shared by historical lab runs.
 */
export function labExtensionCacheRoot(workspaceRoot: string): string {
    return join(workspaceRoot, 'tmp', 'cache');
}

/**
 * Assemble verified release code with the reporter's pinned autobuild filter tree.
 *
 * The cache publishes complete builds atomically; failed assembly never yields a reusable entry,
 * and concurrent assemblers converge on the same directory without deleting another build.
 *
 * @param options - Reporter pin, host cache, release catalog, transport, and logger.
 * @returns Complete extension with its five-field historical provenance.
 */
export async function prepareHistoricalExtensionBuild(
    options: PrepareHistoricalExtensionBuildOptions,
): Promise<HistoricalExtensionBuild> {
    const { build, cacheRoot } = options;
    const release = findHistoricalReleaseByTag(build.releaseTag, options.releases);
    if (!release || release.codeLine !== extensionCodeLine(build.version)) {
        throw new HistoricalBuildError(
            HistoricalBuildFailureCode.ReleaseUnknown,
            `No historical release ${build.releaseTag} supports reporter version ${build.version} (code line ${extensionCodeLine(build.version)}).`,
        );
    }
    const parent = join(cacheRoot, ...HISTORICAL_BUILD_CACHE_SEGMENTS);
    const extensionDir = join(parent, `${release.sha256}-${build.autobuildCommit}`);
    const logger = options.logger.child({
        releaseTag: release.tag,
        releaseSha256: release.sha256,
        autobuildTag: autobuildTagFor(build.version),
        autobuildCommit: build.autobuildCommit,
        extensionDir,
    });
    const result: HistoricalExtensionBuild = {
        extensionDir,
        manifestVersion: release.manifestVersion,
        provenance: {
            version: build.version,
            releaseTag: release.tag,
            releaseSha256: release.sha256,
            autobuildTag: autobuildTagFor(build.version),
            autobuildCommit: build.autobuildCommit,
        },
    };
    if (
        await access(join(extensionDir, MANIFEST_FILE_NAME)).then(
            () => true,
            () => false,
        )
    ) {
        logger.info('Reusing complete historical extension build');
        return result;
    }
    logger.info('Preparing historical release code');
    let preparedRelease;
    try {
        preparedRelease = await downloadPinnedExtensionRelease({
            destinationRoot: cacheRoot,
            pinnedRelease: release,
            fetchImpl: options.fetchImpl,
            logger,
        });
    } catch (error) {
        logger.error({ err: error }, 'Historical release preparation failed');
        const detail =
            error instanceof PinnedReleaseError
                ? `${error.code}: ${error.message}`
                : (error as Error).message;
        throw new HistoricalBuildError(
            HistoricalBuildFailureCode.ReleaseUnavailable,
            `Historical release ${release.tag} unavailable: ${detail}`,
            error,
        );
    }
    logger.info('Preparing autobuild filter tree');
    const filters = await fetchAutobuildFilters({
        commit: build.autobuildCommit,
        cacheRoot,
        remoteUrl: options.autobuildRemoteUrl ?? AUTOBUILD_REMOTE_URL,
        logger,
    });
    await mkdir(parent, { recursive: true });
    const temporary = await mkdtemp(join(parent, BUILD_TEMP_PREFIX));
    try {
        logger.info(
            { temporary, releaseDir: preparedRelease.extensionDir, filters },
            'Copying release and replacing its complete filter tree',
        );
        await cp(preparedRelease.extensionDir, temporary, { recursive: true });
        await rm(join(temporary, FILTERS_DIRECTORY), { recursive: true, force: true });
        await cp(filters, join(temporary, FILTERS_DIRECTORY), { recursive: true });
        const manifestPath = join(temporary, MANIFEST_FILE_NAME);
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as HistoricalManifest;
        const backgroundPath = join(temporary, BACKGROUND_BUNDLE_PATH);
        logger.info({ backgroundPath }, 'Splicing and parsing autobuild script rules');
        const spliced = spliceLocalScriptRules(
            await readFile(backgroundPath, 'utf8'),
            await readFile(join(filters, SCRIPT_RULES_SOURCE_FILE), 'utf8'),
        );
        assertBundleParses(spliced.source, bundleSourceType(manifest));
        const inventory = JSON.parse(
            await readFile(join(filters, SCRIPT_RULES_INVENTORY_FILE), 'utf8'),
        ) as ScriptRulesInventory;
        const keys = new Set(scriptRuleKeys(spliced.block));
        const missingKeys = Object.keys(inventory.rules).filter((key) => !keys.has(key));
        if (missingKeys.length > 0) {
            throw new HistoricalBuildError(
                HistoricalBuildFailureCode.ScriptRulesNotCovered,
                `Autobuild script-rule keys missing from the rewritten bundle: ${missingKeys.join(', ')}.`,
            );
        }
        await writeFile(backgroundPath, spliced.source);
        manifest.version = build.version;
        await writeFile(manifestPath, JSON.stringify(manifest, null, 4) + '\n');
        logger.info({ manifestPath }, 'Checking every declared ruleset against the autobuild tree');
        for (const resource of manifest.declarative_net_request.rule_resources) {
            try {
                await access(join(temporary, resource.path));
            } catch (error) {
                logger.error(
                    { err: error, rulesetPath: resource.path },
                    'Historical build lacks a declared ruleset',
                );
                throw new HistoricalBuildError(
                    HistoricalBuildFailureCode.RulesetMissing,
                    `Historical build is missing declared ruleset ${resource.path}: ${(error as Error).message}`,
                    error,
                );
            }
        }
        try {
            await rename(temporary, extensionDir);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== 'EEXIST' && code !== 'ENOTEMPTY') {
                throw error;
            }
            await access(join(extensionDir, MANIFEST_FILE_NAME));
        }
        logger.info('Historical extension build ready');
        return result;
    } catch (error) {
        logger.error({ err: error, temporary }, 'Historical extension assembly failed');
        throw error;
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }
}
