import { parse, type VariableDeclaration } from 'acorn';
import { HistoricalBuildError, HistoricalBuildFailureCode } from './historical-build-error';

/**
 * Webpack's module boundary identifies the one embedded filter script-rules module.
 */
const SCRIPT_RULES_MODULE_MARKER =
    ';// CONCATENATED MODULE: ./Extension/filters/chromium-mv3/local_script_rules.js';

/**
 * A following concatenated module ends the replaceable block without touching release code.
 */
const CONCATENATED_MODULE_PATTERN = /^;\/\/ CONCATENATED MODULE:/gmu;

/**
 * The release compiler emits exactly one top-level object binding in this module.
 */
const SCRIPT_RULES_VARIABLE_PATTERN = /^const ([\w$]+) = \{/gmu;

/**
 * The autobuild source exports this single object; only its binding name changes in the bundle.
 */
const SCRIPT_RULES_EXPORT_PATTERN = /\bexport const localScriptRules =/gu;

/**
 * Manifest background declarations determine whether the bundle accepts module syntax.
 */
export interface HistoricalBackgroundManifest {
    /**
     * Background execution configuration from the verified release.
     */
    background?: {
        /**
         * A module background permits import and export syntax.
         */
        type?: string;
    };
}

/**
 * Script-rule replacement and the binding retained by the surrounding release code.
 */
export interface SplicedLocalScriptRules {
    /**
     * Complete background source after replacing its script-rules module.
     */
    source: string;
    /**
     * Release binding referenced by the surrounding bundle.
     */
    variableName: string;
    /**
     * Rewritten autobuild module, used for coverage verification.
     */
    block: string;
}

export const BundleSourceType = {
    /**
     * Classic background workers accept script syntax only.
     */
    Script: 'script',
    /**
     * Module background workers also accept import and export declarations.
     */
    Module: 'module',
} as const;

/**
 * JavaScript parsing mode selected by the manifest.
 */
export type BundleSourceType = (typeof BundleSourceType)[keyof typeof BundleSourceType];

/**
 * Replace only the embedded script-rule module with the exact autobuild object.
 *
 * @param background - Verified release background source.
 * @param tagScriptRules - Script rules from the pinned autobuild tree.
 * @returns Rewritten source and the replacement object binding.
 */
export function spliceLocalScriptRules(
    background: string,
    tagScriptRules: string,
): SplicedLocalScriptRules {
    const lines = background.split('\n');
    const markers = lines.flatMap((line, index) =>
        line === SCRIPT_RULES_MODULE_MARKER ? [index] : [],
    );
    const exports = [...tagScriptRules.matchAll(SCRIPT_RULES_EXPORT_PATTERN)];
    if (markers.length !== 1 || exports.length !== 1) {
        throw new HistoricalBuildError(
            HistoricalBuildFailureCode.BundleLayoutMismatch,
            `Expected one script-rules module marker and one autobuild export; found ${markers.length} markers and ${exports.length} exports.`,
        );
    }
    const start = lines.slice(0, markers[0] + 1).join('\n').length + 1;
    const next = [...background.slice(start).matchAll(CONCATENATED_MODULE_PATTERN)][0];
    if (!next) {
        throw new HistoricalBuildError(
            HistoricalBuildFailureCode.BundleLayoutMismatch,
            'The embedded script-rules module has no following concatenated module boundary.',
        );
    }
    const end = start + next.index;
    const variables = [...background.slice(start, end).matchAll(SCRIPT_RULES_VARIABLE_PATTERN)];
    if (variables.length !== 1) {
        throw new HistoricalBuildError(
            HistoricalBuildFailureCode.BundleLayoutMismatch,
            `Expected one script-rules object binding; found ${variables.length}.`,
        );
    }
    const variableName = variables[0][1];
    const block = tagScriptRules.replace(
        SCRIPT_RULES_EXPORT_PATTERN,
        () => `const ${variableName} =`,
    );
    return {
        source: background.slice(0, start) + block + '\n' + background.slice(end),
        variableName,
        block,
    };
}

/**
 * Read the property keys of the replacement script-rule object without executing its code.
 *
 * @param block - Rewritten autobuild module containing one object declaration.
 * @returns Literal and identifier property keys carried by the object.
 */
export function scriptRuleKeys(block: string): string[] {
    const ast = parse(block, { ecmaVersion: 'latest', sourceType: BundleSourceType.Script });
    const declarations = ast.body.filter(
        (node): node is VariableDeclaration => node.type === 'VariableDeclaration',
    );
    const declaration = declarations[0];
    const object = declaration?.declarations[0]?.init;
    if (
        declarations.length !== 1 ||
        declaration.declarations.length !== 1 ||
        object?.type !== 'ObjectExpression'
    ) {
        throw new HistoricalBuildError(
            HistoricalBuildFailureCode.BundleLayoutMismatch,
            'The autobuild script-rules module must contain exactly one object declaration.',
        );
    }
    return object.properties.map((property) => {
        if (property.type !== 'Property' || property.computed) {
            throw new HistoricalBuildError(
                HistoricalBuildFailureCode.BundleLayoutMismatch,
                'Script-rule keys must be literal or identifier properties.',
            );
        }
        if (property.key.type === 'Identifier') {
            return property.key.name;
        }
        if (property.key.type === 'Literal') {
            return String(property.key.value);
        }
        throw new HistoricalBuildError(
            HistoricalBuildFailureCode.BundleLayoutMismatch,
            'Script-rule object has an unsupported key.',
        );
    });
}

/**
 * Select the parser mode used by the release background worker.
 *
 * @param manifest - Verified release manifest.
 * @returns Module mode only when explicitly declared by the manifest.
 */
export function bundleSourceType(manifest: HistoricalBackgroundManifest): BundleSourceType {
    return manifest.background?.type === BundleSourceType.Module
        ? BundleSourceType.Module
        : BundleSourceType.Script;
}

/**
 * Refuse an invalid rewritten bundle before it can enter the prepared-build cache.
 *
 * @param source - Complete rewritten background bundle.
 * @param sourceType - Background parser mode declared by its manifest.
 * @returns Nothing when parsing succeeds.
 */
export function assertBundleParses(source: string, sourceType: BundleSourceType): void {
    try {
        parse(source, { ecmaVersion: 'latest', sourceType });
    } catch (error) {
        throw new HistoricalBuildError(
            HistoricalBuildFailureCode.BundleParseFailed,
            `Rewritten background bundle does not parse: ${(error as Error).message}`,
            error,
        );
    }
}
