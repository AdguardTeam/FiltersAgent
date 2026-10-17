import { renderBenchmarkCsv } from './benchmark-summary-csv';
import { writeFileSync } from 'node:fs';
import {
    readBenchmarkRecords,
    renderBenchmarkSummaryMarkdown,
    summarizeBenchmark,
} from './benchmark-summary';
import { parseSummarizeArgs } from './summarize-cli';

/**
 * Print an offline comparison and optionally save every record to CSV.
 *
 * @returns Nothing after writing the requested outputs.
 */
function main(): void {
    const args = parseSummarizeArgs(process.argv.slice(2));
    const records = readBenchmarkRecords(args.roots);
    process.stdout.write(renderBenchmarkSummaryMarkdown(summarizeBenchmark(records)));
    if (args.csvPath !== null) {
        writeFileSync(args.csvPath, renderBenchmarkCsv(records), 'utf8');
    }
}

try {
    main();
} catch (error) {
    process.stderr.write(`Benchmark summary failed: ${(error as Error).message}\n`);
    process.exitCode = 1;
}
