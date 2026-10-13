/**
 * Remove the npm/pnpm argument separator when a package manager forwards it to the script.
 *
 * Some pnpm versions preserve the leading `--` in `process.argv`. Commander then treats every later
 * option as positional input, so the documented `pnpm start -- fix ...` form fails.
 *
 * @param argv - Node-style argv containing executable and script entries first.
 * @returns The original array or a copy without the forwarded separator.
 */
export function normalizePackageManagerArgv(argv: readonly string[]): string[] {
    if (argv[2] !== '--') {
        return [...argv];
    }
    return [...argv.slice(0, 2), ...argv.slice(3)];
}
