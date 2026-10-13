/**
 * The filtering proxy a desktop run drives, whichever engine it is: the lifecycle both engines
 * share — workspace files, port, spawn, readiness, restarts, stop — and the {@link ProxyEngine} seam
 * through which an engine supplies what differs (its authority, configuration, command line, and
 * what it must release when the run ends).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, open, writeFile, chmod } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { join } from 'node:path';
import {
    filterFilename,
    OUTPUT_LOG_FILENAME,
    USER_RULES_FILENAME,
} from './adguard-cli-proxy-config';

/**
 * Hard deadline for the proxy to accept connections after it was spawned.
 */
const READINESS_TIMEOUT_MS = 60_000;

/**
 * Interval between readiness probes.
 */
const READINESS_POLL_MS = 250;

/**
 * Grace a stopped proxy gets after SIGTERM before SIGKILL.
 */
const TERMINATE_GRACE_MS = 10_000;

/**
 * Lifecycle states of a proxy host.
 */
export const ProxyHostState = {
    New: 'new',
    Prepared: 'prepared',
    Running: 'running',
    Stopped: 'stopped',
    Failed: 'failed',
} as const;
export type ProxyHostState = (typeof ProxyHostState)[keyof typeof ProxyHostState];

/**
 * Stable path-free failures of the proxy boundary.
 */
export const ProxyFailureCode = {
    WorkspaceUnwritable: 'workspace_unwritable',
    SpawnFailed: 'spawn_failed',
    ReadinessTimeout: 'readiness_timeout',
    ProcessExited: 'process_exited',
    DataDirectoryUnknown: 'data_directory_unknown',
    ActivationFailed: 'activation_failed',
    CertificateUnavailable: 'certificate_unavailable',
} as const;
export type ProxyFailureCode = (typeof ProxyFailureCode)[keyof typeof ProxyFailureCode];

/**
 * Stable non-echoing failure raised by a proxy host.
 */
export class ProxyHostError extends Error {
    /**
     * Create one path-free proxy failure.
     *
     * @param code - Stable public failure classification.
     * @param cause - Underlying error, kept for the log.
     */
    constructor(
        readonly code: ProxyFailureCode,
        cause?: unknown,
    ) {
        super(`Filtering proxy failed: ${code}.`, { cause });
        this.name = 'ProxyHostError';
    }
}

/**
 * One filter list the proxy executes, as bytes the caller already resolved.
 */
export interface ProxyFilterList {
    /**
     * Official catalog identifier the list came from, used only for reporting.
     */
    filterId: number;

    /**
     * Complete filter list text.
     */
    content: string;
}

/**
 * Route facts a browser needs to reach the running proxy.
 */
export interface ProxyRoute {
    /**
     * Canonical loopback HTTP proxy URL.
     */
    proxyUrl: string;

    /**
     * Loopback port the proxy accepted.
     */
    port: number;

    /**
     * Absolute path of the certificate authority the proxy signs with.
     */
    certificatePath: string;

    /**
     * Base64 DER of that authority.
     */
    certificateDerBase64: string;
}

/**
 * Path-free lifecycle snapshot of the proxy.
 */
export interface ProxySnapshot {
    /**
     * Current host state.
     */
    state: ProxyHostState;

    /**
     * Loopback port while running, or null.
     */
    port: number | null;

    /**
     * Identifiers of the filter lists the proxy was configured with.
     */
    filterIds: readonly number[];

    /**
     * Number of agent-authored rules currently installed.
     */
    userRuleCount: number;

    /**
     * Identifiers of the lists the running proxy was launched with, in load order, or null while
     * none runs.
     */
    executedFilterIds: readonly number[] | null;

    /**
     * The agent-authored rules the running proxy was launched with, or null while none runs.
     */
    executedUserRules: readonly string[] | null;

    /**
     * First terminal failure classification, or null.
     */
    failureCode: ProxyFailureCode | null;
}

/**
 * What one launch of the proxy executes.
 */
interface ProxyLaunchRecord {
    /**
     * Identifiers of the lists the launch loaded, in load order.
     */
    filterIds: readonly number[];

    /**
     * The agent-authored rules the launch loaded.
     */
    userRules: readonly string[];
}

/**
 * Host owning one filtering proxy for a run. What the proxy executes is exactly the filter files
 * the caller supplies plus the agent-authored rules.
 */
export interface ProxyHost {
    /**
     * Write the filter lists and rules into the owned workspace and let the engine prepare.
     */
    prepare(): Promise<void>;

    /**
     * Start the proxy and wait until it accepts connections.
     *
     * @returns Route facts for the controlled browser.
     */
    start(): Promise<ProxyRoute>;

    /**
     * Replace the agent-authored rules and restart so the proxy executes them.
     *
     * @param rules - Exact rule lines, in order.
     * @returns Route facts of the restarted proxy.
     */
    setUserRules(rules: readonly string[]): Promise<ProxyRoute>;

    /**
     * Replace the text one prepared filter list executes, or restore the prepared text, and restart
     * so the proxy executes it.
     *
     * At most one list is replaced at a time: a replacement for another list restores the first.
     *
     * @param replacement - List and its complete replacement text, or null to restore.
     * @returns Route facts of the restarted proxy.
     */
    setFilterReplacement(replacement: ProxyFilterList | null): Promise<ProxyRoute>;

    /**
     * Choose which prepared filter lists the proxy executes, restarting a running proxy to enact
     * the change.
     *
     * This is what makes a phase honest: an environment phase that claims a disabled baseline must
     * ride a proxy executing no filter list, not a bookkeeping entry saying so.
     *
     * @param filterIds - Enabled subset of the prepared lists, or null for every prepared list.
     * @returns Route facts when a running proxy was restarted to enact a change, null otherwise.
     */
    setEnabledFilters(filterIds: readonly number[] | null): Promise<ProxyRoute | null>;

    /**
     * Stop the proxy and release what the engine holds. Idempotent.
     */
    stop(): Promise<void>;

    /**
     * Read the path-free lifecycle snapshot.
     *
     * @returns Immutable proxy state.
     */
    snapshot(): ProxySnapshot;
}

/**
 * Structured logger a proxy host reports every lifecycle step through, because a proxy that
 * silently takes minutes is indistinguishable from one that hung.
 */
export interface ProxyLogger {
    /**
     * Emit one structured informational record.
     *
     * @param fields - Structured fields.
     * @param message - Human-readable message.
     */
    info(fields: Record<string, unknown>, message: string): void;
}

/**
 * Construction input every proxy host takes, whichever engine it runs.
 */
export interface ProxyHostInput {
    /**
     * Absolute path of the engine executable.
     */
    binaryPath: string;

    /**
     * Absolute directory the host owns for filter lists, rules, configuration, and logs.
     */
    workspaceDir: string;

    /**
     * Filter lists the proxy executes, in load order.
     */
    filterLists: readonly ProxyFilterList[];

    /**
     * Injectable loopback port reservation for deterministic tests.
     */
    reservePort?: () => Promise<number>;

    /**
     * Injectable process spawner for deterministic tests.
     */
    spawnProcess?: typeof spawn;

    /**
     * Injectable readiness probe for deterministic tests.
     */
    probePort?: (port: number) => Promise<boolean>;

    /**
     * Optional logger.
     */
    logger?: ProxyLogger;
}

/**
 * How one engine's proxy process is started.
 */
export interface ProxyCommand {
    /**
     * Arguments after the executable.
     */
    args: readonly string[];

    /**
     * Working directory, or undefined for the workspace.
     */
    cwd?: string;

    /**
     * Complete child environment, or undefined to inherit.
     */
    env?: NodeJS.ProcessEnv;
}

/**
 * What differs between engines behind one {@link ProxyHost}.
 */
export interface ProxyEngine {
    /**
     * Engine name used in log messages.
     */
    name: string;

    /**
     * Prepare the engine after the workspace holds the filter lists and rules. When this throws,
     * the host calls {@link release} at once, so whatever the engine acquired before the failure (a
     * licence activation) is released by the same host that acquired it.
     *
     * @returns The authority the engine signs intercepted connections with.
     */
    prepare(): Promise<Pick<ProxyRoute, 'certificatePath' | 'certificateDerBase64'>>;

    /**
     * Write the configuration one launch runs with.
     *
     * @param port - Loopback HTTP proxy port.
     * @param filterFilenames - Workspace filter list filenames in load order, user rules last.
     */
    writeConfiguration(port: number, filterFilenames: readonly string[]): Promise<void>;

    /**
     * Name the proxy process to start.
     *
     * @returns Arguments, working directory, and environment.
     */
    command(): ProxyCommand;

    /**
     * Release what the engine holds once the proxy is stopped. Called at most once.
     */
    release(): Promise<void>;
}

/**
 * Proxy children this process started, killed when it exits by any path.
 */
const liveProxies = new Set<ChildProcess>();

/**
 * Whether the exit hooks that kill live proxies are installed.
 */
let orphanGuardInstalled = false;

/**
 * Make one proxy child die with this process.
 *
 * @param child - Spawned proxy process.
 */
export function registerOrphanGuard(child: ChildProcess): void {
    liveProxies.add(child);
    child.once('exit', () => liveProxies.delete(child));
    if (orphanGuardInstalled) {
        return;
    }
    orphanGuardInstalled = true;
    const killAll = (): void => {
        for (const proxy of liveProxies) {
            proxy.kill('SIGKILL');
        }
        liveProxies.clear();
    };
    process.once('exit', killAll);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
        process.once(signal, () => {
            killAll();
            process.kill(process.pid, signal);
        });
    }
}

/**
 * Reserve a free loopback port by binding and releasing it.
 *
 * @returns Port number the operating system offered.
 */
export async function reserveLoopbackPort(): Promise<number> {
    return await new Promise<number>((resolve, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
            const address = server.address();
            if (address === null || typeof address === 'string') {
                server.close(() => reject(new Error('port_reservation_failed')));
                return;
            }
            const { port } = address;
            server.close(() => resolve(port));
        });
    });
}

/**
 * Check whether something accepts connections on a loopback port.
 *
 * @param port - Loopback port to probe.
 * @returns Whether the connection succeeded.
 */
export async function probeLoopbackPort(port: number): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
        const socket = connect({ host: '127.0.0.1', port });
        const settle = (value: boolean): void => {
            socket.destroy();
            resolve(value);
        };
        socket.setTimeout(2_000);
        socket.once('connect', () => settle(true));
        socket.once('timeout', () => settle(false));
        socket.once('error', () => settle(false));
    });
}

/**
 * Describe a caught error for a log record.
 *
 * @param error - Caught value.
 * @returns Message and stack where available.
 */
export function describeError(error: unknown): Record<string, unknown> {
    if (!(error instanceof Error)) {
        return { error: String(error) };
    }
    return {
        error: error.message,
        stack: error.stack,
        ...(error.cause === undefined ? {} : { cause: describeError(error.cause) }),
    };
}

/**
 * Create a run-owned proxy host around one engine.
 *
 * @param input - Executable, workspace, filter lists, and optional seams.
 * @param engine - Engine supplying authority, configuration, command line, and release.
 * @returns Host exposing prepare, start, rule replacement, and stop.
 */
export function createProxyHost(input: ProxyHostInput, engine: ProxyEngine): ProxyHost {
    const reservePort = input.reservePort ?? reserveLoopbackPort;
    const spawnProcess = input.spawnProcess ?? spawn;
    const probePort = input.probePort ?? probeLoopbackPort;
    /**
     * Log one lifecycle record under the engine's name.
     *
     * @param fields - Structured fields.
     * @param message - Message after the engine name.
     */
    const log = (fields: Record<string, unknown>, message: string): void => {
        input.logger?.info(fields, `${engine.name} ${message}`);
    };

    let state: ProxyHostState = ProxyHostState.New;
    let failureCode: ProxyFailureCode | null = null;
    let child: ChildProcess | null = null;
    let childExited = false;
    let port: number | null = null;
    let userRules: readonly string[] = [];
    // The one prepared list whose executed text currently differs from the prepared text.
    let replacedFilterId: number | null = null;
    // Null means every prepared list; a set narrows execution to the phase's enabled subset.
    let enabledFilterIds: ReadonlySet<number> | null = null;
    let authority: Pick<ProxyRoute, 'certificatePath' | 'certificateDerBase64'> | null = null;
    let released = false;
    // What the running child was launched with: the lists and rules it executes, not the ones a
    // caller asked for since.
    let executed: ProxyLaunchRecord | null = null;

    const userRulesPath = join(input.workspaceDir, USER_RULES_FILENAME);
    const outputLogPath = join(input.workspaceDir, OUTPUT_LOG_FILENAME);

    /**
     * Identifiers of the lists the next launch executes.
     *
     * @returns Enabled subset of the prepared lists, in load order.
     */
    const activeFilterIds = (): readonly number[] => {
        return input.filterLists
            .map((list) => list.filterId)
            .filter((filterId) => enabledFilterIds === null || enabledFilterIds.has(filterId));
    };

    /**
     * Record the first terminal failure and build its error.
     *
     * @param code - Failure classification.
     * @returns Error to throw.
     */
    const fail = (code: ProxyFailureCode): ProxyHostError => {
        state = ProxyHostState.Failed;
        failureCode ??= code;
        return new ProxyHostError(code);
    };

    /**
     * Write the text one filter list executes, normalized to end in a newline.
     *
     * @param list - List and the text the proxy loads for it.
     */
    const writeFilterList = async (list: ProxyFilterList): Promise<void> => {
        await writeFile(
            join(input.workspaceDir, filterFilename(list.filterId)),
            list.content.endsWith('\n') ? list.content : `${list.content}\n`,
            { mode: 0o600 },
        );
    };

    /**
     * Write the agent-authored rule list the proxy always loads last.
     */
    const writeUserRules = async (): Promise<void> => {
        const body = ['! Agent-authored rules', ...userRules].join('\n');
        await writeFile(userRulesPath, `${body}\n`, { mode: 0o600 });
    };

    /**
     * Release the engine once.
     */
    const release = async (): Promise<void> => {
        if (released) {
            return;
        }
        released = true;
        await engine.release();
    };

    /**
     * Start the proxy on a fresh port and wait for readiness.
     *
     * @returns Route facts of the running proxy.
     */
    const launch = async (): Promise<ProxyRoute> => {
        if (authority === null) {
            throw new Error('The proxy host was not prepared.');
        }
        const chosenPort = await reservePort();
        const filterFilenames = [
            ...activeFilterIds().map((filterId) => filterFilename(filterId)),
            USER_RULES_FILENAME,
        ];
        await engine.writeConfiguration(chosenPort, filterFilenames);
        const command = engine.command();
        // Appended across restarts, so every launch opens with a marker line naming what it runs.
        const output = await open(outputLogPath, 'a', 0o600);
        let spawned: ChildProcess;
        try {
            await output.write(
                `--- ${new Date().toISOString()} starting ${engine.name} on port ${chosenPort} ` +
                    `with filters ${activeFilterIds().join(',')} and ${userRules.length} user rules\n`,
            );
            spawned = spawnProcess(input.binaryPath, [...command.args], {
                cwd: command.cwd ?? input.workspaceDir,
                env: command.env,
                stdio: ['ignore', output.fd, output.fd],
            });
        } catch (error) {
            log(describeError(error), 'spawn failed');
            throw fail(ProxyFailureCode.SpawnFailed);
        } finally {
            // The child holds its own copies of the descriptor.
            await output.close();
        }
        childExited = false;
        spawned.once('exit', (code, signal) => {
            childExited = true;
            log({ pid: spawned.pid ?? null, code, signal }, 'process exited');
        });
        child = spawned;
        port = chosenPort;
        executed = { filterIds: activeFilterIds(), userRules: [...userRules] };
        // A proxy must never outlive the run that started it. Without this a killed or crashed
        // run leaves the process holding its port and workspace, and orphans accumulate across
        // runs until one of them hangs a later run.
        registerOrphanGuard(spawned);

        const startedAt = Date.now();
        log(
            {
                port: chosenPort,
                filterIds: activeFilterIds(),
                preparedFilterIds: input.filterLists.map((list) => list.filterId),
                userRuleCount: userRules.length,
                pid: spawned.pid ?? null,
            },
            'spawned, waiting for readiness',
        );
        const deadline = Date.now() + READINESS_TIMEOUT_MS;
        for (;;) {
            if (childExited) {
                throw fail(ProxyFailureCode.ProcessExited);
            }
            if (await probePort(chosenPort)) {
                break;
            }
            if (Date.now() > deadline) {
                throw fail(ProxyFailureCode.ReadinessTimeout);
            }
            await new Promise((resolve) => setTimeout(resolve, READINESS_POLL_MS));
        }
        state = ProxyHostState.Running;
        log({ port: chosenPort, readyMs: Date.now() - startedAt }, 'ready');
        return { proxyUrl: `http://127.0.0.1:${chosenPort}`, port: chosenPort, ...authority };
    };

    /**
     * Stop the running proxy, if any, and wait for it to exit.
     */
    const terminate = async (): Promise<void> => {
        const running = child;
        child = null;
        port = null;
        executed = null;
        // The exit flag, not exitCode: a process killed by a signal has a null exitCode, and its
        // exit event has already fired, so waiting for it would never settle.
        if (!running || childExited) {
            return;
        }
        await new Promise<void>((resolve) => {
            const killTimer = setTimeout(() => running.kill('SIGKILL'), TERMINATE_GRACE_MS);
            running.once('exit', () => {
                clearTimeout(killTimer);
                resolve();
            });
            running.kill('SIGTERM');
        });
    };

    return {
        async prepare(): Promise<void> {
            try {
                await mkdir(input.workspaceDir, { recursive: true, mode: 0o700 });
                await chmod(input.workspaceDir, 0o700);
                for (const list of input.filterLists) {
                    await writeFilterList(list);
                }
                await writeUserRules();
            } catch (error) {
                log(describeError(error), 'workspace preparation failed');
                throw fail(ProxyFailureCode.WorkspaceUnwritable);
            }
            try {
                authority = await engine.prepare();
            } catch (error) {
                log(describeError(error), 'engine preparation failed');
                await release();
                throw error instanceof ProxyHostError
                    ? fail(error.code)
                    : fail(ProxyFailureCode.WorkspaceUnwritable);
            }
            state = ProxyHostState.Prepared;
        },

        async start(): Promise<ProxyRoute> {
            return await launch();
        },

        async setUserRules(rules: readonly string[]): Promise<ProxyRoute> {
            log({ ruleCount: rules.length }, 'restarting for new user rules');
            userRules = [...rules];
            await writeUserRules();
            await terminate();
            return await launch();
        },

        async setFilterReplacement(replacement: ProxyFilterList | null): Promise<ProxyRoute> {
            log(
                { replacedFilterId: replacement?.filterId ?? null },
                'restarting for a replaced filter list',
            );
            if (replacedFilterId !== null && replacedFilterId !== replacement?.filterId) {
                await writeFilterList(
                    input.filterLists.find((list) => list.filterId === replacedFilterId)!,
                );
            }
            if (replacement !== null) {
                if (!input.filterLists.some((list) => list.filterId === replacement.filterId)) {
                    throw new Error('The replaced filter list is not one this proxy prepared.');
                }
                await writeFilterList(replacement);
            }
            replacedFilterId = replacement?.filterId ?? null;
            await terminate();
            return await launch();
        },

        async setEnabledFilters(filterIds: readonly number[] | null): Promise<ProxyRoute | null> {
            const desired = filterIds === null ? null : new Set(filterIds);
            const unchanged =
                desired === null
                    ? enabledFilterIds === null
                    : enabledFilterIds !== null &&
                      desired.size === enabledFilterIds.size &&
                      [...desired].every((filterId) => enabledFilterIds!.has(filterId));
            if (unchanged) {
                return null;
            }
            enabledFilterIds = desired;
            if (child === null) {
                return null;
            }
            log(
                { filterIds: activeFilterIds(), userRuleCount: userRules.length },
                'restarting for new enabled filter set',
            );
            await terminate();
            return await launch();
        },

        async stop(): Promise<void> {
            await terminate();
            await release();
            if (state !== ProxyHostState.Failed) {
                state = ProxyHostState.Stopped;
            }
        },

        snapshot(): ProxySnapshot {
            return {
                state,
                port,
                filterIds: input.filterLists.map((list) => list.filterId),
                userRuleCount: userRules.length,
                executedFilterIds: executed?.filterIds ?? null,
                executedUserRules: executed?.userRules ?? null,
                failureCode,
            };
        },
    };
}
