/**
 * Repo-relative prefix of the action's source tree.
 */
const SRC_PREFIX = 'src/';

/**
 * Repo-relative prefix of the lab tree.
 */
const LAB_PREFIX = 'lab/';

/**
 * The tsconfig path alias for the src/ tree (`"@/*": ["./src/*"]` in tsconfig.json). A specifier
 * through this alias reaches the same files a relative import does, so it must resolve the same way
 * when deciding whether it reaches the lab tree.
 */
const ALIAS_PREFIX = '@/';

/**
 * Repo-relative directory {@link ALIAS_PREFIX} maps onto.
 */
const ALIAS_TARGET = 'src';

/**
 * Name of the CommonJS synchronous loader function; a `require('../../lab/x')` call reaches the lab
 * tree exactly as an import would, so it must be checked the same way.
 */
const REQUIRE_NAME = 'require';

/**
 * Name of the Node factory that returns a `require`-shaped function bound to a module URL; a
 * chained `createRequire(import.meta.url)('../../lab/x')` call is the ESM equivalent of a bare
 * `require` call and reaches modules the same way.
 */
const CREATE_REQUIRE_NAME = 'createRequire';

/**
 * Convert an absolute oxlint filename into a repo-relative posix path.
 *
 * @param filename - Absolute file path oxlint reports for the file being linted.
 * @param cwd - Working directory oxlint runs from.
 * @returns The filename relative to the working directory, with posix separators.
 */
function repoRelative(filename, cwd) {
    const normalizedCwd = cwd.endsWith('/') ? cwd : `${cwd}/`;
    const normalizedFilename = filename.replace(/\\/g, '/');
    if (normalizedFilename.startsWith(normalizedCwd)) {
        return normalizedFilename.slice(normalizedCwd.length);
    }
    return normalizedFilename;
}

/**
 * Apply a specifier's `.`/`..`/name navigation segments onto a base path's segments.
 *
 * @param baseParts - Path segments the navigation starts from; mutated and returned.
 * @param segments - Segments from the specifier's own path, following its leading anchor.
 * @returns The resulting path segments after applying every navigation segment.
 */
function applySegments(baseParts, segments) {
    for (const segment of segments) {
        if (segment === '.' || segment === '') {
            continue;
        }
        if (segment === '..') {
            if (baseParts.length > 0 && baseParts[baseParts.length - 1] !== '..') {
                baseParts.pop();
            } else {
                baseParts.push('..');
            }
        } else {
            baseParts.push(segment);
        }
    }
    return baseParts;
}

/**
 * Lexically resolve a module specifier against a repo-relative source path.
 *
 * Only relative specifiers are resolved; bare package specifiers pass through unchanged.
 *
 * @param fromRel - Repo-relative path of the importing file (posix separators).
 * @param specifier - Module specifier from an import or export statement.
 * @returns The lexically resolved repo-relative target path.
 */
function resolveSpecifier(fromRel, specifier) {
    if (!specifier.startsWith('.')) {
        return specifier;
    }
    const parts = fromRel.split('/');
    parts.pop();
    return applySegments(parts, specifier.split('/')).join('/');
}

/**
 * Lexically resolve a `@/*` alias specifier (tsconfig's `"@/*": ["./src/*"]`) into a repo-relative
 * path, the same way the bundler's own path-alias resolution would.
 *
 * @param specifier - Module specifier starting with {@link ALIAS_PREFIX}.
 * @returns The lexically resolved repo-relative target path.
 */
function resolveAliasSpecifier(specifier) {
    const rest = specifier.slice(ALIAS_PREFIX.length);
    return applySegments([ALIAS_TARGET], rest.split('/')).join('/');
}

/**
 * Extract a specifier's literal text from a node that names a module statically: a string literal,
 * or a template literal with no interpolated expressions. A template literal with an expression
 * cannot be resolved lexically, so it is left unchecked exactly like any other dynamic value.
 *
 * @param node - AST node in specifier position: an import/require source, or a type-position
 *   `import(...)` argument.
 * @returns The literal specifier text, or undefined when it is not statically known.
 */
function staticSpecifierValue(node) {
    if (!node) {
        return undefined;
    }
    if (node.type === 'Literal' && typeof node.value === 'string') {
        return node.value;
    }
    if (
        node.type === 'TemplateLiteral' &&
        node.expressions.length === 0 &&
        node.quasis.length === 1
    ) {
        const quasi = node.quasis[0].value;
        return quasi.cooked ?? quasi.raw;
    }
    return undefined;
}

/**
 * Identify a `require(...)` or `createRequire(...)(...)` call and return its module-specifier
 * argument node.
 *
 * Both forms reach an arbitrary module synchronously, the same boundary a static `import` reaches
 * lexically. A chained `createRequire(url)(specifier)` call is one CallExpression whose own callee
 * is itself a CallExpression naming `createRequire`.
 *
 * @param node - CallExpression to classify.
 * @returns The first-argument node carrying the module specifier, or undefined when `node` is not a
 *   require-style call or was given no argument.
 */
function requireStyleArgument(node) {
    const { callee } = node;
    const isDirectRequire = callee.type === 'Identifier' && callee.name === REQUIRE_NAME;
    const isCreateRequireCall =
        callee.type === 'CallExpression' &&
        callee.callee.type === 'Identifier' &&
        callee.callee.name === CREATE_REQUIRE_NAME;
    if (!isDirectRequire && !isCreateRequireCall) {
        return undefined;
    }
    return node.arguments[0];
}

/**
 * Convert a source index into a 1-based line and 0-based column pair for `context.report`.
 *
 * @param text - Full source text of the linted file.
 * @param index - Character offset into the text.
 * @returns The 1-based line and 0-based column of the offset.
 */
function lineColAt(text, index) {
    let line = 1;
    let lineStart = 0;
    for (let i = 0; i < index; i += 1) {
        if (text.charCodeAt(i) === 10) {
            line += 1;
            lineStart = i + 1;
        }
    }
    return { line, column: index - lineStart };
}

/**
 * Report every module specifier that resolves into the lab tree from a src/ file.
 *
 * The src/ tree is the code the action ships; lab/ holds the development tools built on it — the
 * local CLI, the benchmark and the end-to-end cases. The dependency runs from lab/ to src/ only, so
 * the action never carries a development tool and src/ stays usable without lab/.
 *
 * The rule self-scopes to files whose repo-relative path starts with src/; oxlint names the file in
 * its output, and the diagnostic names the offending specifier. Every route a specifier can reach
 * the lab tree through is covered: static and dynamic `import`, `export ... from`, a type-position
 * `import('...')`, a `require`/`createRequire(...)(...)` call, and the `@/*` tsconfig alias.
 */
const noLabImports = {
    meta: {
        docs: {
            description:
                'src/ (the action) must not import from lab/ (development tools); the dependency runs lab/ → src/ only.',
        },
    },
    create(context) {
        const rel = repoRelative(context.filename, context.cwd);
        if (!rel.startsWith(SRC_PREFIX)) {
            return {};
        }
        /**
         * Report one specifier when it reaches the lab tree.
         *
         * @param specifier - Module specifier from the import, export, require or type reference.
         * @param node - AST node to anchor the diagnostic at.
         */
        function checkSpecifier(specifier, node) {
            let reachesLab = specifier.startsWith(LAB_PREFIX);
            if (!reachesLab && specifier.startsWith('.')) {
                const resolved = resolveSpecifier(rel, specifier);
                reachesLab = resolved === 'lab' || resolved.startsWith(LAB_PREFIX);
            }
            if (!reachesLab && specifier.startsWith(ALIAS_PREFIX)) {
                const resolved = resolveAliasSpecifier(specifier);
                reachesLab = resolved === 'lab' || resolved.startsWith(LAB_PREFIX);
            }
            if (reachesLab) {
                context.report({
                    node,
                    message: `src/ must not import from lab/ (${specifier}).`,
                });
            }
        }
        /**
         * Check a dynamic-import or type-position `import(...)` node once its specifier is
         * statically known.
         *
         * @param node - `ImportExpression` or `TSImportType` node.
         */
        function checkImportLikeNode(node) {
            const specifier = staticSpecifierValue(node.source);
            if (specifier !== undefined) {
                checkSpecifier(specifier, node.source);
            }
        }
        return {
            ImportDeclaration(node) {
                if (node.source) {
                    checkSpecifier(node.source.value, node.source);
                }
            },
            ExportAllDeclaration(node) {
                if (node.source) {
                    checkSpecifier(node.source.value, node.source);
                }
            },
            ExportNamedDeclaration(node) {
                if (node.source) {
                    checkSpecifier(node.source.value, node.source);
                }
            },
            ImportExpression: checkImportLikeNode,
            TSImportType: checkImportLikeNode,
            CallExpression(node) {
                const argument = requireStyleArgument(node);
                const specifier = staticSpecifierValue(argument);
                if (specifier !== undefined) {
                    checkSpecifier(specifier, argument);
                }
            },
        };
    },
};

/**
 * The AdGuard CLI executor vocabulary that must stay inside its own module. The executor is
 * published as a separately pluggable module under src/adguard-cli/; the rest of src/ learns
 * executors only through the open executor-name vocabulary a registration fills in, and a face that
 * wires the module imports its exported constants instead of spelling the name.
 *
 * Scope: this rule sees only files oxlint parses (JS/TS code and comments) under src/.
 * Non-parseable files — the Markdown prompt documents in src/prompts/documents/ — are outside its
 * reach; their vocabulary hygiene is the repo-level prompt-document scan, not this rule.
 */
const ADGUARD_CLI_EXECUTOR_NEEDLE = /adguard_cli/i;

/**
 * Repo-relative prefix of the AdGuard CLI executor module, the one src/ folder that owns the
 * vocabulary {@link ADGUARD_CLI_EXECUTOR_NEEDLE} matches.
 */
const ADGUARD_CLI_MODULE_PREFIX = 'src/adguard-cli/';

/**
 * Report every occurrence of the AdGuard CLI executor vocabulary in a src/ file outside its module.
 *
 * The rule self-scopes to files whose repo-relative path starts with src/ but not with the module's
 * own prefix, and matches the full parsed source text including comments, so a mention in a comment
 * is as much a boundary break as a mention in code. Matching stays a simple case-insensitive
 * needle: the vocabulary has one root and no host-boundary subtleties.
 */
const noAdguardCliVocabulary = {
    meta: {
        docs: {
            description:
                'src/ files outside src/adguard-cli/ must not mention the AdGuard CLI executor vocabulary.',
        },
    },
    create(context) {
        const rel = repoRelative(context.filename, context.cwd);
        if (!rel.startsWith(SRC_PREFIX) || rel.startsWith(ADGUARD_CLI_MODULE_PREFIX)) {
            return {};
        }
        return {
            Program(node) {
                const text = context.sourceCode.getText();
                const pattern = new RegExp(ADGUARD_CLI_EXECUTOR_NEEDLE.source, 'gi');
                for (const match of text.matchAll(pattern)) {
                    context.report({
                        node,
                        loc: lineColAt(text, match.index),
                        message:
                            'src/ must not mention the AdGuard CLI executor vocabulary ' +
                            '(adguard_cli) outside src/adguard-cli/. Import the module constants ' +
                            'and keep the rest of src/ generic.',
                    });
                }
            },
        };
    },
};

/**
 * The local plugin: rules that hold the src/ and lab/ boundary.
 */
const localPlugin = {
    meta: { name: 'local' },
    rules: {
        'no-lab-imports': noLabImports,
        'no-adguard-cli-vocabulary': noAdguardCliVocabulary,
    },
};

export default localPlugin;
