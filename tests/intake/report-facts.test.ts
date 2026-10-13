import { describe, expect, it } from 'vitest';
import { ProblemType } from '../../src/types/issue-facts';
import { ReportProblemType, type Report } from '../../src/intake/report';
import { reportToIssueFacts } from '../../src/intake/report-facts';

/**
 * A filled report exercising every mapped field.
 */
function fullReport(): Report {
    return {
        siteUrls: ['https://example.com/a', 'https://example.com/b'],
        problemType: ReportProblemType.AntiAdblock,
        declaredType: 'Anti Adblock Script',
        comment: 'The wall appears after three visits.',
        screenshots: [{ url: 'https://example.com/shot.png', description: 'before' }],
        environment: {
            product: 'AdGuard Browser Extension v5.4.3.79 MV3',
            browser: 'Chrome',
            os: 'Mac OS 26.2.0',
        },
        enabledLists: [
            { name: 'AdGuard Base filter', officialFilterId: 2 },
            { name: 'AdGuard Russian filter', officialFilterId: 1 },
        ],
        settingsImportUrl: 'https://reports.adguard.com/settings/import.html?regular_filters=1',
        userRules: ['example.com##.banner'],
        blockedCounts: { EasyList: 3 },
        reproductionSteps: ['Open the page', 'Click the link'],
    };
}

describe('reportToIssueFacts', () => {
    it('takes the identity fields from the source, never the report', () => {
        const facts = reportToIssueFacts(
            {
                number: 42,
                url: 'https://github.com/owner/repo/issues/42',
                labels: ['T: Ads'],
            },
            fullReport(),
        );
        expect(facts.issueNumber).toBe(42);
        expect(facts.issueUrl).toBe('https://github.com/owner/repo/issues/42');
        expect(facts.labels).toEqual(['T: Ads']);
    });

    it('maps the report payload fields onto the facts vocabulary', () => {
        const facts = reportToIssueFacts(
            {
                number: 42,
                url: 'https://github.com/owner/repo/issues/42',
                labels: [],
            },
            fullReport(),
        );
        expect(facts.reportedSiteUrls).toEqual(['https://example.com/a', 'https://example.com/b']);
        expect(facts.problemType).toBe(ProblemType.AntiAdblock);
        expect(facts.declaredIssueType).toBe('Anti Adblock Script');
        expect(facts.product).toBe('AdGuard Browser Extension v5.4.3.79 MV3');
        expect(facts.browser).toBe('Chrome');
        expect(facts.os).toBe('Mac OS 26.2.0');
        expect(facts.enabledFilters).toEqual([
            { name: 'AdGuard Base filter', officialFilterId: 2 },
            { name: 'AdGuard Russian filter', officialFilterId: 1 },
        ]);
        expect(facts.settingsImportUrl).toBe(
            'https://reports.adguard.com/settings/import.html?regular_filters=1',
        );
        expect(facts.userComment).toBe('The wall appears after three visits.');
        expect(facts.screenshots).toEqual([
            { url: 'https://example.com/shot.png', description: 'before' },
        ]);
        expect(facts.reproductionSteps).toEqual(['Open the page', 'Click the link']);
    });

    it('maps the other problem type onto the shared unknown', () => {
        const report = fullReport();
        report.problemType = ReportProblemType.Other;
        const facts = reportToIssueFacts(
            {
                number: 1,
                url: 'https://github.com/owner/repo/issues/1',
                labels: [],
            },
            report,
        );
        expect(facts.problemType).toBe(ProblemType.Unknown);
    });

    it('leaves declaredIssueType absent when the report declares none', () => {
        const report = fullReport();
        delete report.declaredType;
        const facts = reportToIssueFacts(
            {
                number: 1,
                url: 'https://github.com/owner/repo/issues/1',
                labels: [],
            },
            report,
        );
        expect(facts.declaredIssueType).toBeUndefined();
    });

    it('substitutes the unknown product placeholder when the environment has none', () => {
        const report = fullReport();
        report.environment = {};
        const facts = reportToIssueFacts(
            {
                number: 1,
                url: 'https://github.com/owner/repo/issues/1',
                labels: [],
            },
            report,
        );
        expect(facts.product).toBe('Unknown');
        expect(facts.browser).toBeUndefined();
        expect(facts.os).toBeUndefined();
    });
});
