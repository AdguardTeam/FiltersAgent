import 'dotenv/config';
import { join } from 'node:path';
import { loadGithubReadConfig } from '../../src/config/config';
import { createOctokit } from '../../src/github/fetch-issue';
import { createLogger } from '../../src/logger/logger';
import { labExtensionCacheRoot } from '../local/historical-extension-build';
import { autobuildTagFor } from '../local/historical-extension-releases';
import { CaseCheckSelection, parseGoldenCaseCheckArgs } from './case-check-cli';
import { checkGoldenCase, GoldenCaseCheckStatus } from './golden-case-check';
import { listGoldenCaseNames } from './golden-suite';
import { resolveAutobuildTagCommit } from './historical-case-metadata';

/**
 * Official repository whose autobuild tags identify historical extension lists.
 */
const EXTENSION_REPOSITORY_SLUG = 'AdguardTeam/AdguardBrowserExtension';

/**
 * Check every selected case without loading any model configuration or opening a browser.
 *
 * @returns Promise resolved after all selected cases have been reported.
 */
async function main(): Promise<void> {
    const args = parseGoldenCaseCheckArgs(process.argv.slice(2));
    const workspaceRoot = process.cwd();
    const casesRoot = join(workspaceRoot, 'lab', 'benchmark', 'e2e', 'cases');
    const caseNames =
        args.selection === CaseCheckSelection.All
            ? listGoldenCaseNames(casesRoot)
            : [args.caseName!];
    const logger = createLogger();
    let octokit: ReturnType<typeof createOctokit> | undefined;
    for (const caseName of caseNames) {
        const result = await checkGoldenCase(
            join(casesRoot, caseName),
            {
                extensionVersion: args.extensionVersion,
                cacheRoot: labExtensionCacheRoot(workspaceRoot),
                logger,
                onWarning: (rule) => process.stderr.write(`${rule}\n`),
            },
            {
                resolveAutobuildCommit: async (version) => {
                    octokit ??= createOctokit(
                        loadGithubReadConfig(process.env, { flag: EXTENSION_REPOSITORY_SLUG }),
                    );
                    return resolveAutobuildTagCommit(octokit, autobuildTagFor(version));
                },
            },
        );
        process.stdout.write(`${result.caseName}: ${result.status} (${result.detail})\n`);
        if (result.status === GoldenCaseCheckStatus.Refused) {
            process.exitCode = 1;
        }
    }
}

main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
});
