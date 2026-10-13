import { describe, it, expect } from 'vitest';
import * as v from 'valibot';
import { IssueFactsSchema } from '../../src/types/issue-facts';
import { ReproProfileSchema } from '../../src/types/repro-profile';
import { PolicyDecisionSchema } from '../../src/types/policy';
import { RuleProposalSchema } from '../../src/types/rule-proposal';
import { RunTraceSchema } from '../../src/types/trace';
import {
    SearchQuerySchema,
    RuleMatchSchema,
    PlacementMapSchema,
} from '../../src/types/repo-context';

const issueFacts = {
    issueNumber: 12345,
    issueUrl: 'https://github.com/AdguardTeam/AdguardFilters/issues/12345',
    reportedSiteUrls: ['https://example.com'],
    labels: ['T: Ads', 'P: Browser Extension'],
    problemType: 'ads',
    product: 'Browser Extension',
    enabledFilters: [{ name: 'AdGuard Base filter', officialFilterId: 2 }],
    screenshots: [{ url: 'https://example.com/a.png' }],
};

const reproProfile = {
    viewport: 'desktop',
    locale: 'en-US',
    timezone: 'UTC',
    userAgentProfile: 'chrome-desktop',
    consentStrategy: 'untouched',
};

const ruleProposal = {
    rule: '||ads.example.com^$domain=example.com',
    ruleType: 'network',
    risk: {
        level: 'low',
        reasons: ['specific domain'],
    },
    placement: {
        filter: 'AdGuard Base filter',
        filePath: 'filters/BaseFilter/sections/general_url.txt',
        confidence: 0.9,
        alternatives: [],
    },
    duplicateCheck: { classification: 'none', matches: [] },
    productCompatibility: { extension: true },
};

const runTrace = {
    runId: 'run-1',
    issueNumber: 12345,
    mode: 'fix',
    startedAt: '2026-05-29T00:00:00.000Z',
    events: [{ seq: 0, timestamp: '2026-05-29T00:00:00.000Z', type: 'run_start', payload: {} }],
    artifacts: [],
    tokenTotals: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
};

describe('core entity schemas — valid fixtures', () => {
    it.each([
        ['IssueFacts', IssueFactsSchema, issueFacts],
        ['ReproProfile', ReproProfileSchema, reproProfile],
        ['RuleProposal', RuleProposalSchema, ruleProposal],
        ['RunTrace', RunTraceSchema, runTrace],
    ])('accepts a valid %s', (_name, schema, fixture) => {
        expect(v.safeParse(schema, fixture).success).toBe(true);
    });

    it('accepts each PolicyDecision variant', () => {
        for (const decision of ['allow_rule_generation', 'needs_human_review', 'propose_close']) {
            expect(v.safeParse(PolicyDecisionSchema, { decision, reasons: [] }).success).toBe(true);
        }
    });

    it('accepts anti-adblock as a distinct issue problem type', () => {
        expect(
            v.safeParse(IssueFactsSchema, { ...issueFacts, problemType: 'anti-adblock' }).success,
        ).toBe(true);
    });
});

describe('core entity schemas — malformed fixtures rejected', () => {
    it('rejects IssueFacts with a non-numeric issueNumber', () => {
        expect(v.safeParse(IssueFactsSchema, { ...issueFacts, issueNumber: 'x' }).success).toBe(
            false,
        );
    });

    it('rejects IssueFacts with an out-of-enum problemType', () => {
        expect(
            v.safeParse(IssueFactsSchema, { ...issueFacts, problemType: 'tracker' }).success,
        ).toBe(false);
    });

    it('rejects ReproProfile with an unknown viewport', () => {
        expect(
            v.safeParse(ReproProfileSchema, { ...reproProfile, viewport: 'tablet' }).success,
        ).toBe(false);
    });

    it('rejects PolicyDecision with an unknown decision', () => {
        expect(
            v.safeParse(PolicyDecisionSchema, { decision: 'auto_close', reasons: [] }).success,
        ).toBe(false);
    });

    it('rejects RunTrace with an unknown event type', () => {
        const bad = {
            ...runTrace,
            events: [{ seq: 0, timestamp: runTrace.startedAt, type: 'bogus', payload: {} }],
        };
        expect(v.safeParse(RunTraceSchema, bad).success).toBe(false);
    });
});

describe('repo-context schemas', () => {
    it('accepts a minimal SearchQuery with one field', () => {
        const q = v.parse(SearchQuerySchema, { domain: 'ads.example.com' });
        expect(q.domain).toBe('ads.example.com');
    });

    it('accepts a SearchQuery with all fields', () => {
        const q = v.parse(SearchQuerySchema, {
            domain: 'site.com',
            selector: '.ad',
            urlPattern: '||ads.example.com^',
            scriptlet: 'abort-on-property-read',
        });
        expect(q.selector).toBe('.ad');
    });

    it('accepts a valid RuleMatch', () => {
        const m = v.parse(RuleMatchSchema, {
            rule: '||ads.example.com^',
            filePath: '/repo/BaseFilter/filter.txt',
            line: 3,
            filter: 'BaseFilter',
            section: 'Generic network rules',
        });
        expect(m.section).toBe('Generic network rules');
    });

    it('rejects a RuleMatch with an empty rule', () => {
        expect(() =>
            v.parse(RuleMatchSchema, {
                rule: '',
                filePath: '/x',
                line: 1,
                filter: 'F',
                classification: 'exact',
            }),
        ).toThrow();
    });

    it('accepts a valid PlacementMap', () => {
        const map = v.parse(PlacementMapSchema, {
            checkoutPath: '/repo',
            generatedAt: '2026-06-19T00:00:00.000Z',
            files: [
                {
                    filter: 'BaseFilter',
                    relativePath: 'BaseFilter/filter.txt',
                    sections: [{ name: 'General', startLine: 1, endLine: 5 }],
                },
            ],
        });
        expect(map.files[0].sections[0].endLine).toBe(5);
    });
});
