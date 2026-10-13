import { describe, expect, it } from 'vitest';
import { buildFirefoxPolicies } from '../../src/browser/firefox-policies';

describe('buildFirefoxPolicies', () => {
    it('builds a force_installed ExtensionSettings entry with the file XPI URL', () => {
        const policies = buildFirefoxPolicies({
            extensionId: 'uBlock0@raymondhill.net',
            xpiPath: '/tmp/u.xpi',
        });

        expect(policies.policies.ExtensionSettings['uBlock0@raymondhill.net']).toEqual({
            installation_mode: 'force_installed',
            install_url: 'file:///tmp/u.xpi',
        });
    });

    it('passes managed storage through verbatim under 3rdparty.Extensions', () => {
        const managedStorage = {
            adminSettings: {
                userFilters: '||ads.example^',
                selectedFilterLists: ['user-filters'],
            },
        };
        const policies = buildFirefoxPolicies({
            extensionId: 'uBlock0@raymondhill.net',
            xpiPath: '/tmp/u.xpi',
            managedStorage,
        });
        const thirdParty = policies.policies['3rdparty'];

        expect(thirdParty?.Extensions['uBlock0@raymondhill.net']).toEqual(managedStorage);
    });

    it('encodes a path with spaces into a proper file URL', () => {
        const policies = buildFirefoxPolicies({
            extensionId: 'uBlock0@raymondhill.net',
            xpiPath: '/tmp/ublock origin/u.xpi',
        });

        expect(policies.policies.ExtensionSettings['uBlock0@raymondhill.net']).toEqual({
            installation_mode: 'force_installed',
            install_url: 'file:///tmp/ublock%20origin/u.xpi',
        });
    });

    it('rejects a relative xpiPath naming the parameter', () => {
        expect(() =>
            buildFirefoxPolicies({
                extensionId: 'uBlock0@raymondhill.net',
                xpiPath: 'relative/unpacked/u.xpi',
            }),
        ).toThrow(/xpiPath/);
    });

    it('omits the 3rdparty block entirely when no managed storage is given', () => {
        const policies = buildFirefoxPolicies({
            extensionId: 'uBlock0@raymondhill.net',
            xpiPath: '/tmp/u.xpi',
        });

        expect(policies.policies['3rdparty']).toBeUndefined();
        expect(policies.policies.ExtensionSettings['uBlock0@raymondhill.net']).toEqual({
            installation_mode: 'force_installed',
            install_url: 'file:///tmp/u.xpi',
        });
    });
});
