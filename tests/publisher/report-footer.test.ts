import { describe, expect, it } from 'vitest';
import { withReportFooter } from '../../src/publisher/report-footer';

describe('withReportFooter', () => {
    it('ends the report with the filters commit and the filters agent line', () => {
        const body = withReportFooter(
            'Candidate rule proposed\n\n## Rule\n\n`x##.ad`\n\n',
            'a'.repeat(40),
        );

        expect(body).toBe(
            'Candidate rule proposed\n\n## Rule\n\n`x##.ad`\n\n' +
                '<sub>Automated analysis against filters at `aaaaaaa`. Posted by a filters agent; ' +
                'a maintainer reviews before anything is merged.</sub>\n',
        );
    });
});
