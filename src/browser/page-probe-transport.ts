/**
 * Longest bounded string one probe result field carries unless a caller narrows it.
 */
const MAX_PROBE_FACT_LENGTH = 2_000;

/**
 * Encode fixed probe input as base64 JSON so no caller value is ever interpolated as code.
 *
 * @param input - JSON-serializable probe input.
 * @returns Base64 payload the probe decodes in the page.
 */
export function encodeProbeInput(input: Record<string, unknown>): string {
    return Buffer.from(JSON.stringify(input)).toString('base64');
}

/**
 * Read one bounded string from a probe result.
 *
 * @param value - Raw probe field.
 * @param max - Longest string to retain.
 * @returns Bounded string, empty when the probe reported nothing.
 */
export function factString(value: unknown, max: number = MAX_PROBE_FACT_LENGTH): string {
    return typeof value === 'string' ? value.slice(0, max) : '';
}

/**
 * Read one bounded finite number from a probe result.
 *
 * @param value - Raw probe field.
 * @returns Non-negative integer, zero when the probe reported nothing usable.
 */
export function factNumber(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}
