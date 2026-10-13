import importPlugin from 'eslint-plugin-import';
import stylistic from '@stylistic/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

/**
 * Custom rule: enforce multi-line JSDoc format.
 *
 * Single-line JSDoc (`/** text *​/`) is harder to maintain once tags or longer descriptions are
 * added. This rule auto-fixes to the block form with `*` prefix on each line.
 */
const localPlugin = {
    meta: { name: 'local' },
    rules: {
        'jsdoc-multiline': {
            meta: {
                type: 'layout',
                docs: { description: 'Enforce multi-line JSDoc comments.' },
                fixable: 'whitespace',
                messages: {
                    singleLine:
                        'JSDoc comment must use multi-line format. Use `/**` on its own line, `*` prefix for each content line, and `*​/` on its own line.',
                },
            },
            create(context) {
                return {
                    Program() {
                        for (const c of context.sourceCode.getAllComments()) {
                            if (c.type !== 'Block') {
                                continue;
                            }
                            if (!c.value.startsWith('*')) {
                                continue; // not JSDoc
                            }
                            if (c.loc.start.line !== c.loc.end.line) {
                                continue;
                            }

                            context.report({
                                loc: c.loc,
                                messageId: 'singleLine',
                                fix(fixer) {
                                    const text = c.value.slice(1).trim(); // strip leading * and whitespace
                                    const col = c.loc.start.column;
                                    const indent = ' '.repeat(col);
                                    return fixer.replaceText(
                                        c,
                                        `/**\n${indent} * ${text}\n${indent} */`,
                                    );
                                },
                            });
                        }
                    },
                };
            },
        },
    },
};

/**
 * ESLint config — only for rules oxlint doesn't implement. Run via `pnpm lint:eslint` or as part of
 * `pnpm lint`.
 *
 * Strategy:
 *
 * - Oxlint handles ~148 rules (correctness, suspicious, JS/TS style, jsdoc).
 * - Oxfmt owns general formatting (indent, trailing commas) on write.
 * - Eslint handles import-plugin rules, maximum-width import wrapping, and the custom
 *   `jsdoc-multiline` rule. Oxfmt remains the sole owner of general indentation and whether a
 *   within-width import is represented on one line.
 */
export default [
    // Apply to all source files.
    {
        files: ['src/**/*.ts', 'tests/**/*.ts', 'lab/**/*.ts'],
        languageOptions: {
            parser: tsParser,
            ecmaVersion: 2022,
            sourceType: 'module',
        },
        plugins: {
            import: importPlugin,
            '@stylistic': stylistic,
            local: localPlugin,
        },
        rules: {
            /**
             * Enforce multi-line JSDoc format.
             */
            'local/jsdoc-multiline': 'error',

            /**
             * Trailing comma on multi-line imports (matches oxfmt `trailingComma: "all"`).
             * `always-multiline` leaves single-line imports untouched, so it never conflicts.
             */
            '@stylistic/comma-dangle': ['error', 'always-multiline'],

            /**
             * Ban .js/.ts extensions in imports.
             */
            'import/extensions': [
                'error',
                'never',
                {
                    // Allow .json and other non-TS extensions if needed later.
                    json: 'always',
                },
            ],

            /**
             * Newline after the last import, before the first non-import line.
             */
            'import/newline-after-import': 'error',

            /**
             * Forbid duplicate imports from the same module.
             */
            'import/no-duplicates': 'error',

            /**
             * Forbid mutable exports (export let/var).
             */
            'import/no-mutable-exports': 'error',

            /**
             * Forbid self-imports.
             */
            'import/no-self-import': 'error',

            /**
             * Forbid useless path segments like ./index.
             */
            'import/no-useless-path-segments': 'error',

            /**
             * Enforce imports before other statements.
             */
            'import/imports-first': 'error',

            /**
             * Forbid deprecated imports.
             */
            'import/no-deprecated': 'warn',
        },
        settings: {
            'import/resolver': {
                typescript: true,
            },
        },
    },
    // Ignore test files for certain rules.
    {
        files: ['tests/**/*.ts'],
        rules: {
            'import/no-deprecated': 'off',
            'jsdoc/require-jsdoc': 'off',
        },
    },
];
