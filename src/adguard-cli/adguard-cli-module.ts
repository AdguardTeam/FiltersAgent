/**
 * The AdGuard CLI as a blocker module: its executor name, the routing guidance the model reads, and
 * the blocker each run starts from the environment. A process that registers this module drives the
 * CLI in-process; the action runs the same blocker as a separate module process
 * (`adguard-cli-module-main.ts`).
 */
import type { BlockerContract } from '../blocker-contract/blocker-contract';
import type { BlockerModuleDefinition } from '../proxy-blocker/blocker-module-executor';
import { createAdguardCliBlocker } from './adguard-cli-blocker';
import {
    ADGUARD_CLI_HOME_ARCHIVE_ENV,
    ADGUARD_CLI_PATH_ENV,
    ADGUARD_LICENSE_KEY_ENV,
    createAdguardCliProxyHost,
} from './adguard-cli-proxy';
import type { ProxyLogger } from './proxy-host';
import { AdguardCliExecutorName } from './executor-name';

/**
 * Model-facing routing prose for the AdGuard CLI executor, contributed to the select_environment
 * description when the executor is available.
 */
const SELECTION_GUIDANCE =
    'An ordinary AdGuard for Windows/Mac (or CLI) website-filtering report belongs to ' +
    'adguard_cli — desktop apps filter network traffic themselves, not through a browser ' +
    'extension. Website-filtering reports from AdGuard mobile apps (iOS/Android) also belong to ' +
    'adguard_cli: the fix ships in shared filter lists, so validate at network level and ' +
    'record the mobile execution-model gap (for example Safari content-blocker syntax limits) as ' +
    'a conflict. An activated adguard_cli selection browses through the filtering proxy for ' +
    'live evidence and applies exactly one candidate rule beside the locked baseline through ' +
    'apply_rule verification phases. Launch every evidence-browser session with ' +
    'extension:"none": the proxy already filters network traffic and there is no extension to ' +
    'prepare. Never claim that the reported desktop app, its platform, or the reporter browser ' +
    'actually ran.';

/**
 * The AdGuard CLI module definition.
 */
export const ADGUARD_CLI_MODULE: BlockerModuleDefinition = {
    executor: AdguardCliExecutorName,
    selectionGuidance: SELECTION_GUIDANCE,
};

/**
 * Environment variables the AdGuard CLI module needs: the executable and the licence. The seeded
 * HOME archive is optional and not listed.
 */
export const ADGUARD_CLI_MODULE_ENV: readonly string[] = [
    ADGUARD_CLI_PATH_ENV,
    ADGUARD_LICENSE_KEY_ENV,
];

/**
 * A blocker that answers only by naming what the environment lacks, so an unconfigured run ends
 * capability-limited with the reason in its log instead of failing somewhere later.
 *
 * @param missing - The variables that are not set.
 * @returns The blocker.
 */
function unconfiguredBlocker(missing: readonly string[]): BlockerContract {
    const refuse = async (): Promise<never> => {
        throw new Error(`The AdGuard CLI module is not configured: set ${missing.join(' and ')}.`);
    };
    return {
        describe: refuse,
        start: refuse,
        apply: refuse,
        state: refuse,
        log: refuse,
        stop: async () => ({ licenceReleased: false }),
    };
}

/**
 * Start the AdGuard CLI blocker described by an environment.
 *
 * @param environment - Environment naming the executable, the licence, and an optional seed.
 * @param workspaceDir - Private directory the blocker keeps its configuration, lists and logs in.
 * @param logger - Logger the proxy reports its lifecycle through.
 * @returns The blocker.
 */
export function startAdguardCliBlocker(
    environment: Readonly<Record<string, string | undefined>>,
    workspaceDir: string,
    logger: ProxyLogger,
): BlockerContract {
    const missing = ADGUARD_CLI_MODULE_ENV.filter((name) => !environment[name]);
    if (missing.length > 0) {
        return unconfiguredBlocker(missing);
    }
    const licenseKey = environment[ADGUARD_LICENSE_KEY_ENV]!;
    const seededHomeArchive = environment[ADGUARD_CLI_HOME_ARCHIVE_ENV] || undefined;
    return createAdguardCliBlocker({
        binaryPath: environment[ADGUARD_CLI_PATH_ENV]!,
        workspaceDir,
        logger,
        createProxy: (proxyInput) =>
            createAdguardCliProxyHost({ ...proxyInput, licenseKey, seededHomeArchive }),
    });
}
