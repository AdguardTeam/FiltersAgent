import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    decideDeclaredFilters,
    declaredBaselineListKeys,
} from '../../src/environment/declared-filter-baseline';
import {
    EnvironmentCapability,
    EnvironmentPreparationState,
    FilteringEnvironmentAvailability,
    type FilteringEnvironmentDescriptor,
} from '../../src/environment/environment-vocabulary';
import { EnvironmentSelectionHost } from '../../src/environment/environment-selection';
import {
    ExtensionLaunchFamily,
    type FirefoxExtensionLaunch,
} from '../../src/environment/extension-launch';
import type { IssueFacts } from '../../src/types/issue-facts';
import { reportedFilters } from './reported-filter-fixtures';

/**
 * The list names a uBlock Origin report carries: uBO's own list titles, which the official AdGuard
 * catalog cannot resolve and must never be asked to.
 */
const REPORTED_UBLOCK_LISTS = [
    'uBlock filters',
    'uBlock filters \u2013 Annoyances',
    'EasyList',
    'https://example.test/my-own-list.txt',
];

/**
 * The Firefox launch declaration of the shipped uBlock Origin example.
 *
 * @param selectedFilterLists - The declaration's list selection, or undefined to declare none.
 * @returns The declaration.
 */
function ublockLaunch(selectedFilterLists?: readonly string[]): FirefoxExtensionLaunch {
    return {
        launchFamily: ExtensionLaunchFamily.Firefox,
        extensionId: 'uBlock0@raymondhill.net',
        xpiPath: join(tmpdir(), 'ublock-origin.firefox.signed.xpi'),
        managedStorageTemplate: {
            adminSettings:
                selectedFilterLists === undefined
                    ? {}
                    : { selectedFilterLists: [...selectedFilterLists] },
        },
        userFiltersKeyPath: ['adminSettings', 'userFilters'],
    };
}

/**
 * Issue facts of a uBlock Origin report.
 *
 * @returns The facts, whose enabled lists are uBO's own list titles.
 */
function ublockFacts(): IssueFacts {
    return {
        issueNumber: 4242,
        issueUrl: 'https://github.com/uBlockOrigin/uAssets/issues/4242',
        reportedSiteUrls: ['https://example.test/article'],
        labels: ['T: Ads'],
        problemType: 'ads',
        product: 'uBlock Origin in Firefox',
        enabledFilters: reportedFilters(...REPORTED_UBLOCK_LISTS),
        screenshots: [],
    };
}

/**
 * The browser-extension descriptor a uBlock Origin run locks.
 */
const extensionDescriptor: FilteringEnvironmentDescriptor = {
    kind: 'browser_extension',
    availability: FilteringEnvironmentAvailability.Available,
    preparationState: EnvironmentPreparationState.NotStarted,
    limitationCode: null,
    capabilities: [
        EnvironmentCapability.BrowserNavigation,
        EnvironmentCapability.FilteringControl,
        EnvironmentCapability.ExtensionFiltering,
        EnvironmentCapability.CandidateApplication,
        EnvironmentCapability.PhaseProof,
    ],
};

describe('the filter baseline a run declares', () => {
    it("takes the declaration's own list selection plus user filters as the executable baseline", () => {
        const baseline = decideDeclaredFilters({
            launch: ublockLaunch(['ublock-filters', 'easylist', 'user-filters']),
            reportedFilters: REPORTED_UBLOCK_LISTS,
        });

        expect(baseline).toEqual({
            status: 'declared',
            listKeys: ['declared:easylist', 'declared:ublock-filters', 'declared:user-filters'],
            // Compared against the selection for the report only: the reporter's "uBlock filters"
            // and "EasyList" are the declaration's own lists under their human titles, its
            // Annoyances list is one the declaration does not select, and a subscription URL is a
            // source this run does not reproduce at all.
            unmatchedReportedNames: ['uBlock filters \u2013 Annoyances'],
            skippedSources: [
                {
                    kind: 'custom_subscription',
                    reportedName: 'https://example.test/my-own-list.txt',
                },
            ],
        });
    });

    it('keeps user filters in the baseline even when the declaration selects nothing', () => {
        // uBlock Origin applies no user rule at all unless the pseudo-list is selected, so it
        // belongs to the executable baseline whether or not the template spells it.
        expect(declaredBaselineListKeys(ublockLaunch())).toEqual(['declared:user-filters']);
        expect(declaredBaselineListKeys(ublockLaunch(['ublock-filters']))).toEqual([
            'declared:ublock-filters',
            'declared:user-filters',
        ]);
    });

    it('locks a ready environment for a report whose lists the official catalog cannot resolve', () => {
        const facts = ublockFacts();
        const selection = {
            kind: 'browser_extension',
            requiredCapabilities: ['browser_navigation', 'filtering_control'],
            intent: {
                issueType: 'ads' as const,
                rationale: 'The report describes a website advertisement.',
                confidence: 0.9,
                evidence: [
                    { source: 'issue_body' as const, observation: 'A banner remains visible.' },
                ],
                conflicts: [],
            },
            rationale: 'uBlock Origin in Firefox reproduces this report directly.',
            confidence: 0.9,
        };

        // Without a declared baseline the reported uBO list names resolve to nothing and the
        // environment can never be ready.
        const resolving = new EnvironmentSelectionHost(facts, [extensionDescriptor]);
        expect(resolving.select(selection)).toMatchObject({
            accepted: true,
            state: 'capability_limited',
            limitationCode: 'filter_selection_not_executable',
        });

        const declaring = new EnvironmentSelectionHost(facts, [extensionDescriptor], {
            filterBaseline: decideDeclaredFilters({
                launch: ublockLaunch(['ublock-filters', 'user-filters']),
                reportedFilters: facts.enabledFilters.map((filter) => filter.name),
            }),
        });
        expect(declaring.select(selection)).toMatchObject({
            accepted: true,
            state: 'ready',
            limitationCode: null,
            filterBaseline: {
                status: 'declared',
                listKeys: ['declared:ublock-filters', 'declared:user-filters'],
            },
        });
        expect(declaring.snapshot()?.state).toBe('ready');
    });
});
