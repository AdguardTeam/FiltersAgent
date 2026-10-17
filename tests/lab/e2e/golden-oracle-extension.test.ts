import { describe, expect, it } from 'vitest';
import type { LocalExtensionProvenance } from '../../../src/local/run-output';
import { oracleExtensionBuild } from '../../../lab/e2e/golden-oracle-extension';

const historicalBuild = {
    version: '5.4.3.99',
    releaseTag: 'v5.4.3.1',
    releaseSha256: 'a'.repeat(64),
    autobuildTag: 'autobuild-v5.4.3.99',
    autobuildCommit: 'b'.repeat(40),
};

const lockedExtension: LocalExtensionProvenance = {
    source: 'historical_build',
    extensionPath: '/tmp/cache/extensions/historical/build',
    manifestVersion: 3,
    extensionSourceSha256: 'e'.repeat(64),
    historicalBuild,
};

describe('oracleExtensionBuild', () => {
    it('returns the locked historical build identity for the judge', () => {
        expect(oracleExtensionBuild(lockedExtension)).toEqual(historicalBuild);
    });

    it('refuses a locked run without extension provenance', () => {
        expect(() => oracleExtensionBuild(null)).toThrow(/extension provenance/i);
    });

    it('refuses a locked pinned-release provenance', () => {
        expect(() =>
            oracleExtensionBuild({
                source: 'pinned_release',
                extensionPath: '/tmp/cache/extensions/prebuilt/release',
                manifestVersion: 3,
                extensionSourceSha256: 'e'.repeat(64),
            }),
        ).toThrow(/historical.*build/i);
    });

    it('refuses historical provenance without its build identity', () => {
        expect(() =>
            oracleExtensionBuild({ ...lockedExtension, historicalBuild: undefined }),
        ).toThrow(/historical.*build/i);
    });
});
