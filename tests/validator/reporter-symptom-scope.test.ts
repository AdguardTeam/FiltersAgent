import { describe, expect, it } from 'vitest';
import {
    MAX_REPORTER_SYMPTOM_CHARS,
    composeReporterSymptomScope,
} from '../../src/validator/reporter-symptom-scope';

/**
 * A sitepoint.com report: the reporter named four locations, the candidate covered three, and the
 * review was handed only the candidate's three — so it verified a rule that leaves the header
 * banner on the page.
 */
const SITEPOINT_REPORT = 'Visible ads in header, throughout article, in sidebar, and in footer.';
const SITEPOINT_CANDIDATE_TARGET =
    'Reporter-defined in-content ad placeholders (.inline-content), sticky bottom banner ' +
    '(#takeover-footer), and sidebar sticky vertical ad (#takeover-vertical) on sitepoint.com.';

describe('composeReporterSymptomScope', () => {
    it('leads with the reporter material and keeps the candidate description subordinate', () => {
        const scope = composeReporterSymptomScope({
            reportedProblem: SITEPOINT_REPORT,
            issueText: 'sitepoint.com ads\n\nVisible ads in header.',
            screenshotObservations: ['A blue banner sits under the site navigation.'],
            candidateTarget: SITEPOINT_CANDIDATE_TARGET,
        });

        expect(scope).toBeDefined();
        expect(scope).toContain(SITEPOINT_REPORT);
        expect(scope).toContain('A blue banner sits under the site navigation.');
        expect(scope).toContain(SITEPOINT_CANDIDATE_TARGET);
        // The order is the whole point: whatever names the reporter's own symptom has to come
        // before the candidate's, or the candidate's reads as the scope of the review.
        expect(scope!.indexOf(SITEPOINT_REPORT)).toBeLessThan(
            scope!.indexOf(SITEPOINT_CANDIDATE_TARGET),
        );
    });

    it('falls back to the issue text, then to the candidate description, then to nothing', () => {
        const fromIssue = composeReporterSymptomScope({
            issueText: 'sitepoint.com ads\n\nVisible ads in header.',
            candidateTarget: SITEPOINT_CANDIDATE_TARGET,
        });
        const candidateOnly = composeReporterSymptomScope({
            candidateTarget: SITEPOINT_CANDIDATE_TARGET,
        });

        expect(fromIssue).toContain('Visible ads in header.');
        expect(fromIssue).toContain(SITEPOINT_CANDIDATE_TARGET);
        expect(candidateOnly).toBe(SITEPOINT_CANDIDATE_TARGET);
        expect(composeReporterSymptomScope({ reportedProblem: '   ' })).toBeUndefined();
    });

    it('keeps the candidate description whole when a long report fills the budget', () => {
        const scope = composeReporterSymptomScope({
            reportedProblem: `${SITEPOINT_REPORT} ${'Ad units repeat down the page. '.repeat(400)}`,
            candidateTarget: SITEPOINT_CANDIDATE_TARGET,
        });

        expect(scope!.length).toBeLessThanOrEqual(MAX_REPORTER_SYMPTOM_CHARS);
        expect(scope).toContain(SITEPOINT_REPORT);
        expect(scope).toContain(SITEPOINT_CANDIDATE_TARGET);
    });
});
