/**
 * The module side of the wire protocol: answer the agent's requests with one blocker until the
 * agent closes stdin, then stop the blocker so nothing it holds outlives the run.
 *
 * The agent that writes the requests is this project's own code, so the requests are read as the
 * protocol types without re-validating them; a module written elsewhere validates its own way.
 */
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { BlockerApplyRequest, BlockerContract, BlockerStartRequest } from './blocker-contract';
import { BlockerMethod, type BlockerWireRequest } from './blocker-wire';

/**
 * Run one request against the blocker.
 *
 * @param blocker - The blocker.
 * @param request - The request.
 * @returns The operation's result.
 */
async function dispatch(blocker: BlockerContract, request: BlockerWireRequest): Promise<unknown> {
    switch (request.method) {
        case BlockerMethod.Describe:
            return await blocker.describe();
        case BlockerMethod.Start:
            return await blocker.start(request.params as BlockerStartRequest);
        case BlockerMethod.Apply:
            return await blocker.apply(request.params as BlockerApplyRequest);
        case BlockerMethod.State:
            return await blocker.state();
        case BlockerMethod.Log:
            return await blocker.log(request.params as string | null);
        case BlockerMethod.Stop:
            return await blocker.stop();
    }
}

/**
 * Serve one blocker over a line stream until the input ends.
 *
 * Requests run one at a time, in arrival order: the operations change one proxy, and two of them
 * interleaving would leave it in neither requested state.
 *
 * @param blocker - The blocker to serve.
 * @param input - Request lines, the module's stdin.
 * @param output - Response lines, the module's stdout.
 * @returns Resolves once the input ended and the blocker stopped.
 */
export async function serveBlocker(
    blocker: BlockerContract,
    input: Readable,
    output: Writable,
): Promise<void> {
    let queue = Promise.resolve();
    const lines = createInterface({ input });
    lines.on('line', (line) => {
        const request = JSON.parse(line) as BlockerWireRequest;
        queue = queue.then(async () => {
            try {
                const result = await dispatch(blocker, request);
                output.write(`${JSON.stringify({ id: request.id, result })}\n`);
            } catch (error) {
                // The full failure goes to stderr, where the agent's run log collects it; the
                // response carries its message.
                console.error(error);
                const message = error instanceof Error ? error.message : String(error);
                output.write(`${JSON.stringify({ id: request.id, error: { message } })}\n`);
            }
        });
    });
    await new Promise<void>((resolve) => lines.once('close', resolve));
    await queue;
    await blocker.stop();
}
