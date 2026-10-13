/**
 * The AdGuard CLI module process: serve the AdGuard CLI blocker over stdio until the agent closes
 * stdin. Stdout carries only protocol lines, so every log goes to stderr as one JSON object per
 * line, where the agent collects it into the run log.
 *
 * Bundled into one file, this is what the `adguard-cli` setup step installs beside the CLI release
 * it downloads; without `ADGUARD_CLI_PATH` the module runs the release installed next to it.
 */
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BLOCKER_WORKSPACE_ENV } from '../blocker-contract/blocker-contract';
import { serveBlocker } from '../blocker-contract/serve-blocker';
import { startAdguardCliBlocker } from './adguard-cli-module';
import { ADGUARD_CLI_PATH_ENV } from './adguard-cli-proxy';
import type { ProxyLogger } from './proxy-host';

/**
 * Where the setup step installs the CLI release, relative to the module file.
 */
const INSTALLED_BINARY = join('bin', 'adguard-cli');

/**
 * A logger writing one JSON line per record to stderr.
 */
const stderrLogger: ProxyLogger = {
    info(fields: Record<string, unknown>, message: string): void {
        process.stderr.write(`${JSON.stringify({ ...fields, msg: message })}\n`);
    },
};

/**
 * Serve the module on this process's stdio.
 *
 * @returns Resolves once the agent closed stdin and the blocker stopped.
 */
export async function runAdguardCliModule(): Promise<void> {
    const workspaceDir = process.env[BLOCKER_WORKSPACE_ENV];
    if (!workspaceDir) {
        throw new Error(`${BLOCKER_WORKSPACE_ENV} must name the module's private workspace.`);
    }
    const environment = {
        ...process.env,
        [ADGUARD_CLI_PATH_ENV]:
            process.env[ADGUARD_CLI_PATH_ENV] ||
            join(dirname(fileURLToPath(import.meta.url)), INSTALLED_BINARY),
    };
    await serveBlocker(
        startAdguardCliBlocker(environment, workspaceDir, stderrLogger),
        process.stdin,
        process.stdout,
    );
}

/**
 * Whether this file is the process entry point, comparing real paths: Node resolves the entry
 * module through symlinks while `argv[1]` keeps the path as typed.
 *
 * @returns Whether to boot.
 */
function isEntryPoint(): boolean {
    const entry = process.argv[1];
    return (
        entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
    );
}

// Boots only when run as the entry point, so tests may import this file.
if (isEntryPoint()) {
    await runAdguardCliModule();
}
