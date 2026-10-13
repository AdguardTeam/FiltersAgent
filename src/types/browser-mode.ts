/**
 * How much browser the caller asked an investigation to use.
 *
 * The values double as the CLI `--browser` flag vocabulary, so they are part of the user-facing
 * contract and may not be respelled.
 */
export const BrowserMode = {
    /**
     * Use the browser when the host can launch one, fall back to reasoning when it cannot.
     */
    Auto: 'auto',

    /**
     * Require the browser; a host that cannot launch one fails the run.
     */
    On: 'on',

    /**
     * Reasoning only; the browser is never launched.
     */
    Off: 'off',
} as const;

/**
 * Every BrowserMode value, for schemas and exhaustive listings.
 */
export const BROWSER_MODE_VALUES = Object.values(BrowserMode);

/**
 * BrowserMode value.
 */
export type BrowserMode = (typeof BrowserMode)[keyof typeof BrowserMode];
