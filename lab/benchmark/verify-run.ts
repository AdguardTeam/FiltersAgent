import { realpathSync } from 'node:fs';
import { verifyLocalRunManifest } from '../../src/local/run-manifest';

/**
 * Verify the canonical fix-agent run directory before crossing a workflow trust boundary.
 *
 * @returns Nothing after printing the locked run identifier.
 */
async function main(): Promise<void> {
    const configuredDirectory = process.env.AGENT_RUN_DIRECTORY?.trim();
    if (!configuredDirectory) {
        throw new Error('AGENT_RUN_DIRECTORY is required to verify a locked agent run.');
    }
    const runDirectory = realpathSync(configuredDirectory);
    const manifest = verifyLocalRunManifest(runDirectory);
    process.stdout.write(`${manifest.runId}\n`);
}

main().catch((error: unknown) => {
    process.stderr.write(`Agent run verification failed: ${(error as Error).message}\n`);
    process.exitCode = 1;
});
