import 'dotenv/config';
import { join } from 'node:path';
import { describeBrowserBuild, readAgentRevision } from './benchmark-environment';
import { CLOAKBROWSER_AUTO_UPDATE_VAR } from '../../src/browser/cloakbrowser-auto-update';
import { resolveCloakBrowserAutoUpdate } from '../local/cloakbrowser-auto-update';
import { createLogger } from '../../src/logger/logger';
import { enableBlockerModules } from '../../src/proxy-blocker/blocker-module-loader';
import {
    loadLabBlockerModules,
    refuseBlockerModulesInHistoricalRuns,
} from '../local/blocker-modules';
import { ExtensionEnvironmentKind } from '../../src/types/extension-environment-kind';
import { describeRunCost, formatUsd } from '../pricing/run-cost';
import { loadUsagePricing } from '../pricing/usage-pricing';
import { parseGoldenE2EArgs } from './golden-cli';
import { createGoldenBrowserOracleProbe } from './golden-browser-oracle';
import { goldenOutputLayout, listGoldenCaseNames, runGoldenE2ESuite } from './golden-suite';
import { loadGoldenE2EConfigs } from './judge-config';
import { formatGoldenOracleOnlyLine, runGoldenOracleSuite } from './golden-oracle-only';
import { GoldenE2EExitCode } from './golden-exit-code';

/**
 * Run the explicit local-only golden E2E selection and expose its stable exit code.
 *
 * @returns Promise resolved after every selected case completes sequentially.
 */
async function main(): Promise<void> {
    process.env[CLOAKBROWSER_AUTO_UPDATE_VAR] = resolveCloakBrowserAutoUpdate(process.env);
    const selection = parseGoldenE2EArgs(process.argv.slice(2));
    const workspaceRoot = process.cwd();
    const casesRoot = join(workspaceRoot, 'lab', 'benchmark', 'e2e', 'cases');
    const availableCases = listGoldenCaseNames(casesRoot);
    const caseNames = selection.selection === 'all' ? availableCases : [selection.caseName];
    if (caseNames.length === 0) {
        throw new Error(`No golden E2E cases found under ${casesRoot}.`);
    }
    if (selection.selection === 'case' && !availableCases.includes(selection.caseName)) {
        throw new Error(`Unknown golden E2E case: ${selection.caseName}`);
    }

    const configs = loadGoldenE2EConfigs(process.env, selection.oracleOnly);
    const series = {
        judgeConfig: configs.judge,
        judgeCacheRoot: join(workspaceRoot, 'tmp', 'e2e-judge-cache'),
        refreshJudgeCache: selection.refresh,
    };
    if (selection.oracleOnly) {
        const suite = await runGoldenOracleSuite(
            {
                caseNames,
                casesRoot,
                oracleRoot: join(workspaceRoot, 'tmp', 'e2e-oracle-runs'),
                series,
            },
            { createJudgeProbe: createGoldenBrowserOracleProbe },
        );
        for (const entry of suite.results) {
            process.stdout.write(`${formatGoldenOracleOnlyLine(entry.caseName, entry.result)}\n`);
        }
        process.exitCode = suite.exitCode;
        return;
    }
    if (!configs.agent) {
        throw new Error('Golden model runs require agent configuration.');
    }
    // Every load fails before the first case starts, so a missing variable, a broken price file
    // or a broken module manifest never costs a browser launch.
    refuseBlockerModulesInHistoricalRuns(
        ExtensionEnvironmentKind.Historical,
        selection.blockerModules,
    );
    const pricingSnapshot = loadUsagePricing(process.env, workspaceRoot) ?? undefined;
    const modules = loadLabBlockerModules(selection.blockerModules, workspaceRoot, process.env);
    // A case locks the browser extension and every plugged-in module, so each one is enabled.
    const blockerModules = enableBlockerModules(
        modules.map((module) => module.manifest.executor),
        modules,
        process.env,
        createLogger(),
    );
    const layout = goldenOutputLayout(workspaceRoot, selection.outputRoot);
    const suite = await runGoldenE2ESuite(
        configs.agent,
        {
            series: {
                ...series,
                runEnvironment: {
                    agent: readAgentRevision(workspaceRoot),
                    browser: describeBrowserBuild(workspaceRoot),
                },
            },
            caseNames,
            casesRoot,
            outputRoot: layout.outputRoot,
            evaluationRoot: layout.evaluationRoot,
            refuseExistingCaseDirectories: layout.refuseExisting,
            knowledgeBaseSha: selection.knowledgeBaseSha ?? undefined,
            onKnowledgeBaseResolved: (sha) => process.stdout.write(`KnowledgeBase: ${sha}\n`),
            pricingSnapshot,
            blockerModules,
        },
        { createJudgeProbe: createGoldenBrowserOracleProbe },
    );
    for (const entry of suite.results) {
        process.stdout.write(
            `${entry.caseName}: ${entry.result.status} (${entry.result.detail})\n` +
                `    ${describeRunCost(entry.cost)}\n`,
        );
    }
    if (pricingSnapshot && suite.results.length > 1) {
        const pricedTotal = suite.results.reduce((sum, entry) => sum + (entry.cost.usd ?? 0), 0);
        process.stdout.write(`total priced cost: ${formatUsd(pricedTotal)}\n`);
    }
    process.exitCode = suite.exitCode;
}

try {
    await main();
} catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = GoldenE2EExitCode.InfrastructureFailure;
}
