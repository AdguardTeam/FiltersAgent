import type { PreparedExtension } from '../local/prepared-extension';
import { ExtensionLaunchFamily } from '../environment/extension-launch';
import type { AgentExtensionProvenance } from '../types/fix-run-result';

/**
 * Convert the run's one host-prepared extension build to locked-result provenance.
 *
 * This is the one projection from the runtime record onto the durable schema, and the only place
 * that knows which identity fields each launch family carries: a Chromium build names the unpacked
 * directory and the manifest generation read from it — exactly the record every run wrote before
 * the families were distinguished, so no discriminant — and a Firefox build names its family, the
 * extension id and the signed XPI the enterprise policies force-installed. The managed-storage
 * declaration is launch input, not provenance, so it never reaches the durable record.
 *
 * @param extension - Exact extension loaded by a prepared browser session.
 * @returns Bounded build identity suitable for session and candidate bindings.
 */
export function serializeAgentExtensionProvenance(
    extension: PreparedExtension,
): AgentExtensionProvenance {
    const tag =
        extension.extensionSourceTag === undefined
            ? {}
            : { extensionSourceTag: extension.extensionSourceTag };
    if (extension.launchFamily === ExtensionLaunchFamily.Firefox) {
        return {
            source: extension.source,
            launchFamily: extension.launchFamily,
            extensionId: extension.extensionId,
            xpiPath: extension.xpiPath,
            extensionSourceSha256: extension.extensionSourceSha256,
            ...tag,
        };
    }
    return {
        source: extension.source,
        extensionPath: extension.extensionPath,
        manifestVersion: extension.manifestVersion,
        extensionSourceSha256: extension.extensionSourceSha256,
        ...tag,
        ...(extension.historicalBuild === undefined
            ? {}
            : { historicalBuild: extension.historicalBuild }),
    };
}
