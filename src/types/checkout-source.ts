/**
 * How a disposable source checkout was obtained: a local shared clone or a remote shallow clone.
 */
export const CheckoutSource = {
    LocalSharedClone: 'local-shared-clone',
    RemoteShallowClone: 'remote-shallow-clone',
} as const;

/**
 * Every CheckoutSource value, for schemas and exhaustive listings.
 */
export const CHECKOUT_SOURCE_VALUES = Object.values(CheckoutSource);

/**
 * CheckoutSource value.
 */
export type CheckoutSource = (typeof CheckoutSource)[keyof typeof CheckoutSource];
