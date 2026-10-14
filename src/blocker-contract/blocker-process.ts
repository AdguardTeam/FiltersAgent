/**
 * A blocker module running as its own process, driven over the wire protocol (`blocker-wire.ts`).
 *
 * The module is one long-lived process per run: the proxy it starts must live between operations,
 * and whatever it holds — the proxy, a licence device — must be released when the run ends. The
 * module stops itself when its stdin closes, which also happens when this process dies by any path,
 * so a crashed run still lets the module release what it holds.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import * as v from 'valibot';
import type { Logger } from '../logger/logger';
import type {
    BlockerApplied,
    BlockerApplyRequest,
    BlockerContract,
    BlockerDescription,
    BlockerLogRead,
    BlockerRunning,
    BlockerStartRequest,
    BlockerState,
    BlockerStopped,
} from './blocker-contract';
import {
    BLOCKER_RESULT_SCHEMAS,
    BlockerMethod,
    BlockerWireResponseSchema,
    type BlockerResults,
    type BlockerWireRequest,
} from './blocker-wire';

/**
 * How long one operation may take. A start activates a licence and waits for the proxy to accept
 * connections, which takes tens of seconds on a cold runner; anything past this is a hung module.
 */
const REQUEST_TIMEOUT_MS = 5 * 60_000;

/**
 * How long a stopped module may take to exit after its stdin closed before it is killed.
 */
const EXIT_GRACE_MS = 30_000;

/**
 * How a run starts one blocker module.
 */
export interface BlockerProcessInput {
    /**
     * Executable of the module.
     */
    command: string;

    /**
     * Arguments of the module.
     */
    args: readonly string[];

    /**
     * Environment of the module, holding the secrets its manifest names and nothing else secret.
     */
    env: NodeJS.ProcessEnv;

    /**
     * Run logger the module's stderr and lifecycle reach.
     */
    logger: Logger;

    /**
     * Process factory; production spawns.
     */
    spawnProcess?: typeof spawn;
}

/**
 * One request waiting for its response.
 */
interface PendingRequest {
    /**
     * The operation, choosing the schema its result is parsed with.
     */
    method: BlockerMethod;

    /**
     * Settle the request with its parsed result.
     */
    resolve: (result: unknown) => void;

    /**
     * Fail the request.
     */
    reject: (error: Error) => void;

    /**
     * The request's deadline.
     */
    timer: NodeJS.Timeout;
}

/**
 * Drive a blocker module as a separate process.
 *
 * @param input - Command, environment, and logger.
 * @returns The contract, answered by the module.
 */
export function spawnBlockerProcess(input: BlockerProcessInput): BlockerContract {
    const spawnProcess = input.spawnProcess ?? spawn;
    const pending = new Map<number, PendingRequest>();
    let child: ChildProcess | null = null;
    let exited = false;
    let nextId = 1;

    /**
     * Fail every request still waiting.
     *
     * @param error - Why.
     */
    const failPending = (error: Error): void => {
        for (const request of pending.values()) {
            clearTimeout(request.timer);
            request.reject(error);
        }
        pending.clear();
    };

    /**
     * Settle the request one response line answers.
     *
     * @param line - One line the module wrote to stdout.
     */
    const receive = (line: string): void => {
        let parsed: v.InferOutput<typeof BlockerWireResponseSchema>;
        try {
            parsed = v.parse(BlockerWireResponseSchema, JSON.parse(line));
        } catch (error) {
            input.logger.warn(
                { err: error, line: line.slice(0, 500) },
                'the blocker module wrote a line that is not a response',
            );
            failPending(new Error('The blocker module broke the wire protocol.', { cause: error }));
            child?.kill('SIGTERM');
            return;
        }
        const request = pending.get(parsed.id);
        if (request === undefined) {
            input.logger.warn({ id: parsed.id }, 'the blocker module answered no pending request');
            return;
        }
        pending.delete(parsed.id);
        clearTimeout(request.timer);
        if ('error' in parsed) {
            request.reject(
                new Error(`The blocker module failed ${request.method}: ${parsed.error.message}`),
            );
            return;
        }
        const result = v.safeParse(BLOCKER_RESULT_SCHEMAS[request.method], parsed.result);
        if (!result.success) {
            request.reject(
                new Error(
                    `The blocker module answered ${request.method} with an invalid result: ` +
                        v.summarize(result.issues),
                ),
            );
            return;
        }
        request.resolve(result.output);
    };

    /**
     * Start the module on first use.
     *
     * @returns The running module.
     */
    const ensureChild = (): ChildProcess => {
        if (child !== null) {
            return child;
        }
        const spawned = spawnProcess(input.command, [...input.args], {
            env: input.env,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        child = spawned;
        createInterface({ input: spawned.stdout! }).on('line', receive);
        createInterface({ input: spawned.stderr! }).on('line', (line) => {
            input.logger.info({ module: input.command, line }, 'blocker module output');
        });
        spawned.once('error', (error) => {
            input.logger.warn({ err: error, module: input.command }, 'blocker module failed');
            // A process that never started has no pid and never emits `exit`: without this, stop
            // would wait for an answer and an exit that never come.
            if (spawned.pid === undefined) {
                exited = true;
            }
            failPending(new Error('The blocker module could not run.', { cause: error }));
        });
        spawned.once('exit', (code, signal) => {
            exited = true;
            input.logger.info({ module: input.command, code, signal }, 'blocker module exited');
            failPending(new Error(`The blocker module exited (code ${code}, signal ${signal}).`));
        });
        return spawned;
    };

    /**
     * Send one request and wait for its parsed result.
     *
     * @param method - The operation.
     * @param params - Its argument.
     * @returns The parsed result.
     */
    const call = async <M extends BlockerMethod>(
        method: M,
        params: unknown,
    ): Promise<BlockerResults[M]> => {
        const running = ensureChild();
        if (exited) {
            throw new Error(
                `The blocker module is no longer running, so ${method} cannot reach it.`,
            );
        }
        const id = nextId++;
        const request: BlockerWireRequest = { id, method, params };
        return await new Promise<BlockerResults[M]>((resolve, reject) => {
            pending.set(id, {
                method,
                resolve: resolve as (result: unknown) => void,
                reject,
                timer: setTimeout(() => {
                    pending.delete(id);
                    reject(new Error(`The blocker module did not answer ${method} in time.`));
                }, REQUEST_TIMEOUT_MS),
            });
            running.stdin!.write(`${JSON.stringify(request)}\n`);
        });
    };

    return {
        describe: (): Promise<BlockerDescription> => call(BlockerMethod.Describe, null),
        start: (request: BlockerStartRequest): Promise<BlockerRunning> =>
            call(BlockerMethod.Start, request),
        apply: (request: BlockerApplyRequest): Promise<BlockerApplied> =>
            call(BlockerMethod.Apply, request),
        state: (): Promise<BlockerState> => call(BlockerMethod.State, null),
        log: (cursor: string | null): Promise<BlockerLogRead> => call(BlockerMethod.Log, cursor),
        async stop(): Promise<BlockerStopped> {
            const running = child;
            if (running === null || exited) {
                return { licenceReleased: false };
            }
            // The process ends whether or not the module could stop cleanly: a Stop that fails
            // in the module's own cleanup must not leave it running after the run moved on.
            try {
                return await call(BlockerMethod.Stop, null);
            } finally {
                if (!exited) {
                    // A module stops itself once its stdin closes; the kill is only for one that
                    // hangs.
                    await new Promise<void>((resolve) => {
                        const killTimer = setTimeout(() => running.kill('SIGKILL'), EXIT_GRACE_MS);
                        running.once('exit', () => {
                            clearTimeout(killTimer);
                            resolve();
                        });
                        running.stdin!.end();
                    });
                }
            }
        },
    };
}
