import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { createBrowserToolHandlers } from '../../src/browser/browser-tools';
import { MAX_PAGE_STATE_RESULT_BYTES } from '../../src/browser/page-state-budget';
import { MAX_TOOL_RESULT_BYTES } from '../../src/pi/tool-result-envelope';
import type { IBrowserSession } from '../../src/browser/browser-interfaces';
import type { TraceRecorder } from '../../src/tracer/trace-recorder';
import type { HostnameResolver } from '../../src/browser/network-safety';

/**
 * One cookie as Playwright reports it, value included — the probe must never pass the value on.
 */
interface FakeCookie {
    /**
     * Cookie name.
     */
    name: string;

    /**
     * Cookie value, which no result may carry.
     */
    value: string;

    /**
     * Cookie domain.
     */
    domain: string;

    /**
     * Cookie path.
     */
    path: string;

    /**
     * Expiry timestamp; -1 marks a session cookie.
     */
    expires: number;

    /**
     * Whether page scripts are barred from the cookie.
     */
    httpOnly: boolean;

    /**
     * Whether the cookie is HTTPS-only.
     */
    secure: boolean;

    /**
     * SameSite policy.
     */
    sameSite: string;
}

/**
 * The page state a test hands to the probe.
 */
interface PageFixture {
    /**
     * Cookies of the browser context.
     */
    cookies?: FakeCookie[];

    /**
     * LocalStorage contents of the page origin.
     */
    localStorage?: Record<string, string>;

    /**
     * SessionStorage contents of the page origin.
     */
    sessionStorage?: Record<string, string>;

    /**
     * Frame URLs in document order, main frame first.
     */
    frameUrls?: string[];
}

/**
 * Build one cookie with defaults every test can override.
 *
 * @param overrides - Fields this test cares about.
 * @returns The cookie record.
 */
function cookie(overrides: Partial<FakeCookie> = {}): FakeCookie {
    return {
        name: 'consent',
        value: 'value-that-must-never-be-returned',
        domain: '.example.com',
        path: '/',
        expires: -1,
        httpOnly: false,
        secure: true,
        sameSite: 'Lax',
        ...overrides,
    };
}

/**
 * A Web Storage double the fixed probe expression can read inside a VM realm.
 *
 * @param entries - The area's contents in insertion order.
 * @returns An object exposing `length`, `key` and `getItem`.
 */
function fakeStorage(entries: Record<string, string>) {
    const keys = Object.keys(entries);
    return {
        get length() {
            return keys.length;
        },
        key: (index: number) => keys[index] ?? null,
        getItem: (key: string) => entries[key] ?? null,
    };
}

/**
 * Build the browser tool handlers over a page double whose storage read really executes the fixed
 * probe expression, in a VM realm holding the fixture's storage areas.
 *
 * @param fixture - The page state the probe should observe.
 * @returns The handler surface under test.
 */
function handlersFor(fixture: PageFixture) {
    const sandbox = {
        window: {
            localStorage: fakeStorage(fixture.localStorage ?? {}),
            sessionStorage: fakeStorage(fixture.sessionStorage ?? {}),
        },
    };
    const cdpSession = {
        send: async (method: string, params?: Record<string, unknown>) => {
            if (method === 'Page.getFrameTree') {
                return { frameTree: { frame: { id: 'main-frame' } } };
            }
            if (method === 'Page.createIsolatedWorld') {
                return { executionContextId: 1 };
            }
            if (method === 'Runtime.evaluate') {
                const evaluated = runInNewContext(String(params?.expression), sandbox);
                // CDP returnByValue delivers a JSON round-trip, never live realm objects.
                return { result: { value: JSON.parse(JSON.stringify(evaluated)) } };
            }
            return {};
        },
        detach: async () => {},
    };
    const frameUrls = fixture.frameUrls ?? ['https://example.com/'];
    const frames = frameUrls.map((url, index) => ({
        url: () => url,
        name: () => (index === 0 ? '' : `frame-${index}`),
        parentFrame: () => (index === 0 ? null : frames[0]),
    }));
    const page = {
        context: () => ({
            cookies: async () => fixture.cookies ?? [],
            newCDPSession: async () => cdpSession,
        }),
        frames: () => frames,
    };
    const session = { getPage: () => page } as unknown as IBrowserSession;
    return createBrowserToolHandlers({
        session,
        recorder: { addArtifact: vi.fn() } as unknown as TraceRecorder,
        artifactsDir: '/tmp',
        logger: pino({ level: 'silent' }),
        allowedOrigin: 'https://example.com',
        resolveHostname: (async () => ['93.184.216.34']) as HostnameResolver,
    });
}

/**
 * Build a storage area holding `count` long-valued keys under one prefix.
 *
 * @param prefix - Key and value prefix.
 * @param count - Number of keys.
 * @returns The area's contents.
 */
function manyStorageEntries(prefix: string, count: number): Record<string, string> {
    return Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
            `${prefix}_key_${index}`,
            `${prefix}-value-${index}-${'v'.repeat(400)}`,
        ]),
    );
}

/**
 * Build a storage area holding `count` keys whose names and values are both oversized.
 *
 * @param prefix - Key prefix, kept ahead of the bulk so the truncated keys stay distinct.
 * @param count - Number of keys.
 * @returns The area's contents.
 */
function bulkyStorageEntries(prefix: string, count: number): Record<string, string> {
    return Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
            `${prefix}_key_${index}_${'k'.repeat(400)}`,
            'v'.repeat(400),
        ]),
    );
}

describe('inspect_page_state', () => {
    it('returns cookie identities and flags but never a cookie value', async () => {
        const tools = handlersFor({
            cookies: [
                cookie({ name: 'euconsent-v2', value: 'CPXyz-secret-consent-string' }),
                cookie({
                    name: 'sid',
                    value: 'abcdef0123456789',
                    httpOnly: true,
                    expires: 1893456000,
                    path: '/account',
                }),
            ],
        });

        const result = await tools.inspect_page_state({});

        expect(result.cookies).toEqual([
            {
                name: 'euconsent-v2',
                domain: '.example.com',
                path: '/',
                httpOnly: false,
                secure: true,
                sameSite: 'Lax',
                session: true,
            },
            {
                name: 'sid',
                domain: '.example.com',
                path: '/account',
                httpOnly: true,
                secure: true,
                sameSite: 'Lax',
                session: false,
            },
        ]);
        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain('CPXyz-secret-consent-string');
        expect(serialized).not.toContain('abcdef0123456789');
        expect(result.counts.cookies).toEqual({ total: 2, returned: 2 });
    });

    it('redacts sensitive storage values and bounds the ones it returns', async () => {
        const tools = handlersFor({
            localStorage: {
                theme: 'dark',
                cmp_consent_given: 'true',
                access_token: 'plain-but-sensitive-by-key',
                profile: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.s1gnatur3',
                recent_search: 'q'.repeat(600),
                tmdb_movie_cache: 'x'.repeat(50_000),
            },
            sessionStorage: { session_secret: '0xdeadbeef', playbackPosition: '42' },
        });

        const result = await tools.inspect_page_state({});

        // Keys and short flags survive verbatim: they are what a storage-backed rule targets.
        expect(result.localStorage.theme).toBe('dark');
        expect(result.localStorage.cmp_consent_given).toBe('true');
        expect(result.sessionStorage.playbackPosition).toBe('42');
        // Sensitive key names and JWT-shaped values never reach the model.
        expect(result.localStorage.access_token).toBe('[redacted]');
        expect(result.localStorage.profile).toBe('[redacted]');
        expect(result.sessionStorage.session_secret).toBe('[redacted]');
        // A long value keeps a usable head and says how much was cut.
        expect(result.localStorage.recent_search?.length).toBeLessThan(300);
        expect(result.localStorage.recent_search).toContain('truncated');
        // A cache entry is dropped in the page: the key stays, the payload never travels.
        expect(result.localStorage.tmdb_movie_cache).toContain('50000');
        expect(JSON.stringify(result)).not.toContain('x'.repeat(300));
        expect(result.counts.localStorage).toEqual({ total: 6, returned: 6 });
    });

    it('reports the frame inventory with sensitive URL parameters redacted', async () => {
        const tools = handlersFor({
            frameUrls: [
                'https://example.com/article',
                'https://cmp.vendor.test/consent?token=super-secret-token&lang=en',
            ],
        });

        const result = await tools.inspect_page_state({});

        expect(result.frames).toEqual([
            { url: 'https://example.com/article', name: '' },
            {
                url: 'https://cmp.vendor.test/consent?token=[redacted]&lang=en',
                name: 'frame-1',
                parentUrl: 'https://example.com/article',
            },
        ]);
        expect(JSON.stringify(result)).not.toContain('super-secret-token');
    });

    it('lets the entry caps, not the byte budget, bound a state-heavy page', async () => {
        const cookies = Array.from({ length: 300 }, (_, index) =>
            cookie({ name: `tracker_cookie_${index}`, domain: `.node${index}.example.com` }),
        );

        const result = await handlersFor({
            cookies,
            localStorage: manyStorageEntries('local', 500),
            sessionStorage: manyStorageEntries('session', 500),
            frameUrls: Array.from(
                { length: 200 },
                (_, index) => `https://ads.example.com/creative/${index}?slot=${'s'.repeat(200)}`,
            ),
        }).inspect_page_state({});
        const cookiesAlone = await handlersFor({ cookies }).inspect_page_state({});

        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
            MAX_PAGE_STATE_RESULT_BYTES,
        );
        expect(MAX_PAGE_STATE_RESULT_BYTES).toBeLessThan(MAX_TOOL_RESULT_BYTES);
        // A page of this size costs the sections nothing against each other: cookies come back in
        // the same number whether or not the storage areas and the frame inventory are competing
        // for the budget, so what shortened the result is the entry cap alone.
        expect(result.counts.cookies.returned).toBe(cookiesAlone.counts.cookies.returned);
        expect(result.counts.localStorage.returned).toBe(result.counts.sessionStorage.returned);
        expect(result.truncated).toBe(true);
        expect(result.notice).toBeDefined();
        // The counts stay honest about what the page held, so a short result is never read as
        // "the page has no such state".
        expect(result.counts.cookies.total).toBe(300);
        expect(result.counts.localStorage.total).toBe(500);
        expect(result.counts.sessionStorage.total).toBe(500);
        expect(result.counts.frames.total).toBe(200);
        // No section starves another: every one of them carries evidence.
        for (const section of Object.values(result.counts)) {
            expect(section.returned).toBeGreaterThan(0);
            expect(section.returned).toBeLessThan(section.total);
        }
    });

    it('falls back to the byte budget when the page mints oversized entries', async () => {
        const bulky = 'x'.repeat(400);
        const oversized = {
            cookies: Array.from({ length: 300 }, (_, index) =>
                cookie({
                    name: `cookie_${index}_${bulky}`,
                    domain: `.node${index}${bulky}.example.com`,
                    path: `/${bulky}`,
                }),
            ),
            localStorage: bulkyStorageEntries('local', 500),
            sessionStorage: bulkyStorageEntries('session', 500),
            frameUrls: Array.from(
                { length: 200 },
                (_, index) => `https://ads.example.com/creative/${index}/${bulky}`,
            ),
        };

        const result = await handlersFor(oversized).inspect_page_state({});
        const modest = await handlersFor({
            cookies: Array.from({ length: 300 }, (_, index) =>
                cookie({ name: `cookie_${index}`, domain: `.node${index}.example.com` }),
            ),
            localStorage: manyStorageEntries('local', 500),
            sessionStorage: manyStorageEntries('session', 500),
            frameUrls: oversized.frameUrls,
        }).inspect_page_state({});

        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
            MAX_PAGE_STATE_RESULT_BYTES,
        );
        // Entries this large exhaust the budget before the caps are reached, so fewer of them come
        // back than the same number of ordinary entries would yield.
        expect(result.counts.cookies.returned).toBeLessThan(modest.counts.cookies.returned);
        expect(result.truncated).toBe(true);
        expect(result.notice).toBeDefined();
        // Round-robin admission still leaves every section on the page represented.
        for (const section of Object.values(result.counts)) {
            expect(section.returned).toBeGreaterThan(0);
        }
    });
});
