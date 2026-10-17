/**
 * Offline benchmark summary inputs.
 */
export interface SummarizeArgs {
    /**
     * One or more trees containing benchmark records.
     */
    roots: string[];
    /**
     * Optional raw-record CSV destination.
     */
    csvPath: string | null;
}

/**
 * Parse the small offline comparison command line.
 *
 * @param argv - Arguments following the script name.
 * @returns Roots and optional CSV destination.
 */
export function parseSummarizeArgs(argv: readonly string[]): SummarizeArgs {
    const args = argv.filter((argument) => argument !== '--');
    const roots: string[] = [];
    let csvPath: string | null = null;
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index]!;
        if (argument === '--csv') {
            const value = args[index + 1];
            if (!value || value.startsWith('-')) {
                throw new Error('--csv requires a path.');
            }
            csvPath = value;
            index += 1;
        } else if (argument.startsWith('-')) {
            throw new Error(`Unknown option: ${argument}`);
        } else {
            roots.push(argument);
        }
    }
    if (roots.length === 0) {
        throw new Error('At least one benchmark root is required.');
    }
    return { roots, csvPath };
}
