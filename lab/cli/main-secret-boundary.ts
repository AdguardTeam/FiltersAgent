import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import { createHandledInterruptScope } from '../local/handled-interrupt';
import type { HandledInterruptProcessTarget } from '../local/handled-interrupt';
import { redactText } from '../../src/tracer/redact-text';
import { sanitizeFailureMessage } from '../../src/tracer/redactor';

/**
 * Minimal terminal writer used by production and deterministic bootstrap tests.
 */
export interface MainTerminalWriter {
    /**
     * Write one already sanitized terminal fragment.
     *
     * @param value - Text fragment safe for the selected terminal stream.
     * @returns Writer-specific result ignored by the runtime.
     */
    write(value: string): unknown;
}

/**
 * Command context delivered only after synchronous environment consumption.
 */
export interface MainRuntimeContext {
    /**
     * Frozen environment projection.
     */
    env: Readonly<Record<string, string | undefined>>;
    /**
     * Original executable argv.
     */
    argv: readonly string[];
    /**
     * Fixed workspace root selected by the executable boundary.
     */
    workspaceRoot: string;
    /**
     * Merged first-wins SIGINT/SIGTERM cancellation signal.
     */
    signal: AbortSignal;
    /**
     * Scoped terminal writer that redacts before writing stdout.
     */
    stdout: MainTerminalWriter;
    /**
     * Scoped terminal writer that redacts before writing stderr.
     */
    stderr: MainTerminalWriter;
    /**
     * Record a non-signal command failure without terminating cleanup early.
     */
    setFailureExitCode(): void;
}

/**
 * Dynamically loaded command runtime surface.
 */
export interface MainRuntimeModule {
    /**
     * Parse, dispatch, and await one complete command.
     *
     * @param context - Command and capability context.
     */
    runMainRuntime(context: MainRuntimeContext): Promise<void>;
}

/**
 * Injectable synchronous bootstrap seams.
 */
export interface MainSecretBoundaryOptions {
    /**
     * Actual mutable process environment.
     */
    env?: NodeJS.ProcessEnv;
    /**
     * Executable argv.
     */
    argv?: readonly string[];
    /**
     * Workspace root supplied to command adapters.
     */
    workspaceRoot?: string;
    /**
     * Dynamic command-runtime loader invoked only after environment preparation.
     */
    loadRuntime?: () => Promise<MainRuntimeModule>;
    /**
     * Raw stdout destination wrapped by the redactor.
     */
    stdout?: MainTerminalWriter;
    /**
     * Raw stderr destination wrapped by the redactor.
     */
    stderr?: MainTerminalWriter;
    /**
     * Injectable signal target preserving pre-existing listeners.
     */
    processTarget?: HandledInterruptProcessTarget;
    /**
     * Injectable exit-code sink.
     */
    setExitCode?: (code: number) => void;
    /**
     * Injectable workspace `.env` reader. Production reads the real file only when `env` is not
     * injected; injected-environment callers must opt in explicitly.
     */
    loadWorkspaceEnv?: (workspaceRoot: string) => Record<string, string> | null;
}

/**
 * Read and parse the workspace `.env` for generic configuration keys.
 *
 * @param workspaceRoot - Exact workspace root selected by the executable boundary.
 * @returns Parsed declarations, or null when the file is absent or unreadable.
 */
function readWorkspaceEnvFile(workspaceRoot: string): Record<string, string> | null {
    try {
        return parseDotenv(readFileSync(resolve(workspaceRoot, '.env')));
    } catch {
        return null;
    }
}

/**
 * Apply workspace `.env` declarations to the real environment before command dispatch.
 *
 * The already-present environment always wins.
 *
 * @param env - Actual mutable process environment.
 * @param declarations - Parsed workspace `.env` declarations.
 */
function applyWorkspaceEnv(env: NodeJS.ProcessEnv, declarations: Record<string, string>): void {
    for (const [key, value] of Object.entries(declarations)) {
        if (Object.hasOwn(env, key)) {
            continue;
        }
        env[key] = value;
    }
}

/**
 * Write one terminal fragment through generic redaction.
 *
 * @param writer - Raw destination unavailable to the command runtime.
 * @param value - Potentially unsafe terminal text.
 */
function writeSanitized(writer: MainTerminalWriter, value: string): void {
    try {
        writer.write(redactText(value, []));
    } catch {
        writer.write('TERMINAL_REDACTION_FAILED\n');
    }
}

/**
 * Prepare the environment and dispatch one command runtime invocation.
 *
 * The function is intentionally not declared `async`: workspace `.env` application and the frozen
 * environment projection complete in the caller's current stack before the first Promise is
 * returned. Workspace `.env` is applied only when the real process environment is in use, with the
 * already-exported environment winning.
 *
 * @param options - Optional production boundary replacements used by focused tests.
 * @returns Promise settling only after command work and terminal rendering complete.
 */
export function runMainSecretBoundary(options: MainSecretBoundaryOptions = {}): Promise<void> {
    const env = options.env ?? process.env;
    const stderr = options.stderr ?? { write: (value: string) => process.stderr.write(value) };
    const stdout = options.stdout ?? { write: (value: string) => process.stdout.write(value) };
    const setExitCode = options.setExitCode ?? ((code: number) => (process.exitCode = code));

    const workspaceRoot = options.workspaceRoot ?? process.cwd();
    const productionEnvironment = options.env === undefined;
    const loadWorkspaceEnv =
        options.loadWorkspaceEnv ?? (productionEnvironment ? readWorkspaceEnvFile : undefined);
    if (loadWorkspaceEnv) {
        const declarations = loadWorkspaceEnv(workspaceRoot);
        if (declarations) {
            applyWorkspaceEnv(env, declarations);
        }
    }

    const frozenEnvironment = Object.freeze({ ...env });
    const interruptScope = createHandledInterruptScope({
        processTarget: options.processTarget,
    });
    let commandFailed = false;
    const context: MainRuntimeContext = {
        env: frozenEnvironment,
        argv: Object.freeze([...(options.argv ?? process.argv)]),
        workspaceRoot,
        signal: interruptScope.signal,
        stdout: {
            write: (value) => writeSanitized(stdout, value),
        },
        stderr: {
            write: (value) => writeSanitized(stderr, value),
        },
        setFailureExitCode: () => {
            commandFailed = true;
        },
    };
    let runtime: Promise<MainRuntimeModule>;
    try {
        runtime = (options.loadRuntime ?? (() => import('./main-runtime')))();
    } catch (error) {
        runtime = Promise.reject(error);
    }

    return runtime
        .then(async (loaded) => await loaded.runMainRuntime(context))
        .catch((error: unknown) => {
            commandFailed = true;
            const message = sanitizeFailureMessage(error, [], 1_000);
            writeSanitized(stderr, `Runtime failed: ${message}\n`);
        })
        .finally(() => {
            const intent = interruptScope.intent();
            if (intent?.exitCode !== null && intent?.exitCode !== undefined) {
                setExitCode(intent.exitCode);
            } else if (commandFailed) {
                setExitCode(1);
            }
            interruptScope.dispose();
        });
}
