/**
 * Web addresses of files in a GitHub repository, pinned to one commit.
 *
 * A comment and a citation link a file at the commit the run read it at, so the link keeps showing
 * the same content however the branch moves on.
 */

/**
 * The origin GitHub serves repository pages and files from in a browser.
 */
const GITHUB_WEB_ORIGIN = 'https://github.com';

/**
 * How GitHub serves a file: rendered in its page, or as its bytes.
 */
export const GitHubFileView = {
    Blob: 'blob',
    Raw: 'raw',
} as const;

/**
 * GitHubFileView value.
 */
export type GitHubFileView = (typeof GitHubFileView)[keyof typeof GitHubFileView];

/**
 * One file at one commit of a GitHub repository.
 */
export interface GitHubFileAddress {
    /**
     * The repository as `owner/repo`.
     */
    repository: string;

    /**
     * The commit the file is read at.
     */
    commit: string;

    /**
     * Repository-relative file path, `/`-separated.
     */
    filePath: string;
}

/**
 * Build the web address of a file at a commit.
 *
 * @param view - Whether GitHub renders the file or serves its bytes.
 * @param address - The repository, commit and file.
 * @param fragment - A fragment without its `#`, such as `L84` for a line or a heading anchor.
 * @returns The absolute URL; each path segment is percent-encoded, so a file name with a space or a
 *   `#` still names the file.
 */
export function gitHubFileUrl(
    view: GitHubFileView,
    address: GitHubFileAddress,
    fragment?: string,
): string {
    const path = address.filePath.split('/').map(encodeURIComponent).join('/');
    const suffix = fragment === undefined ? '' : `#${fragment}`;
    return `${GITHUB_WEB_ORIGIN}/${address.repository}/${view}/${address.commit}/${path}${suffix}`;
}
