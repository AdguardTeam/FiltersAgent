import { execFileSync } from 'node:child_process';
import {
    mkdtempSync,
    mkdirSync as createReviewCheckoutTestDirectory,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bindReviewCandidate } from '../../src/repo/repository-edit';
import type { CandidatePatch } from '../../src/types/fix-run-result';
import type { PreparedFiltersCheckout } from '../../src/local/filters-preparer';
import type { LocalRunRecord } from '../../src/local/run-output';
import { materializeReviewCheckout } from '../../src/local/review-checkout';

/**
 * Run Git in one test-owned repository.
 *
 * @param cwd - Repository path.
 * @param args - Git arguments.
 * @returns UTF-8 stdout.
 */
function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/**
 * Create an exact temporary source with history, tag, staged and unstaged operator state.
 *
 * @returns Test source fixture.
 */
function createSourceFixture(): {
    root: string;
    source: PreparedFiltersCheckout;
    filePath: string;
    commit: string;
} {
    const root = mkdtempSync(join(tmpdir(), 'review-checkout-'));
    const sourcePath = join(root, 'source');
    const filePath = 'BaseFilter/sections/foreign.txt';
    createReviewCheckoutTestDirectory(join(sourcePath, 'BaseFilter/sections'), { recursive: true });
    git(sourcePath, 'init', '-q');
    for (const [index, content] of [
        '! old\n',
        '! header\nexample.com##.old\nlast.example##.last\n',
    ].entries()) {
        writeFileSync(join(sourcePath, filePath), content);
        git(sourcePath, 'add', '.');
        git(
            sourcePath,
            '-c',
            'user.name=Test',
            '-c',
            'user.email=test@example.invalid',
            'commit',
            '-qm',
            `fixture-${index}`,
        );
    }
    git(sourcePath, 'tag', 'must-not-copy');
    const commit = git(sourcePath, 'rev-parse', 'HEAD').trim();
    writeFileSync(join(sourcePath, 'staged-operator.txt'), 'staged\n');
    git(sourcePath, 'add', 'staged-operator.txt');
    writeFileSync(join(sourcePath, 'dirty-operator.txt'), 'dirty\n');
    return {
        root,
        filePath,
        commit,
        source: {
            checkoutPath: sourcePath,
            filtersPath: sourcePath,
            provenance: {
                environment: 'current',
                source: 'local-shared-clone',
                sourceLocation: sourcePath,
                requestedRevision: commit,
                commit,
            },
        },
    };
}

/**
 * Capture all source state that review publication must preserve.
 *
 * @param sourcePath - Test-owned source repository.
 * @returns Stable source state fingerprint.
 */
function sourceFingerprint(sourcePath: string): string {
    return [
        git(sourcePath, 'rev-parse', 'HEAD'),
        git(sourcePath, 'symbolic-ref', 'HEAD'),
        git(sourcePath, 'status', '--porcelain=v2', '--untracked-files=all'),
        git(sourcePath, 'diff', '--binary'),
        git(sourcePath, 'diff', '--cached', '--binary'),
        git(sourcePath, 'show-ref'),
    ].join('\0');
}

/**
 * Build the immutable binder-visible run record.
 *
 * @param commit - Exact source commit.
 * @param candidate - Candidate under test.
 * @returns Minimal record accepted by the binding boundary.
 */
function bindingRecord(commit: string, candidate: CandidatePatch): LocalRunRecord {
    return {
        result: { filtersBaseSha: commit, candidatePatch: candidate, runStatus: 'patch_proposed' },
    } as LocalRunRecord;
}

describe('materializeReviewCheckout', () => {
    it.each([
        [
            'add',
            {
                rule: 'middle.example##.new',
                ruleType: 'cosmetic',
                filePath: 'BaseFilter/sections/foreign.txt',
                repositoryEdit: {
                    kind: 'insert',
                    insertionPoint: 2,
                    anchorRule: 'last.example##.last',
                },
            },
            'middle.example##.new',
        ],
        [
            'edit',
            {
                rule: 'example.com##.new',
                ruleType: 'cosmetic',
                filePath: 'BaseFilter/sections/foreign.txt',
                repositoryEdit: {
                    kind: 'replace',
                    line: 2,
                    originalRule: 'example.com##.old',
                    replacementRule: 'example.com##.new',
                },
            },
            'example.com##.new',
        ],
        [
            'remove',
            {
                rule: 'example.com##.old',
                ruleType: 'cosmetic',
                filePath: 'BaseFilter/sections/foreign.txt',
                repositoryEdit: {
                    kind: 'remove',
                    line: 2,
                    originalRule: 'example.com##.old',
                },
            },
            '! header\nlast.example##.last',
        ],
        [
            'exception add',
            {
                rule: '@@||ads.example.net^$domain=example.com',
                ruleType: 'network',
                filePath: 'BaseFilter/sections/foreign.txt',
                repositoryEdit: {
                    kind: 'insert',
                    insertionPoint: 2,
                    anchorRule: 'last.example##.last',
                },
            },
            '@@||ads.example.net^$domain=example.com',
        ],
        [
            'shared-rule extension',
            {
                rule: 'nettg.example##.old',
                ruleType: 'cosmetic',
                filePath: 'BaseFilter/sections/foreign.txt',
                repositoryEdit: {
                    kind: 'extend_domains',
                    line: 2,
                    originalRule: 'example.com##.old',
                    replacementRule: 'nettg.example,example.com##.old',
                },
            },
            'nettg.example,example.com##.old',
        ],
    ] as const)(
        'creates a standalone exact %s checkout without touching source state',
        (_kind, rawCandidate, expected) => {
            const fixture = createSourceFixture();
            const candidate = rawCandidate as CandidatePatch;
            const before = sourceFingerprint(fixture.source.checkoutPath);
            const binding = bindReviewCandidate(
                candidate,
                fixture.source,
                bindingRecord(fixture.commit, candidate),
            );
            expect(binding.kind).toBe('bound');
            if (binding.kind !== 'bound') {
                throw new Error('Expected a bound candidate.');
            }

            const checkoutPath = join(fixture.root, 'publication', 'review');
            const materialized = materializeReviewCheckout({
                candidate: binding.candidate,
                source: fixture.source,
                checkoutPath,
                createdAt: '2026-07-24T00:00:00.000Z',
            });

            expect(sourceFingerprint(fixture.source.checkoutPath)).toBe(before);
            expect(readFileSync(join(checkoutPath, fixture.filePath), 'utf8')).toContain(expected);
            expect(git(checkoutPath, 'diff', '--binary', '--no-ext-diff', '--no-textconv')).toBe(
                materialized.patch.toString('utf8'),
            );
            expect(git(checkoutPath, 'diff', '--cached')).toBe('');
            expect(git(checkoutPath, 'branch', '--show-current')).toBe('');
            expect(git(checkoutPath, 'remote')).toBe('');
            expect(git(checkoutPath, 'tag')).toBe('');
            expect(git(checkoutPath, 'rev-list', '--count', 'HEAD').trim()).toBe('1');
            expect(materialized.receipt).toMatchObject({
                checkoutPath: 'review',
                sourceCommit: fixture.commit,
                headCommit: fixture.commit,
                changedPath: fixture.filePath,
                cleanupEligible: true,
            });

            rmSync(fixture.source.checkoutPath, { recursive: true, force: true });
            expect(git(checkoutPath, 'status', '--porcelain')).toBe(` M ${fixture.filePath}\n`);
            expect(git(checkoutPath, 'diff', '--binary')).toBe(materialized.patch.toString('utf8'));
            rmSync(fixture.root, { recursive: true, force: true });
        },
    );

    it('writes a declared placement comment directly above the appended rule', () => {
        const fixture = createSourceFixture();
        const candidate: CandidatePatch = {
            rule: 'middle.example##.new',
            ruleType: 'cosmetic',
            filePath: fixture.filePath,
            repositoryEdit: {
                kind: 'insert',
                basis: 'append_eof',
                precedingComment: '! https://github.com/owner/repo/issues/42',
            },
        };
        const binding = bindReviewCandidate(
            candidate,
            fixture.source,
            bindingRecord(fixture.commit, candidate),
        );
        if (binding.kind !== 'bound') {
            throw new Error('Expected a bound candidate.');
        }

        const checkoutPath = join(fixture.root, 'publication', 'review');
        materializeReviewCheckout({
            candidate: binding.candidate,
            source: fixture.source,
            checkoutPath,
            createdAt: '2026-07-24T00:00:00.000Z',
        });

        expect(readFileSync(join(checkoutPath, fixture.filePath), 'utf8')).toBe(
            '! header\nexample.com##.old\nlast.example##.last\n' +
                '! https://github.com/owner/repo/issues/42\nmiddle.example##.new\n',
        );

        rmSync(fixture.root, { recursive: true, force: true });
    });

    it('fails before exposing a checkout when the bound source preimage becomes stale', () => {
        const fixture = createSourceFixture();
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
        const binding = bindReviewCandidate(
            candidate,
            fixture.source,
            bindingRecord(fixture.commit, candidate),
        );
        if (binding.kind !== 'bound') {
            throw new Error('Expected a bound candidate.');
        }
        writeFileSync(join(fixture.source.checkoutPath, fixture.filePath), 'changed\n');

        expect(() =>
            materializeReviewCheckout({
                candidate: binding.candidate,
                source: fixture.source,
                checkoutPath: join(fixture.root, 'publication', 'review'),
                createdAt: '2026-07-24T00:00:00.000Z',
            }),
        ).toThrow(/preimage/i);
    });
});
