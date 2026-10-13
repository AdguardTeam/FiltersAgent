import { createServer } from 'node:http';
import { createTestPiRuntime } from '../test-runtime';

/**
 * A response large enough to fill the socket buffer, so the body parser is paused by backpressure
 * while the client has not read it yet.
 */
const RESPONSE_BYTES = 64 * 1024;
const responseBody = 'x'.repeat(RESPONSE_BYTES);

const server = createServer((_request, response) => {
    // The server ends the connection right after the body: the peer's FIN reaches a parser that is
    // still paused, which is what the gateway does to a streamed completion the client has not
    // drained.
    response.writeHead(200, {
        connection: 'close',
        'content-length': String(RESPONSE_BYTES),
        'content-type': 'application/json',
    });
    response.end(responseBody);
});

await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, resolve);
});

try {
    const address = server.address();
    if (typeof address !== 'object' || address === null) {
        throw new Error('Transport probe server did not expose an address');
    }
    const endpoint = `http://127.0.0.1:${String(address.port)}/completion`;

    // Every mode reaches the network only after it has a pi runtime, so creating one is what a run
    // does before its first request.
    await createTestPiRuntime({ baseUrl: endpoint });

    const response = await fetch(endpoint);
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    const body = await response.text();

    process.stdout.write(
        JSON.stringify({ bytes: Buffer.byteLength(body), status: response.status }),
    );
} finally {
    await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
    });
}
