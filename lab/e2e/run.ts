import 'dotenv/config';
import { join } from 'node:path';
import { loadCoreConfig } from '../../src/config/config';
import { createLogger } from '../../src/logger/logger';
import { enableBlockerModules } from '../../src/proxy-blocker/blocker-module-loader';
import { loadLabBlockerModules } from '../local/blocker-modules';
import { describeRunCost, formatUsd } from '../pricing/run-cost';
import { loadUsagePricing } from '../pricing/usage-pricing';
import { parseGoldenE2EArgs } from './golden-cli';
import { createGoldenBrowserOracleProbe } from './golden-browser-oracle';
import { listGoldenCaseNames, runGoldenE2ESuite } from './golden-suite';

/**
 * Run the explicit local-only golden E2E selection and expose its stable exit code.
 *
 * @returns Promise resolved after every selected case completes sequentially.
 */
async function main(): Promise<void> {
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

    // Every load fails before the first case starts, so a missing variable, a broken price file
    // or a broken module manifest never costs a browser launch.
    const coreConfig = loadCoreConfig();
    const pricingSnapshot = loadUsagePricing(process.env, workspaceRoot) ?? undefined;
    const modules = loadLabBlockerModules(selection.blockerModules, workspaceRoot, process.env);
    // A case locks the browser extension and every plugged-in module, so each one is enabled.
    const blockerModules = enableBlockerModules(
        modules.map((module) => module.manifest.executor),
        modules,
        process.env,
        createLogger(),
    );
    const suite = await runGoldenE2ESuite(
        coreConfig,
        {
            caseNames,
            casesRoot,
            outputRoot: join(workspaceRoot, 'tmp', 'e2e-runs'),
            evaluationRoot: join(workspaceRoot, 'tmp', 'e2e-evaluations'),
            pricingSnapshot,
            blockerModules,
        },
        { probeHumanCandidate: createGoldenBrowserOracleProbe(coreConfig) },
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
    process.exitCode = 3;
}
