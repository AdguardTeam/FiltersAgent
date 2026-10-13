import { describe, expect, it } from 'vitest';
import { describeCulpritReplacement } from '../../src/repo/culprit-replacement';

const CULPRIT = 'a.example,b.example##.content';
const BOTH_SCOPES = { affectedScopes: ['a.example', 'b.example'] };

interface Row {
    name: string;
    original: string;
    replacement: string;
    expected: ReturnType<typeof describeCulpritReplacement>;
}

const rows: Row[] = [
    {
        name: 'discloses every scope the culprit governed when the expression itself changes',
        original: CULPRIT,
        replacement: 'a.example,b.example##.content.ad',
        expected: BOTH_SCOPES,
    },
    {
        name: 'discloses what the culprit governed, not what survives, when a scope is dropped',
        original: CULPRIT,
        replacement: 'a.example##.content.ad',
        expected: BOTH_SCOPES,
    },
    {
        name: 'refuses a replacement serving a positive scope the report never named',
        original: CULPRIT,
        replacement: 'a.example,b.example,c.example##.content.ad',
        expected: null,
    },
    {
        name: 'accepts an added negation, which can only narrow what the rule reaches',
        original: CULPRIT,
        replacement: 'a.example,b.example,~c.example##.content.ad',
        expected: BOTH_SCOPES,
    },
    {
        name: 'refuses dropping a negation the culprit carried, which broadens the rule',
        original: 'a.example,b.example,~c.example##.content',
        replacement: 'a.example,b.example##.content.ad',
        expected: null,
    },
    {
        name: 'lets a global culprit be narrowed and reports no bounded scope for it',
        original: '##.content',
        replacement: 'a.example##.content.ad',
        expected: { affectedScopes: [] },
    },
    {
        name: 'refuses a replacement that turns the culprit into an exception',
        original: 'a.example##.content',
        replacement: 'a.example#@#.content',
        expected: null,
    },
    {
        name: 'refuses correcting an exception, which inverts what the rule does',
        original: 'a.example#@#.content',
        replacement: 'a.example##.content',
        expected: null,
    },
    {
        name: 'refuses a replacement of a different rule kind',
        original: 'a.example##.content',
        replacement: '||a.example/x^',
        expected: null,
    },
    {
        name: 'refuses a replacement written in a different concrete syntax',
        original: 'a.example##.content',
        replacement: 'a.example#?#.content',
        expected: null,
    },
    {
        name: 'refuses a replacement that changes nothing but domain order',
        original: CULPRIT,
        replacement: 'b.example,a.example##.content',
        expected: null,
    },
    {
        name: 'refuses a comment as a replacement even though it lints clean',
        original: 'a.example##.content',
        replacement: '! a comment',
        expected: null,
    },
    {
        name: 'refuses a malformed replacement',
        original: 'a.example##.content',
        replacement: 'a.example##',
        expected: null,
    },
    {
        name: 'carries $domain= scopes through the same predicate as cosmetic prefixes',
        original: '||ads.example^$domain=a.example|b.example',
        replacement: '||ads.example^$domain=a.example|b.example|~reported.example',
        expected: BOTH_SCOPES,
    },
];

describe('describeCulpritReplacement', () => {
    it.each(rows)('$name', (row) => {
        expect(describeCulpritReplacement(row.original, row.replacement)).toEqual(row.expected);
    });
});
