import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    adguardCliHome,
    createAdguardCliProxyHost,
    SEEDED_DATA_DIR_FILENAME,
    SEEDED_HOME_MARKER,
} from '../../src/adguard-cli/adguard-cli-proxy';
import { ProxyFailureCode, ProxyHostState } from '../../src/adguard-cli/proxy-host';
import { startAdguardCliBlocker } from '../../src/adguard-cli/adguard-cli-module';
import { PERSISTENT_CA_TEST_CERTIFICATE_PEM } from './fixtures/persistent-ca-test-authority';

const LICENSE_KEY = 'TEST-LICENCE-FAKE';

/**
 * A stand-in for the release: it records every argv next to itself, announces its data directory on
 * first use, keeps the licence state as a file, exports a certificate on `cert`, and listens on the
 * configured port on `start`. `behavior.json` next to it turns individual steps into failures.
 */
const STAND_IN_CLI = `#!${process.execPath}
const { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { createServer } = require('node:net');
const { dirname, join } = require('node:path');
const here = dirname(process.argv[1]);
const behavior = JSON.parse(readFileSync(join(here, 'behavior.json'), 'utf8'));
const args = process.argv.slice(2);
appendFileSync(join(here, 'calls.jsonl'), JSON.stringify(args) + '\\n');
const data = join(process.env.HOME, 'data');
const licensed = join(data, 'licensed');
// Like the release: every command but --version loads proxy.yaml and refuses a \`filters\` key
// that is not a list (a bare \`filters:\` is YAML null).
if (args[0] !== '--version' && existsSync(join(data, 'proxy.yaml'))) {
    if (/^filters:\\n(?! {4}-)/m.test(readFileSync(join(data, 'proxy.yaml'), 'utf8'))) {
        console.log('Invalid settings value type for key \`filters\`');
        process.exit(1);
    }
}
switch (args[0]) {
    case '--version':
        if (!existsSync(data)) {
            mkdirSync(data, { recursive: true });
            console.log('Created data directory ' + data);
        }
        console.log('AdGuard CLI v9.9.9-test');
        break;
    case 'activate':
        console.log('activating ' + args[1]);
        if (behavior.activationWorks) {
            writeFileSync(licensed, '');
        }
        break;
    case 'license':
        process.exitCode = existsSync(licensed) ? 0 : 1;
        break;
    case 'cert':
        if (behavior.certificate) {
            for (const name of ['AdGuard Filters Agent.cer', 'AdGuard Filters Agent.pem']) {
                writeFileSync(join(data, name), ${JSON.stringify(PERSISTENT_CA_TEST_CERTIFICATE_PEM)});
            }
        }
        break;
    case 'start': {
        if (behavior.dieOnStart) {
            process.kill(process.pid, 'SIGKILL');
        }
        const port = Number(/http_proxy: (\\d+)/.exec(readFileSync(join(data, 'proxy.yaml'), 'utf8'))[1]);
        createServer().listen(port, '127.0.0.1');
        break;
    }
    case 'reset-license':
        rmSync(licensed, { force: true });
        break;
}
`;

interface StandIn {
    binaryPath: string;
    workspaceDir: string;
    calls: () => Promise<string[][]>;
}

const temporaryRoots: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
    );
});

async function standIn(behavior: Record<string, boolean>): Promise<StandIn> {
    const root = await mkdtemp(join(tmpdir(), 'adguard-cli-proxy-'));
    temporaryRoots.push(root);
    const binaryPath = join(root, 'adguard-cli');
    await writeFile(binaryPath, STAND_IN_CLI, { mode: 0o755 });
    await writeFile(join(root, 'behavior.json'), JSON.stringify(behavior));
    const workspaceDir = join(root, 'workspace');
    temporaryRoots.push(adguardCliHome(workspaceDir));
    return {
        binaryPath,
        workspaceDir,
        calls: async () =>
            (await readFile(join(root, 'calls.jsonl'), 'utf8'))
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line) as string[]),
    };
}

function host(cli: StandIn, seededHomeArchive?: string) {
    return createAdguardCliProxyHost({
        binaryPath: cli.binaryPath,
        workspaceDir: cli.workspaceDir,
        filterLists: [{ filterId: 2, content: '! Base\nexample.org##.ad\n' }],
        licenseKey: LICENSE_KEY,
        seededHomeArchive,
    });
}

/**
 * Pack a seeded HOME the way scripts/seed-adguard-cli-home.sh does, for the stand-in's layout.
 */
async function seededArchive(licensed: boolean): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'adguard-cli-seed-'));
    temporaryRoots.push(root);
    const home = join(root, 'home');
    await mkdir(join(home, 'data'), { recursive: true });
    if (licensed) {
        await writeFile(join(home, 'data', 'licensed'), '');
    }
    await writeFile(join(home, SEEDED_DATA_DIR_FILENAME), 'data\n');
    await writeFile(join(home, SEEDED_HOME_MARKER), '');
    const archive = join(root, 'seed.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', home, '.']);
    return archive;
}

const verbs = (calls: string[][]): string[] => calls.map((call) => call[0]!);

describe('AdGuard CLI proxy host', () => {
    it('activates once, runs the run’s own lists, and resets the licence once on stop', async () => {
        const cli = await standIn({ activationWorks: true, certificate: true });
        const proxy = host(cli);

        await proxy.prepare();
        const route = await proxy.start();
        expect(proxy.snapshot().state).toBe(ProxyHostState.Running);
        expect(route.certificateDerBase64.length).toBeGreaterThan(0);
        await proxy.stop();
        await proxy.stop();

        expect(verbs(await cli.calls())).toEqual([
            '--version',
            'activate',
            'license',
            'cert',
            'start',
            'reset-license',
        ]);
        // The configuration the release ran with names the downloaded list file, not flm://.
        const config = await readFile(join(cli.workspaceDir, 'proxy.yaml'), 'utf8');
        expect(config).toContain(join(cli.workspaceDir, 'filter-2.txt'));
        expect(config).not.toContain('flm://');
        // The licence never reaches the retained transcript, and the HOME holding it is gone.
        const transcript = await readFile(join(cli.workspaceDir, 'proxy-output.log'), 'utf8');
        expect(transcript).toContain('activating');
        expect(transcript).not.toContain(LICENSE_KEY);
        expect(existsSync(adguardCliHome(cli.workspaceDir))).toBe(false);
    });

    it('fails preparation when the licence did not activate, and still resets', async () => {
        const cli = await standIn({ activationWorks: false, certificate: true });
        const proxy = host(cli);

        await expect(proxy.prepare()).rejects.toMatchObject({
            code: ProxyFailureCode.ActivationFailed,
        });

        expect(verbs(await cli.calls())).toEqual([
            '--version',
            'activate',
            'license',
            'reset-license',
        ]);
        expect(proxy.snapshot().failureCode).toBe(ProxyFailureCode.ActivationFailed);
    });

    it('resets the licence when preparation fails after the activation', async () => {
        const cli = await standIn({ activationWorks: true, certificate: false });
        const proxy = host(cli);

        await expect(proxy.prepare()).rejects.toMatchObject({
            code: ProxyFailureCode.CertificateUnavailable,
        });
        await proxy.stop();

        expect(verbs(await cli.calls())).toEqual([
            '--version',
            'activate',
            'license',
            'cert',
            'reset-license',
        ]);
    });

    it('stops and resets after the CLI died from a signal while starting', async () => {
        const cli = await standIn({ activationWorks: true, certificate: true, dieOnStart: true });
        const proxy = host(cli);
        await proxy.prepare();

        await expect(proxy.start()).rejects.toMatchObject({
            code: ProxyFailureCode.ProcessExited,
        });
        await proxy.stop();

        expect(verbs(await cli.calls()).at(-1)).toBe('reset-license');
    });
});

describe('AdGuard CLI proxy host with a seeded home', () => {
    it('restores the seeded licence without activating, and never resets it', async () => {
        const cli = await standIn({ activationWorks: true, certificate: true });
        const proxy = host(cli, await seededArchive(true));

        await proxy.prepare();
        await proxy.start();
        await proxy.stop();

        expect(verbs(await cli.calls())).toEqual(['license', 'cert', 'start']);
        expect(existsSync(adguardCliHome(cli.workspaceDir))).toBe(false);
    });

    it('activates and resets on its own when the seeded licence is no longer active', async () => {
        const cli = await standIn({ activationWorks: true, certificate: true });
        const proxy = host(cli, await seededArchive(false));

        await proxy.prepare();
        await proxy.start();
        await proxy.stop();

        expect(verbs(await cli.calls())).toEqual([
            'license',
            '--version',
            'activate',
            'license',
            'cert',
            'start',
            'reset-license',
        ]);
    });
});

describe('startAdguardCliBlocker', () => {
    it('names every variable a run must set before it can describe the CLI', async () => {
        const logger = { info: () => undefined };

        await expect(startAdguardCliBlocker({}, '/tmp/unused', logger).describe()).rejects.toThrow(
            'set ADGUARD_CLI_PATH and ADGUARD_LICENSE_KEY',
        );
        await expect(
            startAdguardCliBlocker(
                { ADGUARD_LICENSE_KEY: LICENSE_KEY },
                '/tmp/unused',
                logger,
            ).describe(),
        ).rejects.toThrow('set ADGUARD_CLI_PATH.');
    });
});
