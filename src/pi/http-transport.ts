/**
 * The HTTP client every request of a run goes through.
 *
 * Node's built-in `fetch` runs on the copy of Undici bundled with the Node binary, and the copy in
 * the Node 24 line asserts inside its HTTP parser when the peer closes a connection whose response
 * body is still paused by backpressure. The assertion is thrown from a socket event, so no caller
 * can catch it: the process exits. An LLM gateway that closes a connection before the client has
 * drained a streamed completion triggers exactly that, typically right after a run's first
 * screenshot analysis.
 *
 * The project already pins a fixed Undici (`package.json`) whose parser finishes a paused body
 * instead of asserting. Installing its `Agent` as the process-wide dispatcher routes the built-in
 * `fetch` — the OpenAI SDK under pi, and every other request of the run — through that code, once
 * for the whole process instead of per call site.
 */
import { Agent, setGlobalDispatcher } from 'undici';

/**
 * Whether this process already runs on the pinned dispatcher; one install serves every runtime.
 */
let installed = false;

/**
 * Route the process's HTTP requests through the pinned Undici dispatcher.
 *
 * @returns Nothing; later calls are no-ops.
 */
export function installHttpTransport(): void {
    if (installed) {
        return;
    }
    setGlobalDispatcher(new Agent());
    installed = true;
}
