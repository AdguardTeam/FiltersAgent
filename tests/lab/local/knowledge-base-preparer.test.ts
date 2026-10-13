import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RuleGuidanceSourceKind } from '../../../src/knowledge/guidance-source';
import type { PreparedFiltersCheckout } from '../../../src/local/filters-preparer';
import { withPreparedKnowledgeBase } from '../../../lab/local/knowledge-base-preparer';
import type { KnowledgeBasePreparationConfig } from '../../../src/local/run-config-types';

function createRepository(): { path: string; commit: string } {
    const path = mkdtempSync(join(tmpdir(), 'knowledge-source-'));
    mkdirSync(join(path, 'docs', 'general', 'ad-filtering'), { recursive: true });
    writeFileSync(
        join(path, 'docs', 'general', 'ad-filtering', 'create-own-filters.md'),
        '### Element hiding rules {#cosmetic-elemhide-rules}\nUse ##.\n',
    );
    writeFileSync(
        join(path, 'docs', 'general', 'ad-filtering', 'filter-policy.md'),
        '## Common criteria\nDo not break pages.\n',
    );
    writeFileSync(join(path, 'private.md'), 'must not be checked out\n');
    execFileSync('git', ['init', '-q'], { cwd: path });
    execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: path });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: path });
    execFileSync('git', ['add', '.'], { cwd: path });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: path });
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: path,
        encoding: 'utf8',
    }).trim();
    return { path, commit };
}

function createFiltersCheckout(): PreparedFiltersCheckout {
    const checkoutPath = mkdtempSync(join(tmpdir(), 'filters-source-'));
    writeFileSync(join(checkoutPath, 'CONTRIBUTING.md'), '## Repository structure\nPlacement.\n');
    return {
        filtersPath: checkoutPath,
        checkoutPath,
        provenance: {
            environment: 'historical',
            source: 'local-shared-clone',
            sourceLocation: checkoutPath,
            requestedRevision: '2'.repeat(40),
            commit: '2'.repeat(40),
        },
    };
}

function config(path: string, commit: string): KnowledgeBasePreparationConfig {
    return {
        environment: { kind: 'pinned', commit },
        localSourcePath: path,
        remoteUrl: path,
        knowledgeBaseRepository: 'kb-owner/knowledge-base',
        filtersRepository: 'filters-owner/adguard-filters',
        currentRef: 'master',
        keepTemporaryFiles: false,
    };
}

describe('withPreparedKnowledgeBase', () => {
    it('resolves current documentation from the configured remote branch head', async () => {
        const source = createRepository();
        const filters = createFiltersCheckout();
        const currentRef = execFileSync('git', ['branch', '--show-current'], {
            cwd: source.path,
            encoding: 'utf8',
        }).trim();
        const currentConfig: KnowledgeBasePreparationConfig = {
            environment: { kind: 'current' },
            localSourcePath: source.path,
            remoteUrl: source.path,
            knowledgeBaseRepository: 'kb-owner/knowledge-base',
            filtersRepository: 'filters-owner/adguard-filters',
            currentRef,
            keepTemporaryFiles: false,
        };

        const provenance = await withPreparedKnowledgeBase(
            currentConfig,
            filters,
            async (prepared) => prepared.provenance,
        );

        expect(provenance).toMatchObject({
            environment: 'current',
            requestedRevision: currentRef,
            commit: source.commit,
        });
    });

    it('uses a detached sparse checkout, preserves the source, and exposes only allowed docs', async () => {
        const source = createRepository();
        const filters = createFiltersCheckout();
        writeFileSync(join(source.path, 'untracked-local.txt'), 'keep me\n');
        const beforeStatus = execFileSync('git', ['status', '--short'], {
            cwd: source.path,
            encoding: 'utf8',
        });

        const observed = await withPreparedKnowledgeBase(
            config(source.path, source.commit),
            filters,
            async (prepared) => ({
                provenance: prepared.provenance,
                syntax: readFileSync(prepared.guidanceSource.syntaxPath, 'utf8'),
                policy: readFileSync(prepared.guidanceSource.policyPath, 'utf8'),
                privatePresent: existsSync(join(prepared.checkoutPath, 'private.md')),
                contributingPath: prepared.guidanceSource.contributingPath,
            }),
        );

        const afterStatus = execFileSync('git', ['status', '--short'], {
            cwd: source.path,
            encoding: 'utf8',
        });
        expect(afterStatus).toBe(beforeStatus);
        expect(observed.syntax).toContain('Use ##.');
        expect(observed.policy).toContain('Do not break pages.');
        expect(observed.privatePresent).toBe(false);
        expect(observed.contributingPath).toBe(join(filters.filtersPath, 'CONTRIBUTING.md'));
        expect(observed.provenance).toMatchObject({
            environment: 'pinned',
            source: 'local-shared-clone',
            requestedRevision: source.commit,
            commit: source.commit,
            filtersCommit: filters.provenance.commit,
            documents: [
                'docs/general/ad-filtering/create-own-filters.md',
                'docs/general/ad-filtering/filter-policy.md',
                'CONTRIBUTING.md',
            ],
        });
    });

    it('rejects a pinned SHA mismatch before invoking the consumer', async () => {
        const source = createRepository();
        const filters = createFiltersCheckout();
        let called = false;

        await expect(
            withPreparedKnowledgeBase(config(source.path, 'f'.repeat(40)), filters, async () => {
                called = true;
            }),
        ).rejects.toThrow(/knowledgebase/i);
        expect(called).toBe(false);
    });

    it('falls back to a shallow remote clone when the local source is unavailable', async () => {
        const source = createRepository();
        const filters = createFiltersCheckout();
        const remoteConfig: KnowledgeBasePreparationConfig = {
            ...config('/missing/knowledge-base', source.commit),
            remoteUrl: source.path,
        };

        const provenance = await withPreparedKnowledgeBase(
            remoteConfig,
            filters,
            async (prepared) => prepared.provenance,
        );

        expect(provenance).toMatchObject({
            source: 'remote-shallow-clone',
            sourceLocation: source.path,
            commit: source.commit,
        });
    });

    it('carries the configured citation repositories into the guidance source', async () => {
        const source = createRepository();
        const filters = createFiltersCheckout();

        const guidanceSource = await withPreparedKnowledgeBase(
            config(source.path, source.commit),
            filters,
            async (prepared) => prepared.guidanceSource,
        );

        expect(guidanceSource).toMatchObject({
            kind: RuleGuidanceSourceKind.KnowledgeBase,
            knowledgeBaseCommit: source.commit,
            filtersCommit: filters.provenance.commit,
            knowledgeBaseRepository: 'kb-owner/knowledge-base',
            filtersRepository: 'filters-owner/adguard-filters',
        });
    });

    it.each([
        { label: 'knowledgeBaseRepository', value: 'knowledge-base' },
        { label: 'filtersRepository', value: 'https://github.com/filters-owner/adguard-filters' },
    ])(
        'rejects a $label that does not name an owner/repo before cloning',
        async ({ label, value }) => {
            const source = createRepository();
            const filters = createFiltersCheckout();
            let called = false;

            await expect(
                withPreparedKnowledgeBase(
                    { ...config(source.path, source.commit), [label]: value },
                    filters,
                    async () => {
                        called = true;
                    },
                ),
            ).rejects.toThrow(/owner\/repo/i);
            expect(called).toBe(false);
        },
    );
});
