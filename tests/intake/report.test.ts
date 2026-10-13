import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { formatIssues } from '../../src/pi/valibot-issues';
import {
    IntakeExtractionPayloadSchema,
    IntakeVerdict,
    ReportProblemType,
    type Report,
} from '../../src/intake/report';

/**
 * Minimal schema-valid report payload: every required field present, one site URL.
 */
function minimalReport(): Report {
    return {
        siteUrls: ['https://example.com/page'],
        problemType: ReportProblemType.Ads,
        declaredType: 'Ads',
        comment: 'an ad banner appears over the content',
        screenshots: [{ url: 'https://example.com/shot.png' }],
        environment: {
            product: 'AdGuard Browser Extension v5.0.0',
            browser: 'Chrome',
            os: 'Windows',
        },
        enabledLists: [{ name: 'EasyList' }],
        settingsImportUrl: 'https://filters.adtidy.org/extension/ublock/settings',
        userRules: ['example.com##.banner'],
        blockedCounts: { EasyList: 3 },
        reproductionSteps: ['Open the page', 'Scroll down'],
    };
}

describe('IntakeExtractionPayloadSchema', () => {
    it('accepts a minimal filter-report payload with one site URL', () => {
        const result = v.safeParse(IntakeExtractionPayloadSchema, {
            verdict: IntakeVerdict.FilterReport,
            report: minimalReport(),
        });
        expect(result.success).toBe(true);
    });

    it('rejects a filter-report with an empty siteUrls array, naming the field', () => {
        const report = minimalReport();
        report.siteUrls = [];
        const result = v.safeParse(IntakeExtractionPayloadSchema, {
            verdict: IntakeVerdict.FilterReport,
            report,
        });
        expect(result.success).toBe(false);
        if (result.success) {
            return;
        }
        const detail = formatIssues(result.issues);
        expect(detail).toContain('siteUrls');
        expect(detail).toMatch(/siteUrls: /);
    });

    it('rejects a wrong-typed blockedCounts, naming the field', () => {
        const report = minimalReport();
        report.blockedCounts = 'EasyList: 3' as unknown as Report['blockedCounts'];
        const result = v.safeParse(IntakeExtractionPayloadSchema, {
            verdict: IntakeVerdict.FilterReport,
            report,
        });
        expect(result.success).toBe(false);
        if (result.success) {
            return;
        }
        expect(formatIssues(result.issues)).toContain('blockedCounts');
    });

    it('rejects a non-URL siteUrls entry, naming the field', () => {
        const report = minimalReport();
        report.siteUrls = ['not a url'];
        const result = v.safeParse(IntakeExtractionPayloadSchema, {
            verdict: IntakeVerdict.FilterReport,
            report,
        });
        expect(result.success).toBe(false);
        if (result.success) {
            return;
        }
        expect(formatIssues(result.issues)).toContain('siteUrls');
    });

    it('rejects a declaredType over 100 characters, naming the field', () => {
        const report = minimalReport();
        report.declaredType = 'x'.repeat(101);
        const result = v.safeParse(IntakeExtractionPayloadSchema, {
            verdict: IntakeVerdict.FilterReport,
            report,
        });
        expect(result.success).toBe(false);
        if (result.success) {
            return;
        }
        expect(formatIssues(result.issues)).toContain('declaredType');
    });

    it('accepts the not-a-filter-report variant with a reason', () => {
        const result = v.safeParse(IntakeExtractionPayloadSchema, {
            verdict: IntakeVerdict.NotAFilterReport,
            reason: 'no site URL in the issue',
        });
        expect(result.success).toBe(true);
    });

    it('rejects an unknown verdict literal', () => {
        const result = v.safeParse(IntakeExtractionPayloadSchema, {
            verdict: 'maybe-a-report',
            reason: 'x',
        });
        expect(result.success).toBe(false);
        if (result.success) {
            return;
        }
        expect(formatIssues(result.issues)).toContain('verdict');
    });
});
