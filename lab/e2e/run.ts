import 'dotenv/config';
import { join } from 'node:path';
import { describeBrowserBuild, readAgentRevision } from './benchmark-environment';
import { CLOAKBROWSER_AUTO_UPDATE_VAR } from '../../src/browser/cloakbrowser-auto-update';
import { resolveCloakBrowserAutoUpdate } from '../local/cloakbrowser-auto-update';
import { loadCoreConfig } from '../../src/config/config';
import { describeRunCost, formatUsd } from '../pricing/run-cost';
import { loadUsagePricing } from '../pricing/usage-pricing';
import { parseGoldenE2EArgs } from './golden-cli';
import { goldenOutputLayout, listGoldenCaseNames, runGoldenE2ESuite } from './golden-suite';
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

    const coreConfig = loadCoreConfig(process.env);
    // Every load fails before the first case starts, so a missing variable or a broken price file
    // never costs a browser launch.
    const pricingSnapshot = loadUsagePricing(process.env, workspaceRoot) ?? undefined;
    const layout = goldenOutputLayout(workspaceRoot, selection.outputRoot);
    const suite = await runGoldenE2ESuite(coreConfig, {
        runEnvironment: {
            agent: readAgentRevision(workspaceRoot),
            browser: describeBrowserBuild(workspaceRoot),
        },
        caseNames,
        casesRoot,
        outputRoot: layout.outputRoot,
        evaluationRoot: layout.evaluationRoot,
        refuseExistingCaseDirectories: layout.refuseExisting,
        knowledgeBaseSha: selection.knowledgeBaseSha ?? undefined,
        onKnowledgeBaseResolved: (sha) => process.stdout.write(`KnowledgeBase: ${sha}\n`),
        pricingSnapshot,
    });
    for (const entry of suite.results) {
        const { status, failureKind, detail } = entry.record.outcome;
        const kind = failureKind === null ? '' : ` [${failureKind}]`;
        const reason = detail === null ? '' : ` (${detail})`;
        const { rulesError } = entry.record.human;
        process.stdout.write(
            `${entry.caseName}: ${status}${kind}${reason}\n    ${describeRunCost(entry.cost)}\n` +
                (rulesError === null ? '' : `    human fix not read: ${rulesError}\n`),
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
    process.exitCode = GoldenE2EExitCode.Incomplete;
}
