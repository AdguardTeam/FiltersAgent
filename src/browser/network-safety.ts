import { lookup } from 'node:dns/promises';

/**
 * Resolve a hostname to every address that the browser could reach.
 */
export type HostnameResolver = (hostname: string) => Promise<string[]>;

/**
 * Constraints applied while validating an outbound HTTP URL.
 */
export interface PublicHttpUrlOptions {
    /**
     * Canonical origins a top-level navigation must remain on: the reported issue origin and the
     * origins the reported page itself redirected to.
     */
    expectedOrigins?: readonly string[];

    /**
     * Exact hostnames accepted by the caller, when the destination is allowlist-only.
     */
    allowedHostnames?: readonly string[];

    /**
     * Whether plain HTTP must be rejected.
     */
    httpsOnly?: boolean;

    /**
     * Injectable DNS resolver used to detect hostnames that resolve to private addresses.
     */
    resolveHostname?: HostnameResolver;
}

/**
 * Why an outbound URL was refused.
 *
 * The caller turns this into a recorded fallback reason, and that reason decides whether the
 * outcome may be published as a statement about the reporter's site. A single opaque error forced
 * that decision to be made by matching prose, so an off-origin redirect and a real HTTP refusal
 * were reported identically.
 */
export const UnsafeUrlRefusal = {
    /**
     * The text is not an absolute URL, or carries no hostname.
     */
    MalformedUrl: 'malformed_url',

    /**
     * The scheme is not one we open.
     */
    UnsupportedProtocol: 'unsupported_protocol',

    /**
     * The URL embeds credentials.
     */
    CredentialsPresent: 'credentials_present',

    /**
     * The host is loopback, private, or resolves to a non-public address.
     */
    NonPublicHost: 'non_public_host',

    /**
     * The URL leaves the origin configured for this issue.
     */
    OriginMismatch: 'origin_mismatch',

    /**
     * The host is outside the caller's allowlist.
     */
    HostNotAllowlisted: 'host_not_allowlisted',

    /**
     * The host produced no usable DNS answer from this runner.
     */
    DnsUnresolved: 'dns_unresolved',

    /**
     * The URL reads the filter repository whose maintainers fix the reports the agent works on.
     */
    WithheldRepository: 'withheld_repository',
} as const;

/**
 * UnsafeUrlRefusal value.
 */
export type UnsafeUrlRefusal = (typeof UnsafeUrlRefusal)[keyof typeof UnsafeUrlRefusal];

/**
 * Error raised when an outbound URL fails a network safety constraint.
 */
export class UnsafeNetworkUrlError extends Error {
    /**
     * Which constraint refused the URL.
     */
    readonly refusal: UnsafeUrlRefusal;

    /**
     * Create a network URL validation error.
     *
     * @param refusal - Which constraint refused the URL.
     * @param message - Human-readable reason the URL was rejected.
     */
    constructor(refusal: UnsafeUrlRefusal, message: string) {
        super(message);
        this.name = 'UnsafeNetworkUrlError';
        this.refusal = refusal;
    }
}

/**
 * Hostname suffixes reserved for loopback or private name resolution.
 */
const PRIVATE_HOSTNAME_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

/**
 * Well-known metadata service hostnames that must never be requested.
 */
const METADATA_HOSTNAMES = new Set([
    'metadata',
    'metadata.google.internal',
    'metadata.azure.internal',
    'instance-data',
]);

/**
 * Owner and name of the filter repository the agent's browser must never read, lowercase.
 *
 * Test runs copy real reports from it, and its maintainers fix them there: in the commit, in the
 * issue thread, in the published list file. A run that reached any of them could repeat the fix
 * instead of finding one, which makes its answer worthless as a test. Top-level navigation is held
 * to the reported origin anyway; this also stops a page's own request and a site's own redirect.
 */
const WITHHELD_REPOSITORY = 'adguardteam/adguardfilters';

/**
 * GitHub hosts that serve a repository's pages, API, raw files and archives.
 */
const REPOSITORY_HOSTNAMES = new Set([
    'github.com',
    'www.github.com',
    'api.github.com',
    'raw.githubusercontent.com',
    'codeload.github.com',
]);

/**
 * Decide whether a URL reads the withheld filter repository.
 *
 * The query counts as well as the path, so a GitHub search scoped to the repository
 * (`?q=repo:AdguardTeam/AdguardFilters`) is refused like its issue pages are.
 *
 * @param url - Parsed URL with a normalized hostname.
 * @returns Whether the URL reaches the withheld repository.
 */
function readsWithheldRepository(url: URL): boolean {
    if (!REPOSITORY_HOSTNAMES.has(url.hostname)) {
        return false;
    }
    let target: string;
    try {
        target = decodeURIComponent(`${url.pathname}${url.search}`).toLowerCase();
    } catch {
        target = `${url.pathname}${url.search}`.toLowerCase();
    }
    const index = target.indexOf(WITHHELD_REPOSITORY);
    if (index === -1) {
        return false;
    }
    // `AdguardTeam/AdguardFiltersExtra` is a different repository; `.git`, `/`, `?`, `&` and the end
    // of the string all close the name.
    const following = target.charAt(index + WITHHELD_REPOSITORY.length);
    return following === '' || /[^a-z0-9_-]/u.test(following);
}

/**
 * Remove URL-only hostname syntax before address and allowlist checks.
 *
 * @param hostname - Hostname returned by URL parsing or DNS.
 * @returns Lowercase hostname without IPv6 brackets, zone ID, or a trailing root dot.
 */
function normalizeHostname(hostname: string): string {
    return hostname
        .trim()
        .toLowerCase()
        .replace(/^\[|\]$/g, '')
        .replace(/%.+$/, '')
        .replace(/\.$/, '');
}

/**
 * Parse a dotted IPv4 address into four bytes.
 *
 * @param address - Candidate IPv4 address.
 * @returns Four address bytes, or null when the text is not canonical IPv4.
 */
function parseIpv4(address: string): number[] | null {
    const parts = address.split('.');
    if (parts.length !== 4) {
        return null;
    }
    const bytes = parts.map((part) => (/^\d+$/.test(part) ? Number(part) : Number.NaN));
    if (bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
        return null;
    }
    return bytes;
}

/**
 * Parse an IPv6 address into sixteen bytes, including IPv4-embedded forms.
 *
 * @param address - Candidate IPv6 address.
 * @returns Sixteen address bytes, or null when the text is not valid IPv6.
 */
function parseIpv6(address: string): number[] | null {
    let value = normalizeHostname(address);
    const ipv4Match = value.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/);
    if (ipv4Match) {
        const ipv4 = parseIpv4(ipv4Match[1]);
        if (!ipv4) {
            return null;
        }
        const replacement = `${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${(
            (ipv4[2] << 8) |
            ipv4[3]
        ).toString(16)}`;
        value = value.slice(0, -ipv4Match[1].length) + replacement;
    }

    const doubleColonParts = value.split('::');
    if (doubleColonParts.length > 2) {
        return null;
    }
    const head = doubleColonParts[0]
        ? doubleColonParts[0].split(':').filter((part) => part.length > 0)
        : [];
    const tail =
        doubleColonParts.length === 2 && doubleColonParts[1]
            ? doubleColonParts[1].split(':').filter((part) => part.length > 0)
            : [];
    const missing = 8 - head.length - tail.length;
    if ((doubleColonParts.length === 1 && missing !== 0) || missing < 0) {
        return null;
    }
    const groups = [
        ...head,
        ...Array.from({ length: doubleColonParts.length === 2 ? missing : 0 }, () => '0'),
        ...tail,
    ];
    if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) {
        return null;
    }
    return groups.flatMap((group) => {
        const parsed = Number.parseInt(group, 16);
        return [parsed >> 8, parsed & 0xff];
    });
}

/**
 * Determine whether IPv4 bytes belong to a non-public or special-purpose range.
 *
 * @param bytes - Four parsed IPv4 bytes.
 * @returns True for loopback, private, link-local, metadata, documentation, and reserved ranges.
 */
function isUnsafeIpv4(bytes: number[]): boolean {
    const [a, b, c] = bytes;
    return (
        a === 0 ||
        a === 10 ||
        a === 127 ||
        a >= 224 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 0 && c === 0) ||
        (a === 192 && b === 0 && c === 2) ||
        (a === 192 && b === 168) ||
        (a === 198 && (b === 18 || b === 19)) ||
        (a === 198 && b === 51 && c === 100) ||
        (a === 203 && b === 0 && c === 113)
    );
}

/**
 * Determine whether IPv6 bytes belong to a non-public or transition range.
 *
 * @param bytes - Sixteen parsed IPv6 bytes.
 * @returns True for loopback, private, link-local, metadata-capable, and reserved ranges.
 */
function isUnsafeIpv6(bytes: number[]): boolean {
    const firstTwelveZero = bytes.slice(0, 12).every((byte) => byte === 0);
    const ipv4Mapped =
        bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
    if (firstTwelveZero || ipv4Mapped) {
        return isUnsafeIpv4(bytes.slice(12));
    }

    return (
        (bytes[0] & 0xfe) === 0xfc ||
        (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) ||
        (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0xc0) ||
        bytes[0] === 0xff ||
        (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) ||
        (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) ||
        (bytes[0] === 0x20 && bytes[1] === 0x02) ||
        (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b)
    );
}

/**
 * Determine whether an address is invalid or cannot be reached safely from an untrusted input.
 *
 * @param address - IPv4 or IPv6 address text.
 * @returns True when the address is non-public, special-purpose, or malformed.
 */
function isUnsafeIpAddress(address: string): boolean {
    const normalized = normalizeHostname(address);
    const ipv4 = parseIpv4(normalized);
    if (ipv4) {
        return isUnsafeIpv4(ipv4);
    }
    const ipv6 = parseIpv6(normalized);
    if (ipv6) {
        return isUnsafeIpv6(ipv6);
    }
    return true;
}

/**
 * Parse and statically validate an HTTP URL before any DNS or network activity.
 *
 * @param rawUrl - Untrusted URL text.
 * @param httpsOnly - Whether the URL must use HTTPS.
 * @returns Parsed URL with a normalized hostname.
 */
function parseHttpUrl(rawUrl: string, httpsOnly: boolean): URL {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        throw new UnsafeNetworkUrlError(
            UnsafeUrlRefusal.MalformedUrl,
            'URL must be an absolute http or https URL.',
        );
    }
    if (!['http:', 'https:'].includes(url.protocol) || (httpsOnly && url.protocol !== 'https:')) {
        throw new UnsafeNetworkUrlError(
            UnsafeUrlRefusal.UnsupportedProtocol,
            httpsOnly ? 'URL must use https.' : 'URL must use http or https.',
        );
    }
    if (url.username || url.password) {
        throw new UnsafeNetworkUrlError(
            UnsafeUrlRefusal.CredentialsPresent,
            'URL credentials are not allowed.',
        );
    }

    const hostname = normalizeHostname(url.hostname);
    if (hostname.length === 0) {
        throw new UnsafeNetworkUrlError(UnsafeUrlRefusal.MalformedUrl, 'URL hostname is required.');
    }
    const privateName =
        hostname === 'localhost' ||
        METADATA_HOSTNAMES.has(hostname) ||
        PRIVATE_HOSTNAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
    const literalIpv4 = parseIpv4(hostname);
    const literalIpv6 = parseIpv6(hostname);
    if (privateName || ((literalIpv4 || literalIpv6) && isUnsafeIpAddress(hostname))) {
        throw new UnsafeNetworkUrlError(
            UnsafeUrlRefusal.NonPublicHost,
            `URL hostname '${hostname}' is non-public.`,
        );
    }

    if (!literalIpv6) {
        url.hostname = hostname;
    }
    return url;
}

/**
 * Resolve a hostname through the operating system resolver.
 *
 * @param hostname - Public hostname to resolve.
 * @returns Every IPv4 and IPv6 address returned by the resolver.
 */
export async function defaultHostnameResolver(hostname: string): Promise<string[]> {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    return addresses.map((entry) => entry.address);
}

/**
 * Canonicalize a configured reported URL to the exact origin navigation may use.
 *
 * @param rawUrl - Reported issue URL or an already canonical origin.
 * @returns Lowercase, default-port-normalized HTTP origin.
 */
export function canonicalHttpOrigin(rawUrl: string): string {
    return parseHttpUrl(rawUrl, false).origin;
}

/**
 * Validate that an outbound URL is public and satisfies origin or hostname constraints.
 *
 * DNS is checked before the caller performs network I/O. Every returned address must be public so
 * dual-stack hostnames cannot hide a private target behind one safe record.
 *
 * @param rawUrl - Untrusted absolute URL.
 * @param options - Origin, allowlist, protocol, and resolver constraints.
 * @returns Parsed URL after all checks succeed.
 */
export async function validatePublicHttpUrl(
    rawUrl: string,
    options: PublicHttpUrlOptions = {},
): Promise<URL> {
    const url = parseHttpUrl(rawUrl, options.httpsOnly ?? false);
    const hostname = normalizeHostname(url.hostname);
    if (readsWithheldRepository(url)) {
        throw new UnsafeNetworkUrlError(
            UnsafeUrlRefusal.WithheldRepository,
            'URL reads the filter repository the reports come from, which this run must not see.',
        );
    }
    if (options.expectedOrigins) {
        const expectedOrigins = options.expectedOrigins.map(canonicalHttpOrigin);
        if (!expectedOrigins.includes(url.origin)) {
            const quoted = expectedOrigins.map((origin) => `'${origin}'`).join(', ');
            throw new UnsafeNetworkUrlError(
                UnsafeUrlRefusal.OriginMismatch,
                expectedOrigins.length === 1
                    ? `URL must remain on configured issue origin ${quoted}.`
                    : `URL must remain on the configured issue origins ${quoted}.`,
            );
        }
    }
    if (options.allowedHostnames) {
        const allowed = options.allowedHostnames.map(normalizeHostname);
        if (!allowed.includes(hostname)) {
            throw new UnsafeNetworkUrlError(
                UnsafeUrlRefusal.HostNotAllowlisted,
                `URL hostname '${hostname}' is not allowlisted.`,
            );
        }
    }

    if (!parseIpv4(hostname) && !parseIpv6(hostname)) {
        let addresses: string[];
        try {
            addresses = await (options.resolveHostname ?? defaultHostnameResolver)(hostname);
        } catch (error) {
            throw new UnsafeNetworkUrlError(
                UnsafeUrlRefusal.DnsUnresolved,
                `DNS resolution failed for '${hostname}': ${(error as Error).message}`,
            );
        }
        if (addresses.length === 0) {
            throw new UnsafeNetworkUrlError(
                UnsafeUrlRefusal.DnsUnresolved,
                `DNS resolution returned no addresses for '${hostname}'.`,
            );
        }
        const unsafeAddress = addresses.find(isUnsafeIpAddress);
        if (unsafeAddress) {
            throw new UnsafeNetworkUrlError(
                UnsafeUrlRefusal.NonPublicHost,
                `Hostname '${hostname}' resolves to non-public address '${unsafeAddress}'.`,
            );
        }
    }
    return url;
}
