import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES_DIR = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'tmp',
    'fixtures',
);
const XPI_PATH = join(FIXTURES_DIR, 'ublock-origin-latest.firefox.signed.xpi');
const MIN_XPI_BYTES = 100_000;

export interface UboXpiFixtureReady {
    /**
     * Whether the signed XPI is available.
     */
    ok: true;

    /**
     * Absolute path of the cached signed XPI.
     */
    path: string;
}

export interface UboXpiFixtureUnavailable {
    /**
     * Whether the signed XPI is available; always `false` here.
     */
    ok: false;

    /**
     * The precise fetch or release-shape failure, for a caller that skips with a message.
     */
    reason: string;
}

/**
 * The release metadata slice the XPI fixture needs from the GitHub releases API.
 */
interface UboReleaseMeta {
    /**
     * Downloadable release assets.
     */
    assets?: Array<{
        /**
         * Asset file name; the Firefox build ends `.firefox.signed.xpi`.
         */
        name: string;

        /**
         * Direct download URL of the asset.
         */
        browser_download_url: string;
    }>;

    /**
     * Release tag name, quoted in the failure message when no XPI asset exists.
     */
    tag_name?: string;
}

/**
 * Download and cache the current signed uBlock Origin XPI into the git-ignored `tmp/fixtures/`.
 *
 * Uses only the public GitHub releases API: no credentials. The cache survives across runs; a
 * previous complete download is reused without a network call.
 *
 * @returns The cached XPI path, or the precise reason it is unavailable.
 */
export async function ensureUboXpi(): Promise<UboXpiFixtureReady | UboXpiFixtureUnavailable> {
    if (cachedBytes(XPI_PATH) > MIN_XPI_BYTES) {
        return { ok: true, path: XPI_PATH };
    }
    try {
        const release = await fetch('https://api.github.com/repos/gorhill/uBlock/releases/latest', {
            headers: { 'user-agent': 'filters-agent-integration-test' },
        }).then(async (response) => {
            if (!response.ok) {
                throw new Error(`github api ${response.status}`);
            }
            return (await response.json()) as UboReleaseMeta;
        });
        const asset = (release.assets ?? []).find((candidate) =>
            candidate.name.endsWith('.firefox.signed.xpi'),
        );
        if (!asset) {
            return {
                ok: false,
                reason: `no .firefox.signed.xpi asset on release ${release.tag_name ?? 'unknown'}`,
            };
        }
        const response = await fetch(asset.browser_download_url);
        if (!response.ok) {
            throw new Error(`xpi download failed with ${response.status}`);
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        mkdirSync(FIXTURES_DIR, { recursive: true });
        writeFileSync(XPI_PATH, bytes);
        return { ok: true, path: XPI_PATH };
    } catch (error) {
        return {
            ok: false,
            reason: `ublock origin XPI unavailable: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
}

/**
 * Stat the cached XPI without failing on the missing file.
 *
 * @param path - Candidate cache path.
 * @returns The cached file's size in bytes, or 0 when nothing usable is cached.
 */
function cachedBytes(path: string): number {
    try {
        return statSync(path).size;
    } catch {
        return 0;
    }
}
