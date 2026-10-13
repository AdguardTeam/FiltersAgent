/**
 * Thrown when required environment variables are missing or malformed.
 */
export class ConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ConfigError';
    }
}
