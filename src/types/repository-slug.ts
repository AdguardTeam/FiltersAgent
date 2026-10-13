/**
 * One segment of a `host/repo` pair naming a git repository on a hosting service.
 */
export interface RepositorySlug {
    /**
     * The account or organization that owns the repository.
     */
    owner: string;

    /**
     * The repository name, without the `.git` clone suffix.
     */
    repo: string;
}

/**
 * Accepts an `owner/repo` slug: each segment starts with an alphanumeric character and continues
 * with alphanumerics, dots, underscores or hyphens. Deliberately permissive about which service the
 * repository lives on, so forks on other owners and self-hosted hosts pass; stricter
 * service-specific checks belong at the seams that talk to those services.
 */
export const REPOSITORY_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/**
 * Matches a scheme-prefixed git URL such as `https://github.com/o/r` or `ssh://git@host/o/r`,
 * capturing nothing itself — only its presence lets the parser know the authority ends at the first
 * `/` of the remainder.
 */
const GIT_URL_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u;

/**
 * Matches an scp-like git URL `user@host:path`, capturing the path after the colon. Anchored, so
 * ordinary paths containing `@` deeper inside are not mistaken for one.
 */
const SCP_LIKE_URL_PATTERN = /^[^:/\s@]+@[^:/\s]+:(.+)$/u;

/**
 * Matches the `.git` suffix that clone URLs append to the repository name.
 */
const GIT_CLONE_SUFFIX_PATTERN = /\.git$/u;

/**
 * Extracts the path part of a git URL, dropping the scheme, userinfo and host. Returns `null` for
 * anything that is not a URL — a bare checkout path carries no repository identity and must not be
 * read as one, even when its tail happens to look like `owner/repo`.
 *
 * @param url The remote URL to take the path from.
 * @returns The path relative to the host, or `null` when the string is not a git URL.
 */
function extractGitUrlPath(url: string): string | null {
    if (GIT_URL_SCHEME_PATTERN.test(url)) {
        const schemeEnd = url.indexOf('//') + 2;
        const remainder = url.slice(schemeEnd);
        if (remainder.startsWith('/')) {
            // Empty authority (`file:///path/to/checkout`): the path starts after the leading slash.
            return remainder.replace(/^\/+/u, '');
        }
        const pathStart = remainder.indexOf('/');
        if (pathStart === -1) {
            return null;
        }
        return remainder.slice(pathStart + 1);
    }
    const scpLikeEnd = SCP_LIKE_URL_PATTERN.exec(url);
    if (scpLikeEnd) {
        return scpLikeEnd[1];
    }
    return null;
}

/**
 * Parses the `owner/repo` slug a git remote URL points at. Accepts scheme URLs
 * (`https://github.com/o/r`, `https://github.com/o/r.git`, `ssh://git@host/o/r.git`) and scp-like
 * URLs (`git@github.com:o/r.git`); the `.git` suffix is stripped. Returns `null` for anything else
 * — including bare checkout paths, so call sites decide how to name the unparsable source in their
 * errors.
 *
 * @param url The remote URL to parse.
 * @returns The slug, or `null` when the URL yields no `owner/repo` pair.
 */
export function parseRepositorySlugFromGitUrl(url: string): RepositorySlug | null {
    const rawPath = extractGitUrlPath(url.trim());
    if (rawPath === null) {
        return null;
    }
    const path = rawPath.replace(/\/+$/u, '').replace(GIT_CLONE_SUFFIX_PATTERN, '');
    const segments = path.split('/');
    if (segments.length !== 2) {
        return null;
    }
    const slug = `${segments[0]}/${segments[1]}`;
    if (!REPOSITORY_SLUG_PATTERN.test(slug)) {
        return null;
    }
    return {
        owner: segments[0],
        repo: segments[1],
    };
}
