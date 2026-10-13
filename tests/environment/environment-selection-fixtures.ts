/**
 * Fixtures shared by the environment selection host suites.
 */
import type { IssueFacts, ReportedFilter } from '../../src/types/issue-facts';
import {
    EnvironmentCapability,
    EnvironmentLimitationCode,
    EnvironmentPreparationState,
    FilteringEnvironmentAvailability,
    type FilteringEnvironmentDescriptor,
} from '../../src/environment/environment-vocabulary';
import { EnvironmentSelectionHost } from '../../src/environment/environment-selection';
import type { ExecutorPreparationOutcome } from '../../src/environment/executor-preparation';

export const facts: IssueFacts = {
    issueNumber: 42,
    issueUrl: 'https://github.com/AdguardTeam/AdguardFilters/issues/42',
    reportedSiteUrls: ['https://example.test/'],
    labels: ['T: Ads', 'N: AdGuard for Windows'],
    declaredIssueType: 'Ads',
    problemType: 'ads',
    product: 'AdGuard for Windows',
    os: 'Windows 11',
    browser: 'Edge',
    enabledFilters: [{ name: 'AdGuard Base filter', officialFilterId: 2 }],
    screenshots: [],
};

export const intent = {
    issueType: 'ads' as const,
    rationale: 'The report describes a website advertisement.',
    confidence: 0.9,
    evidence: [{ source: 'issue_body' as const, observation: 'A banner remains visible.' }],
    conflicts: ['The product label names Windows, but the browser evidence is portable.'],
};

export const extensionDecision = {
    kind: 'browser_extension',
    requiredCapabilities: ['browser_navigation', 'filtering_control'],
    intent,
    rationale: 'The extension can reproduce this website-filtering report.',
    confidence: 0.85,
};

export const cliDecision = {
    kind: 'adguard_cli',
    requiredCapabilities: [],
    intent,
    rationale: 'CLI is the closest available approximation of the reported desktop product.',
    confidence: 0.8,
};

export const extensionDescriptor: FilteringEnvironmentDescriptor = {
    kind: 'browser_extension',
    availability: FilteringEnvironmentAvailability.Available,
    preparationState: EnvironmentPreparationState.NotStarted,
    limitationCode: null,
    capabilities: [
        EnvironmentCapability.BrowserNavigation,
        EnvironmentCapability.FilteringControl,
        EnvironmentCapability.ExtensionFiltering,
        EnvironmentCapability.CandidateApplication,
        EnvironmentCapability.BaselineIntegrity,
        EnvironmentCapability.PhaseProof,
    ],
};

export const cliDescriptor: FilteringEnvironmentDescriptor = {
    kind: 'adguard_cli',
    availability: FilteringEnvironmentAvailability.Available,
    preparationState: EnvironmentPreparationState.Preparable,
    limitationCode: null,
    capabilities: [EnvironmentCapability.CliInstallation, EnvironmentCapability.CliActivation],
};

export const descriptors: FilteringEnvironmentDescriptor[] = [extensionDescriptor, cliDescriptor];

/**
 * A selection host over both descriptors for the shared report facts.
 *
 * @param enabledFilters - The reported filter selection.
 * @returns A fresh host.
 */
export function host(
    enabledFilters: ReportedFilter[] = facts.enabledFilters,
): EnvironmentSelectionHost {
    return new EnvironmentSelectionHost({ ...facts, enabledFilters }, descriptors, {
        now: () => '2026-07-23T20:00:00.000Z',
    });
}

/**
 * A ready preparation outcome with path-free official provenance.
 *
 * @returns The outcome.
 */
export function readyExecutorPreparation(): ExecutorPreparationOutcome {
    return {
        ready: true,
        provenance: {
            source: 'official_release',
            product: 'AdGuard CLI',
            version: '1.4.13',
            digestB32: 'digestb32examplevalue0123456789abcdefghijklmnopqrstuvwxyz',
        },
    };
}

/**
 * The extension descriptor shipped as unavailable.
 *
 * @returns The descriptor.
 */
export function unavailableExtensionDescriptor(): FilteringEnvironmentDescriptor {
    return {
        ...extensionDescriptor,
        availability: FilteringEnvironmentAvailability.Unavailable,
        preparationState: EnvironmentPreparationState.AdapterUnavailable,
        limitationCode: EnvironmentLimitationCode.ExecutorUnavailable,
    };
}
