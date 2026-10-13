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
 * Parse the intentionally small manual E2E command line.
 *
 * @param argv - Arguments following the script name.
 * @returns Validated explicit case selection.
 */
export function parseGoldenE2EArgs(argv: readonly string[]): GoldenE2ESelection {
    const args = argv.filter((argument) => argument !== '--');
    let caseName: string | undefined;
    let all = false;
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === '--all') {
            all = true;
            continue;
        }
        if (argument === '--case') {
            const value = args[index + 1];
            if (!value || value.startsWith('--')) {
                throw new Error('--case requires a value.');
            }
            caseName = value;
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
    return caseName ? { selection: 'case', caseName } : { selection: 'all' };
}
