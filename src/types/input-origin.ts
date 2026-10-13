/**
 * Where a run took its issue input from: an exported local snapshot or the live queue.
 */
export const InputOrigin = {
    Exported: 'exported',
    Live: 'live',
} as const;

/**
 * Every InputOrigin value, for schemas and exhaustive listings.
 */
export const INPUT_ORIGIN_VALUES = Object.values(InputOrigin);

/**
 * InputOrigin value.
 */
export type InputOrigin = (typeof InputOrigin)[keyof typeof InputOrigin];
