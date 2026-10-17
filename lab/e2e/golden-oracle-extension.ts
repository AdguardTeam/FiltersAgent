import type { LocalExtensionProvenance } from '../../src/local/run-output';
import type { HistoricalExtensionBuildProvenance } from '../../src/environment/environment-proofs';
import { PreparedExtensionSource } from '../../src/environment/extension-preparation';

/**
 * Read the reporter build identity fixed by the locked agent run.
 *
 * @param extension - Locked verified-session extension provenance.
 * @returns Exact release and autobuild identities the judge must reuse.
 */
export function oracleExtensionBuild(
    extension: LocalExtensionProvenance | null,
): HistoricalExtensionBuildProvenance {
    if (!extension) {
        throw new Error('Golden human oracle requires locked extension provenance.');
    }
    if (
        extension.source !== PreparedExtensionSource.HistoricalBuild ||
        !extension.historicalBuild
    ) {
        throw new Error(
            'Golden human oracle requires a locked historical build with its reporter build identity; ' +
                `locked provenance source=${extension.source}.`,
        );
    }
    return extension.historicalBuild;
}
