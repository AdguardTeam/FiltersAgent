import { describe, expect, it, vi } from 'vitest';
import {
    buildHumanCommitFetchArgs,
    extractHumanCommitFix,
    parseHumanCommitDiff,
    type HumanCommitGitReader,
} from '../../../lab/e2e/human-commit-oracle';

const HUMAN_COMMIT = '8e9ba459a4552df35b3edb1a4e4d8dd240095ce8';
const FIRST_PARENT = '8e73dd6c67cb432e1d93bfb79326fd88b16fdbe5';
const SECOND_PARENT = 'a'.repeat(40);

const NETTG_DIFF = `diff --git a/BaseFilter/sections/foreign.txt b/BaseFilter/sections/foreign.txt
index 9b32fb0..75e6e0b 100644
--- a/BaseFilter/sections/foreign.txt
+++ b/BaseFilter/sections/foreign.txt
@@ -7383 +7383 @@ tvrepublika.pl##.block--type-advertisement
-morizon.pl,prawo.pl,polski-tenis.pl##.banner
+nettg.pl,morizon.pl,prawo.pl,polski-tenis.pl##.banner
diff --git a/SpywareFilter/sections/specific.txt b/SpywareFilter/sections/specific.txt
index 6f42604..49f93d2 100644
--- a/SpywareFilter/sections/specific.txt
+++ b/SpywareFilter/sections/specific.txt
@@ -90,0 +91 @@
+||nettg.pl/store-view/api/track-page-view
`;

describe('human commit oracle extraction', () => {
    it('fetches the complete two-commit diff without a lazy blob dependency', () => {
        const args = buildHumanCommitFetchArgs(HUMAN_COMMIT);

        expect(args).toEqual([
            'fetch',
            '--quiet',
            '--depth',
            '2',
            '--no-tags',
            'https://github.com/AdguardTeam/AdguardFilters.git',
            HUMAN_COMMIT,
        ]);
        expect(args).not.toContain('--filter=blob:none');
    });

    it('uses the first parent and extracts every added filter change with file/edit metadata', async () => {
        const git: HumanCommitGitReader = {
            readParents: vi.fn().mockResolvedValue([FIRST_PARENT, SECOND_PARENT]),
            readDiff: vi.fn().mockResolvedValue(NETTG_DIFF),
        };

        const fix = await extractHumanCommitFix(HUMAN_COMMIT, git);

        expect(git.readParents).toHaveBeenCalledWith(HUMAN_COMMIT);
        expect(git.readDiff).toHaveBeenCalledWith(FIRST_PARENT, HUMAN_COMMIT);
        expect(fix).toEqual({
            commit: HUMAN_COMMIT,
            firstParent: FIRST_PARENT,
            rawDiff: NETTG_DIFF,
            removedRules: [],
            candidates: [
                {
                    rule: 'nettg.pl##.banner',
                    syntaxKind: 'element_hiding',
                    filePath: 'BaseFilter/sections/foreign.txt',
                    repositoryEdit: 'extend_domains',
                    sourceRule: 'nettg.pl,morizon.pl,prawo.pl,polski-tenis.pl##.banner',
                },
                {
                    rule: '||nettg.pl/store-view/api/track-page-view',
                    syntaxKind: 'network',
                    filePath: 'SpywareFilter/sections/specific.txt',
                    repositoryEdit: 'insert',
                    sourceRule: '||nettg.pl/store-view/api/track-page-view',
                },
            ],
        });
    });

    it('preserves deletion-only rules separately from replayable added candidates', async () => {
        const diff = `diff --git a/EnglishFilter/sections/specific.txt b/EnglishFilter/sections/specific.txt
--- a/EnglishFilter/sections/specific.txt
+++ b/EnglishFilter/sections/specific.txt
@@ -1 +0,0 @@
-||obsolete.example^$domain=reporter.example
diff --git a/BaseFilter/sections/foreign.txt b/BaseFilter/sections/foreign.txt
--- a/BaseFilter/sections/foreign.txt
+++ b/BaseFilter/sections/foreign.txt
@@ -1,0 +2 @@
+reporter.example##.ad
`;
        const git: HumanCommitGitReader = {
            readParents: async () => [FIRST_PARENT],
            readDiff: async () => diff,
        };

        const fix = await extractHumanCommitFix(HUMAN_COMMIT, git);

        expect(fix.rawDiff).toBe(diff);
        expect(fix.removedRules).toEqual([
            {
                rule: '||obsolete.example^$domain=reporter.example',
                syntaxKind: 'network',
                filePath: 'EnglishFilter/sections/specific.txt',
            },
        ]);
        expect(fix.candidates).toHaveLength(1);
    });

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

    it('rejects missing parents, malformed SHAs, and commits without rule candidates', async () => {
        const missingParent: HumanCommitGitReader = {
            readParents: async () => [],
            readDiff: vi.fn(),
        };
        await expect(extractHumanCommitFix(HUMAN_COMMIT, missingParent)).rejects.toThrow(
            /first parent/i,
        );
        await expect(extractHumanCommitFix('short', missingParent)).rejects.toThrow(
            /40-character/i,
        );

        const commentsOnly: HumanCommitGitReader = {
            readParents: async () => [FIRST_PARENT],
            readDiff: async () => `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -0,0 +1 @@
+! comment only
`,
        };
        await expect(extractHumanCommitFix(HUMAN_COMMIT, commentsOnly)).rejects.toThrow(
            /no actionable filter rules/i,
        );
    });
});
