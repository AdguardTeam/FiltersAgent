import { readFileSync } from 'node:fs';
import * as v from 'valibot';
import { guidanceRepositorySlugFromRemote } from './knowledge-base-preparer';
import type { LocalRunConfig } from '../../src/local/run-config-types';
import { ExtensionEnvironmentKind } from '../../src/types/extension-environment-kind';
import { KnowledgeBaseEnvironmentKind } from '../../src/types/knowledge-base-environment-kind';

const FullCommitSchema = v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/iu));

const RawLocalRunConfigSchema = v.object({
    filtersBaseSha: v.optional(FullCommitSchema),
    filtersLocalSourcePath: v.optional(v.string()),
    filtersRemoteUrl: v.optional(v.pipe(v.string(), v.minLength(1))),
    filtersCurrentRef: v.optional(v.pipe(v.string(), v.minLength(1))),
    instructionPath: v.optional(v.pipe(v.string(), v.minLength(1))),
    knowledgeBaseSha: v.optional(FullCommitSchema),
    knowledgeBaseLocalSourcePath: v.optional(v.string()),
    knowledgeBaseRemoteUrl: v.optional(v.pipe(v.string(), v.minLength(1))),
    knowledgeBaseCurrentRef: v.optional(v.pipe(v.string(), v.minLength(1))),
});

/**
 * Parse one optional local case file without including any human reference fields.
 *
 * @param configPath - Optional JSON case configuration path.
 * @returns Validated raw overrides.
 */
function readRawConfig(
    configPath: string | undefined,
): v.InferOutput<typeof RawLocalRunConfigSchema> {
    if (!configPath) {
        return v.parse(RawLocalRunConfigSchema, {});
    }
    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch (error) {
        throw new Error(
            `Unable to read local run config ${configPath}: ${(error as Error).message}`,
            {
                cause: error,
            },
        );
    }
    return v.parse(RawLocalRunConfigSchema, raw);
}

/**
 * Load current or exact historical environment configuration for one local run.
 *
 * Human reference metadata is deliberately absent from this API and must be loaded only after the
 * returned environment has completed its core run.
 *
 * @param environment - CLI-selected product time horizon.
 * @param configPath - Optional JSON case file; mandatory for historical runs.
 * @param keepTemporaryFiles - Explicit debug retention flag.
 * @returns Fully defaulted filter and KnowledgeBase settings.
 */
export function loadLocalRunConfig(
    environment: ExtensionEnvironmentKind,
    configPath: string | undefined,
    keepTemporaryFiles: boolean,
): LocalRunConfig {
    if (environment === ExtensionEnvironmentKind.Historical && !configPath) {
        throw new Error('Historical runs require --run-config with exact case provenance.');
    }
    const raw = readRawConfig(configPath);
    if (environment === ExtensionEnvironmentKind.Historical && !raw.filtersBaseSha) {
        throw new Error('Historical runs require filtersBaseSha in the local case config.');
    }
    const filtersEnvironment =
        environment === ExtensionEnvironmentKind.Current
            ? ({ kind: ExtensionEnvironmentKind.Current } as const)
            : ({
                  kind: ExtensionEnvironmentKind.Historical,
                  baseSha: raw.filtersBaseSha!,
              } as const);
    const filtersRemoteUrl =
        raw.filtersRemoteUrl ?? 'https://github.com/AdguardTeam/AdguardFilters.git';
    const knowledgeBaseRemoteUrl =
        raw.knowledgeBaseRemoteUrl ?? 'https://github.com/AdguardTeam/KnowledgeBase.git';
    return {
        environment,
        filters: {
            environment: filtersEnvironment,
            localSourcePath: raw.filtersLocalSourcePath,
            remoteUrl: filtersRemoteUrl,
            currentRef: raw.filtersCurrentRef ?? 'master',
            keepTemporaryFiles,
        },
        knowledgeBase: {
            environment: raw.knowledgeBaseSha
                ? { kind: KnowledgeBaseEnvironmentKind.Pinned, commit: raw.knowledgeBaseSha }
                : { kind: ExtensionEnvironmentKind.Current },
            localSourcePath: raw.knowledgeBaseLocalSourcePath,
            remoteUrl: knowledgeBaseRemoteUrl,
            knowledgeBaseRepository: guidanceRepositorySlugFromRemote(
                knowledgeBaseRemoteUrl,
                'KnowledgeBase',
            ),
            filtersRepository: guidanceRepositorySlugFromRemote(filtersRemoteUrl, 'Filters'),
            currentRef: raw.knowledgeBaseCurrentRef ?? 'master',
            keepTemporaryFiles,
        },
        ...(raw.instructionPath !== undefined ? { instructionPath: raw.instructionPath } : {}),
    };
}
