import { describe, expect, it } from 'vitest';
import { parseSummarizeArgs } from '../../../lab/benchmark/summarize-cli';

describe('benchmark summarize command line', () => {
    it('parses roots and --csv', () => {
        expect(
            parseSummarizeArgs(['--', 'example-first', '--csv', 'summary.csv', 'example-second']),
        ).toEqual({ roots: ['example-first', 'example-second'], csvPath: 'summary.csv' });
        expect(parseSummarizeArgs(['example-root'])).toEqual({
            roots: ['example-root'],
            csvPath: null,
        });
    });

    it('refuses no roots and unknown flags', () => {
        expect(() => parseSummarizeArgs([])).toThrow(/root/i);
        expect(() => parseSummarizeArgs(['--csv', 'summary.csv'])).toThrow(/root/i);
        expect(() => parseSummarizeArgs(['example-root', '--unknown'])).toThrow(/unknown/i);
        expect(() => parseSummarizeArgs(['example-root', '-x'])).toThrow(/unknown/i);
        expect(() => parseSummarizeArgs(['example-root', '--csv'])).toThrow(/csv/i);
        expect(() => parseSummarizeArgs(['example-root', '--csv', '--unknown'])).toThrow(/csv/i);
    });
});
