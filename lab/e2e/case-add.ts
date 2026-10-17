import 'dotenv/config';
import { join } from 'node:path';
import { loadCoreConfig, loadGithubReadConfig } from '../../src/config/config';
import { bindExtractReport } from '../../src/intake/extract-issue-facts';
import { createLogger } from '../../src/logger/logger';
import { labExtensionCacheRoot } from '../local/historical-extension-build';
import { parseGoldenCaseAddArgs } from './case-add-cli';
import { prepareGoldenCase } from './golden-case-preparer';

/**
 * The repository every golden case comes from: a case pins one AdguardFilters issue and the human
 * commit that fixed it there. Named here, so the command needs only a GitHub token and never asks
 * the user for a repository identity.
 */
const CASE_SOURCE_REPOSITORY = { owner: 'AdguardTeam', repo: 'AdguardFilters' } as const;

/**
 * Execute the read-only GitHub case preparation command.
 *
 * Compatibility facts come from the intake extraction, so the command also needs the run's LLM
 * configuration and pays one extraction per candidate report body.
 *
 * @returns Promise resolved after one portable case is validated and materialized.
 */
async function main(): Promise<void> {
    const args = parseGoldenCaseAddArgs(process.argv.slice(2));
    const workspaceRoot = process.cwd();
    const readConfig = loadGithubReadConfig(process.env, {
        flag: `${CASE_SOURCE_REPOSITORY.owner}/${CASE_SOURCE_REPOSITORY.repo}`,
    });
    const coreConfig = loadCoreConfig();
    const prepared = await prepareGoldenCase(
        { token: readConfig.token, ...CASE_SOURCE_REPOSITORY },
        {
            ...args,
            workspaceRoot,
            cacheRoot: labExtensionCacheRoot(workspaceRoot),
            logger: createLogger(),
            onWarning: (rule) => process.stderr.write(`${rule}\n`),
            casesRoot: join(workspaceRoot, 'lab', 'benchmark', 'e2e', 'cases'),
        },
        {
            extractReport: bindExtractReport(coreConfig.llm),
        },
    );
    process.stdout.write(
        `${JSON.stringify(
            {
                caseName: prepared.caseName,
                caseDirectory: prepared.caseDirectory,
                filtersBaseSha: prepared.filtersBaseSha,
                extensionBuild: prepared.extensionBuild,
                promptVisibleScreenshotCount: prepared.promptVisibleScreenshotCount,
            },
            null,
            2,
        )}\n`,
    );
}

main().catch((error: unknown) => {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
});
