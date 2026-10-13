import { describe, expect, it } from 'vitest';
import { matchingNames, parseNameList } from '../../src/github/github-name-list';

describe('parseNameList', () => {
    it('splits a comma-separated list and drops blank entries', () => {
        expect(parseNameList(' NSFW , ,Unsorted ')).toEqual(['NSFW', 'Unsorted']);
    });

    it('reads an unset or blank value as an empty list', () => {
        expect(parseNameList(undefined)).toEqual([]);
        expect(parseNameList(' , ')).toEqual([]);
    });
});

describe('matchingNames', () => {
    it('names the listed issue labels in their own spelling, ignoring case like GitHub does', () => {
        expect(matchingNames(['T: Ads', 'nsfw'], ['NSFW'])).toEqual(['nsfw']);
    });

    it('finds nothing when no name matches or nothing is listed', () => {
        expect(matchingNames(['T: Ads'], ['NSFW'])).toEqual([]);
        expect(matchingNames(['NSFW'], [])).toEqual([]);
    });
});
