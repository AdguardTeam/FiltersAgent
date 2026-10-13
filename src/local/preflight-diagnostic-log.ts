import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Diagnostic channels written by one preflight run.
 *
 * The public JSON transcript stays code-only by design, so a failure it reports as a finite code is
 * only diagnosable if the native material behind that code is preserved somewhere. These channels
 * are that somewhere.
 */
export type PreflightDiagnosticChannel =
    | 'run'
    | 'public_event'
    | 'contained_stdout'
    | 'cli_subprocess'
    | 'filter_catalog'
    | 'published_baseline'
    | 'cli_phase'
    | 'foreground'
    | 'browser'
    | 'tls_interception'
    | 'macos_trust'
    | 'persistent_ca'
    | 'state_root';

/**
 * Local post-mortem sink for one preflight run.
 */
export interface PreflightDiagnosticLog {
    /**
     * Absolute path of the file this run appends to.
     */
    readonly path: string;
    /**
     * Append one diagnostic record, redacted through the registered scoped secret when present.
     *
     * @param channel - Origin of the record.
     * @param detail - Arbitrary structured or native detail.
     */
    record(channel: PreflightDiagnosticChannel, detail: unknown): void;
    /**
     * Append a terminal record and stop accepting further ones.
     *
     * @param detail - Final run detail.
     */
    close(detail: unknown): void;
}

/**
 * Serialize an error with its full native message, stack and cause chain.
 *
 * Public failure envelopes deliberately collapse these to finite codes; the whole point of this log
 * is to keep the collapsed material for the operator.
 *
 * @param error - Arbitrary thrown value.
 * @returns Plain describable projection.
 */
export function describeDiagnosticError(error: unknown): unknown {
    if (!(error instanceof Error)) {
        return { thrown: String(error) };
    }
    const described: Record<string, unknown> = {
        name: error.name,
        message: error.message,
        stack: error.stack,
    };
    if ('cause' in error && error.cause !== undefined) {
        described.cause = describeDiagnosticError(error.cause);
    }
    return described;
}

/**
 * Build the fixed name of one run's diagnostic file.
 *
 * @param startedAt - Run start instant.
 * @returns Colon-free file name safe on every supported filesystem.
 */
function diagnosticFileName(startedAt: Date): string {
    return `adguard-cli-preflight-${startedAt.toISOString().replaceAll(':', '-')}.log`;
}

/**
 * Open one run's local diagnostic log.
 *
 * @param directory - Git-ignored directory that will hold the file.
 * @param startedAt - Run start instant used for the file name.
 * @returns Sink appending one JSON record per line.
 */
export function openPreflightDiagnosticLog(
    directory: string,
    startedAt: Date = new Date(),
): PreflightDiagnosticLog {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, diagnosticFileName(startedAt));
    let closed = false;

    /**
     * Append one already-shaped record, never throwing into the run it observes.
     *
     * @param channel - Origin of the record.
     * @param detail - Arbitrary structured or native detail.
     */
    const append = (channel: PreflightDiagnosticChannel, detail: unknown): void => {
        try {
            appendFileSync(
                path,
                `${JSON.stringify({ at: new Date().toISOString(), channel, detail })}\n`,
                { mode: 0o600 },
            );
        } catch {
            /* a diagnostic sink must never fail the run it observes */
        }
    };

    return {
        path,
        record(channel, detail) {
            if (closed) {
                return;
            }
            append(channel, detail);
        },
        close(detail) {
            if (closed) {
                return;
            }
            append('run', detail);
            closed = true;
        },
    };
}

let installedLog: PreflightDiagnosticLog | null = null;

/**
 * Install the sink the whole run writes to.
 *
 * The sink is process-wide on purpose: the material worth preserving is produced many layers below
 * the entry point, and threading a diagnostics parameter through every seam would reshape contracts
 * that exist to stay path-free.
 *
 * @param log - Sink for this run, or null to uninstall.
 */
export function installPreflightDiagnosticLog(log: PreflightDiagnosticLog | null): void {
    installedLog = log;
}

/**
 * Append one record to the installed sink, if any.
 *
 * @param channel - Origin of the record.
 * @param detail - Arbitrary structured or native detail.
 */
export function recordPreflightDiagnostic(
    channel: PreflightDiagnosticChannel,
    detail: unknown,
): void {
    installedLog?.record(channel, detail);
}
