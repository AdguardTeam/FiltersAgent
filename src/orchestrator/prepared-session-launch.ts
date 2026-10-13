/**
 * How a run launches browser sessions for its one prepared extension build.
 *
 * The engine, the user-agent family and the extension channel all follow the build's launch family,
 * and a Firefox family needs two things no Chromium launch does — the current content of the
 * declared user-filters file in its enterprise policies, and a relaunch whenever that content
 * changes, because Firefox reads `policies.json` only at startup. The runtime holds none of that
 * logic itself: it hands this module the leaf options it needs (`PreparedSessionLaunchHost`) and
 * calls these functions, so the family knowledge lives in one place beside the channel builder it
 * delegates to.
 */
import { readFileSync } from 'node:fs';
import type { IBrowserSession } from '../browser/browser-interfaces';
import { CloakBrowserEngine } from '../browser/cloakbrowser-engine';
import { BrowserSession, type BrowserSessionConfig } from '../browser/browser-session';
import { FirefoxEngine } from '../browser/firefox-engine';
import {
    buildPreparedExtensionLaunchChannel,
    type PolicySessionRelaunchRequest,
    type PreparedExtensionLaunchChannel,
} from '../browser/prepared-extension-launch';
import type { ActualExecutionContextInput } from '../environment/environment-selection-contract';
import { ExtensionLaunchFamily } from '../environment/extension-launch';
import type { LoadedInstruction } from '../knowledge/instruction-loader';
import { readPreparedExtensionManifest, type PreparedExtension } from '../local/prepared-extension';
import { createLogger } from '../logger/logger';
import { BrowserDisplayName } from '../types/browser-display-name';
import type { ReproProfile } from '../types/repro-profile';
import { PhaseLabel } from '../types/validation';
import { resolveDeclaredBlockerFile } from './blocker-file-target';
import { applicationInstructionContent } from './phase-application-flow-host';

/**
 * The errno a read raises for a path that does not exist — the one read failure of the declared
 * user-filters file that is an expected state rather than a fault, because the host writes that
 * file only when it applies a candidate.
 */
const FILE_ABSENT_ERRNO = 'ENOENT';

/**
 * The run's leaf launch options, narrowed to what a prepared-extension launch needs.
 */
export interface PreparedSessionLaunchHost {
    /**
     * The run instruction loaded at run start, when this run carries one; its state-verification
     * declaration names the file a Firefox launch carries into managed storage.
     */
    instruction?: LoadedInstruction;

    /**
     * The run's host-state root a declared relative target resolves against; the same directory the
     * between-phases application maintains that file in, so a launch can never serve a different
     * file than the read-back credits.
     */
    hostStateRoot: string;

    /**
     * The run artifacts directory a relaunched session writes into.
     */
    artifactsDir: string;

    /**
     * Whether browsers launch headless.
     */
    headless: boolean;

    /**
     * Whether Chromium launches must pass `--no-sandbox`.
     */
    noSandbox?: boolean;

    /**
     * Whether verbose lifecycle logging is enabled.
     */
    verbose: boolean;

    /**
     * Session factory used instead of `BrowserSession.create`, when the run injected one.
     */
    createBrowserSession?: (config: BrowserSessionConfig) => Promise<BrowserSession>;
}

/**
 * The actual execution context one prepared build reports for the run record.
 *
 * A Firefox-family build is installed as a signed XPI: no unpacked manifest exists to read a
 * product version out of, so the context names the extension id the enterprise policies installed
 * and the browser that really ran. The Chromium route drives the stealth Chromium engine for every
 * reporter browser: an Edge (or explicit-MV2) reporter is served by the CloakBrowser Chromium
 * substitute, and the environment selection's fidelity recomputation records the
 * browser-approximation limitation for the substituted browser, so the substitution stays visible
 * in the report.
 *
 * @param extension - The run's one prepared extension build.
 * @returns The product, browser and version the run really executed with.
 */
export function preparedExtensionActualContext(
    extension: PreparedExtension,
): ActualExecutionContextInput {
    if (extension.launchFamily === ExtensionLaunchFamily.Firefox) {
        return {
            product: extension.extensionId,
            browser: BrowserDisplayName.PlaywrightFirefox,
        };
    }
    return {
        product: 'AdGuard Browser Extension',
        browser: BrowserDisplayName.CloakBrowserChromium,
        productVersion: readPreparedExtensionManifest(extension.extensionPath).packageVersion,
    };
}

/**
 * Read the current content of the file this run's instruction declares as its blocker state.
 *
 * The file is the host's own to maintain, so its absence is the expected state before the first
 * application writes it: empty content is the baseline ground state, which is exactly what a
 * missing file means. An absent file is therefore an info line without an error object — an
 * `ENOENT` stack at warn on every Firefox launch before the run has written anything reads as a
 * fault in the log and is not one. Every other read failure keeps its warn and its error before the
 * same empty content is used, so a launch never silently serves stale filters.
 *
 * @param host - The run's leaf launch options.
 * @returns The file's content, or empty content when the run has not written it yet.
 */
function declaredUserFiltersContent(host: PreparedSessionLaunchHost): string {
    const logger = createLogger({ verbose: host.verbose });
    const targetPath = resolveDeclaredBlockerFile(
        applicationInstructionContent(host.instruction),
        host.hostStateRoot,
    );
    if (targetPath === undefined) {
        logger.info(
            {},
            'the run instruction declares no file-backed blocker state; launching with empty managed user filters',
        );
        return '';
    }
    try {
        const content = readFileSync(targetPath, 'utf8');
        logger.info(
            { targetPath, byteLength: Buffer.byteLength(content, 'utf8') },
            'launching with the declared user-filters file content in managed storage',
        );
        return content;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === FILE_ABSENT_ERRNO) {
            logger.info(
                { targetPath },
                'no user-filters file yet; launching with empty managed user filters',
            );
            return '';
        }
        logger.warn(
            { err: error, targetPath },
            'the declared user-filters file could not be read; launching with empty managed user filters',
        );
        return '';
    }
}

/**
 * Build the launch channel one prepared build is loaded through, policies and all.
 *
 * A Firefox-family channel carries the enterprise policies, whose managed storage must hold
 * whatever the declared user-filters file holds right now: the host maintains that file between
 * phases and Firefox reads the policies only at startup, so every launch rebuilds them from the
 * file as it is at that moment.
 *
 * @param host - The run's leaf launch options.
 * @param extension - The run's one prepared extension build.
 * @returns The engine, the user-agent family and the family's own extension channel.
 */
export function preparedExtensionLaunchChannel(
    host: PreparedSessionLaunchHost,
    extension: PreparedExtension,
): PreparedExtensionLaunchChannel {
    if (extension.launchFamily !== ExtensionLaunchFamily.Firefox) {
        return buildPreparedExtensionLaunchChannel({ launch: extension });
    }
    return buildPreparedExtensionLaunchChannel({
        launch: extension,
        userFiltersContent: declaredUserFiltersContent(host),
    });
}

/**
 * Relaunch one session with rebuilt Firefox enterprise policies.
 *
 * Firefox applies `policies.json` only at startup, so the host-performed file-backed application
 * closes the running session and launches a fresh one over the same reproduction profile — through
 * the same session factory every other session of the run uses, so a test observes the rebuilt
 * policies through its own injected factory.
 *
 * @param host - The run's leaf launch options.
 * @param request - The session to replace, the rebuilt policies, and the profile to carry.
 * @returns The replacement session.
 */
export async function relaunchPolicySession(
    host: PreparedSessionLaunchHost,
    request: PolicySessionRelaunchRequest,
): Promise<IBrowserSession> {
    const logger = createLogger({ verbose: host.verbose });
    await Promise.resolve(request.previous.close()).catch((error: unknown) => {
        logger.error(
            { err: error },
            'the session being replaced for rebuilt policies did not close cleanly',
        );
    });
    const createSession = host.createBrowserSession ?? BrowserSession.create;
    const session = await createSession({
        engine: new FirefoxEngine(),
        logger,
        reproProfile: structuredClone(request.reproProfile),
        artifactsDir: host.artifactsDir,
        headless: host.headless,
        noSandbox: host.noSandbox,
        firefoxPolicies: request.firefoxPolicies,
    });
    logger.info(
        { policyExtensionIds: Object.keys(request.firefoxPolicies.policies.ExtensionSettings) },
        'relaunched the session with rebuilt Firefox enterprise policies',
    );
    return session;
}

/**
 * What one adapter-owned phase session launches with.
 */
export interface PreparedPhaseSessionInput {
    /**
     * The run's one prepared extension build.
     */
    extension: PreparedExtension;

    /**
     * Exact A/B/C phase the session is opened for.
     */
    phase: PhaseLabel;

    /**
     * Unpacked extension root the adapter names for the phases that load it, null for phase A.
     */
    extensionRoot: string | null;

    /**
     * Reproduction profile the phase session observes its target with.
     */
    reproProfile: ReproProfile;

    /**
     * Wall-clock budget of the extension-readiness waits a loading phase session gets.
     */
    readinessBudgetMs: number;
}

/**
 * Build the configuration one adapter-owned phase session launches with.
 *
 * Phase A runs unfiltered, so it loads no extension at all. For every other phase the engine and
 * the channel follow the prepared build's launch family: the adapter's own extension root is the
 * Chromium channel — the same unpacked directory this build names, since the adapter is constructed
 * from this very record — while a Firefox family installs the signed XPI its declaration names, for
 * which the adapter carries no root.
 *
 * @param host - The run's leaf launch options.
 * @param input - The build, the phase, the adapter's root, the profile and the readiness budget.
 * @returns The session configuration, carrying exactly one family's extension channel.
 */
export function preparedPhaseSessionConfig(
    host: PreparedSessionLaunchHost,
    input: PreparedPhaseSessionInput,
): BrowserSessionConfig {
    const loadsExtension =
        input.extension.launchFamily === ExtensionLaunchFamily.Firefox
            ? input.phase !== PhaseLabel.A
            : input.extensionRoot !== null;
    const channel = loadsExtension
        ? preparedExtensionLaunchChannel(host, input.extension)
        : undefined;
    // Phase A is the run's control state, not a different browser: a Firefox-family run observes it
    // in the same Firefox build its other phases use, just without the extension. Only the Chromium
    // line falls back to the stealth engine here.
    const unfilteredEngine =
        input.extension.launchFamily === ExtensionLaunchFamily.Firefox
            ? new FirefoxEngine()
            : new CloakBrowserEngine();
    return {
        engine: channel?.engine ?? unfilteredEngine,
        logger: createLogger({ verbose: host.verbose }),
        reproProfile: structuredClone(input.reproProfile),
        artifactsDir: host.artifactsDir,
        headless: host.headless,
        noSandbox: host.noSandbox,
        ...(channel === undefined
            ? {}
            : {
                  ...channel.extensionChannel,
                  // A phase session always bootstraps a fresh profile, so it gets the raised
                  // budget; analysis sessions keep the short built-in default.
                  extensionReadinessBudgetMs: input.readinessBudgetMs,
              }),
    };
}
