import { pino, type Logger } from 'pino';

export interface LoggerOptions {
    /**
     * When true, the log level is set to `debug` instead of `info`.
     */
    verbose?: boolean;
}

/**
 * Create the application's pino logger.
 *
 * @param options - Logger options; `verbose` raises the level to `debug`.
 * @returns A configured pino logger instance.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
    return pino({
        level: options.verbose ? 'debug' : 'info',
    });
}

export type { Logger };
