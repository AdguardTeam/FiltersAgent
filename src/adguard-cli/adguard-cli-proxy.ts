/**
 * The AdGuard CLI, the official public release, as the desktop {@link ProxyEngine}.
 *
 * What the release forces on top of the shared proxy lifecycle lives here: a short sandboxed HOME
 * the release keeps its configuration, licence state and authority in; a licence activation before
 * the first filtering command and a reset when the run ends; and the authority the release mints
 * itself, which no system trust store learns: the browser accepts it only after the run proved the
 * proxy decrypts HTTPS under it.
 *
 * The run's filter files go into `filters:` as absolute paths instead of `flm://`, so the release
 * executes exactly the lists the run downloaded.
 */
import { createHash, X509Certificate } from 'node:crypto';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { execFile, spawn } from 'node:child_process';
import { join } from 'node:path';
import {
    ACCESS_LOG_FILENAME,
    CONFIG_FILENAME,
    OUTPUT_LOG_FILENAME,
} from './adguard-cli-proxy-config';
import {
    createProxyHost,
    describeError,
    ProxyFailureCode,
    ProxyHostError,
    type ProxyEngine,
    type ProxyHost,
    type ProxyHostInput,
} from './proxy-host';

/**
 * Environment variable naming the AdGuard CLI executable.
 */
export const ADGUARD_CLI_PATH_ENV = 'ADGUARD_CLI_PATH';

/**
 * Environment variable carrying the licence key the CLI is activated with.
 */
export const ADGUARD_LICENSE_KEY_ENV = 'ADGUARD_LICENSE_KEY';

/**
 * Prefix of every CLI HOME. A cleanup that resets what it finds under it frees the licence of a run
 * killed before its own reset.
 */
export const ADGUARD_CLI_HOME_PREFIX = '/tmp/agcli-';

/**
 * Environment variable naming a gzipped tar of an activated CLI HOME, made once by
 * `scripts/seed-adguard-cli-home.sh`. Every run restores a private copy of it instead of activating
 * the licence, so all runs share one licence device.
 */
export const ADGUARD_CLI_HOME_ARCHIVE_ENV = 'ADGUARD_CLI_HOME_ARCHIVE';

/**
 * File at the root of a seeded HOME naming its data directory relative to HOME: a restored HOME is
 * not fresh, so the release no longer announces the directory.
 */
export const SEEDED_DATA_DIR_FILENAME = '.agcli-data-dir';

/**
 * Marker at the root of a seeded HOME. Its licence device is shared by every run restored from the
 * same archive, so nothing may reset it: `reset-license` on any copy would unbind them all. A
 * cleanup of leftover HOMEs must skip a HOME carrying it.
 */
export const SEEDED_HOME_MARKER = '.agcli-seeded';

/**
 * Hex digits of the workspace hash in the HOME name. The release puts its control socket under HOME
 * and refuses to start once that path passes the 104-byte `sun_path` limit; twelve digits keep HOME
 * short and still unique per workspace.
 */
const HOME_HASH_LENGTH = 12;

/**
 * Common name of the authority the release mints; it also names the exported certificate file.
 */
const ROOT_CERTIFICATE_NAME = 'AdGuard Filters Agent';

/**
 * Extension of the certificate `cert` exports: DER `.cer` on macOS, PEM elsewhere.
 */
const CERTIFICATE_EXTENSION = process.platform === 'darwin' ? '.cer' : '.pem';

/**
 * Deadline for one short command (version, activate, license, cert, reset-license).
 */
const COMMAND_TIMEOUT_MS = 60_000;

/**
 * The port written into the configuration the setup commands read. They never listen; the release
 * only refuses every command until it finds a configuration.
 */
const SETUP_PORT = 0;

/**
 * The line the release prints when it creates its data directory, on the first command under a
 * fresh HOME. It is the one source of that path, whatever platform convention the release follows.
 */
const DATA_DIRECTORY_LINE = /^Created data directory (.+)$/mu;

/**
 * The version line `--version` prints.
 */
const VERSION_LINE = /^AdGuard CLI v(\S+)/mu;

/**
 * Promise form of `execFile`, for the archive extraction.
 */
const execFileAsync = promisify(execFile);

/**
 * Placeholder the licence key is replaced with in every logged transcript.
 */
const REDACTED_LICENSE = '[redacted licence]';

/**
 * Construction input for one run-owned AdGuard CLI proxy.
 */
export interface CreateAdguardCliProxyHostInput extends ProxyHostInput {
    /**
     * Licence key the sandboxed CLI is activated with.
     */
    licenseKey: string;

    /**
     * Gzipped tar of an activated HOME to restore instead of activating, or undefined to activate.
     */
    seededHomeArchive?: string;
}

/**
 * Outcome of one short CLI command.
 */
interface CommandOutcome {
    /**
     * Exit code, or null when a signal or the deadline ended it.
     */
    code: number | null;

    /**
     * Combined stdout and stderr, licence redacted.
     */
    output: string;
}

/**
 * Render the CLI's `proxy.yaml` for one launch.
 *
 * @param port - Loopback HTTP proxy port.
 * @param filterPaths - Absolute filter list paths, in load order, user rules last.
 * @param accessLogPath - Absolute access log path the AdGuard CLI readers already watch.
 * @returns Complete YAML document.
 */
function renderCliConfig(
    port: number,
    filterPaths: readonly string[],
    accessLogPath: string,
): string {
    return [
        'proxy_mode: manual',
        'filtered_ports: 80:5221,5300:49151',
        'show_hints: false',
        'update_channel: default',
        'send_crash_reports: false',
        'log_level: info',
        'show_notifications: false',
        'listen_address: 127.0.0.1',
        'listen_ports:',
        `    http_proxy: ${port}`,
        '    socks5_proxy: -1',
        'listen_auth:',
        '    enabled: false',
        '    username: admin',
        '    password: admin',
        'worker_threads: 4',
        `access_log_file: ${JSON.stringify(accessLogPath)}`,
        'outbound_interface: null',
        'ad_blocking_enabled: true',
        'adguard_headers_enabled: false',
        'auto_enable_language_filters: false',
        // A bare `filters:` is YAML null, which the release rejects on every command, `activate`
        // and `reset-license` included; the setup configuration has no lists, so it says `[]`.
        ...(filterPaths.length === 0
            ? ['filters: []']
            : ['filters:', ...filterPaths.map((path) => `    - ${JSON.stringify(path)}`)]),
        'dns_filtering:',
        '    enabled: false',
        '    upstream: default',
        '    fallbacks: default',
        '    bootstraps: default',
        '    filters: []',
        '    block_ech: false',
        '    listen_port: -1',
        'https_filtering:',
        '    enabled: true',
        '    certificates_cache: .',
        `    root_certificate_name: ${ROOT_CERTIFICATE_NAME}`,
        '    filter_ev_certificates: false',
        '    enable_tls13: true',
        '    ocsp_check_enabled: false',
        // On, the CLI's own default. Off, the 1.5 pre-releases (CoreLibs 1.23) cannot satisfy the
        // extra SCT constraints they attach to some roots (USERTrust RSA, GlobalSign Root R3),
        // call every chain to those roots invalid and tunnel the site unfiltered; on keeps those
        // sites filtered whichever release the module pins.
        '    enforce_certificate_transparency: true',
        '    http3_filtering_enabled: false',
        '    exclusions: https_exclusions.txt',
        '    filter_secure_dns_mode: off',
        '    encrypted_client_hello: false',
        'safebrowsing:',
        '    enabled: false',
        '    send_anonymous_statistics: false',
        'crlite:',
        '    enabled: false',
        'stealthmode:',
        '    enabled: false',
        'outbound_proxy:',
        '    enabled: false',
        'userscripts: []',
        'har_writer:',
        '    enabled: false',
        '    location: .',
        // An empty list crashes the release's config loader; it needs at least one entry.
        'apps:',
        "    - name: '*'",
        "      action: 'default'",
        '',
    ].join('\n');
}

/**
 * Resolve the CLI HOME for one workspace.
 *
 * @param workspaceDir - The host's workspace.
 * @returns Short, workspace-unique HOME under {@link ADGUARD_CLI_HOME_PREFIX}.
 */
export function adguardCliHome(workspaceDir: string): string {
    const digest = createHash('sha256').update(workspaceDir).digest('hex');
    return `${ADGUARD_CLI_HOME_PREFIX}${digest.slice(0, HOME_HASH_LENGTH)}`;
}

/**
 * Create the run-owned AdGuard CLI proxy host.
 *
 * @param input - Executable, workspace, filter lists, licence, and optional seams.
 * @returns Host exposing prepare, start, rule replacement, and stop.
 */
export function createAdguardCliProxyHost(input: CreateAdguardCliProxyHostInput): ProxyHost {
    return createProxyHost(input, createAdguardCliEngine(input));
}

/**
 * Build the AdGuard CLI engine for one host.
 *
 * @param input - Executable, workspace, licence, and optional seams.
 * @returns Engine the shared proxy host drives.
 */
function createAdguardCliEngine(input: CreateAdguardCliProxyHostInput): ProxyEngine {
    const spawnProcess = input.spawnProcess ?? spawn;
    /**
     * Log one CLI step.
     *
     * @param fields - Structured fields.
     * @param message - Message after the engine name.
     */
    const log = (fields: Record<string, unknown>, message: string): void => {
        input.logger?.info(fields, `adguard cli ${message}`);
    };

    const home = adguardCliHome(input.workspaceDir);
    const outputLogPath = join(input.workspaceDir, OUTPUT_LOG_FILENAME);
    const accessLogPath = join(input.workspaceDir, ACCESS_LOG_FILENAME);
    // HOME is the whole sandbox: the release keeps its config, licence state, and authority there.
    const childEnv: NodeJS.ProcessEnv = { HOME: home, PATH: process.env.PATH, LANG: 'en_US.UTF-8' };
    let dataDir: string | null = null;
    let activated = false;

    /**
     * Read the data directory the release announced.
     *
     * @returns Absolute data directory.
     */
    const requireDataDir = (): string => {
        if (dataDir === null) {
            throw new Error('The AdGuard CLI data directory is not known yet.');
        }
        return dataDir;
    };

    /**
     * Run one short command and append its redacted transcript to the proxy output log.
     *
     * @param args - Command arguments.
     * @param stdin - Text fed to the command's prompts.
     * @returns Exit code and redacted output.
     */
    const runCommand = async (args: readonly string[], stdin = ''): Promise<CommandOutcome> => {
        const chunks: Buffer[] = [];
        const code = await new Promise<number | null>((resolve) => {
            const spawned = spawnProcess(input.binaryPath, [...args], {
                env: childEnv,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            const timer = setTimeout(() => spawned.kill('SIGKILL'), COMMAND_TIMEOUT_MS);
            spawned.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
            spawned.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk));
            spawned.once('error', (error) => {
                clearTimeout(timer);
                chunks.push(Buffer.from(`spawn error: ${error.message}\n`));
                resolve(null);
            });
            spawned.once('close', (exitCode) => {
                clearTimeout(timer);
                resolve(exitCode);
            });
            spawned.stdin?.end(stdin);
        });
        const output = Buffer.concat(chunks)
            .toString('utf8')
            .replaceAll(input.licenseKey, REDACTED_LICENSE);
        // The verb only: `activate` carries the licence as its argument.
        await appendFile(
            outputLogPath,
            `--- ${new Date().toISOString()} adguard-cli ${args[0]} exited ${code}\n${output}`,
            { mode: 0o600 },
        );
        return { code, output };
    };

    /**
     * Write the configuration into the release's data directory, and a copy into the workspace so
     * the retained diagnostics show what the release ran with.
     *
     * @param port - Loopback HTTP proxy port.
     * @param filterFilenames - Workspace filter list filenames in load order, user rules last.
     */
    const writeConfiguration = async (
        port: number,
        filterFilenames: readonly string[],
    ): Promise<void> => {
        const config = renderCliConfig(
            port,
            filterFilenames.map((filename) => join(input.workspaceDir, filename)),
            accessLogPath,
        );
        await writeFile(join(requireDataDir(), CONFIG_FILENAME), config, { mode: 0o600 });
        await writeFile(join(input.workspaceDir, CONFIG_FILENAME), config, { mode: 0o600 });
    };

    /**
     * Replace HOME with an empty private directory.
     */
    const resetHome = async (): Promise<void> => {
        // A leftover HOME from a killed run holds another run's state; start clean and private
        // before anything is created inside it.
        await rm(home, { recursive: true, force: true });
        await mkdir(home, { recursive: true, mode: 0o700 });
    };

    /**
     * Restore the seeded HOME and check that its licence is still active there.
     *
     * @returns Whether the restored HOME is ready to filter without an activation.
     */
    const restoreSeededHome = async (): Promise<boolean> => {
        await resetHome();
        try {
            await execFileAsync('tar', ['-xzf', input.seededHomeArchive!, '-C', home]);
            const relativeDataDir = (
                await readFile(join(home, SEEDED_DATA_DIR_FILENAME), 'utf8')
            ).trim();
            dataDir = join(home, relativeDataDir);
        } catch (error) {
            log(describeError(error), 'seeded home unusable, activating instead');
            return false;
        }
        await writeConfiguration(SETUP_PORT, []);
        const licence = await runCommand(['license']);
        if (licence.code !== 0) {
            // The shared device was unlinked or the archive is stale: fall back to a private
            // activation, which this run resets again.
            log(
                { exitCode: licence.code, output: licence.output },
                'seeded licence not active, activating instead',
            );
            return false;
        }
        log({ dataDir }, 'licence restored from the seeded home');
        return true;
    };

    /**
     * Activate the licence in a fresh HOME; release() resets it.
     */
    const activateFreshHome = async (): Promise<void> => {
        await resetHome();
        dataDir = null;
        const version = await runCommand(['--version']);
        const announced = DATA_DIRECTORY_LINE.exec(version.output);
        if (announced === null) {
            log({ exitCode: version.code, output: version.output }, 'data directory unknown');
            throw new ProxyHostError(ProxyFailureCode.DataDirectoryUnknown);
        }
        dataDir = announced[1]!;
        log({ dataDir, version: VERSION_LINE.exec(version.output)?.[1] ?? null }, 'data directory');
        // The release refuses every command until it finds a configuration.
        await writeConfiguration(SETUP_PORT, []);

        // From here on the licence may be bound to this HOME, so release() resets it even when
        // `activate` itself reports failure.
        activated = true;
        const activation = await runCommand(['activate', input.licenseKey]);
        // `activate` exits 0 even when it only printed a login link, so the licence state is what
        // proves the activation.
        const licence = await runCommand(['license']);
        if (licence.code !== 0) {
            log(
                {
                    activateExitCode: activation.code,
                    activateOutput: activation.output,
                    licenseExitCode: licence.code,
                    licenseOutput: licence.output,
                },
                'activation failed',
            );
            throw new ProxyHostError(ProxyFailureCode.ActivationFailed);
        }
        log({ activateExitCode: activation.code }, 'activated');
    };

    return {
        name: 'adguard cli',

        async prepare() {
            if (!(input.seededHomeArchive !== undefined && (await restoreSeededHome()))) {
                await activateFreshHome();
            }

            // `cert` asks whether to install the authority into the system store; the answer is
            // no: no system trust store is touched, and the browser accepts the authority only
            // once the run proved the proxy decrypts HTTPS under it.
            const generated = await runCommand(['cert'], 'n\n');
            const certificatePath = join(
                requireDataDir(),
                `${ROOT_CERTIFICATE_NAME}${CERTIFICATE_EXTENSION}`,
            );
            try {
                const certificate = new X509Certificate(await readFile(certificatePath));
                return {
                    certificatePath,
                    certificateDerBase64: certificate.raw.toString('base64'),
                };
            } catch (error) {
                log(
                    { exitCode: generated.code, output: generated.output, ...describeError(error) },
                    'certificate unavailable',
                );
                throw new ProxyHostError(ProxyFailureCode.CertificateUnavailable, error);
            }
        },

        writeConfiguration,

        command() {
            return {
                args: ['start', '--no-fork', '--pid-file', join(requireDataDir(), 'adguard.pid')],
                env: childEnv,
            };
        },

        async release() {
            if (activated) {
                activated = false;
                const reset = await runCommand(['reset-license']);
                // A failed reset leaves one device on the licence until it is unlinked in the
                // AdGuard account; it must be visible in the run log, not only in the workspace.
                log(
                    { exitCode: reset.code, output: reset.output },
                    reset.code === 0 ? 'licence reset' : 'licence reset FAILED',
                );
            }
            // A restored HOME is never reset: its device is shared with every other run. The HOME
            // holds the minted authority key and the licence state; the workspace keeps the
            // configuration copy and the transcripts for diagnostics.
            await rm(home, { recursive: true, force: true });
        },
    };
}
