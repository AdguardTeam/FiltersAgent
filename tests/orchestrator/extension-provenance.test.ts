import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import {
    PreparedExtensionSource,
    ExtensionManifestVersion,
} from '../../src/environment/extension-preparation';
import { serializeAgentExtensionProvenance } from '../../src/orchestrator/extension-provenance';
import { AgentExtensionProvenanceSchema } from '../../src/types/fix-run-result';

describe('serializeAgentExtensionProvenance', () => {
    it('keeps the build identity of a historical build in the locked provenance', () => {
        const historicalBuild = {
            version: '5.4.3.99',
            releaseTag: 'v5.4.3.1',
            releaseSha256: 'a'.repeat(64),
            autobuildTag: 'autobuild-v5.4.3.99',
            autobuildCommit: 'b'.repeat(40),
        };
        const provenance = serializeAgentExtensionProvenance({
            source: PreparedExtensionSource.HistoricalBuild,
            extensionPath: '/tmp/extension',
            manifestVersion: ExtensionManifestVersion.Mv3,
            userScriptsPermission: true,
            extensionSourceSha256: 'c'.repeat(64),
            extensionSourceTag: historicalBuild.autobuildTag,
            historicalBuild,
        });

        expect(v.parse(AgentExtensionProvenanceSchema, provenance).historicalBuild).toEqual(
            historicalBuild,
        );
    });
});
