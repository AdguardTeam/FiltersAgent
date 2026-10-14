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
 * The parsed manual E2E command line: the case selection and the blocker modules every case plugs
 * in.
 */
export type GoldenE2EArgs = GoldenE2ESelection & {
    /**
     * Manifest paths of the blocker modules every case plugs in, in the order given.
     */
    blockerModules: string[];
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
 * @returns Validated explicit case selection and the plugged-in module manifests.
 */
export function parseGoldenE2EArgs(argv: readonly string[]): GoldenE2EArgs {
    const args = argv.filter((argument) => argument !== '--');
    let caseName: string | undefined;
    let all = false;
    const blockerModules: string[] = [];
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
        if (argument === '--blocker-module') {
            blockerModules.push(optionValue(args, index));
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
        ? { selection: 'case', caseName, blockerModules }
        : { selection: 'all', blockerModules };
}
