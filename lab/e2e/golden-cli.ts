import { FULL_COMMIT_SHA_PATTERN } from '../../src/environment/environment-proofs';
import { GOLDEN_CASE_NAME_PATTERN } from './golden-case-name';

/**
 * One explicit case or all tracked golden cases.
 */
export type GoldenE2ESelection =
    | {
          /**
           * Run exactly one named case.
           */
          selection: 'case';

          /**
           * Safe directory name under benchmark/e2e/cases.
           */
          caseName: string;
      }
    | {
          /**
           * Run all tracked cases sequentially.
           */
          selection: 'all';
      };

/**
 * The parsed manual E2E command line: the case selection and the run options.
 */
export type GoldenE2EArgs = GoldenE2ESelection & {
    /**
     * Optional isolated root for model run and evaluation artifacts.
     */
    outputRoot: string | null;
    /**
     * Explicit immutable KnowledgeBase commit for agent runs.
     */
    knowledgeBaseSha: string | null;
};

/**
 * Read the value following an option, which must not be another option.
 *
 * @param args - Every argument.
 * @param index - Index of the option.
 * @returns The value.
 * @throws {Error} When the option has no value.
 */
function optionValue(args: readonly string[], index: number): string {
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
        throw new Error(`${args[index]} requires a value.`);
    }
    return value;
}

/**
 * Parse the intentionally small manual E2E command line.
 *
 * @param argv - Arguments following the script name.
 * @returns Validated explicit case selection and the run options.
 */
export function parseGoldenE2EArgs(argv: readonly string[]): GoldenE2EArgs {
    const args = argv.filter((argument) => argument !== '--');
    let caseName: string | undefined;
    let all = false;
    let outputRoot: string | null = null;
    let knowledgeBaseSha: string | null = null;
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === '--all') {
            all = true;
            continue;
        }
        if (argument === '--case') {
            caseName = optionValue(args, index);
            index += 1;
            continue;
        }
        if (argument === '--knowledge-base-sha') {
            knowledgeBaseSha = optionValue(args, index).toLowerCase();
            if (!FULL_COMMIT_SHA_PATTERN.test(knowledgeBaseSha)) {
                throw new Error('--knowledge-base-sha must be a full 40-character commit.');
            }
            index += 1;
            continue;
        }
        if (argument === '--output-root') {
            outputRoot = optionValue(args, index);
            index += 1;
            continue;
        }
        throw new Error(`Unknown golden E2E argument: ${argument}`);
    }
    if (Boolean(caseName) === all) {
        throw new Error('Select exactly one mode: --case <name> or --all.');
    }
    if (caseName && !GOLDEN_CASE_NAME_PATTERN.test(caseName)) {
        throw new Error(`Invalid golden E2E case name: ${caseName}`);
    }
    return caseName
        ? { selection: 'case', caseName, outputRoot, knowledgeBaseSha }
        : { selection: 'all', outputRoot, knowledgeBaseSha };
}
