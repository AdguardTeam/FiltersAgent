import { createHash } from 'node:crypto';
import type * as v from 'valibot';
import type { PreparedExtension } from '../local/prepared-extension';
import { ExtensionLaunchFamily } from '../environment/extension-launch';
import type {
    AgentExtensionProvenance,
    AgentExtensionProvenanceSchema,
} from '../types/fix-run-result';

/**
 * Every provenance field before the brand, each key required: a projection must write each one, as
 * `undefined` where its launch family carries none.
 */
export type AgentExtensionProvenanceFields = {
    [K in keyof Required<v.InferInput<typeof AgentExtensionProvenanceSchema>>]:
        | v.InferInput<typeof AgentExtensionProvenanceSchema>[K]
        | undefined;
};

/**
 * The durable identity of the one build a run loads, as every proof and result records it.
 */
export interface ExtensionBuildIdentity {
    /**
     * The build's locked-result provenance.
     */
    provenance: AgentExtensionProvenance;

    /**
     * Lowercase SHA-256 of the serialized provenance, the build digest every proof binds.
     */
    buildDigest: string;
}

/**
 * Convert the run's one host-prepared extension build to locked-result provenance.
 *
 * This is the one projection from the runtime record onto the durable schema, and the only place
 * that knows which identity fields each launch family carries: a Chromium build names the unpacked
 * directory and the manifest generation read from it — exactly the record every run wrote before
 * the families were distinguished, so no discriminant — and a Firefox build names its family, the
 * extension id and the signed XPI the enterprise policies force-installed. Launch input (the
 * `userScripts` permission, the managed-storage declaration) is not provenance, so it never reaches
 * the durable record.
 *
 * The schema is strict and its output type is branded, so the record itself never type-checks as
 * provenance. Each literal below names every schema field in schema order and is checked with
 * `satisfies` against {@link AgentExtensionProvenanceFields}: a missing field, a field the schema
 * gains later, or an extra key fails to compile, and a spread of the record fails the brand cast.
 * The `undefined` fields vanish from every serialization, so stored records and digests carry only
 * the fields the family has.
 *
 * @param extension - Exact extension loaded by a prepared browser session.
 * @returns Bounded build identity suitable for session and candidate bindings.
 */
export function serializeAgentExtensionProvenance(
    extension: PreparedExtension,
): AgentExtensionProvenance {
    if (extension.launchFamily === ExtensionLaunchFamily.Firefox) {
        return {
            source: extension.source,
            launchFamily: extension.launchFamily,
            extensionPath: undefined,
            manifestVersion: undefined,
            extensionId: extension.extensionId,
            xpiPath: extension.xpiPath,
            extensionSourceSha256: extension.extensionSourceSha256,
            extensionSourceTag: extension.extensionSourceTag,
            historicalBuild: extension.historicalBuild,
        } satisfies AgentExtensionProvenanceFields as AgentExtensionProvenance;
    }
    return {
        source: extension.source,
        launchFamily: undefined,
        extensionPath: extension.extensionPath,
        manifestVersion: extension.manifestVersion,
        extensionId: undefined,
        xpiPath: undefined,
        extensionSourceSha256: extension.extensionSourceSha256,
        extensionSourceTag: extension.extensionSourceTag,
        historicalBuild: extension.historicalBuild,
    } satisfies AgentExtensionProvenanceFields as AgentExtensionProvenance;
}

/**
 * Project the run's prepared build onto its provenance and the build digest taken over it.
 *
 * Both environment adapters bind this pair, so the digest is always taken over the projection and
 * never over the runtime record with its launch input.
 *
 * @param extension - Exact extension loaded by a prepared browser session.
 * @returns The provenance and its digest.
 */
export function serializeExtensionBuildIdentity(
    extension: PreparedExtension,
): ExtensionBuildIdentity {
    const provenance = serializeAgentExtensionProvenance(extension);
    return {
        provenance,
        buildDigest: createHash('sha256').update(JSON.stringify(provenance)).digest('hex'),
    };
}
