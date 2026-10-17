import { TRUSTED_REPORT_SETTINGS_HOSTS } from '../../src/browser/adguard-settings-import-url';
import type { RawIssue } from '../../src/github/fetch-issue';
import type { LocalExtensionProvenance, LocalRunRecord } from '../../src/local/run-output';
import { loadLocalIssueSnapshot, toAgentIssueInput } from '../../src/local/issue-snapshot';
import {
    ExtensionManifestVersion,
    PreparedExtensionSource,
} from '../../src/environment/extension-preparation';
import {
    adguardListKey,
    parseAdguardListKey,
    sortListKeys,
} from '../../src/environment/filter-list-ref';
import { NOT_OBSERVED_TEXT } from '../../src/environment/environment-proofs';
import { ReproductionSettingsStatus } from '../../src/types/fix-run-result';
import type { Report } from '../../src/intake/report';
import { reportToIssueFacts } from '../../src/intake/report-facts';

/**
 * Injectable effects for the post-lock reporter-environment assessment.
 */
export interface GoldenAgentEnvironmentDependencies {
    /**
     * Independent reporter settings, read through the judge cache or freshly extracted.
     */
    readReporterEnvironment: () => Promise<GoldenReporterEnvironment>;
}

/**
 * Reporter environment parsed independently after the agent result is locked.
 */
export interface GoldenReporterEnvironment {
    /**
     * Exact browser-extension version reported by the user.
     */
    extensionVersion: string;

    /**
     * Browser extension manifest generation reported by the user.
     */
    manifestVersion: number;

    /**
     * Exact enabled regular-filter IDs from the trusted import URL.
     */
    enabledFilterIds: number[];

    /**
     * Exact Stealth Mode state from the trusted import URL.
     */
    stealthEnabled: boolean;
}

/**
 * Post-lock comparison of the agent environment with independently read reporter settings.
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
     * Case or record integrity prevents comparison.
     */
    InfrastructureFailure: 'infrastructure_failure',
} as const;

/**
 * Value of the post-lock reporter-environment classification.
 */
export type GoldenAgentEnvironmentStatus =
    (typeof GoldenAgentEnvironmentStatus)[keyof typeof GoldenAgentEnvironmentStatus];

/**
 * Successful post-lock proof that the agent used the reporter environment.
 */
export interface GoldenAgentEnvironmentMatch {
    /**
     * Stable successful assessment discriminator.
     */
    status: typeof GoldenAgentEnvironmentStatus.Matched;

    /**
     * Human-readable exact-environment summary.
     */
    detail: string;

    /**
     * Locked verified-session extension provenance safe for the human oracle to reuse.
     */
    extension: LocalExtensionProvenance;
}

/**
 * Post-lock evidence that the model selected or verified the wrong reporter environment.
 */
export interface GoldenAgentEnvironmentMismatch {
    /**
     * Stable agent-regression assessment discriminator.
     */
    status: typeof GoldenAgentEnvironmentStatus.AgentMismatch;

    /**
     * Exact provenance or settings difference.
     */
    detail: string;

    /**
     * No extension may be reused for the oracle after a mismatch.
     */
    extension: null;
}

/**
 * Post-lock case or record integrity failure that prevents environment comparison.
 */
export interface GoldenAgentEnvironmentInfrastructureFailure {
    /**
     * Stable infrastructure assessment discriminator.
     */
    status: typeof GoldenAgentEnvironmentStatus.InfrastructureFailure;

    /**
     * Exact case parsing or locked-record integrity failure.
     */
    detail: string;

    /**
     * No extension may be reused when integrity could not be established.
     */
    extension: null;
}

/**
 * Post-lock reporter-environment classification supplied to the golden comparator.
 */
export type GoldenAgentEnvironmentAssessment =
    | GoldenAgentEnvironmentMatch
    | GoldenAgentEnvironmentMismatch
    | GoldenAgentEnvironmentInfrastructureFailure;

/**
 * Read one required trusted settings-import parameter.
 *
 * @param url - Parsed trusted settings import URL.
 * @param name - Required query parameter name.
 * @returns Non-empty parameter value.
 */
function requiredParameter(url: URL, name: string): string {
    const value = url.searchParams.get(name)?.trim();
    if (!value) {
        throw new Error(`Golden exact settings import is missing ${name}.`);
    }
    return value;
}

/**
 * Parse exact filter IDs from an AdGuard reporter import URL.
 *
 * @param source - Comma- or dot-separated regular filter IDs.
 * @returns Sorted unique positive filter IDs.
 */
function parseFilterIds(source: string): number[] {
    const ids = source.split(/[,.]/u).map((item) => Number(item.trim()));
    if (ids.length === 0 || ids.some((id) => !Number.isSafeInteger(id) || id < 1)) {
        throw new Error('Golden exact settings import contains malformed regular_filters.');
    }
    return sortedUniqueIds(ids);
}

/**
 * Parse one exact Stealth Mode value from a reporter import URL.
 *
 * @param source - Encoded boolean value.
 * @returns Reporter Stealth Mode state.
 */
function parseStealthEnabled(source: string): boolean {
    if (source === '1' || source === 'true') {
        return true;
    }
    if (source === '0' || source === 'false') {
        return false;
    }
    throw new Error('Golden exact settings import contains malformed stealth.enabled.');
}

/**
 * Parse machine-checkable historical extension and settings from the prompt-safe issue.
 *
 * This runs only after run-result.json has been written and schema-validated. It is never exposed
 * to the core, prompt, or agent tools. The facts come from the intake extraction's mapped report.
 *
 * @param issueFile - Portable local issue snapshot used by the completed run.
 * @param extractReport - Bound intake extraction seam.
 * @returns Exact reporter environment from the trusted settings import URL.
 */
export async function extractGoldenReporterEnvironment(
    issueFile: string,
    extractReport: (raw: RawIssue) => Promise<Report | null>,
): Promise<GoldenReporterEnvironment> {
    const issue = toAgentIssueInput(loadLocalIssueSnapshot(issueFile));
    const report = await extractReport(issue);
    if (report === null) {
        throw new Error(
            'The intake extraction skipped the golden issue: it is not a filter report.',
        );
    }
    const facts = reportToIssueFacts(
        { number: issue.number, url: issue.url, labels: issue.labels },
        report,
    );
    if (!facts.settingsImportUrl) {
        throw new Error('Golden issue has no exact reporter settings import URL.');
    }
    const importUrl = new URL(facts.settingsImportUrl);
    if (!TRUSTED_REPORT_SETTINGS_HOSTS.has(importUrl.hostname.toLowerCase())) {
        throw new Error(`Golden settings import host is not trusted: ${importUrl.hostname}.`);
    }
    const extensionVersion = requiredParameter(importUrl, 'product_version');
    if (!/^\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/u.test(extensionVersion)) {
        throw new Error('Golden exact settings import contains malformed product_version.');
    }
    const manifestVersion = Number(requiredParameter(importUrl, 'ext.manifest_version'));
    if (!Number.isSafeInteger(manifestVersion)) {
        throw new Error('Golden exact settings import contains malformed ext.manifest_version.');
    }
    return {
        extensionVersion,
        manifestVersion,
        enabledFilterIds: parseFilterIds(requiredParameter(importUrl, 'regular_filters')),
        stealthEnabled: parseStealthEnabled(requiredParameter(importUrl, 'stealth.enabled')),
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
 * Produce a sorted unique ID list without mutating caller-owned evidence.
 *
 * @param ids - Unordered filter IDs.
 * @returns Ascending unique IDs.
 */
function sortedUniqueIds(ids: readonly number[]): number[] {
    const ordered: number[] = [];
    for (const id of new Set(ids)) {
        const insertionIndex = ordered.findIndex((candidate) => id < candidate);
        if (insertionIndex === -1) {
            ordered.push(id);
        } else {
            ordered.splice(insertionIndex, 0, id);
        }
    }
    return ordered;
}

/**
 * Verify that local wrapper provenance is the same extension bound to the locked result.
 *
 * @param record - Schema-validated locked local run.
 * @returns Error detail, or null when both provenance views agree.
 */
function lockedProvenanceMismatch(record: LocalRunRecord): string | null {
    const result = record.result.extensionProvenance;
    const wrapper = record.provenance.extension;
    if (!result || !wrapper) {
        return null;
    }
    // One host-prepared build per run: both views serialize the same PreparedExtension, so the
    // views agree exactly when their single-source records compare equal.
    return JSON.stringify(wrapper) === JSON.stringify(result)
        ? null
        : 'Locked result and local wrapper extension provenance disagree.';
}

/**
 * Compare a locked verified-session environment with exact reporter settings after the agent stops.
 *
 * The reporter environment comes from `readReporterEnvironment`: the judge's cached or freshly
 * extracted settings. The runner binds the judge's LLM configuration.
 *
 * @param record - Schema-validated local run record.
 * @param dependencies - The independent reporter environment reader.
 * @returns Match, agent mismatch, or case/record infrastructure failure.
 */
export async function assessGoldenAgentEnvironment(
    record: LocalRunRecord,
    dependencies: GoldenAgentEnvironmentDependencies,
): Promise<GoldenAgentEnvironmentAssessment> {
    let reporter: GoldenReporterEnvironment;
    try {
        reporter = await dependencies.readReporterEnvironment();
    } catch (error) {
        return {
            status: GoldenAgentEnvironmentStatus.InfrastructureFailure,
            detail: error instanceof Error ? error.message : String(error),
            extension: null,
        };
    }
    if (reporter.manifestVersion !== ExtensionManifestVersion.Mv3) {
        return {
            status: GoldenAgentEnvironmentStatus.InfrastructureFailure,
            detail:
                `Golden reporter environment requires MV${reporter.manifestVersion}; ` +
                'this suite supports Chromium MV3 only.',
            extension: null,
        };
    }

    const extension = record.result.extensionProvenance;
    const wrapperExtension = record.provenance.extension;
    if (!extension || !wrapperExtension) {
        return {
            status: GoldenAgentEnvironmentStatus.InfrastructureFailure,
            detail: 'Locked result has no historical build extension provenance.',
            extension: null,
        };
    }
    const provenanceMismatch = lockedProvenanceMismatch(record);
    if (provenanceMismatch) {
        return {
            status: GoldenAgentEnvironmentStatus.InfrastructureFailure,
            detail: provenanceMismatch,
            extension: null,
        };
    }
    if (
        extension.source !== PreparedExtensionSource.HistoricalBuild ||
        !extension.historicalBuild
    ) {
        return {
            status: GoldenAgentEnvironmentStatus.InfrastructureFailure,
            detail: 'Locked result requires a historical build with its reporter build identity.',
            extension: null,
        };
    }
    if (extension.historicalBuild.version !== reporter.extensionVersion) {
        return {
            status: GoldenAgentEnvironmentStatus.InfrastructureFailure,
            detail:
                `The loaded reporter build version ${extension.historicalBuild.version} does not ` +
                `match reporter product_version=${reporter.extensionVersion}.`,
            extension: null,
        };
    }
    if (extension.manifestVersion !== ExtensionManifestVersion.Mv3) {
        return {
            status: GoldenAgentEnvironmentStatus.AgentMismatch,
            detail:
                `The loaded extension build declares manifest_version=${extension.manifestVersion}; ` +
                'this suite verifies the reporter Chromium MV3 build.',
            extension: null,
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
            extension: null,
        };
    }
    if (settings.limitsExceeded) {
        return {
            status: GoldenAgentEnvironmentStatus.AgentMismatch,
            detail: 'Reporter settings exceeded MV3 limits and were not verified exactly.',
            extension: null,
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
            extension: null,
        };
    }
    const enabledKeys = sortListKeys(settings.enabledListKeys);
    if (!equalKeyLists(enabledKeys, sortListKeys(reporter.enabledFilterIds.map(adguardListKey)))) {
        return {
            status: GoldenAgentEnvironmentStatus.AgentMismatch,
            detail:
                `Enabled filter IDs ${renderedFilterIds(enabledKeys)} do not match reporter IDs ` +
                `${reporter.enabledFilterIds.join(',')}.`,
            extension: null,
        };
    }
    const activeKeys = sortListKeys(settings.activeRulesetListKeys);
    if (!equalKeyLists(activeKeys, sortListKeys(reporter.enabledFilterIds.map(adguardListKey)))) {
        return {
            status: GoldenAgentEnvironmentStatus.AgentMismatch,
            detail:
                `Active ruleset filter IDs ${renderedFilterIds(activeKeys)} do not match reporter ` +
                `IDs ${reporter.enabledFilterIds.join(',')}.`,
            extension: null,
        };
    }
    if (settings.stealthEnabled !== reporter.stealthEnabled) {
        return {
            status: GoldenAgentEnvironmentStatus.AgentMismatch,
            detail:
                `Stealth state ${settings.stealthEnabled ? 'enabled' : 'disabled'} does not match ` +
                `reporter state ${reporter.stealthEnabled ? 'enabled' : 'disabled'}.`,
            extension: null,
        };
    }
    return {
        status: GoldenAgentEnvironmentStatus.Matched,
        detail:
            `Locked verified session matches the reporter extension build (${wrapperExtension.source}), ` +
            `${reporter.enabledFilterIds.length} reporter filter IDs, and exact Stealth state.`,
        extension: wrapperExtension,
    };
}
