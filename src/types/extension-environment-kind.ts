/**
 * Extension preparation environments: the tracked current stable channel or one exact historical
 * build.
 */
export const ExtensionEnvironmentKind = {
    Current: 'current',
    Historical: 'historical',
} as const;

/**
 * Every ExtensionEnvironmentKind value, for schemas and exhaustive listings.
 */
export const EXTENSION_ENVIRONMENT_KIND_VALUES = Object.values(ExtensionEnvironmentKind);

/**
 * ExtensionEnvironmentKind value.
 */
export type ExtensionEnvironmentKind =
    (typeof ExtensionEnvironmentKind)[keyof typeof ExtensionEnvironmentKind];
