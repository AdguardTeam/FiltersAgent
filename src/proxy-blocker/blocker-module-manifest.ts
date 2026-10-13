/**
 * The manifest a blocker module ships beside its code: the executor it registers, the routing
 * guidance the model reads, the command that starts it, and the environment variables it needs or
 * can use. A workflow plugs a module in by naming its manifest; the action reads the manifest,
 * registers the executor, and starts the module per run with exactly the variables the manifest
 * lists.
 *
 * A manifest comes from whatever repository the action runs in, so it is validated here, once.
 */
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import * as v from 'valibot';
import { spawnBlockerProcess } from '../blocker-contract/blocker-process';
import { BLOCKER_WORKSPACE_ENV, type BlockerContract } from '../blocker-contract/blocker-contract';
import { ExecutorNameSchema } from '../environment/executor-name';
import type { Logger } from '../logger/logger';
import type { BlockerModuleDefinition } from './blocker-module-executor';
import type { EnabledBlockerModule } from './blocker-module-run-issue';

/**
 * Upper bound of the routing guidance, which lands verbatim in a tool description the model reads
 * on every turn.
 */
const MAX_GUIDANCE_LENGTH = 2_000;

/**
 * Environment variable names a manifest may list: the portable shell identifier shape.
 */
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/u;

/**
 * Variables every module process receives regardless of its manifest: what any executable needs to
 * run, and nothing secret.
 */
const BASE_ENVIRONMENT = ['PATH', 'HOME', 'LANG', 'TMPDIR'] as const;

export const BlockerModuleManifestSchema = v.strictObject({
    executor: ExecutorNameSchema,
    selectionGuidance: v.pipe(v.string(), v.nonEmpty(), v.maxLength(MAX_GUIDANCE_LENGTH)),
    command: v.pipe(v.array(v.pipe(v.string(), v.nonEmpty())), v.minLength(1)),
    env: v.array(v.pipe(v.string(), v.regex(ENV_NAME))),
    // Variables passed when the step sets them and left out otherwise, such as a cached state the
    // module falls back from.
    optionalEnv: v.optional(v.array(v.pipe(v.string(), v.regex(ENV_NAME))), []),
});

/**
 * A validated module manifest.
 */
export type BlockerModuleManifest = v.InferOutput<typeof BlockerModuleManifestSchema>;

/**
 * A manifest with where it was read from, so its relative command resolves against its own
 * directory.
 */
export interface LoadedBlockerModule {
    /**
     * The validated manifest.
     */
    manifest: BlockerModuleManifest;

    /**
     * Directory the manifest file sits in.
     */
    directory: string;
}

/**
 * Read and validate one manifest file.
 *
 * @param path - Absolute path of the manifest.
 * @returns The manifest and its directory.
 * @throws {Error} Naming the file and every problem when it is not a valid manifest.
 */
export function loadBlockerModuleManifest(path: string): LoadedBlockerModule {
    const parsed = v.safeParse(BlockerModuleManifestSchema, JSON.parse(readFileSync(path, 'utf8')));
    if (!parsed.success) {
        throw new Error(`${path} is not a blocker module manifest: ${v.summarize(parsed.issues)}`);
    }
    return { manifest: parsed.output, directory: dirname(path) };
}

/**
 * The module's executor definition.
 *
 * @param module - The loaded module.
 * @returns Its executor name and guidance.
 */
export function blockerModuleDefinition(module: LoadedBlockerModule): BlockerModuleDefinition {
    return {
        executor: module.manifest.executor,
        selectionGuidance: module.manifest.selectionGuidance,
    };
}

/**
 * Name the variables a module needs that the environment does not set.
 *
 * @param module - The loaded module.
 * @param environment - The environment the module would start from.
 * @returns The missing variable names, empty when the module can start.
 */
export function missingModuleEnvironment(
    module: LoadedBlockerModule,
    environment: Readonly<Record<string, string | undefined>>,
): string[] {
    return module.manifest.env.filter((name) => !environment[name]);
}

/**
 * Resolve one command word: a relative path starting with `./` or `../` against the manifest's
 * directory, anything else as written (an absolute path, or a program found on PATH).
 *
 * @param word - The command word.
 * @param directory - The manifest's directory.
 * @returns The resolved word.
 */
function resolveCommandWord(word: string, directory: string): string {
    return !isAbsolute(word) && (word.startsWith('./') || word.startsWith('../'))
        ? resolve(directory, word)
        : word;
}

/**
 * The environment one module process starts with: the base variables, the variables the manifest
 * lists that the environment sets, and the private workspace.
 *
 * @param module - The loaded module.
 * @param environment - The environment the variables are taken from.
 * @param workspaceDir - The process's private workspace.
 * @returns The process environment.
 */
export function blockerModuleProcessEnvironment(
    module: LoadedBlockerModule,
    environment: Readonly<Record<string, string | undefined>>,
    workspaceDir: string,
): Record<string, string> {
    const passed = [...BASE_ENVIRONMENT, ...module.manifest.env, ...module.manifest.optionalEnv];
    return {
        ...Object.fromEntries(
            passed.flatMap((name) => {
                const value = environment[name];
                return value === undefined ? [] : [[name, value]];
            }),
        ),
        [BLOCKER_WORKSPACE_ENV]: workspaceDir,
    };
}

/**
 * Enable one loaded module for a run: each issue starts its own module process with the environment
 * `blockerModuleProcessEnvironment` builds.
 *
 * @param module - The loaded module.
 * @param environment - The environment the variables are taken from.
 * @param logger - Run logger the module's output reaches.
 * @returns The module, ready for the per-issue engine.
 */
export function enableBlockerModule(
    module: LoadedBlockerModule,
    environment: Readonly<Record<string, string | undefined>>,
    logger: Logger,
): EnabledBlockerModule {
    const [command, ...args] = module.manifest.command.map((word) =>
        resolveCommandWord(word, module.directory),
    );
    return {
        executor: module.manifest.executor,
        startBlocker: (workspaceDir: string): BlockerContract =>
            spawnBlockerProcess({
                command: command!,
                args,
                env: blockerModuleProcessEnvironment(module, environment, workspaceDir),
                logger,
            }),
    };
}
