import { describe, expect, it } from 'vitest';
import type { NetworkRequestEntry } from '../../src/browser/browser-interfaces';
import { summarizeNetworkLog } from '../../src/browser/network-log-inventory';

/**
 * Build a network request entry with sensible defaults for the fields a test does not set.
 *
 * @param url - The request URL.
 * @param overrides - Partial fields to override.
 * @returns A complete network request entry.
 */
function entry(url: string, overrides: Partial<NetworkRequestEntry> = {}): NetworkRequestEntry {
    return {
        url,
        method: 'GET',
        resourceType: 'script',
        statusCode: 200,
        requestHeaders: {},
        responseHeaders: {},
        ...overrides,
    };
}

describe('summarizeNetworkLog', () => {
    it('lists every request, including the loader hosts the old /ad filter hid', () => {
        // Reproduces inbook.pl / flyert.com.cn / mystrikingly.com: the loaders maintainers
        // blocked matched neither `/ad` nor `doubleclick`, so the model never saw them.
        const inventory = summarizeNetworkLog(
            [
                entry('https://inbook.pl/', { resourceType: 'document' }),
                entry('https://cdn.selly.pl/js/libs/cookieconsentv3.js?v3.0.1'),
                entry('https://ptfg.flyertrip.com/static/img/campain/bottom.jpg', {
                    resourceType: 'image',
                }),
                entry('https://beacon.errorception.com/x.gif', { resourceType: 'image' }),
                entry('https://inbook.pl/theme.css', { resourceType: 'stylesheet' }),
            ],
            'https://inbook.pl/',
        );

        expect(inventory.requests).toHaveLength(5);
        const hosts = inventory.requests.map((request) => request.host);
        expect(hosts).toEqual(
            expect.arrayContaining([
                'cdn.selly.pl',
                'ptfg.flyertrip.com',
                'beacon.errorception.com',
                'inbook.pl',
            ]),
        );
        // Page chrome is evidence too: a document or stylesheet request is not filtered out.
        expect(inventory.requests.some((request) => request.type === 'stylesheet')).toBe(true);
        expect(inventory.requests.find((request) => request.host === 'cdn.selly.pl')).toMatchObject(
            {
                type: 'script',
                thirdParty: true,
                count: 1,
            },
        );
        expect(inventory.omittedRequestCount).toBe(0);
    });

    it('marks a first-party plugin path as first party while listing it', () => {
        // curiouspatch.com/static/rsoc.js and thehealthy.com/wp-content/... are first-party
        // sub-resources the agent should block with ||site/path.
        const inventory = summarizeNetworkLog(
            [
                entry('https://curiouspatch.com/static/rsoc.js'),
                entry('https://www.curiouspatch.com/wp-content/plugins/ads/loader.js'),
                entry('https://vendor.test/cmp.js'),
            ],
            'https://curiouspatch.com/',
        );

        expect(inventory.requests.find((r) => r.path.includes('rsoc.js'))).toMatchObject({
            host: 'curiouspatch.com',
            thirdParty: false,
        });
        expect(inventory.requests.find((r) => r.host === 'www.curiouspatch.com')?.thirdParty).toBe(
            false,
        );
        // Third-party entries lead the list so a shared vendor is the first thing read.
        expect(inventory.requests[0]?.host).toBe('vendor.test');
    });

    it('collapses repeats into one entry with a count and reports per-host totals', () => {
        const inventory = summarizeNetworkLog(
            [
                entry('https://site.test/', { resourceType: 'document' }),
                entry('https://vendor.test/beacon.gif', { resourceType: 'image' }),
                entry('https://vendor.test/beacon.gif', { resourceType: 'image' }),
                entry('https://vendor.test/beacon.gif', { resourceType: 'image' }),
                entry('https://blocked.test/track.js', { statusCode: 0 }),
            ],
            'https://site.test/',
        );

        expect(inventory.requestCount).toBe(5);
        expect(inventory.blockedCount).toBe(1);
        expect(inventory.byType).toMatchObject({ document: 1, image: 3, script: 1 });
        expect(inventory.byHost).toMatchObject({ 'vendor.test': 3, 'blocked.test': 1 });
        expect(inventory.requests.find((r) => r.host === 'vendor.test')?.count).toBe(3);
        expect(inventory.blocked).toContain('https://blocked.test/track.js');
    });

    it('keeps every host visible when the per-path list is bounded', () => {
        const many = Array.from({ length: 400 }, (_, index) =>
            entry(`https://vendor${index}.test/script.js`),
        );

        const inventory = summarizeNetworkLog(many, 'https://site.test/');

        expect(inventory.requestCount).toBe(400);
        expect(inventory.omittedRequestCount).toBeGreaterThan(0);
        expect(inventory.requests.length + inventory.omittedRequestCount).toBe(400);
        // Nothing vanishes silently: the omitted paths' hosts are still counted.
        expect(Object.keys(inventory.byHost)).toHaveLength(400);
    });
});

describe('third-party marking', () => {
    it('judges the party by registrable domain, so sibling subdomains stay first party', () => {
        // The reported page is www.site.com while its assets load from cdn.site.com: neither host
        // contains the other, yet both are the same site, and a first-party asset must not be
        // read as a shared vendor.
        const inventory = summarizeNetworkLog(
            [
                entry('https://cdn.site.com/ads/loader.js'),
                entry('https://www.site.com/app.js'),
                entry('https://cs.iubenda.com/cs.js'),
                entry('https://other.co.uk/tag.js'),
            ],
            'https://www.site.com/article',
        );

        const party = Object.fromEntries(
            inventory.requests.map((request) => [request.host, request.thirdParty]),
        );
        expect(party).toEqual({
            'cdn.site.com': false,
            'www.site.com': false,
            'cs.iubenda.com': true,
            'other.co.uk': true,
        });
    });

    it('marks nothing as third party when the reported origin does not parse', () => {
        const inventory = summarizeNetworkLog([entry('https://vendor.test/cmp.js')], 'not-a-url');

        expect(inventory.requests[0]?.thirdParty).toBe(false);
    });
});
