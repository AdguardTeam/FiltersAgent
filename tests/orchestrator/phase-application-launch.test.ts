import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { afterEach, describe, expect, it } from 'vitest';
import { PreparedExtensionProvenanceSchema } from '../../src/environment/environment-proofs';
import {
    ExtensionManifestVersion,
    PreparedExtensionSource,
} from '../../src/environment/extension-preparation';
import { loadPreparedExtensionFromDirectory } from '../../src/local/prepared-extension';
import type { AgentRuntimeSessionState } from '../../src/orchestrator/agent-runtime-session-evidence';
import { buildBrowserExtensionEnvironmentOptions } from '../../src/orchestrator/phase-application-launch';
import { SettingsProfileKind } from '../../src/types/settings-profile-kind';

describe('buildBrowserExtensionEnvironmentOptions', () => {
    const roots: string[] = [];

    afterEach(() => {
        for (const root of roots.splice(0)) {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('projects a prepared MV3 build that asks for userScripts onto parseable provenance', async () => {
        const extensionPath = mkdtempSync(join(tmpdir(), 'prepared-extension-'));
        roots.push(extensionPath);
        writeFileSync(
            join(extensionPath, 'manifest.json'),
            JSON.stringify({
                version: '5.4.3.1',
                manifest_version: 3,
                permissions: ['userScripts'],
            }),
        );
        const extension = await loadPreparedExtensionFromDirectory(
            extensionPath,
            PreparedExtensionSource.PinnedRelease,
            'a'.repeat(64),
            'v5.4.3.1',
        );
        const state = {
            extension,
            settingsProfile: {
                kind: SettingsProfileKind.DefaultsPlusRequired,
                requiredFilterIds: [],
            },
            extensionBaselineReadBack: {},
        } as unknown as AgentRuntimeSessionState;

        const options = buildBrowserExtensionEnvironmentOptions(undefined, state, {
            extensionBaselineSettingsFor: () => {
                throw new Error('not read while building options');
            },
            createSession: () => Promise.reject(new Error('not started while building options')),
            phaseConfiguration: () => Promise.reject(new Error('not run while building options')),
        });

        // Every adapter proof and locked result carries this provenance through the strict schema;
        // a launch-only field left in it refuses every apply_rule before any phase runs.
        expect(v.parse(PreparedExtensionProvenanceSchema, options.extensionProvenance)).toEqual({
            source: PreparedExtensionSource.PinnedRelease,
            extensionPath,
            manifestVersion: ExtensionManifestVersion.Mv3,
            extensionSourceSha256: 'a'.repeat(64),
            extensionSourceTag: 'v5.4.3.1',
        });
    });
});
