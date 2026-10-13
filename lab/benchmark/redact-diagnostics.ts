import { createInterface } from 'node:readline';
import { diagnosticSecretsFromEnvironment, redactDiagnosticText } from './diagnostic-redactor';

/**
 * Stream line-delimited agent diagnostics from stdin to stdout with secrets redacted.
 *
 * @returns A promise that resolves after stdin closes and all redacted lines are written.
 */
async function main(): Promise<void> {
    const secrets = diagnosticSecretsFromEnvironment(process.env);
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of lines) {
        process.stdout.write(`${redactDiagnosticText(line, secrets)}\n`);
    }
}

main().catch((error: unknown) => {
    process.stderr.write(`Diagnostic redaction failed: ${(error as Error).message}\n`);
    process.exitCode = 1;
});
