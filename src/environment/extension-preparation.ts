/**
 * Shared extension-preparation vocabulary: the manifest generations this app can load and the
 * provenance kind of one host-prepared build. Both cross the Host/model boundary — the launch
 * wiring reads the manifest generation, the durable proof schemas serialize the provenance — so
 * they are declared once here rather than respelled as literals at each of those seams. A path-free
 * vocabulary shared by both layers, which is what `src/environment` is for; it imports nothing.
 */

/**
 * The extension manifest generations this app can prepare and launch: MV2 (the Edge build) and MV3
 * (the Chromium line). No other generation ships, so a prepared build declaring one is refused when
 * its manifest is validated (`prepared-extension.ts`), before any browser session loads it.
 */
export const ExtensionManifestVersion = {
    /**
     * Manifest V2, the generation Edge reporter parity requires; branded Edge itself is not yet
     * driven, so today this build loads into the same stealth engine as MV3, an approximation
     * recorded as a fidelity conflict.
     */
    Mv2: 2,

    /**
     * Manifest V3, shipped by the Chromium line.
     */
    Mv3: 3,
} as const;

/**
 * Every ExtensionManifestVersion value, for schemas and exhaustive listings.
 */
export const EXTENSION_MANIFEST_VERSION_VALUES = Object.values(ExtensionManifestVersion);

/**
 * One supported extension manifest generation.
 */
export type ExtensionManifestVersion =
    (typeof ExtensionManifestVersion)[keyof typeof ExtensionManifestVersion];

/**
 * Where the one extension build a fix run loads came from.
 *
 * The run carries exactly one host-prepared build, prepared before its fix session starts; the
 * provenance kind is recorded in run records and serialized evidence so a published run states
 * whether the build is the operator-pinned prebuilt release, an operator-preloaded directory, or
 * the instruction's own preparation steps. A shared, path-free vocabulary: the local preparation
 * modules produce it, the durable proof schemas serialize it.
 */
export const PreparedExtensionSource = {
    /**
     * The host downloaded and unpacked the pinned prebuilt release.
     */
    PinnedRelease: 'pinned_release',

    /**
     * The operator supplied an unpacked directory (the `ADGUARD_EXTENSION_PATH` channel).
     *
     * Never emitted: the host reads no `ADGUARD_EXTENSION_PATH`, and a custom build goes through
     * the instruction's `## Preparation` section instead. This value stays parseable because run
     * records and evidence bundles written by earlier builds may still carry it.
     */
    Preloaded: 'preloaded',

    /**
     * The preparation session built the unpacked directory from the instruction's section.
     */
    Instruction: 'instruction',
} as const;

/**
 * Every PreparedExtensionSource value, for schemas and exhaustive listings.
 */
export const PREPARED_EXTENSION_SOURCE_VALUES = Object.values(PreparedExtensionSource);

/**
 * PreparedExtensionSource value.
 */
export type PreparedExtensionSource =
    (typeof PreparedExtensionSource)[keyof typeof PreparedExtensionSource];
