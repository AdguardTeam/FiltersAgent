import { EXTENSION_BUILD_VERSION_PATTERN } from '../../src/environment/environment-proofs';
import { GOLDEN_CASE_NAME_PATTERN } from './golden-case-name';

export const CaseCheckSelection = {
    /**
     * Check one named case, optionally replacing its reporter build pin.
     */
    Case: 'case',
    /**
     * Check every tracked case with its existing build pin.
     */
    All: 'all',
} as const;

/**
 * Scope of a case-check invocation.
 */
export type CaseCheckSelection = (typeof CaseCheckSelection)[keyof typeof CaseCheckSelection];

/**
 * Validated case-check command arguments.
 */
export interface GoldenCaseCheckArgs {
    /**
     * Whether to check one case or the whole corpus.
     */
    selection: CaseCheckSelection;
    /**
     * Portable directory name when checking one case.
     */
    caseName?: string;
    /**
     * Explicit reporter version whose autobuild tag must be resolved.
     */
    extensionVersion?: string;
}

/**
 * Parse the case-check CLI without loading provider or GitHub configuration.
 *
 * @param argv - Arguments following the script name, including any pnpm separator.
 * @returns Validated case selection and optional reporter version.
 */
export function parseGoldenCaseCheckArgs(argv: readonly string[]): GoldenCaseCheckArgs {
    const args = argv.filter((argument) => argument !== '--');
    let selection: CaseCheckSelection | undefined;
    let caseName: string | undefined;
    let extensionVersion: string | undefined;
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index]!;
        if (argument === '--extension-version') {
            if (extensionVersion !== undefined) {
                throw new Error('--extension-version may be supplied only once.');
            }
            extensionVersion = args[index + 1];
            if (!extensionVersion || !EXTENSION_BUILD_VERSION_PATTERN.test(extensionVersion)) {
                throw new Error('--extension-version requires a four-component numeric version.');
            }
            index += 1;
        } else if (argument === '--all' && selection === undefined) {
            selection = CaseCheckSelection.All;
        } else if (selection === undefined && GOLDEN_CASE_NAME_PATTERN.test(argument)) {
            selection = CaseCheckSelection.Case;
            caseName = argument;
        } else {
            throw new Error(`Unknown benchmark case-check argument: ${argument}`);
        }
    }
    if (selection === undefined) {
        throw new Error('Specify a case name or --all.');
    }
    if (selection === CaseCheckSelection.All && extensionVersion !== undefined) {
        throw new Error('--extension-version is supported only with one case.');
    }
    return {
        selection,
        ...(caseName === undefined ? {} : { caseName }),
        ...(extensionVersion === undefined ? {} : { extensionVersion }),
    };
}
