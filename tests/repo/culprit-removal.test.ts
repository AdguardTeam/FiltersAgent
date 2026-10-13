import { describe, expect, it } from 'vitest';
import { describeCulpritRemoval } from '../../src/repo/culprit-removal';

const BOTH_SCOPES = { affectedScopes: ['a.example', 'b.example'] };

interface Row {
    name: string;
    original: string;
    expected: ReturnType<typeof describeCulpritRemoval>;
}

const rows: Row[] = [
    {
        name: 'discloses every scope the removed rule governed',
        original: 'a.example,b.example##.content',
        expected: BOTH_SCOPES,
    },
    {
        name: 'discloses the scopes ascending however the rule happened to be written',
        original: 'b.example,a.example##.content',
        expected: BOTH_SCOPES,
    },
    {
        name: 'omits a negated scope, which loses nothing when the rule goes away',
        original: 'a.example,~b.example##.content',
        expected: { affectedScopes: ['a.example'] },
    },
    {
        name: 'reports no bounded scope for a rule that already governed every site',
        original: '##.content',
        expected: { affectedScopes: [] },
    },
    {
        name: 'refuses removing a cosmetic exception, which restores blocking instead of repairing it',
        original: 'a.example#@#.content',
        expected: null,
    },
    {
        name: 'refuses removing a network exception, which restores blocking instead of repairing it',
        original: '@@||ads.example^$domain=a.example',
        expected: null,
    },
    {
        name: 'refuses a comment even though it lints clean',
        original: '! a comment',
        expected: null,
    },
    {
        name: 'refuses a malformed rule',
        original: 'a.example##',
        expected: null,
    },
    {
        name: 'refuses a target spanning more than one line',
        original: 'a.example##.content\nb.example##.content',
        expected: null,
    },
    {
        name: 'carries $domain= scopes through the same predicate as cosmetic prefixes',
        original: '||ads.example^$domain=a.example|b.example',
        expected: BOTH_SCOPES,
    },
];

describe('describeCulpritRemoval', () => {
    it.each(rows)('$name', (row) => {
        expect(describeCulpritRemoval(row.original)).toEqual(row.expected);
    });
});
