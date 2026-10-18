import { describe, expect, it, vi } from 'vitest';
import {
    extractHumanCommitFix,
    readHumanCommitRuleLines,
    type HumanCommitGitReader,
} from '../../../lab/e2e/human-commit-reader';

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

describe('human commit git reader', () => {
    it('uses the first parent and extracts every added filter change with file/edit metadata', async () => {
        const git: HumanCommitGitReader = {
            readParents: vi.fn().mockResolvedValue([FIRST_PARENT, SECOND_PARENT]),
            readDiff: vi.fn().mockResolvedValue(NETTG_DIFF),
        };

        const fix = await extractHumanCommitFix(HUMAN_COMMIT, git);

        expect(git.readParents).toHaveBeenCalledWith(HUMAN_COMMIT);
        expect(git.readDiff).toHaveBeenCalledWith(FIRST_PARENT, HUMAN_COMMIT);
        expect(fix).toEqual({
            firstParent: FIRST_PARENT,
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

        expect(fix.removedRules).toEqual([
            {
                rule: '||obsolete.example^$domain=reporter.example',
                syntaxKind: 'network',
                filePath: 'EnglishFilter/sections/specific.txt',
            },
        ]);
        expect(fix.candidates).toHaveLength(1);
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

    it('reads the rule lines of the first-parent diff through the git reader', async () => {
        const git: HumanCommitGitReader = {
            readParents: vi.fn().mockResolvedValue([FIRST_PARENT, SECOND_PARENT]),
            readDiff: vi.fn().mockResolvedValue(NETTG_DIFF),
        };

        const lines = await readHumanCommitRuleLines(HUMAN_COMMIT, git);

        expect(git.readParents).toHaveBeenCalledWith(HUMAN_COMMIT);
        expect(git.readDiff).toHaveBeenCalledWith(FIRST_PARENT, HUMAN_COMMIT);
        expect(lines).toEqual({
            added: [
                'nettg.pl,morizon.pl,prawo.pl,polski-tenis.pl##.banner',
                '||nettg.pl/store-view/api/track-page-view',
            ],
            removed: ['morizon.pl,prawo.pl,polski-tenis.pl##.banner'],
        });
    });
});
