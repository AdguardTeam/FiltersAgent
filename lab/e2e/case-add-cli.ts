import { GOLDEN_CASE_NAME_PATTERN } from './golden-case-name';

/**
 * Parsed arguments for one read-only historical case preparation.
 */
export interface GoldenCaseAddArgs {
    /**
     * Upstream AdguardFilters issue number.
     */
    issueNumber: number;

    /**
     * Full human fix commit kept exclusively in the closed oracle document.
     */
    humanFixCommit: string;

    /**
     * Optional explicit portable case name; otherwise it is derived from the reported domain.
     */
    caseName?: string;
}

/**
 * Read one required option value from a small manual CLI.
 *
 * @param args - Normalized command arguments.
 * @param index - Index of the option whose value follows.
 * @returns Non-option value following the requested argument.
 */
function readOptionValue(args: readonly string[], index: number): string {
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
        throw new Error(`${args[index]} requires a value.`);
    }
    return value;
}

/**
 * Parse the intentionally narrow historical case-add command line.
 *
 * @param argv - Arguments following the script name.
 * @returns Validated issue, oracle commit, and optional case name.
 */
export function parseGoldenCaseAddArgs(argv: readonly string[]): GoldenCaseAddArgs {
    const args = argv.filter((argument) => argument !== '--');
    let issueRaw: string | undefined;
    let humanFixCommit: string | undefined;
    let caseName: string | undefined;

    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === '--issue') {
            if (issueRaw !== undefined) {
                throw new Error('--issue may be supplied only once.');
            }
            issueRaw = readOptionValue(args, index);
            index += 1;
            continue;
        }
        if (argument === '--human-fix-commit') {
            if (humanFixCommit !== undefined) {
                throw new Error('--human-fix-commit may be supplied only once.');
            }
            humanFixCommit = readOptionValue(args, index);
            index += 1;
            continue;
        }
        if (argument === '--case-name') {
            if (caseName !== undefined) {
                throw new Error('--case-name may be supplied only once.');
            }
            caseName = readOptionValue(args, index);
            index += 1;
            continue;
        }
        throw new Error(`Unknown benchmark case-add argument: ${argument}`);
    }

    if (issueRaw === undefined) {
        throw new Error('--issue is required.');
    }
    const issueNumber = Number(issueRaw);
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
        throw new Error(`Invalid issue number: ${issueRaw}`);
    }
    if (humanFixCommit === undefined) {
        throw new Error('--human-fix-commit is required.');
    }
    if (!/^[0-9a-f]{40}$/iu.test(humanFixCommit)) {
        throw new Error('--human-fix-commit must be a full commit SHA.');
    }
    if (caseName !== undefined && !GOLDEN_CASE_NAME_PATTERN.test(caseName)) {
        throw new Error(`Invalid golden E2E case name: ${caseName}`);
    }

    return {
        issueNumber,
        humanFixCommit: humanFixCommit.toLowerCase(),
        ...(caseName === undefined ? {} : { caseName }),
    };
}
