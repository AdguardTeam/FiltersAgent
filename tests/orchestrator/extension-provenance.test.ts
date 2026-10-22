import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { ExtensionLaunchFamily } from '../../src/environment/extension-launch';
import {
    PreparedExtensionSource,
    ExtensionManifestVersion,
} from '../../src/environment/extension-preparation';
import type {
    ChromiumPreparedExtension,
    PreparedExtension,
} from '../../src/local/prepared-extension';
import {
    serializeAgentExtensionProvenance,
    type AgentExtensionProvenanceFields,
} from '../../src/orchestrator/extension-provenance';
import {
    AgentExtensionProvenanceSchema,
    type AgentExtensionProvenance,
} from '../../src/types/fix-run-result';

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

    it.each<[string, PreparedExtension, Record<string, unknown>]>([
        [
            'Chromium',
            {
                source: PreparedExtensionSource.PinnedRelease,
                extensionPath: '/tmp/extension',
                manifestVersion: ExtensionManifestVersion.Mv3,
                userScriptsPermission: true,
                extensionSourceSha256: 'c'.repeat(64),
                extensionSourceTag: 'v5.4.3.1',
            },
            {
                source: PreparedExtensionSource.PinnedRelease,
                extensionPath: '/tmp/extension',
                manifestVersion: ExtensionManifestVersion.Mv3,
                extensionSourceSha256: 'c'.repeat(64),
                extensionSourceTag: 'v5.4.3.1',
            },
        ],
        [
            'Firefox',
            {
                source: PreparedExtensionSource.Instruction,
                launchFamily: ExtensionLaunchFamily.Firefox,
                extensionId: 'uBlock0@raymondhill.net',
                xpiPath: '/tmp/ublock-origin.xpi',
                managedStorageTemplate: { adminSettings: { selectedFilterLists: [] } },
                userFiltersKeyPath: ['adminSettings', 'userFilters'],
                extensionSourceSha256: 'c'.repeat(64),
            },
            {
                source: PreparedExtensionSource.Instruction,
                launchFamily: ExtensionLaunchFamily.Firefox,
                extensionId: 'uBlock0@raymondhill.net',
                xpiPath: '/tmp/ublock-origin.xpi',
                extensionSourceSha256: 'c'.repeat(64),
            },
        ],
    ])(
        'leaves the launch input of a %s build out of the strict provenance',
        (_, record, expected) => {
            expect(
                v.parse(AgentExtensionProvenanceSchema, serializeAgentExtensionProvenance(record)),
            ).toEqual(expected);
        },
    );

    it('refuses the runtime record and partial fields as provenance at compile time', () => {
        // Each statement under a @ts-expect-error must fail to compile; `pnpm typecheck` fails if
        // one starts compiling. They run here only as harmless expressions.
        const record: ChromiumPreparedExtension = {
            source: PreparedExtensionSource.PinnedRelease,
            extensionPath: '/tmp/extension',
            manifestVersion: ExtensionManifestVersion.Mv3,
            userScriptsPermission: true,
            extensionSourceSha256: 'c'.repeat(64),
        };
        // @ts-expect-error The runtime record is not provenance.
        const passed: AgentExtensionProvenance = record;
        // @ts-expect-error A spread of the runtime record is not provenance either.
        void ({ ...record } satisfies AgentExtensionProvenanceFields as AgentExtensionProvenance);
        const fields = serializeAgentExtensionProvenance(record) as AgentExtensionProvenanceFields;
        const { extensionPath, ...withoutPath } = fields;
        // @ts-expect-error Every schema field must be written, as undefined when the family has none.
        void (withoutPath satisfies AgentExtensionProvenanceFields);

        expect([passed, extensionPath]).toHaveLength(2);
    });
});
