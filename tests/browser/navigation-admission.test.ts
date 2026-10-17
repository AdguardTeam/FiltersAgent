import { describe, expect, it } from 'vitest';
import { isRelatedHost } from '../../src/browser/navigation-admission';

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
