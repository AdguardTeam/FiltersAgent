/**
 * What a run hands the Firefox-family filtering environment.
 *
 * The Chromium twin of this module (`buildBrowserExtensionEnvironmentOptions` in
 * `phase-application-launch.ts`) reads an unpacked build's `manifest.json` for its versions and
 * binds an AdGuard settings provider over the launch read-back. A Firefox-family run has neither:
 * its whole executable identity is the launch declaration, so the options are built from that
 * declaration plus the session seams the runtime supplies, and the run's filter baseline is the
 * declaration's list selection rather than anything resolved against AdGuard's catalog.
 */
import { createHash } from 'node:crypto';
import {
    declaredBaselineListKeys,
    decideDeclaredFilters,
    type SelectionFilterBaseline,
} from '../environment/declared-filter-baseline';
import { ExtensionLaunchFamily } from '../environment/extension-launch';
import type { FirefoxExtensionEnvironmentOptions } from '../environment/firefox-extension-environment';
import type { LoadedInstruction } from '../knowledge/instruction-loader';
import type { FirefoxPreparedExtension, PreparedExtension } from '../local/prepared-extension';
import type { AgentRuntimeSessionState } from './agent-runtime-session-evidence';
import { serializeAgentExtensionProvenance } from './agentic-run-evidence';
import { applicationInstructionContent } from './phase-application-flow-host';
import type { BrowserExtensionEnvironmentCallbacks } from './phase-application-launch';

/**
 * The Firefox-family prepared build this run carries, or null for any other family.
 *
 * @param extension - The run's one prepared extension build, when the run prepared one.
 * @returns The Firefox arm of the prepared build, or null.
 */
export function firefoxPreparedLaunch(
    extension: PreparedExtension | undefined,
): FirefoxPreparedExtension | null {
    return extension !== undefined && extension.launchFamily === ExtensionLaunchFamily.Firefox
        ? extension
        : null;
}

/**
 * The executable filter baseline a Firefox-family run declares, or undefined for any other family.
 *
 * The declaration is the baseline. A run of any other family returns undefined, so the environment
 * selection resolves the reported names against AdGuard's catalog.
 *
 * @param extension - The run's one prepared extension build, when the run prepared one.
 * @param reportedFilters - The reporter's own filter list texts, untrusted; compared against the
 *   declared selection for the report only.
 * @returns The declared baseline, or undefined when this run resolves its own.
 */
export function runDeclaredFilterBaseline(
    extension: PreparedExtension | undefined,
    reportedFilters: readonly string[],
): SelectionFilterBaseline | undefined {
    const launch = firefoxPreparedLaunch(extension);
    return launch === null ? undefined : decideDeclaredFilters({ launch, reportedFilters });
}

/**
 * Build production options for the Firefox-family filtering environment.
 *
 * @param instruction - The run instruction loaded at run start, when this run carries one.
 * @param state - Active prepared session whose launch declaration this environment executes.
 * @param callbacks - The runtime seams this construction needs, bound to `state`; the Chromium
 *   route's settings accessor is never read, because this family has no settings to provide.
 * @returns The declaration, the run's profile and instruction, and the session seams.
 * @throws When the session carries no Firefox-family prepared build or no selected settings profile
 *   — the run's launch wiring guarantees both by the time an environment is built.
 */
export function buildFirefoxExtensionEnvironmentOptions(
    instruction: LoadedInstruction | undefined,
    state: AgentRuntimeSessionState,
    callbacks: BrowserExtensionEnvironmentCallbacks,
): FirefoxExtensionEnvironmentOptions {
    const launch = firefoxPreparedLaunch(state.extension);
    if (launch === null || !state.settingsProfile) {
        throw new Error(
            'A prepared Firefox-family session with a selected settings profile is required to ' +
                'build the Firefox blocker environment.',
        );
    }
    const provenance = serializeAgentExtensionProvenance(launch);
    return {
        extensionId: launch.extensionId,
        xpiPath: launch.xpiPath,
        declaredListKeys: declaredBaselineListKeys(launch),
        profileKind: state.settingsProfile.kind,
        application: applicationInstructionContent(instruction),
        buildDigest: createHash('sha256').update(JSON.stringify(provenance)).digest('hex'),
        extensionProvenance: provenance,
        createSession: callbacks.createSession,
        phaseConfiguration: callbacks.phaseConfiguration,
    };
}
