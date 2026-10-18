import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { reportedSiteUrl } from '../../../lab/e2e/case-site';
import { listGoldenCaseNames } from '../../../lab/e2e/golden-suite';
import { pinnedReport } from '../../../lab/e2e/pinned-report';
import type { RawIssue } from '../../../src/github/fetch-issue';
import { loadLocalIssueSnapshot, toAgentIssueInput } from '../../../src/local/issue-snapshot';
import { reporterSettingsImportUrls } from '../../../src/orchestrator/reporter-import-url';

const CASES_ROOT = join(process.cwd(), 'lab', 'benchmark', 'e2e', 'cases');

function report(siteUrl: string, version: string): string {
    return (
        `### Issue URL (Ads)\n[${siteUrl}](https://adguardteam.github.io/AnonymousRedirect/)\n\n` +
        '### Issue configuration\n[Import](https://reports.adguard.com/settings/import.html?' +
        `scheme_version=4&amp;product_type=ext&amp;product_version=${version}&amp;` +
        'ext.manifest_version=3&amp;browser=chrome&amp;' +
        'regular_filters=2%2C216&amp;stealth.enabled=0)'
    );
}

const issue: RawIssue = {
    number: 1,
    url: 'https://github.com/example-owner/example-repo/issues/1',
    title: 'example.org',
    body: report('https://first.example.org/', '5.4.3.90'),
    state: 'closed',
    labels: [],
    assignee: null,
    comments: [
        {
            author: 'example-reporter',
            body: report('https://second.example.org/', '5.4.3.99'),
            createdAt: '2026-07-01T00:00:00Z',
        },
    ],
};

describe('pinnedReport', () => {
    it.each([
        ['5.4.3.99', 'https://second.example.org/'],
        ['5.4.3.90', 'https://first.example.org/'],
    ])('reads the site and the single link of the report pinned to %s', (version, site) => {
        const pinned = pinnedReport(issue, version);

        expect(reportedSiteUrl(pinned)).toBe(site);
        expect(reporterSettingsImportUrls(pinned).size).toBe(1);
    });

    it.each([
        ['an Edge report', (body: string) => body.replace('browser=chrome', 'browser=edge')],
        ['a quoted report', (body: string) => body.replace('### Issue URL', '> ### Issue URL')],
    ])('does not take %s of the same version for the pinned one', (_name, change) => {
        const reported: RawIssue = {
            ...issue,
            comments: issue.comments.map((comment) => ({
                ...comment,
                body: change(report('https://second.example.org/', '5.4.3.90')),
            })),
        };

        expect(reportedSiteUrl(pinnedReport(reported, '5.4.3.90'))).toBe(
            'https://first.example.org/',
        );
    });

    it('refuses an issue with no report for the pinned version', () => {
        expect(() => pinnedReport(issue, '5.4.3.1')).toThrow(/5\.4\.3\.1/u);
    });

    it.each(listGoldenCaseNames(CASES_ROOT))(
        'finds the pinned report of tracked case %s',
        (name) => {
            const run = JSON.parse(readFileSync(join(CASES_ROOT, name, 'run.json'), 'utf8')) as {
                extensionBuild: { version: string };
            };
            const snapshot = loadLocalIssueSnapshot(join(CASES_ROOT, name, 'issue', 'issue.json'));

            const pinned = pinnedReport(toAgentIssueInput(snapshot), run.extensionBuild.version);

            expect(reporterSettingsImportUrls(pinned).size).toBe(1);
            expect(() => reportedSiteUrl(pinned)).not.toThrow();
        },
    );
});
