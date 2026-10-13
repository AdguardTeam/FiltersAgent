import { describe, expect, it, vi } from 'vitest';
import {
    canonicalHttpOrigin,
    validatePublicHttpUrl,
    type HostnameResolver,
} from '../../src/browser/network-safety';

const publicResolver: HostnameResolver = vi.fn().mockResolvedValue(['93.184.216.34']);

describe('canonicalHttpOrigin', () => {
    it('normalizes an https URL to its origin', () => {
        expect(canonicalHttpOrigin('HTTPS://Example.COM:443/path?q=1')).toBe('https://example.com');
    });

    it.each(['file:///etc/passwd', 'data:text/plain,secret', 'ftp://example.com/file'])(
        'rejects the non-http URL %s',
        (url) => {
            expect(() => canonicalHttpOrigin(url)).toThrow('http or https');
        },
    );
});

describe('validatePublicHttpUrl', () => {
    it('accepts a public URL on the configured origin', async () => {
        const url = await validatePublicHttpUrl('https://example.com/path', {
            expectedOrigins: ['https://example.com'],
            resolveHostname: publicResolver,
        });

        expect(url.href).toBe('https://example.com/path');
    });

    it('rejects a URL on a different origin', async () => {
        await expect(
            validatePublicHttpUrl('https://other.example/path', {
                expectedOrigins: ['https://example.com'],
                resolveHostname: publicResolver,
            }),
        ).rejects.toThrow('configured issue origin');
    });

    it.each([
        'http://localhost/',
        'http://127.0.0.1/',
        'http://10.0.0.1/',
        'http://169.254.169.254/latest/meta-data/',
        'http://192.168.1.10/',
        'http://[::1]/',
        'http://[fc00::1]/',
        'http://[fe80::1]/',
        'http://[::ffff:127.0.0.1]/',
    ])('rejects the local or private URL %s', async (url) => {
        await expect(
            validatePublicHttpUrl(url, { resolveHostname: publicResolver }),
        ).rejects.toThrow('non-public');
    });

    it.each([
        'https://github.com/AdguardTeam/AdguardFilters/issues/243417',
        'https://github.com/adguardteam/adguardfilters/commit/2373061fde',
        'https://github.com/AdguardTeam/AdguardFilters.git',
        'https://api.github.com/repos/AdguardTeam/AdguardFilters/issues/243417/comments',
        'https://raw.githubusercontent.com/AdguardTeam/AdguardFilters/master/BaseFilter/sections/foreign.txt',
        'https://github.com/search?q=repo%3AAdguardTeam%2FAdguardFilters+samoletplus.ru&type=issues',
    ])('keeps the browser off the repository the reports come from: %s', async (url) => {
        // The agent must find the fix itself; the maintainers' answer is in this repository.
        await expect(
            validatePublicHttpUrl(url, { resolveHostname: publicResolver }),
        ).rejects.toMatchObject({ refusal: 'withheld_repository' });
    });

    it.each([
        'https://github.com/AdguardTeam/AdguardFiltersExtra',
        'https://github.com/AdguardTeam/AdguardBrowserExtension/issues/1',
        'https://example.com/AdguardTeam/AdguardFilters',
    ])('leaves other repositories and sites reachable: %s', async (url) => {
        await expect(
            validatePublicHttpUrl(url, { resolveHostname: publicResolver }),
        ).resolves.toBeInstanceOf(URL);
    });

    it('rejects a public hostname when DNS resolves it to a private address', async () => {
        const privateResolver: HostnameResolver = vi.fn().mockResolvedValue(['10.0.0.7']);

        await expect(
            validatePublicHttpUrl('https://example.com', {
                resolveHostname: privateResolver,
            }),
        ).rejects.toThrow('non-public address');
    });

    it('requires an allowlisted hostname when an allowlist is configured', async () => {
        await expect(
            validatePublicHttpUrl('https://other.example/image.png', {
                allowedHostnames: ['cdn.adguardcdn.com'],
                httpsOnly: true,
                resolveHostname: publicResolver,
            }),
        ).rejects.toThrow('allowlisted');
    });
});
