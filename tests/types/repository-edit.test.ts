import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { RepositoryEditSchema, type InsertRepositoryEdit } from '../../src/types/repository-edit';

describe('RepositoryEditSchema', () => {
    it.each([
        {
            kind: 'replace',
            line: 2,
            originalRule: 'example.com##.old',
            replacementRule: 'example.com##.new',
        },
        {
            kind: 'remove',
            line: 2,
            originalRule: 'example.com##.old',
        },
    ])('accepts an exact $kind source edit', (edit) => {
        expect(v.parse(RepositoryEditSchema, edit)).toEqual(edit);
    });

    it('rejects multiline exact source edits', () => {
        expect(() =>
            v.parse(RepositoryEditSchema, {
                kind: 'remove',
                line: 1,
                originalRule: 'one\ntwo',
            }),
        ).toThrow();
    });

    it.each([{ basis: 'domain_block' }, { basis: 'terminal_section' }])(
        'still parses insert edits written with the $basis basis',
        (edit) => {
            expect(v.parse(RepositoryEditSchema, { kind: 'insert', ...edit })).toEqual({
                kind: 'insert',
                ...edit,
            });
        },
    );

    it('parses a chosen-line insert with the agent-chosen heading', () => {
        const edit: InsertRepositoryEdit = {
            kind: 'insert',
            insertionPoint: 4,
            anchorRule: 'example.com##.old',
            basis: 'chosen_line',
            heading: '! NOTE: Regular rules',
        };

        expect(v.parse(RepositoryEditSchema, edit)).toEqual(edit);
    });

    it('keeps parsing a result written with the legacy section field', () => {
        // Earlier builds named the same value `section`; a locked result carrying it must still
        // parse and keep it, so every renderer can fall back to it.
        const edit = {
            kind: 'insert',
            insertionPoint: 4,
            anchorRule: 'example.com##.old',
            basis: 'chosen_line',
            section: '! NOTE: Regular rules',
        };

        expect(v.parse(RepositoryEditSchema, edit)).toEqual(edit);
    });

    it('refuses a blank or multi-line heading and legacy section', () => {
        for (const field of ['heading', 'section']) {
            for (const value of ['   ', '\t', 'one\ntwo']) {
                expect(() =>
                    v.parse(RepositoryEditSchema, {
                        kind: 'insert',
                        basis: 'chosen_line',
                        [field]: value,
                    }),
                ).toThrow();
            }
        }
    });

    it('refuses a blank or multi-line end-of-file reason', () => {
        for (const reason of ['', '   ', '\t', 'one\ntwo']) {
            expect(() =>
                v.parse(RepositoryEditSchema, {
                    kind: 'insert',
                    basis: 'append_eof',
                    reason,
                }),
            ).toThrow();
        }
    });

    it('keeps the reason verbatim rather than trimming it', () => {
        const reason = 'No section keeps rules of this kind.  ';
        const parsed = v.parse(RepositoryEditSchema, {
            kind: 'insert',
            basis: 'append_eof',
            reason,
        });

        expect(parsed).toMatchObject({ reason });
    });

    it('parses an optional single-line placement condition', () => {
        const edit = {
            kind: 'insert',
            insertionPoint: 4,
            anchorRule: 'example.com##.old',
            basis: 'chosen_line',
            heading: '! NOTE: Regular rules',
            condition: '!#if (adguard_ext_android_cb)',
        };

        expect(v.parse(RepositoryEditSchema, edit)).toEqual(edit);
        expect(
            v.parse(RepositoryEditSchema, { kind: 'insert', basis: 'append_eof' }),
        ).not.toHaveProperty('condition');
    });

    it('refuses a blank or multi-line placement condition', () => {
        for (const condition of ['', '   ', '\t', 'one\ntwo']) {
            expect(() =>
                v.parse(RepositoryEditSchema, {
                    kind: 'insert',
                    basis: 'append_eof',
                    condition,
                }),
            ).toThrow();
        }
    });

    it('parses an insert edit anchored on a blank line', () => {
        // A chosen line may be a blank one; the blank anchor keeps the stale guard.
        const edit: InsertRepositoryEdit = {
            kind: 'insert',
            insertionPoint: 2,
            anchorRule: '',
            basis: 'chosen_line',
        };

        expect(v.parse(RepositoryEditSchema, edit)).toEqual(edit);
    });
});
