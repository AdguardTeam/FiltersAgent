import { describe, expect, it } from 'vitest';
import { refuseBlockerModulesInHistoricalRuns } from '../../../lab/local/blocker-modules';
import { ConfigError } from '../../../src/config/config';
import { ExtensionEnvironmentKind } from '../../../src/types/extension-environment-kind';

describe('historical blocker module admission', () => {
    it('refuses blocker modules in a historical run with a ConfigError naming the flag', () => {
        const manifestPaths = ['module.json'];
        const run = () =>
            refuseBlockerModulesInHistoricalRuns(
                ExtensionEnvironmentKind.Historical,
                manifestPaths,
            );
        expect(run).toThrow(ConfigError);
        expect(run).toThrow('--blocker-module');
    });
    it('accepts blocker modules in a current run and a historical run without them', () => {
        expect(() =>
            refuseBlockerModulesInHistoricalRuns(ExtensionEnvironmentKind.Current, ['module.json']),
        ).not.toThrow();
        expect(() =>
            refuseBlockerModulesInHistoricalRuns(ExtensionEnvironmentKind.Historical, []),
        ).not.toThrow();
    });
});
