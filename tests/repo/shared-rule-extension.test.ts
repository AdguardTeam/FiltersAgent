import { describe, expect, it } from 'vitest';
import { describeSharedRuleExtension } from '../../src/repo/shared-rule-extension';

const SHARED_RULE = 'a.example,b.example##.widget';
const CANDIDATE = 'reported.test##.widget';

interface Row {
    name: string;
    candidate: string;
    original: string;
    replacement: string;
    expected: ReturnType<typeof describeSharedRuleExtension>;
}

const rows: Row[] = [
    {
        name: 'accepts a network family extension that adds only the reported scope',
        candidate: '||cs.iubenda.com^$domain=reported.test',
        original: '||cs.iubenda.com^$domain=a.it|b.it',
        replacement: '||cs.iubenda.com^$domain=reported.test|a.it|b.it',
        expected: { addedScope: 'reported.test', retainedScopes: ['a.it', 'b.it'] },
    },
    {
        name: 'refuses a network replacement whose other modifiers changed',
        candidate: '||cs.iubenda.com^$domain=reported.test',
        original: '||cs.iubenda.com^$domain=a.it|b.it',
        replacement: '||cs.iubenda.com^$script,domain=reported.test|a.it|b.it',
        expected: null,
    },
    {
        name: 'accepts a scriptlet family extension that adds only the reported scope',
        candidate: "reported.test#%#//scriptlet('set-local-storage-item', 'x', 'true')",
        original: "a.com,b.com#%#//scriptlet('set-local-storage-item', 'x', 'true')",
        replacement:
            "reported.test,a.com,b.com#%#//scriptlet('set-local-storage-item', 'x', 'true')",
        expected: { addedScope: 'reported.test', retainedScopes: ['a.com', 'b.com'] },
    },
    {
        name: 'adds exactly the reported scope and discloses every scope already served',
        candidate: CANDIDATE,
        original: SHARED_RULE,
        replacement: 'reported.test,a.example,b.example##.widget',
        expected: { addedScope: 'reported.test', retainedScopes: ['a.example', 'b.example'] },
    },
    {
        name: 'refuses a replacement that drops a domain the shared rule already served',
        candidate: CANDIDATE,
        original: SHARED_RULE,
        replacement: 'reported.test,a.example##.widget',
        expected: null,
    },
    {
        name: 'refuses a replacement that moves the rule expression',
        candidate: CANDIDATE,
        original: SHARED_RULE,
        replacement: 'reported.test,a.example,b.example##.widget2',
        expected: null,
    },
    {
        name: 'refuses a replacement adding a scope the report never named',
        candidate: CANDIDATE,
        original: SHARED_RULE,
        replacement: 'other.example,a.example,b.example##.widget',
        expected: null,
    },
    {
        name: 'refuses a shared rule that already carries the reported scope',
        candidate: CANDIDATE,
        original: 'reported.test,a.example,b.example##.widget',
        replacement: 'reported.test,a.example,b.example##.widget',
        expected: null,
    },
    {
        name: 'refuses an unhide original, which shares a syntax kind with the blocking candidate',
        candidate: CANDIDATE,
        original: 'a.example,b.example#@#.widget',
        replacement: 'reported.test,a.example,b.example#@#.widget',
        expected: null,
    },
    {
        name: 'refuses a negated candidate scope',
        candidate: '~reported.test##.widget',
        original: SHARED_RULE,
        replacement: '~reported.test,a.example,b.example##.widget',
        expected: null,
    },
    {
        name: 'refuses a negation among the scopes it would have to enumerate as also affected',
        candidate: CANDIDATE,
        original: '~a.example,b.example,c.example##.widget',
        replacement: 'reported.test,~a.example,b.example,c.example##.widget',
        expected: null,
    },
    {
        name: 'refuses adding an unnamed domain to a rule that already carries the reported scope',
        candidate: CANDIDATE,
        original: 'reported.test,a.example##.widget',
        replacement: 'reported.test,a.example,evil.example##.widget',
        expected: null,
    },
    {
        name: 'refuses a global rule, whose narrowing to one site is not an extension',
        candidate: CANDIDATE,
        original: '##.widget',
        replacement: 'reported.test##.widget',
        expected: null,
    },
    {
        name: 'refuses a single-domain rule, which no second site shares',
        candidate: CANDIDATE,
        original: 'a.example##.widget',
        replacement: 'reported.test,a.example##.widget',
        expected: null,
    },
    {
        name: 'discloses ascending deduplicated scopes regardless of source ordering',
        candidate: CANDIDATE,
        original: 'b.example,a.example,b.example##.widget',
        replacement: 'b.example,reported.test,a.example##.widget',
        expected: { addedScope: 'reported.test', retainedScopes: ['a.example', 'b.example'] },
    },
];

describe('describeSharedRuleExtension', () => {
    it.each(rows)('$name', (row) => {
        expect(describeSharedRuleExtension(row.candidate, row.original, row.replacement)).toEqual(
            row.expected,
        );
    });
});
