import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { firefox } from 'playwright-core';
import type { Browser, BrowserContext } from 'playwright-core';
import {
    ConsoleCoverage,
    type IBrowserEngine,
    type BrowserEngineLaunchConfig,
    type BrowserEnginePersistentLaunchConfig,
} from './browser-interfaces';
import { BrowserConfigurationError } from './browser-session';
import { FIREFOX_POLICIES_ENV_VAR } from './firefox-policies';
import {
    createFirefoxLaunchHome,
    readFirefoxSandboxSnapshot,
    type FirefoxLaunchHome,
} from './firefox-launch-environment';
import { createLogger, type Logger } from '../logger/logger';

/**
 * Staged policies artifact the engine writes into the profile directory.
 */
const PROFILE_POLICIES_FILE_NAME = 'policies.json';

/**
 * Environment variable naming the home directory of the browser process tree.
 */
const HOME_ENV_VAR = 'HOME';

/**
 * Launch shapes the engine records in its per-launch home log line.
 */
const FirefoxLaunchKind = {
    /**
     * A plain `firefox.launch()` — a Firefox run's unfiltered phase A.
     */
    Plain: 'plain',

    /**
     * A persistent context on an owned profile, the channel a force-installed XPI arrives through.
     */
    Persistent: 'persistent',
} as const;

/**
 * FirefoxLaunchKind value.
 */
type FirefoxLaunchKind = (typeof FirefoxLaunchKind)[keyof typeof FirefoxLaunchKind];

/**
 * The playwright-core seam the engine launches through.
 *
 * Only the two launch entry points are used, so a test can hand the engine a recorder and observe
 * the exact options — the launch environment above all — without starting a browser.
 */
export interface FirefoxBrowserType {
    /**
     * Launch a plain browser.
     *
     * @param options - Playwright launch options.
     * @returns The launched browser.
     */
    launch(options: Parameters<typeof firefox.launch>[0]): Promise<Browser>;

    /**
     * Launch a persistent context on a profile directory.
     *
     * @param userDataDir - Profile directory the context launches with.
     * @param options - Playwright persistent-context launch options.
     * @returns The launched persistent context.
     */
    launchPersistentContext(
        userDataDir: string,
        options: Parameters<typeof firefox.launchPersistentContext>[1],
    ): Promise<BrowserContext>;
}

/**
 * Construction seams of the Firefox engine.
 */
export interface FirefoxEngineDeps {
    /**
     * The playwright-core Firefox handle; defaults to the real one.
     */
    browserType?: FirefoxBrowserType;

    /**
     * Logger receiving the per-launch home path and sandbox snapshot; defaults to the app logger.
     */
    logger?: Logger;
}

/**
 * Playwright Firefox engine reproducing the Firefox reporter environment.
 *
 * Extensions load only through enterprise policies: the engine stages a `policies.json` into the
 * profile directory and points the patched browser build at it through
 * `PLAYWRIGHT_FIREFOX_POLICIES_JSON` so a signed XPI is force-installed before the first page
 * loads. Unpacked Chromium extension directories have no Firefox equivalent and are rejected loudly
 * instead of being dropped.
 *
 * Every launch — plain (a Firefox run's phase A) and persistent alike — gets its own `HOME`: a
 * temporary directory the launching process owns, created before the launch and removed when the
 * browser closes. Firefox refuses to run as root under a home owned by another user, which is
 * exactly the container action's situation, so a shared `$HOME` is not a launch option at all
 * (`firefox-launch-environment.ts` carries the observed refusal).
 */
export class FirefoxEngine implements IBrowserEngine {
    /**
     * Engine identifier for logging and diagnostics.
     */
    readonly browserType = 'firefox';

    /**
     * Firefox delivers the page's own console output: the uBlock Origin session test reads the
     * fixture page's marker line back through `get_console_log`.
     */
    readonly consoleCoverage = ConsoleCoverage.PageConsole;

    /**
     * The playwright-core handle this engine launches through.
     */
    private readonly playwrightFirefox: FirefoxBrowserType;

    /**
     * Logger receiving the per-launch home path and the sandbox snapshot.
     */
    private readonly logger: Logger;

    constructor(deps: FirefoxEngineDeps = {}) {
        this.playwrightFirefox = deps.browserType ?? firefox;
        this.logger = deps.logger ?? createLogger();
    }

    /**
     * Launch a plain Firefox instance through playwright-core.
     *
     * Locale and timezone are context-level options; a plain browser launch cannot carry them.
     *
     * @param config - Launch parameters forwarded to playwright-core's `firefox.launch()`.
     * @returns A Playwright-compatible Browser instance.
     */
    async launch(config: BrowserEngineLaunchConfig): Promise<Browser> {
        const home = this.createLaunchHome(FirefoxLaunchKind.Plain);
        let browser: Browser;
        try {
            browser = await this.playwrightFirefox.launch({
                headless: config.headless,
                args: config.args,
                env: this.launchEnvironment(config.environment, home, undefined),
                ...(config.browserProcessLogger ? { logger: config.browserProcessLogger } : {}),
                ...(config.ignoreDefaultArgs
                    ? { ignoreDefaultArgs: [...config.ignoreDefaultArgs] }
                    : {}),
            });
        } catch (error) {
            home.dispose();
            throw error;
        }
        // The home outlives the launch and dies with the browser: Firefox keeps writing caches and
        // crash state into it for the whole session.
        browser.on('disconnected', () => {
            home.dispose();
        });
        return browser;
    }

    /**
     * Launch a persistent Firefox context with enterprise policies force-installing extensions.
     *
     * The policies file is staged into `<userDataDir>/policies.json` and the launch environment
     * gains the absolute path, so the browser applies the policies before its first session.
     *
     * @param config - Persistent profile and policy launch parameters.
     * @returns A Playwright-compatible persistent BrowserContext.
     */
    async launchPersistentContext(
        config: BrowserEnginePersistentLaunchConfig,
    ): Promise<BrowserContext> {
        if (config.extensionPaths.length > 0) {
            throw new BrowserConfigurationError(
                `${this.browserType} cannot load unpacked extension directories; ` +
                    'load a signed XPI through `firefoxPolicies` instead.',
            );
        }
        const policies: BrowserEnginePersistentLaunchConfig['firefoxPolicies'] =
            config.firefoxPolicies;
        const policiesPath = policies
            ? this.stagePolicies(config.userDataDir, policies)
            : undefined;
        const home = this.createLaunchHome(FirefoxLaunchKind.Persistent);
        let context: BrowserContext;
        try {
            context = await this.playwrightFirefox.launchPersistentContext(config.userDataDir, {
                headless: config.headless,
                locale: config.locale,
                timezoneId: config.timezone,
                userAgent: config.userAgent,
                viewport: config.viewport,
                env: this.launchEnvironment(config.environment, home, policiesPath),
                ...(config.browserProcessLogger ? { logger: config.browserProcessLogger } : {}),
                ...(config.ignoreDefaultArgs
                    ? { ignoreDefaultArgs: [...config.ignoreDefaultArgs] }
                    : {}),
            });
        } catch (error) {
            home.dispose();
            throw error;
        }
        context.on('close', () => {
            home.dispose();
        });
        return context;
    }

    /**
     * Create this launch's private home directory and record it with the sandbox snapshot.
     *
     * @param launchKind - Which of the engine's two launch shapes is starting, for the log line.
     * @returns The created home directory handle.
     */
    private createLaunchHome(launchKind: FirefoxLaunchKind): FirefoxLaunchHome {
        const home = createFirefoxLaunchHome();
        this.logger.info(
            {
                launchKind,
                home: home.path,
                homeOwnerUid: home.ownerUid ?? null,
                sandbox: readFirefoxSandboxSnapshot(),
            },
            'firefox launches with its own home directory',
        );
        return home;
    }

    /**
     * Stage the enterprise policies into the profile directory ahead of the launch.
     *
     * @param userDataDir - Profile directory the context launches with.
     * @param policies - Enterprise policies payload for the force-installed extension.
     * @returns Absolute path of the staged policies file.
     */
    private stagePolicies(
        userDataDir: string,
        policies: NonNullable<BrowserEnginePersistentLaunchConfig['firefoxPolicies']>,
    ): string {
        mkdirSync(userDataDir, { recursive: true });
        const policiesPath = join(userDataDir, PROFILE_POLICIES_FILE_NAME);
        writeFileSync(policiesPath, JSON.stringify(policies, null, 4), 'utf8');
        return policiesPath;
    }

    /**
     * Build the launch environment: this launch's own home, plus the staged policies path.
     *
     * Both variables are consumed by the browser process itself, so they must live in the child
     * environment. The home overrides whatever the parent inherited — that inherited value is
     * exactly what Firefox refuses to run under inside the container action. The policies path must
     * be absolute because the browser may resolve it later.
     *
     * @param environment - Allowlisted environment inherited by the browser process tree.
     * @param home - This launch's own home directory.
     * @param policiesPath - Absolute staged policies path, or undefined when none was given.
     * @returns The launch environment the browser process starts with.
     */
    private launchEnvironment(
        environment: Record<string, string>,
        home: FirefoxLaunchHome,
        policiesPath: string | undefined,
    ): Record<string, string> {
        return {
            ...environment,
            [HOME_ENV_VAR]: home.path,
            ...(policiesPath === undefined ? {} : { [FIREFOX_POLICIES_ENV_VAR]: policiesPath }),
        };
    }
}
