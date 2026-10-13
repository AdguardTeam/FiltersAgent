/**
 * A blocker module process for the wire tests: serves an in-memory blocker over stdio. The
 * FAKE_BLOCKER_MODE environment variable makes it misbehave in one named way.
 */
import { serveBlocker } from '../../../src/blocker-contract/serve-blocker';
import {
    BLOCKER_CONTRACT_VERSION,
    BlockerEventKind,
    BlockerKind,
    type BlockerApplyRequest,
    type BlockerContract,
    type BlockerStartRequest,
} from '../../../src/blocker-contract/blocker-contract';

const mode = process.env['FAKE_BLOCKER_MODE'] ?? 'ok';
let revision = 0;
let enabled: readonly number[] = [];
let rules: readonly string[] = [];
let lists: BlockerStartRequest['lists'] = [];

const route = {
    proxyUrl: 'http://127.0.0.1:58222',
    certificateDerBase64: Buffer.from('fake authority').toString('base64'),
};

const blocker: BlockerContract = {
    async describe() {
        if (mode === 'exit-on-describe') {
            process.exit(3);
        }
        return {
            contractVersion: BLOCKER_CONTRACT_VERSION,
            product: mode === 'invalid-describe' ? '' : 'Fake blocker',
            version: '1.0.0',
            binarySha256: 'a'.repeat(64),
            kind: BlockerKind.Proxy,
            covers: 'everything',
            notReported: [],
            pageEvidence: null,
        };
    },
    async start(request: BlockerStartRequest) {
        lists = request.lists;
        enabled = request.enabledListIds ?? request.lists.map((list) => list.id);
        rules = request.userRules;
        revision = 1;
        return { route, revision };
    },
    async apply(request: BlockerApplyRequest) {
        enabled = request.enabledListIds ?? lists.map((list) => list.id);
        rules = request.userRules;
        revision += 1;
        return { route, revision, restarted: true };
    },
    async state() {
        return {
            running: revision > 0,
            revision,
            port: 58_222,
            lists: enabled.map((id) => ({ id, sha256: 'b'.repeat(64) })),
            userRules: [...rules],
        };
    },
    async log(cursor: string | null) {
        return {
            revision,
            cursor: 'end',
            events:
                cursor === null
                    ? []
                    : [
                          {
                              kind: BlockerEventKind.Request,
                              url: 'https://ads.example/a.js',
                              rule: '||ads.example^',
                              handshakeBlock: false,
                          },
                          {
                              kind: BlockerEventKind.UnfilteredHost,
                              host: 'tunnelled.example',
                              reason: "server doesn't have valid certificate",
                          },
                      ],
        };
    },
    async stop() {
        if (mode === 'fail-on-stop') {
            throw new Error('native cleanup failed');
        }
        process.stderr.write('fake blocker stopped\n');
        return { licenceReleased: true };
    },
};

await serveBlocker(blocker, process.stdin, process.stdout);
