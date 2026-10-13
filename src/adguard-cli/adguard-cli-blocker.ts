/**
 * The AdGuard CLI as a blocker-contract module: the official release running as a filtering proxy,
 * driven by the shared proxy host, answering the six contract operations. Everything that knows the
 * CLI — its configuration, licence, logs and in-page markers — stays behind this module; the agent
 * only sees the contract.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
    BLOCKER_CONTRACT_VERSION,
    BlockerKind,
    PageEvidenceFormat,
    type BlockerApplied,
    type BlockerApplyRequest,
    type BlockerContract,
    type BlockerDescription,
    type BlockerFilterList,
    type BlockerLogRead,
    type BlockerRunning,
    type BlockerStartRequest,
    type BlockerState,
    type BlockerStopped,
} from '../blocker-contract/blocker-contract';
import { readAdguardCliLog } from './adguard-cli-log';
import { filterFilename, INJECTIONS_HOST } from './adguard-cli-proxy-config';
import {
    ProxyHostState,
    type ProxyHost,
    type ProxyHostInput,
    type ProxyLogger,
    type ProxyRoute,
} from './proxy-host';

/**
 * Product label the run reports for this blocker.
 */
export const ADGUARD_CLI_PRODUCT_LABEL = 'AdGuard CLI';

/**
 * The period one applied-rules read covers.
 */
const COVERS =
    'Every request the proxy filtered and every script it injected since this browser session ' +
    'started, on any page (its logs have no page boundary); element hiding as the frames of the ' +
    'current page show it at the moment of the read.';

/**
 * What the proxy applies without ever naming it.
 */
const NOT_REPORTED: readonly string[] = [
    'Network rules other than the one that decided a request: document-level exceptions ' +
        '($document, $elemhide, $generichide, $specifichide, $jsinject, $content) and rules that ' +
        'modify a request or response ($csp, $permissions, $removeparam, $removeheader, $cookie, ' +
        '$replace, $referrerpolicy, $hls, $jsonprune, $xmlprune, $urltransform). The proxy counts ' +
        'them on the request but never logs their text.',
    'Hiding by extended CSS (#?#) rules and by CSS rules that set their own content: the proxy ' +
        'marks neither on the element it hides.',
];

/**
 * The version line `--version` prints.
 */
const VERSION_LINE = /^AdGuard CLI v(\S+)/mu;

/**
 * How long the version probe may take; it only prints and exits.
 */
const VERSION_PROBE_TIMEOUT_MS = 30_000;

/**
 * Promise form of `execFile`.
 */
const execFileAsync = promisify(execFile);

/**
 * Ask the release for its version in a throwaway HOME, so the probe neither reads nor leaves any
 * state the run's own HOME would see.
 *
 * @param binaryPath - The executable.
 * @param logger - Logger for a probe that failed.
 * @returns The version, or null when the release did not print one.
 */
async function probeVersion(binaryPath: string, logger?: ProxyLogger): Promise<string | null> {
    const home = await mkdtemp(join(tmpdir(), 'agcli-version-'));
    try {
        const { stdout } = await execFileAsync(binaryPath, ['--version'], {
            env: { HOME: home, PATH: process.env['PATH'], LANG: 'en_US.UTF-8' },
            timeout: VERSION_PROBE_TIMEOUT_MS,
        });
        return VERSION_LINE.exec(stdout)?.[1] ?? null;
    } catch (error) {
        logger?.info(
            { error: error instanceof Error ? error.message : String(error) },
            'adguard cli version probe failed',
        );
        return null;
    } finally {
        await rm(home, { recursive: true, force: true });
    }
}

/**
 * Whether two list replacements ask for the same executed text.
 *
 * @param left - One replacement, or null.
 * @param right - The other, or null.
 * @returns Whether they are equal.
 */
function sameReplacement(left: BlockerFilterList | null, right: BlockerFilterList | null): boolean {
    return left === null || right === null
        ? left === right
        : left.id === right.id && left.content === right.content;
}

/**
 * Construction input for one AdGuard CLI blocker.
 */
export interface CreateAdguardCliBlockerInput {
    /**
     * Absolute path of the `adguard-cli` executable.
     */
    binaryPath: string;

    /**
     * Directory the blocker owns for configuration, filter files, and logs.
     */
    workspaceDir: string;

    /**
     * Builds the proxy host around the lists a start supplies.
     */
    createProxy: (proxyInput: ProxyHostInput) => ProxyHost;

    /**
     * Logger the proxy reports its lifecycle through.
     */
    logger?: ProxyLogger;
}

/**
 * Create the AdGuard CLI blocker.
 *
 * @param input - Binary, workspace, version, and proxy factory.
 * @returns The blocker answering the contract.
 */
export function createAdguardCliBlocker(input: CreateAdguardCliBlockerInput): BlockerContract {
    let proxy: ProxyHost | null = null;
    let route: ProxyRoute | null = null;
    let revision = 0;
    // The list text the proxy executes instead of a started list's own, if any.
    let replacement: BlockerFilterList | null = null;

    /**
     * The started proxy, or a failure naming the operation that needed it.
     *
     * @param operation - The contract operation.
     * @returns The proxy.
     */
    const requireProxy = (operation: string): ProxyHost => {
        if (proxy === null) {
            throw new Error(`The AdGuard CLI blocker answered ${operation} before it was started.`);
        }
        return proxy;
    };

    /**
     * Record a (re)started proxy route as a new revision.
     *
     * @param next - The route the proxy now listens on.
     * @returns The running configuration.
     */
    const running = (next: ProxyRoute): BlockerRunning => {
        route = next;
        revision += 1;
        return {
            route: { proxyUrl: next.proxyUrl, certificateDerBase64: next.certificateDerBase64 },
            revision,
        };
    };

    /**
     * Execute exactly the requested lists, list text and rules, restarting the proxy as needed.
     *
     * @param request - The lists, the replaced list text, and the rules.
     * @returns How the browser reaches the proxy now.
     */
    const applyRequest = async (request: BlockerApplyRequest): Promise<BlockerApplied> => {
        const host = requireProxy('apply');
        const current = host.snapshot().executedUserRules ?? [];
        let restarted = false;
        const relisted = await host.setEnabledFilters(request.enabledListIds);
        if (relisted !== null) {
            running(relisted);
            restarted = true;
        }
        if (!sameReplacement(replacement, request.listReplacement)) {
            running(
                await host.setFilterReplacement(
                    request.listReplacement === null
                        ? null
                        : {
                              filterId: request.listReplacement.id,
                              content: request.listReplacement.content,
                          },
                ),
            );
            replacement = request.listReplacement;
            restarted = true;
        }
        const sameRules =
            current.length === request.userRules.length &&
            current.every((rule, index) => rule === request.userRules[index]);
        if (!sameRules) {
            running(await host.setUserRules(request.userRules));
            restarted = true;
        }
        return {
            route: {
                proxyUrl: route!.proxyUrl,
                certificateDerBase64: route!.certificateDerBase64,
            },
            revision,
            restarted,
        };
    };

    return {
        async describe(): Promise<BlockerDescription> {
            return {
                contractVersion: BLOCKER_CONTRACT_VERSION,
                product: ADGUARD_CLI_PRODUCT_LABEL,
                version: await probeVersion(input.binaryPath, input.logger),
                binarySha256: createHash('sha256')
                    .update(await readFile(input.binaryPath))
                    .digest('hex'),
                kind: BlockerKind.Proxy,
                covers: COVERS,
                notReported: NOT_REPORTED,
                pageEvidence: {
                    format: PageEvidenceFormat.AdguardMarkers,
                    contentScriptHost: INJECTIONS_HOST,
                },
            };
        },

        async start(request: BlockerStartRequest): Promise<BlockerRunning> {
            if (proxy !== null) {
                throw new Error('The AdGuard CLI blocker was started twice.');
            }
            const host = input.createProxy({
                binaryPath: input.binaryPath,
                workspaceDir: input.workspaceDir,
                logger: input.logger,
                filterLists: request.lists.map((list) => ({
                    filterId: list.id,
                    content: list.content,
                })),
            });
            proxy = host;
            await host.prepare();
            // Not running yet, so this only chooses what the first launch executes.
            await host.setEnabledFilters(request.enabledListIds);
            const started = running(await host.start());
            // A start that asks for rules or a replaced list applies them the way an apply does.
            if (request.userRules.length === 0 && request.listReplacement === null) {
                return started;
            }
            const applied = await applyRequest(request);
            return { route: applied.route, revision: applied.revision };
        },

        apply: applyRequest,

        async state(): Promise<BlockerState> {
            const snapshot = requireProxy('state').snapshot();
            const isRunning = snapshot.state === ProxyHostState.Running && snapshot.port !== null;
            const listIds = isRunning ? (snapshot.executedFilterIds ?? []) : [];
            const lists = [];
            for (const id of listIds) {
                // The bytes the proxy loads, read back from the file it was configured with.
                const bytes = await readFile(join(input.workspaceDir, filterFilename(id)));
                lists.push({ id, sha256: createHash('sha256').update(bytes).digest('hex') });
            }
            const userRules = isRunning ? (snapshot.executedUserRules ?? []) : [];
            return {
                running: isRunning,
                revision,
                port: isRunning ? snapshot.port : null,
                lists,
                userRules,
            };
        },

        async log(cursor: string | null): Promise<BlockerLogRead> {
            requireProxy('log');
            return await readAdguardCliLog(input.workspaceDir, cursor, revision);
        },

        async stop(): Promise<BlockerStopped> {
            if (proxy === null) {
                return { licenceReleased: false };
            }
            await proxy.stop();
            route = null;
            return { licenceReleased: true };
        },
    };
}
