import { redactPayload } from './redactor';
import { TraceRecorder, type TraceRecorderOptions } from './trace-recorder';

/**
 * Options accepted by the production trace recorder factory.
 */
export interface RuntimeTraceRecorderOptions extends Omit<TraceRecorderOptions, 'redact'> {
    /**
     * Exact host-only values to redact in addition to generic credential patterns.
     */
    exactSecrets?: readonly string[];
}

/**
 * Create a trace recorder that redacts every persisted event payload.
 *
 * @param options - Run identity, mode, and optional clock.
 * @returns Trace recorder with the shared recursive redactor wired in.
 */
export function createRuntimeTraceRecorder(options: RuntimeTraceRecorderOptions): TraceRecorder {
    const { exactSecrets = [], ...traceOptions } = options;
    return new TraceRecorder({
        ...traceOptions,
        redact: (payload) => redactPayload(payload, exactSecrets) as Record<string, unknown>,
    });
}
