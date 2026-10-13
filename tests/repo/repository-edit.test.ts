import {
    lstatSync,
    mkdtempSync,
    mkdirSync,
    readFileSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
    applyRepositoryEdit,
    bindReviewCandidate,
    inspectBoundReviewCandidate,
    planRepositoryEdit,
} from '../../src/repo/repository-edit';
import type { PreparedFiltersCheckout } from '../../src/local/filters-preparer';
import type { LocalRunRecord } from '../../src/local/run-output';
import type { CandidatePatch } from '../../src/types/fix-run-result';

/**
 * Run Git in one test-owned repository.
 *
 * @param cwd - Repository path.
 * @param args - Git arguments.
 * @returns UTF-8 standard output.
 */
function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/**
 * Commit every present file and report the exact resulting commit.
 *
 * @param checkout - Repository path.
 * @param message - Commit message.
 * @returns Full commit SHA now at HEAD.
 */
function commitAll(checkout: string, message: string): string {
    git(checkout, 'add', '-A');
    git(
        checkout,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '-qm',
        message,
    );
    return git(checkout, 'rev-parse', 'HEAD').trim();
}

/**
 * Describe one committed checkout as the prepared snapshot a run is pinned to.
 *
 * @param checkout - Repository path.
 * @param commit - Exact commit the run recorded as its pin.
 * @returns Prepared checkout carrying that provenance.
 */
function preparedAt(checkout: string, commit: string): PreparedFiltersCheckout {
    return {
        checkoutPath: checkout,
        filtersPath: checkout,
        provenance: {
            environment: 'current',
            source: 'local-shared-clone',
            sourceLocation: checkout,
            requestedRevision: commit,
            commit,
        },
    };
}

/**
 * Create a standalone exact source repository fixture owned by this test.
 *
 * @returns Prepared source and commit identity for binding tests.
 */
function createBindingFixture(): {
    source: PreparedFiltersCheckout;
    filePath: string;
    commit: string;
} {
    const checkout = mkdtempSync(join(tmpdir(), 'repository-binding-'));
    const filePath = 'BaseFilter/sections/foreign.txt';
    mkdirSync(join(checkout, 'BaseFilter/sections'), { recursive: true });
    writeFileSync(
        join(checkout, filePath),
        ['! header', 'example.com##.old', 'last.example##.last', ''].join('\n'),
    );
    git(checkout, 'init', '-q');
    const commit = commitAll(checkout, 'fixture');
    return { filePath, commit, source: preparedAt(checkout, commit) };
}

/**
 * Build the binder-visible portion of an immutable local run record.
 *
 * @param commit - Exact source commit selected by the run.
 * @param candidate - Exact candidate carried by the run.
 * @returns Record fixture for the public binding boundary.
 */
function bindingRecord(commit: string, candidate: CandidatePatch | null): LocalRunRecord {
    return {
        result: {
            filtersBaseSha: commit,
            candidatePatch: candidate,
            runStatus: candidate ? 'patch_proposed' : 'not_reproduced',
        },
    } as LocalRunRecord;
}

describe('bindReviewCandidate', () => {
    it('binds add, edit, and remove to the exact source blob and preimage', () => {
        const fixture = createBindingFixture();
        const sourceBytes = readFileSync(join(fixture.source.checkoutPath, fixture.filePath));
        const targetFileSha256 = createHash('sha256').update(sourceBytes).digest('hex');
        const candidates: CandidatePatch[] = [
            {
                rule: 'middle.example##.new',
                ruleType: 'cosmetic',
                filePath: fixture.filePath,
                repositoryEdit: {
                    kind: 'insert',
                    insertionPoint: 2,
                    anchorRule: 'last.example##.last',
                },
            },
            {
                rule: 'example.com##.new',
                ruleType: 'cosmetic',
                filePath: fixture.filePath,
                repositoryEdit: {
                    kind: 'replace',
                    line: 2,
                    originalRule: 'example.com##.old',
                    replacementRule: 'example.com##.new',
                },
            },
            {
                rule: 'example.com##.old',
                ruleType: 'cosmetic',
                filePath: fixture.filePath,
                repositoryEdit: {
                    kind: 'remove',
                    line: 2,
                    originalRule: 'example.com##.old',
                },
            },
        ];

        const operations = candidates.map((candidate) => {
            const outcome = bindReviewCandidate(
                candidate,
                fixture.source,
                bindingRecord(fixture.commit, candidate),
            );
            expect(outcome.kind).toBe('bound');
            if (outcome.kind !== 'bound') {
                throw new Error('Expected a bound candidate.');
            }
            return inspectBoundReviewCandidate(outcome.candidate);
        });

        expect(operations.map((operation) => operation.operation)).toEqual([
            'add',
            'edit',
            'remove',
        ]);
        expect(operations.every((operation) => operation.sourceCommit === fixture.commit)).toBe(
            true,
        );
        expect(
            operations.every((operation) => operation.targetFileSha256 === targetFileSha256),
        ).toBe(true);
        expect(operations[0]).toMatchObject({
            line: 3,
            beforeLine: 'example.com##.old',
            afterLine: 'last.example##.last',
        });
    });

    it('fails closed on source drift, linked targets, and forged opaque values without leaking paths', () => {
        const fixture = createBindingFixture();
        const candidate: CandidatePatch = {
            rule: 'example.com##.new',
            ruleType: 'cosmetic',
            filePath: fixture.filePath,
            repositoryEdit: {
                kind: 'replace',
                line: 2,
                originalRule: 'example.com##.old',
                replacementRule: 'example.com##.new',
            },
        };
        const mismatch = bindReviewCandidate(
            candidate,
            fixture.source,
            bindingRecord('f'.repeat(40), candidate),
        );
        expect(mismatch).toMatchObject({
            kind: 'failed',
            failure: { code: 'source_commit_mismatch', stage: 'candidate_binding' },
        });
        expect(JSON.stringify(mismatch)).not.toContain(fixture.source.checkoutPath);

        const linkedPath = 'BaseFilter/sections/linked.txt';
        symlinkSync(
            join(fixture.source.checkoutPath, fixture.filePath),
            join(fixture.source.checkoutPath, linkedPath),
        );
        const linkedCandidate = { ...candidate, filePath: linkedPath };
        expect(
            bindReviewCandidate(
                linkedCandidate,
                fixture.source,
                bindingRecord(fixture.commit, linkedCandidate),
            ),
        ).toMatchObject({ kind: 'failed', failure: { code: 'unsafe_target' } });
        expect(lstatSync(join(fixture.source.checkoutPath, linkedPath)).isSymbolicLink()).toBe(
            true,
        );

        expect(() => inspectBoundReviewCandidate({} as never)).toThrow(/opaque/i);
    });

    it('returns a typed legitimate disposition when no candidate was produced', () => {
        const fixture = createBindingFixture();
        expect(
            bindReviewCandidate(null, fixture.source, bindingRecord(fixture.commit, null)),
        ).toEqual({
            kind: 'not_applicable',
            disposition: 'not_verified',
        });
    });
});

describe('planRepositoryEdit', () => {
    it('extends the unique multi-domain selector rule across domain suffixes', () => {
        const checkout = mkdtempSync(join(tmpdir(), 'repository-edit-'));
        const filePath = 'BaseFilter/sections/foreign.txt';
        mkdirSync(join(checkout, 'BaseFilter/sections'), { recursive: true });
        writeFileSync(
            join(checkout, filePath),
            ['example.de,news.com##.banner', '! Footer', ''].join('\n'),
        );

        expect(planRepositoryEdit(checkout, filePath, 'nettg.pl##.banner')).toEqual({
            filePath,
            edit: {
                kind: 'extend_domains',
                line: 1,
                originalRule: 'example.de,news.com##.banner',
                replacementRule: 'nettg.pl,example.de,news.com##.banner',
            },
        });
    });

    it('refuses a chosen file the checkout does not hold, naming it', () => {
        const checkout = mkdtempSync(join(tmpdir(), 'repository-edit-'));
        mkdirSync(join(checkout, 'BaseFilter/sections'), { recursive: true });
        // The shared rule elsewhere is not a place the planner moves the edit to: the agent chose
        // the file, and a file that is not there is refused so the agent can choose again.
        writeFileSync(
            join(checkout, 'BaseFilter/sections/foreign.txt'),
            'morizon.pl,prawo.pl,telepolis.pl##.banner\n',
        );

        expect(() =>
            planRepositoryEdit(checkout, 'BaseFilter/sections/missing.txt', 'nettg.pl##.banner'),
        ).toThrow(/BaseFilter\/sections\/missing\.txt/);
    });

    it('extends the unique shared network rule domain list with the reported site', () => {
        // Maintainers fix CMP banners at the platform: one `||cmp-host^$domain=…` line shared
        // by many sites (cs.iubenda.com, cmp.inmobi.com, team.epccm19.com live examples).
        const checkout = mkdtempSync(join(tmpdir(), 'repository-edit-'));
        const filePath = 'AnnoyancesFilter/Cookies/sections/cookies_specific.txt';
        mkdirSync(join(checkout, 'AnnoyancesFilter/Cookies/sections'), { recursive: true });
        writeFileSync(
            join(checkout, filePath),
            ['||cs.iubenda.com^$domain=a.it|b.it', '! Footer', ''].join('\n'),
        );

        expect(
            planRepositoryEdit(checkout, filePath, '||cs.iubenda.com^$domain=reported.test'),
        ).toEqual({
            filePath,
            edit: {
                kind: 'extend_domains',
                line: 1,
                originalRule: '||cs.iubenda.com^$domain=a.it|b.it',
                replacementRule: '||cs.iubenda.com^$domain=reported.test|a.it|b.it',
            },
        });
    });

    it('does not extend a network rule whose other modifiers differ from the candidate', () => {
        const checkout = mkdtempSync(join(tmpdir(), 'repository-edit-'));
        const filePath = 'AnnoyancesFilter/Cookies/sections/cookies_specific.txt';
        mkdirSync(join(checkout, 'AnnoyancesFilter/Cookies/sections'), { recursive: true });
        writeFileSync(join(checkout, filePath), '||cs.iubenda.com^$script,domain=a.it|b.it\n');

        expect(
            planRepositoryEdit(checkout, filePath, '||cs.iubenda.com^$domain=reported.test'),
        ).toEqual({ filePath, edit: { kind: 'insert', basis: 'append_eof' } });
    });

    it('extends the unique shared scriptlet family with the reported site', () => {
        const checkout = mkdtempSync(join(tmpdir(), 'repository-edit-'));
        const filePath = 'AnnoyancesFilter/Cookies/sections/cookies_specific.txt';
        mkdirSync(join(checkout, 'AnnoyancesFilter/Cookies/sections'), { recursive: true });
        const family =
            "a.com,b.com#%#//scriptlet('set-local-storage-item', 'cookies-accepted', 'true')";
        writeFileSync(join(checkout, filePath), `${family}\n`);

        expect(
            planRepositoryEdit(
                checkout,
                filePath,
                "reported.test#%#//scriptlet('set-local-storage-item', 'cookies-accepted', 'true')",
            ),
        ).toEqual({
            filePath,
            edit: {
                kind: 'extend_domains',
                line: 1,
                originalRule: family,
                replacementRule: `reported.test,${family}`,
            },
        });
    });

    it('does not extend a rule with a different syntax kind', () => {
        const checkout = mkdtempSync(join(tmpdir(), 'repository-edit-'));
        const filePath = 'foreign.txt';
        writeFileSync(join(checkout, filePath), 'one.pl,two.pl##.banner\n');

        expect(
            planRepositoryEdit(
                checkout,
                filePath,
                'nettg.pl#$#.banner { min-height: 0 !important; }',
            ),
        ).toEqual({ filePath, edit: { kind: 'insert', basis: 'append_eof' } });
    });

    it('ignores matching selector groups outside the model-selected filter scope', () => {
        const checkout = mkdtempSync(join(tmpdir(), 'repository-edit-'));
        const filePath = 'BaseFilter/sections/foreign.txt';
        const otherFilePath = 'AnnoyancesFilter/sections/other.txt';
        mkdirSync(join(checkout, 'BaseFilter/sections'), { recursive: true });
        mkdirSync(join(checkout, 'AnnoyancesFilter/sections'), { recursive: true });
        writeFileSync(join(checkout, filePath), 'one.pl,two.pl##.banner\n');
        writeFileSync(join(checkout, otherFilePath), 'three.de,four.com##.banner\n');

        expect(planRepositoryEdit(checkout, filePath, 'nettg.pl##.banner')).toMatchObject({
            filePath,
            edit: {
                kind: 'extend_domains',
                originalRule: 'one.pl,two.pl##.banner',
            },
        });
    });

    it('prefers an equivalent target-file expression from the candidate domain cohort', () => {
        const checkout = mkdtempSync(join(tmpdir(), 'repository-edit-'));
        const filePath = 'BaseFilter/sections/foreign.txt';
        mkdirSync(join(checkout, 'BaseFilter/sections'), { recursive: true });
        writeFileSync(
            join(checkout, filePath),
            [
                'one.ge,two.ge##.banner',
                'one.com,two.com##.banner',
                'morizon.pl,prawo.pl,wyniki.pl##.banner',
                'three.pl,four.com##.banner',
                '',
            ].join('\n'),
        );

        expect(planRepositoryEdit(checkout, filePath, 'nettg.pl##.banner')).toMatchObject({
            filePath,
            edit: {
                kind: 'extend_domains',
                originalRule: 'morizon.pl,prawo.pl,wyniki.pl##.banner',
            },
        });
    });

    it('inserts into the chosen file when only other files hold the selector', () => {
        const checkout = mkdtempSync(join(tmpdir(), 'repository-edit-'));
        const filePath = 'BaseFilter/sections/foreign.txt';
        mkdirSync(join(checkout, 'BaseFilter/sections'), { recursive: true });
        mkdirSync(join(checkout, 'AnnoyancesFilter/sections'), { recursive: true });
        mkdirSync(join(checkout, 'CyrillicFilters/RussianFilter/sections'), {
            recursive: true,
        });
        writeFileSync(join(checkout, filePath), '! No matching selector\n');
        writeFileSync(
            join(checkout, 'AnnoyancesFilter/sections/other.txt'),
            'one.pl,two.pl##.banner\n',
        );
        writeFileSync(
            join(checkout, 'CyrillicFilters/RussianFilter/sections/specific.txt'),
            'three.de,four.com##.banner\n',
        );

        expect(planRepositoryEdit(checkout, filePath, 'nettg.pl##.banner')).toEqual({
            filePath,
            edit: { kind: 'insert', basis: 'append_eof' },
        });
    });

    it('does not treat non-filter text files as repository rule sections', () => {
        const checkout = mkdtempSync(join(tmpdir(), 'repository-edit-'));
        const filePath = 'BaseFilter/sections/foreign.txt';
        mkdirSync(join(checkout, 'BaseFilter/sections'), { recursive: true });
        mkdirSync(join(checkout, 'docs'), { recursive: true });
        writeFileSync(join(checkout, filePath), '! Empty section\n');
        writeFileSync(join(checkout, 'docs/example.txt'), 'one.pl,two.pl##.banner\n');

        expect(planRepositoryEdit(checkout, filePath, 'nettg.pl##.banner')).toEqual({
            filePath,
            edit: { kind: 'insert', basis: 'append_eof' },
        });
    });

    it('inserts a new selector before the first rule in the reported-domain block', () => {
        const checkout = mkdtempSync(join(tmpdir(), 'repository-edit-'));
        const filePath = 'BaseFilter/sections/foreign.txt';
        const firstDomainRule = 'wpoznaniu.pl##.g-dyn > a:not([href*="wpoznaniu.pl"]) > img';
        mkdirSync(join(checkout, 'BaseFilter/sections'), { recursive: true });
        writeFileSync(
            join(checkout, filePath),
            [
                '! https://github.com/AdguardTeam/AdguardFilters/issues/109929',
                firstDomainRule,
                'wpoznaniu.pl##.g-single',
                '! Footer',
                '',
            ].join('\n'),
        );

        expect(
            planRepositoryEdit(checkout, filePath, 'wpoznaniu.pl##div[class^="inner-ads-header"]'),
        ).toEqual({
            filePath,
            edit: {
                kind: 'insert',
                insertionPoint: 1,
                anchorRule: firstDomainRule,
                basis: 'domain_block',
            },
        });
    });

    it('anchors an ordinary selector before the terminal fixing-other-filters banner', () => {
        const checkout = mkdtempSync(join(tmpdir(), 'repository-edit-'));
        const filePath = 'BaseFilter/sections/foreign.txt';
        const candidateRule = 'www.nebule.pl##.l-sec--commercial-banner';
        const content = [
            'last.example##.ordinary-rule',
            '!---------------------------------------------------------------------',
            '!------------------------------ Fixing other filters -----------------',
            '!---------------------------------------------------------------------',
            '! SECTION: Fixing other filters',
            '! AdGuard platforms related only',
            '!',
            '! NOTE: Fixing other filters end ⬆️',
            '! !SECTION: Fixing other filters',
            '',
        ].join('\n');
        mkdirSync(join(checkout, 'BaseFilter/sections'), { recursive: true });
        writeFileSync(join(checkout, filePath), content);

        const plan = planRepositoryEdit(checkout, filePath, candidateRule);

        expect(plan).toEqual({
            filePath,
            edit: {
                kind: 'insert',
                insertionPoint: 1,
                anchorRule:
                    '!---------------------------------------------------------------------',
                basis: 'terminal_section',
            },
        });
        expect(applyRepositoryEdit(content, candidateRule, plan.edit)).toBe(
            [
                'last.example##.ordinary-rule',
                candidateRule,
                '!---------------------------------------------------------------------',
                '!------------------------------ Fixing other filters -----------------',
                '!---------------------------------------------------------------------',
                '! SECTION: Fixing other filters',
                '! AdGuard platforms related only',
                '!',
                '! NOTE: Fixing other filters end ⬆️',
                '! !SECTION: Fixing other filters',
                '',
            ].join('\n'),
        );
    });

    it('keeps a generic insert inside an intended terminal regular-rules section', () => {
        const checkout = mkdtempSync(join(tmpdir(), 'repository-edit-'));
        const filePath = 'MobileFilter/sections/specific_web.txt';
        const candidateRule = 'new.example##.mobile-ad';
        mkdirSync(join(checkout, 'MobileFilter/sections'), { recursive: true });
        writeFileSync(
            join(checkout, filePath),
            [
                '! SECTION: Regular rules',
                'existing.example##.mobile-ad',
                '! NOTE: Regular rules end ⬆️',
                '! !SECTION: Regular rules',
                '',
            ].join('\n'),
        );

        expect(planRepositoryEdit(checkout, filePath, candidateRule)).toEqual({
            filePath,
            edit: {
                kind: 'insert',
                insertionPoint: 2,
                anchorRule: '! NOTE: Regular rules end ⬆️',
                basis: 'terminal_section',
            },
        });
    });

    it('keeps a generic insert outside a specialized terminal section', () => {
        const checkout = mkdtempSync(join(tmpdir(), 'repository-edit-'));
        const filePath = 'BaseFilter/sections/specific.txt';
        const candidateRule = 'new.example##.article-ad';
        mkdirSync(join(checkout, 'BaseFilter/sections'), { recursive: true });
        writeFileSync(
            join(checkout, filePath),
            [
                'existing.example##.ordinary-ad',
                '!---------------- Ad-Shield ----------------',
                '! SECTION: Ad-Shield',
                'ad-shield.example##.special-case',
                '! !SECTION: Ad-Shield',
                '',
            ].join('\n'),
        );

        expect(planRepositoryEdit(checkout, filePath, candidateRule)).toEqual({
            filePath,
            edit: {
                kind: 'insert',
                insertionPoint: 1,
                anchorRule: '!---------------- Ad-Shield ----------------',
                basis: 'terminal_section',
            },
        });
    });

    it('does not join a same-domain block inside fixing-other-filters', () => {
        const checkout = mkdtempSync(join(tmpdir(), 'repository-edit-'));
        const filePath = 'BaseFilter/sections/foreign.txt';
        const candidateRule = 'www.nebule.pl##.ordinary-leftover';
        mkdirSync(join(checkout, 'BaseFilter/sections'), { recursive: true });
        writeFileSync(
            join(checkout, filePath),
            [
                'last.example##.ordinary-rule',
                '!---------------- Fixing other filters ----------------',
                '! SECTION: Fixing other filters',
                'www.nebule.pl##.extension-specific-workaround',
                '! !SECTION: Fixing other filters',
                '',
            ].join('\n'),
        );

        expect(planRepositoryEdit(checkout, filePath, candidateRule)).toEqual({
            filePath,
            edit: {
                kind: 'insert',
                insertionPoint: 1,
                anchorRule: '!---------------- Fixing other filters ----------------',
                basis: 'terminal_section',
            },
        });
    });

    it('does not move unsectioned terminal rules into an earlier closed section', () => {
        const checkout = mkdtempSync(join(tmpdir(), 'repository-edit-'));
        const filePath = 'BaseFilter/sections/specific.txt';
        mkdirSync(join(checkout, 'BaseFilter/sections'), { recursive: true });
        writeFileSync(
            join(checkout, filePath),
            [
                '! SECTION: Temporary',
                'old.example##.temporary',
                '! !SECTION: Temporary',
                'existing.example##.specific',
                '',
            ].join('\n'),
        );

        expect(planRepositoryEdit(checkout, filePath, 'new.example##.specific')).toEqual({
            filePath,
            edit: { kind: 'insert', basis: 'append_eof' },
        });
    });
});

describe('applyRepositoryEdit', () => {
    it('replaces only the exact locked source line for extend_domains', () => {
        const content = 'first\r\none.pl,two.pl##.banner\r\nlast\r\n';

        expect(
            applyRepositoryEdit(content, 'nettg.pl##.banner', {
                kind: 'extend_domains',
                line: 2,
                originalRule: 'one.pl,two.pl##.banner',
                replacementRule: 'nettg.pl,one.pl,two.pl##.banner',
            }),
        ).toBe('first\r\nnettg.pl,one.pl,two.pl##.banner\r\nlast\r\n');
    });

    it('rejects a stale domain-extension source line', () => {
        expect(() =>
            applyRepositoryEdit('different\n', 'nettg.pl##.banner', {
                kind: 'extend_domains',
                line: 1,
                originalRule: 'one.pl,two.pl##.banner',
                replacementRule: 'nettg.pl,one.pl,two.pl##.banner',
            }),
        ).toThrow(/stale/i);
    });

    it('inserts before an exact locked domain-block anchor', () => {
        const anchorRule = 'wpoznaniu.pl##.g-dyn';

        expect(
            applyRepositoryEdit(
                `! issue\n${anchorRule}\nwpoznaniu.pl##.g-single\n`,
                'wpoznaniu.pl##div[class^="inner-ads-header"]',
                {
                    kind: 'insert',
                    insertionPoint: 1,
                    anchorRule,
                },
            ),
        ).toBe(
            '! issue\nwpoznaniu.pl##div[class^="inner-ads-header"]\n' +
                `${anchorRule}\nwpoznaniu.pl##.g-single\n`,
        );
    });

    it('rejects a stale insertion anchor instead of moving the candidate', () => {
        expect(() =>
            applyRepositoryEdit('! issue\nwpoznaniu.pl##.changed\n', 'wpoznaniu.pl##.ad', {
                kind: 'insert',
                insertionPoint: 1,
                anchorRule: 'wpoznaniu.pl##.g-dyn',
            }),
        ).toThrow(/anchor/i);
    });
});

describe('a declared placement', () => {
    it('appends the rule at the end of the declared file behind the declared comment', () => {
        const checkout = mkdtempSync(join(tmpdir(), 'repository-edit-declared-'));
        const filePath = 'filters/filters-2026.txt';
        const candidateRule = 'sarkisozleri.bbs.tr##.ad-slot';
        const commentLine = '! https://github.com/uBlockOrigin/uAssets/issues/29471';
        // The file already holds a rule for the reported domain, which is what normally attracts
        // an insertion into that domain's block: a declared placement appends regardless, because
        // the repository that says where its rules go also says how they are added.
        const content = ['! Title: uBlock filters 2026', 'sarkisozleri.bbs.tr##.older-ad', ''].join(
            '\n',
        );
        mkdirSync(join(checkout, 'filters'), { recursive: true });
        writeFileSync(join(checkout, filePath), content);

        const plan = planRepositoryEdit(checkout, filePath, candidateRule, {
            byRuleType: {},
            unqualified: { filePath, commentLine },
        });

        expect(plan).toEqual({
            filePath,
            edit: { kind: 'insert', basis: 'append_eof', precedingComment: commentLine },
        });
        expect(applyRepositoryEdit(content, candidateRule, plan.edit)).toBe(
            [
                '! Title: uBlock filters 2026',
                'sarkisozleri.bbs.tr##.older-ad',
                commentLine,
                candidateRule,
                '',
            ].join('\n'),
        );
    });

    it('refuses to plan against a declared file the checkout does not hold, naming it', () => {
        const checkout = mkdtempSync(join(tmpdir(), 'repository-edit-declared-missing-'));

        expect(() =>
            planRepositoryEdit(checkout, 'filters/filters-2027.txt', 'example.com##.ad', {
                byRuleType: {},
                unqualified: { filePath: 'filters/filters-2027.txt' },
            }),
        ).toThrow(/filters\/filters-2027\.txt/);
    });

    it('refuses a file other than the one declared for the rule kind, naming both', () => {
        const checkout = mkdtempSync(join(tmpdir(), 'repository-edit-declared-other-'));
        mkdirSync(join(checkout, 'filters'), { recursive: true });
        writeFileSync(join(checkout, 'filters/filters-2026.txt'), '! Title: uBlock filters 2026\n');
        writeFileSync(
            join(checkout, 'filters/annoyances-cookies.txt'),
            '! Title: uBlock filters - Cookie notices\n',
        );

        expect(() =>
            planRepositoryEdit(checkout, 'filters/annoyances-cookies.txt', 'example.com##.ad', {
                byRuleType: {},
                unqualified: { filePath: 'filters/filters-2026.txt' },
            }),
        ).toThrow(/filters\/filters-2026\.txt.*filters\/annoyances-cookies\.txt/);
    });
});
