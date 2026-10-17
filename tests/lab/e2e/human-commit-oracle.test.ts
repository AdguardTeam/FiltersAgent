import { describe, expect, it } from 'vitest';
import {
    parseHumanCommitDiff,
    parseHumanCommitRuleLines,
} from '../../../lab/e2e/human-commit-oracle';

describe('human commit oracle extraction', () => {
    it('ignores comments and extracts inserted rules from multiple hunks and files', () => {
        const diff = `diff --git a/BaseFilter/sections/foreign.txt b/BaseFilter/sections/foreign.txt
--- a/BaseFilter/sections/foreign.txt
+++ b/BaseFilter/sections/foreign.txt
@@ -9235,0 +9236,2 @@
+! https://github.com/AdguardTeam/AdguardFilters/issues/235403
+wpoznaniu.pl##div[class^="inner-ads-header"]
diff --git a/EnglishFilter/sections/antiadblock.txt b/EnglishFilter/sections/antiadblock.txt
--- a/EnglishFilter/sections/antiadblock.txt
+++ b/EnglishFilter/sections/antiadblock.txt
@@ -10,0 +11 @@
+example.com#%#//scriptlet('abort-current-inline-script', 'document.createElement')
`;

        expect(parseHumanCommitDiff(diff)).toEqual([
            {
                rule: 'wpoznaniu.pl##div[class^="inner-ads-header"]',
                syntaxKind: 'element_hiding',
                filePath: 'BaseFilter/sections/foreign.txt',
                repositoryEdit: 'insert',
                sourceRule: 'wpoznaniu.pl##div[class^="inner-ads-header"]',
            },
            {
                rule:
                    "example.com#%#//scriptlet('abort-current-inline-script', " +
                    "'document.createElement')",
                syntaxKind: 'scriptlet',
                filePath: 'EnglishFilter/sections/antiadblock.txt',
                repositoryEdit: 'insert',
                sourceRule:
                    "example.com#%#//scriptlet('abort-current-inline-script', " +
                    "'document.createElement')",
            },
        ]);
    });

    it('does not misclassify a changed selector as a domain extension', () => {
        const diff = `diff --git a/BaseFilter/sections/foreign.txt b/BaseFilter/sections/foreign.txt
--- a/BaseFilter/sections/foreign.txt
+++ b/BaseFilter/sections/foreign.txt
@@ -1 +1 @@
-example.com##.old-ad
+example.com##.new-ad
`;

        expect(parseHumanCommitDiff(diff)).toEqual([
            {
                rule: 'example.com##.new-ad',
                syntaxKind: 'element_hiding',
                filePath: 'BaseFilter/sections/foreign.txt',
                repositoryEdit: 'insert',
                sourceRule: 'example.com##.new-ad',
            },
        ]);
    });

    it('recognizes a domain-scoped network rule extension', () => {
        const diff = `diff --git a/EnglishFilter/sections/specific.txt b/EnglishFilter/sections/specific.txt
--- a/EnglishFilter/sections/specific.txt
+++ b/EnglishFilter/sections/specific.txt
@@ -1 +1 @@
-||ads.example^$domain=one.pl|two.pl,script
+||ads.example^$domain=nettg.pl|one.pl|two.pl,script
`;

        expect(parseHumanCommitDiff(diff)).toEqual([
            {
                rule: '||ads.example^$domain=nettg.pl,script',
                syntaxKind: 'network',
                filePath: 'EnglishFilter/sections/specific.txt',
                repositoryEdit: 'extend_domains',
                sourceRule: '||ads.example^$domain=nettg.pl|one.pl|two.pl,script',
            },
        ]);
    });

    it('classifies a newly excluded network domain as a parent-rule replacement', () => {
        const diff = `diff --git a/EnglishFilter/sections/specific.txt b/EnglishFilter/sections/specific.txt
--- a/EnglishFilter/sections/specific.txt
+++ b/EnglishFilter/sections/specific.txt
@@ -1 +1 @@
-||ads.example^$domain=one.pl,script
+||ads.example^$domain=one.pl|~two.pl,script
`;

        expect(parseHumanCommitDiff(diff)).toEqual([
            {
                rule: '||ads.example^$domain=one.pl|~two.pl,script',
                syntaxKind: 'network',
                filePath: 'EnglishFilter/sections/specific.txt',
                repositoryEdit: 'replace',
                sourceRule: '||ads.example^$domain=one.pl|~two.pl,script',
                replacedRule: '||ads.example^$domain=one.pl,script',
            },
        ]);
    });

    it('classifies a narrowed network resource modifier as a parent-rule replacement', () => {
        const diff = `diff --git a/EnglishFilter/sections/specific.txt b/EnglishFilter/sections/specific.txt
--- a/EnglishFilter/sections/specific.txt
+++ b/EnglishFilter/sections/specific.txt
@@ -1 +1 @@
-||ads.example^$domain=example.com
+||ads.example^$domain=example.com,script
`;

        expect(parseHumanCommitDiff(diff)).toEqual([
            {
                rule: '||ads.example^$domain=example.com,script',
                syntaxKind: 'network',
                filePath: 'EnglishFilter/sections/specific.txt',
                repositoryEdit: 'replace',
                sourceRule: '||ads.example^$domain=example.com,script',
                replacedRule: '||ads.example^$domain=example.com',
            },
        ]);
    });

    it('classifies a narrowed cosmetic domain scope as a parent-rule replacement', () => {
        const diff = `diff --git a/BaseFilter/sections/foreign.txt b/BaseFilter/sections/foreign.txt
--- a/BaseFilter/sections/foreign.txt
+++ b/BaseFilter/sections/foreign.txt
@@ -1 +1 @@
-example.com,other.example##.ad-slot
+example.com##.ad-slot
`;

        expect(parseHumanCommitDiff(diff)).toEqual([
            {
                rule: 'example.com##.ad-slot',
                syntaxKind: 'element_hiding',
                filePath: 'BaseFilter/sections/foreign.txt',
                repositoryEdit: 'replace',
                sourceRule: 'example.com##.ad-slot',
                replacedRule: 'example.com,other.example##.ad-slot',
            },
        ]);
    });

    it('recognizes removal of a global network exclusion as a positive domain extension', () => {
        const diff = `diff --git a/EnglishFilter/sections/specific.txt b/EnglishFilter/sections/specific.txt
--- a/EnglishFilter/sections/specific.txt
+++ b/EnglishFilter/sections/specific.txt
@@ -1 +1 @@
-||ads.example^$domain=~reporter.pl,script
+||ads.example^$script
`;

        expect(parseHumanCommitDiff(diff)).toEqual([
            {
                rule: '||ads.example^$script,domain=reporter.pl',
                syntaxKind: 'network',
                filePath: 'EnglishFilter/sections/specific.txt',
                repositoryEdit: 'extend_domains',
                sourceRule: '||ads.example^$script',
            },
        ]);
    });

    it('collects every actionable added and removed rule line of a diff', () => {
        const diff = `diff --git a/BaseFilter/sections/specific.txt b/BaseFilter/sections/specific.txt
--- a/BaseFilter/sections/specific.txt
+++ b/BaseFilter/sections/specific.txt
@@ -1,3 +1,4 @@
-! old comment
-
-example.com##.banner
+! new comment
+
+example.com,sub.example.com##.banner
${'+  ||example.org/ads^  '}
diff --git a/EnglishFilter/sections/specific.txt b/EnglishFilter/sections/specific.txt
--- a/EnglishFilter/sections/specific.txt
+++ b/EnglishFilter/sections/specific.txt
@@ -1 +1 @@
-||example.com^$domain=example.org
+||example.com^$domain=example.org,script
`;

        expect(parseHumanCommitRuleLines(diff)).toEqual({
            added: [
                'example.com,sub.example.com##.banner',
                '  ||example.org/ads^  ',
                '||example.com^$domain=example.org,script',
            ],
            removed: ['example.com##.banner', '||example.com^$domain=example.org'],
        });
    });

    it('preserves actionable hunk rules whose prefixes resemble file headers', () => {
        const diff = `diff --git a/BaseFilter/sections/specific.txt b/BaseFilter/sections/specific.txt
--- a/BaseFilter/sections/specific.txt
+++ b/BaseFilter/sections/specific.txt
@@ -1 +1 @@
---old-ad--
+++new-ad++
diff --git a/EnglishFilter/sections/specific.txt b/EnglishFilter/sections/specific.txt
--- a/EnglishFilter/sections/specific.txt
+++ b/EnglishFilter/sections/specific.txt
@@ -1 +1 @@
-||example.com/old-ad^
+||example.com/new-ad^
`;

        expect(parseHumanCommitRuleLines(diff)).toEqual({
            added: ['++new-ad++', '||example.com/new-ad^'],
            removed: ['--old-ad--', '||example.com/old-ad^'],
        });
    });
});
