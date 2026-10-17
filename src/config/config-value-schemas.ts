import * as v from 'valibot';
import { REASONING_EFFORT_VALUES } from './reasoning-effort';

/**
 * Minimum provider stall timeout; shorter waits would abandon ordinary model reasoning.
 */
export const MIN_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Maximum provider stall timeout, bounding a silent attempt to five minutes.
 */
export const MAX_REQUEST_TIMEOUT_MS = 300_000;

/**
 * One request attempt is the minimum needed to contact the provider.
 */
export const MIN_REQUEST_MAX_ATTEMPTS = 1;

/**
 * Three provider attempts cap the time and usage spent on a repeatedly failing request.
 */
export const MAX_REQUEST_MAX_ATTEMPTS = 3;

/**
 * Schema of one model limit in tokens, failing with a message that names the variable to set.
 *
 * @param envVar - The environment variable the limit is read from.
 * @returns The limit's schema.
 */
export function tokenLimitSchema(envVar: string) {
    const message = `${envVar} must name the model's limit in tokens`;
    return v.pipe(v.number(message), v.integer(message), v.minValue(1, message));
}

/**
 * Schema of one required provider value, failing with a message that names the variable to set.
 *
 * @param envVar - The environment variable the value is read from.
 * @returns The value's schema.
 */
export function providerValueSchema(envVar: string) {
    const message = `${envVar} is required`;
    return v.pipe(v.string(message), v.minLength(1, message));
}

/**
 * Validate an integer tuning value while naming its environment variable on every failure.
 *
 * @param envVar - Environment variable supplying the tuning value.
 * @param minimum - Smallest accepted integer.
 * @param maximum - Largest accepted integer.
 * @returns Integer schema with a named diagnostic shared by all failed constraints.
 */
export function boundedIntegerSchema(envVar: string, minimum: number, maximum: number) {
    const message = `${envVar} must be an integer from ${minimum} to ${maximum}`;
    return v.pipe(
        v.number(message),
        v.integer(message),
        v.minValue(minimum, message),
        v.maxValue(maximum, message),
    );
}

/**
 * Validate a provider reasoning effort with a diagnostic naming the configured variable.
 *
 * @param envVar - Environment variable supplying the effort.
 * @returns Schema accepting only reasoning levels supported by the runtime.
 */
export function reasoningEffortSchema(envVar: string) {
    return v.picklist(
        REASONING_EFFORT_VALUES,
        `${envVar} must be one of: ${REASONING_EFFORT_VALUES.join(', ')}`,
    );
}
