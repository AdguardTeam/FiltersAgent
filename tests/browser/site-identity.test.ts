import { describe, expect, it } from 'vitest';
import { isRelatedHost, isSameSiteUrl } from '../../src/browser/site-identity';

describe('isRelatedHost', () => {
    it('relates a landing host to the issue host only by subdomain in either direction', () => {
        for (const [landing, issue, expected] of [
            ['example.com', 'example.com', true],
            ['sub.example.com', 'example.com', true],
            ['example.com', 'www.example.com', true],
            ['m.example.com', 'www.example.com', false],
            ['example.org', 'example.com', false],
            ['notexample.com', 'example.com', false],
        ] as const) {
            expect(isRelatedHost(landing, issue)).toBe(expected);
        }
    });
});

describe('isSameSiteUrl', () => {
    it("keeps a site's own redirects on the reported site", () => {
        for (const landed of [
            'https://example.com/',
            'https://www.example.com',
            'http://www.example.com/',
            'https://example.com/news/?page=2#top',
            'https://www.example.com.:443/',
        ]) {
            expect(isSameSiteUrl(landed, 'https://www.example.com/')).toBe(true);
        }
    });

    it('refuses another site, a sibling on a shared suffix and unparsable input', () => {
        for (const [landed, reported] of [
            ['https://example.org/', 'https://www.example.com/'],
            ['https://notexample.com/', 'https://example.com/'],
            ['https://b.github.io/', 'https://a.github.io/'],
            ['javascript:void(0)', 'https://example.com/'],
            ['not a url', 'https://example.com/'],
            ['https://example.com/', 'undefined'],
        ] as const) {
            expect(isSameSiteUrl(landed, reported)).toBe(false);
        }
    });
});
