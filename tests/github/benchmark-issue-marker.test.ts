import { describe, expect, it } from 'vitest';
import { stripBenchmarkIssueMarker } from '../../src/github/benchmark-issue-marker';

const filtersBaseSha = '0123456789abcdef0123456789abcdef01234567';
const humanFixCommit = '89abcdef0123456789abcdef0123456789abcdef';

describe('benchmark issue marker', () => {
    it('removes metadata from prompt text without mutating surrounding reporter content', () => {
        const source = [
            'Reporter description.',
            `<!-- adguard-agent-benchmark: {"filtersBaseSha":"${filtersBaseSha}","humanFixCommit":"${humanFixCommit}"} -->`,
            'More reporter details.',
        ].join('\n');

        expect(stripBenchmarkIssueMarker(source)).toBe(
            ['Reporter description.', 'More reporter details.'].join('\n'),
        );
        expect(source).toContain(humanFixCommit);
    });

    it('strips a marker whose metadata is invalid', () => {
        expect(
            stripBenchmarkIssueMarker(
                'Reporter\n<!-- adguard-agent-benchmark: {"humanFixCommit":"leak"} -->',
            ),
        ).toBe('Reporter');
    });
});
