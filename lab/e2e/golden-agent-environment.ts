import type { RawIssue } from '../../src/github/fetch-issue';
import type { LocalRunRecord } from '../../src/local/run-output';
import { ExtensionManifestVersion } from '../../src/environment/extension-preparation';
import {
    adguardListKey,
    parseAdguardListKey,
    sortListKeys,
} from '../../src/environment/filter-list-ref';
import { NOT_OBSERVED_TEXT } from '../../src/environment/environment-proofs';
import { parseImportExpectations } from '../../src/browser/adguard-extension-settings';
import { reporterSettingsImportUrls } from '../../src/orchestrator/reporter-import-url';
import { ReproductionSettingsStatus } from '../../src/types/fix-run-result';

/**
 * Query parameter of a reporter settings import link naming the extension manifest generation.
 */
const MANIFEST_VERSION_PARAMETER = 'ext.manifest_version';

/**
 * Reporter environment read from the issue's settings import link after the agent result is locked.
 */
interface GoldenReporterEnvironment {
    /**
     * Browser extension manifest generation reported by the user.
     */
    manifestVersion: number;

    /**
     * Exact enabled regular-filter IDs from the trusted import URL, ascending and unique.
     */
    enabledFilterIds: number[];

    /**
     * Exact Stealth Mode state from the trusted import URL.
     */
    stealthEnabled: boolean;
}

/**
 * Post-lock comparison of the agent environment with the reporter settings.
 */
export const GoldenAgentEnvironmentStatus = {
    /**
     * Locked agent settings and reporter settings agree.
     */
    Matched: 'matched',
    /**
     * The agent selected or verified different reporter settings.
     */
    AgentMismatch: 'agent_mismatch',
    /**
     * The report or the locked record cannot be compared: the report has no single usable import
     * link or is not MV3, or the run stopped before it prepared the reporter build.
     */
    Unavailable: 'unavailable',
} as const;

/**
 * Value of the post-lock reporter-environment classification.
 */
export type GoldenAgentEnvironmentStatus =
    (typeof GoldenAgentEnvironmentStatus)[keyof typeof GoldenAgentEnvironmentStatus];

/**
 * Post-lock reporter-environment classification written to the benchmark record.
 */
export interface GoldenAgentEnvironmentAssessment {
    /**
     * Whether the agent ran in the reporter environment.
     */
    status: GoldenAgentEnvironmentStatus;

    /**
     * Exact environment summary, settings difference, or the reason no comparison was possible.
     */
    detail: string;
}

/**
 * Read the reporter environment from the settings import link of an AdGuard report.
 *
 * The report form writes the link itself, so code reads it: no model interprets the report. The
 * link is found by {@link reporterSettingsImportUrls}, the scan that binds the agent's launches to
 * the reporter's link, and parsed by {@link parseImportExpectations}, the parser `launch_browser`
 * applies it with, so the benchmark reads the same filters and Stealth state the agent was held
 * to.
 *
 * @param issue - Prompt-safe issue the completed run received.
 * @returns Exact reporter environment from the single trusted settings import URL.
 * @throws {Error} When the issue carries no import link, several different ones, or a malformed
 *   one.
 */
function readGoldenReporterEnvironment(issue: RawIssue): GoldenReporterEnvironment {
    const links = [...reporterSettingsImportUrls(issue).values()];
    if (links.length === 0) {
        throw new Error('Golden issue has no exact reporter settings import URL.');
    }
    if (links.length > 1) {
        throw new Error(
            `Golden issue carries ${links.length} different reporter settings import URLs.`,
        );
    }
    const expectations = parseImportExpectations(links[0]!);
    // The agent's parser does not read the manifest generation; this suite replays MV3 builds only.
    const manifestValues = new URL(links[0]!).searchParams.getAll(MANIFEST_VERSION_PARAMETER);
    const manifestVersion = Number(manifestValues[0]);
    if (manifestValues.length !== 1 || !Number.isSafeInteger(manifestVersion)) {
        throw new Error(
            `Golden settings import needs exactly one numeric ${MANIFEST_VERSION_PARAMETER}.`,
        );
    }
    return {
        manifestVersion,
        enabledFilterIds: expectations.enabledFilterIds,
        stealthEnabled: expectations.stealthEnabled,
    };
}

/**
 * Render stored list keys as the numeric registry ids the mismatch details have always shown.
 *
 * @param listKeys - List keys from the locked settings evidence.
 * @returns Comma-joined renderables, ids numeric-ascending; an unresolvable key is shown verbatim.
 */
function renderedFilterIds(listKeys: readonly string[]): string {
    const rendered = listKeys.map((listKey) => parseAdguardListKey(listKey) ?? listKey);
    const ids = rendered.filter((value): value is number => typeof value === 'number');
    const foreign = rendered.filter((value): value is string => typeof value === 'string');
    return [...ids.sort((left, right) => left - right), ...foreign].join(',');
}

/**
 * Compare two list-key collections as exact canonical sets.
 *
 * @param left - First sorted key list.
 * @param right - Second sorted key list.
 * @returns Whether both contain the same keys.
 */
function equalKeyLists(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((listKey, index) => listKey === right[index]);
}

/**
 * Compare a locked verified-session environment with exact reporter settings after the agent stops.
 *
 * @param record - Schema-validated local run record.
 * @param issue - The report the case is pinned to; its settings import link is the reporter's.
 * @returns Match, agent mismatch, or the reason no comparison was possible.
 */
export function assessGoldenAgentEnvironment(
    record: LocalRunRecord,
    issue: RawIssue,
): GoldenAgentEnvironmentAssessment {
    let reporter: GoldenReporterEnvironment;
    try {
        reporter = readGoldenReporterEnvironment(issue);
    } catch (error) {
        return {
            status: GoldenAgentEnvironmentStatus.Unavailable,
            detail: error instanceof Error ? error.message : String(error),
        };
    }
    if (reporter.manifestVersion !== ExtensionManifestVersion.Mv3) {
        return {
            status: GoldenAgentEnvironmentStatus.Unavailable,
            detail:
                `Golden reporter environment requires MV${reporter.manifestVersion}; ` +
                'this suite supports Chromium MV3 only.',
        };
    }

    // The build comes from the case's own pin, so only its absence says anything: the run stopped
    // before it prepared the reporter build.
    const extension = record.result.extensionProvenance;
    if (!extension) {
        return {
            status: GoldenAgentEnvironmentStatus.Unavailable,
            detail: 'Locked result has no extension provenance: the run stopped before it prepared the reporter build.',
        };
    }
    if (extension.manifestVersion !== ExtensionManifestVersion.Mv3) {
        return {
            status: GoldenAgentEnvironmentStatus.AgentMismatch,
            detail:
                `The loaded extension build declares manifest_version=${extension.manifestVersion}; ` +
                'this suite verifies the reporter Chromium MV3 build.',
        };
    }

    const settings = record.result.settingsEvidence;
    if (
        !settings ||
        record.result.reproductionSettingsStatus !== ReproductionSettingsStatus.Applied
    ) {
        return {
            status: GoldenAgentEnvironmentStatus.AgentMismatch,
            detail: 'Locked result has no applied verified-session settings evidence.',
        };
    }
    if (settings.limitsExceeded) {
        return {
            status: GoldenAgentEnvironmentStatus.AgentMismatch,
            detail: 'Reporter settings exceeded MV3 limits and were not verified exactly.',
        };
    }
    if (
        settings.enabledListKeys === null ||
        settings.activeRulesetListKeys === null ||
        settings.stealthEnabled === null
    ) {
        return {
            status: GoldenAgentEnvironmentStatus.AgentMismatch,
            detail:
                `Locked verified session cannot be compared: its enabled filter set, its active ` +
                `ruleset set or its Stealth state is ${NOT_OBSERVED_TEXT}.`,
        };
    }
    const enabledKeys = sortListKeys(settings.enabledListKeys);
    if (!equalKeyLists(enabledKeys, sortListKeys(reporter.enabledFilterIds.map(adguardListKey)))) {
        return {
            status: GoldenAgentEnvironmentStatus.AgentMismatch,
            detail:
                `Enabled filter IDs ${renderedFilterIds(enabledKeys)} do not match reporter IDs ` +
                `${reporter.enabledFilterIds.join(',')}.`,
        };
    }
    const activeKeys = sortListKeys(settings.activeRulesetListKeys);
    if (!equalKeyLists(activeKeys, sortListKeys(reporter.enabledFilterIds.map(adguardListKey)))) {
        return {
            status: GoldenAgentEnvironmentStatus.AgentMismatch,
            detail:
                `Active ruleset filter IDs ${renderedFilterIds(activeKeys)} do not match reporter ` +
                `IDs ${reporter.enabledFilterIds.join(',')}.`,
        };
    }
    if (settings.stealthEnabled !== reporter.stealthEnabled) {
        return {
            status: GoldenAgentEnvironmentStatus.AgentMismatch,
            detail:
                `Stealth state ${settings.stealthEnabled ? 'enabled' : 'disabled'} does not match ` +
                `reporter state ${reporter.stealthEnabled ? 'enabled' : 'disabled'}.`,
        };
    }
    return {
        status: GoldenAgentEnvironmentStatus.Matched,
        detail:
            `Locked verified session matches the reporter extension build (${extension.source}), ` +
            `${reporter.enabledFilterIds.length} reporter filter IDs, and exact Stealth state.`,
    };
}
