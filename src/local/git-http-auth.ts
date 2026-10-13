/**
 * Git HTTP credentials for github.com, delivered through `GIT_CONFIG_*` environment variables.
 *
 * Why the environment and not the URL or argv: the failure paths print the exact git command
 * (`runChecked` in the preparers, the exported `cycle-result.json`), and a token embedded in the
 * clone URL would also persist in `.git/config` of every disposable checkout. `GIT_CONFIG_COUNT`
 * (git 2.31+) keeps the credential out of both and scopes it to one host.
 *
 * Why `basic` with `x-access-token`: that is how actions/checkout authenticates with the workflow
 * token, and GitHub accepts the same form for fine-grained and classic tokens.
 */

/**
 * The only origin these credentials are ever sent to; git scopes the header by URL prefix.
 */
export const GITHUB_HTTP_ORIGIN = 'https://github.com/';

/**
 * Username GitHub expects in basic authentication when the password is an access token.
 */
const GITHUB_TOKEN_BASIC_USER = 'x-access-token';

/**
 * The base64 credential git sends; exported so diagnostics redaction can mask the derived form.
 *
 * @param token - GitHub token.
 * @returns Base64 of `x-access-token:<token>`.
 */
export function gitHttpBasicCredential(token: string): string {
    return Buffer.from(`${GITHUB_TOKEN_BASIC_USER}:${token}`, 'utf8').toString('base64');
}

/**
 * Environment entries that make git send the token on every request to {@link GITHUB_HTTP_ORIGIN}.
 *
 * @param token - GitHub token with read access to the repositories being cloned.
 * @returns Variables to merge into a git subprocess environment.
 */
export function gitHttpAuthEnvironment(token: string): NodeJS.ProcessEnv {
    return {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: `http.${GITHUB_HTTP_ORIGIN}.extraheader`,
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${gitHttpBasicCredential(token)}`,
    };
}
