import { parseRepositorySlugFromGitUrl, REPOSITORY_SLUG_PATTERN } from '../types/repository-slug';
import type { RepositorySlug } from '../types/repository-slug';
import { ConfigError } from './config-error';

export type { RepositorySlug };

/**
 * Environment variable carrying the explicit repository owner, always set together with
 * {@link GITHUB_REPO_NAME_VAR}.
 */
export const GITHUB_REPO_OWNER_VAR = 'GITHUB_REPO_OWNER';

/**
 * Environment variable carrying the explicit repository name, always set together with
 * {@link GITHUB_REPO_OWNER_VAR}.
 */
export const GITHUB_REPO_NAME_VAR = 'GITHUB_REPO_NAME';

/**
 * Workflow environment variable (`owner/repo`) carrying the repository, as GitHub Actions exposes
 * it for the run.
 */
export const GITHUB_REPOSITORY_VAR = 'GITHUB_REPOSITORY';

/**
 * Environment variable naming the local checkout the run works with. Its origin remote is the
 * last-resort identity source; the path itself never carries repository identity.
 */
export const REPOSITORY_PATH_VAR = 'REPOSITORY_PATH';

/**
 * Where a repository identity may come from, besides the environment. Sources are resolved in
 * strict precedence order: CLI flag first, checkout origin last.
 */
export interface RepositoryIdentitySources {
    /**
     * The `--repository <owner/repo>` value given on the command line; highest precedence.
     */
    flag?: string | undefined;

    /**
     * The origin URL of the checkout named by {@link REPOSITORY_PATH_VAR}, as read by the CLI
     * seam's git adapter; lowest precedence. Only the URL travels here — the CLI seam never parses
     * or merges slugs itself. `null` means the adapter had no origin to read, never a failure.
     */
    checkoutOriginUrl?: string | null | undefined;
}

/**
 * Read one `owner/repo` value, validating it against the shared slug pattern and splitting it into
 * its segments. The pattern pins exactly one `/`, so the split cannot go out of shape.
 *
 * @param value - The raw candidate value, already trimmed.
 * @param problemPrefix - The source name the error must point at when the value is malformed.
 * @returns The parsed slug.
 */
function parseSlug(value: string, problemPrefix: string): RepositorySlug {
    if (!REPOSITORY_SLUG_PATTERN.test(value)) {
        throw new ConfigError(
            `Repository identity: ${problemPrefix} must be an 'owner/repo' slug, got '${value}'.`,
        );
    }
    const [owner, repo] = value.split('/');
    return { owner, repo };
}

/**
 * Read one optional environment value, collapsing absent and blank into `undefined` so an
 * empty-string variable is treated as unset rather than as a malformed candidate.
 *
 * The one copy of this helper: every other reader of an optional environment or input value
 * (`entry/entry-inputs.ts`, `action/action-input-binding.ts`) imports it instead of respelling it.
 *
 * @param value - The raw environment value.
 * @returns The trimmed value, or `undefined`.
 */
export function optionalEnvValue(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}

/**
 * Render the error thrown when no candidate source yields a repository identity.
 *
 * @returns The message naming every candidate variable, so one read tells the operator all of
 * them.
 */
function missingIdentityMessage(): string {
    return (
        `Repository identity is required: set ${GITHUB_REPO_OWNER_VAR} and ${GITHUB_REPO_NAME_VAR}, ` +
        `or ${GITHUB_REPOSITORY_VAR}, or point ${REPOSITORY_PATH_VAR} at a git checkout with a ` +
        'parseable origin remote.'
    );
}

/**
 * Resolve the repository the run works with, by strict precedence: CLI flag, then the explicit
 * `GITHUB_REPO_OWNER`+`GITHUB_REPO_NAME` pair, then `GITHUB_REPOSITORY`, then the origin slug of
 * the checkout. Pure over (env, sources). A present-but-malformed source fails here — a half-set
 * pair or an unparsable `GITHUB_REPOSITORY` silently falling through would leave the operator
 * believing a repository is configured when nothing is — while an absent or unparsable checkout
 * origin simply yields `null`, because the checkout is a fallback, never a misconfiguration.
 *
 * @param env - Environment source supplied by the caller.
 * @param sources - Explicit non-environment sources (CLI flag, checkout origin URL).
 * @returns The resolved slug, or `null` when no source yields one.
 */
export function resolveRepositoryIdentity(
    env: Readonly<Record<string, string | undefined>>,
    sources: RepositoryIdentitySources = {},
): RepositorySlug | null {
    const flag = optionalEnvValue(sources.flag);
    if (flag !== undefined) {
        return parseSlug(flag, '--repository');
    }

    const owner = optionalEnvValue(env[GITHUB_REPO_OWNER_VAR]);
    const name = optionalEnvValue(env[GITHUB_REPO_NAME_VAR]);
    if (owner !== undefined && name !== undefined) {
        return parseSlug(
            `${owner}/${name}`,
            `${GITHUB_REPO_OWNER_VAR} and ${GITHUB_REPO_NAME_VAR}`,
        );
    }
    if (owner !== undefined || name !== undefined) {
        throw new ConfigError(
            `Repository identity: ${GITHUB_REPO_OWNER_VAR} and ${GITHUB_REPO_NAME_VAR} must be ` +
                'set together; one of them is missing or empty.',
        );
    }

    const githubRepository = optionalEnvValue(env[GITHUB_REPOSITORY_VAR]);
    if (githubRepository !== undefined) {
        return parseSlug(githubRepository, GITHUB_REPOSITORY_VAR);
    }

    const originUrl = optionalEnvValue(sources.checkoutOriginUrl ?? undefined);
    if (originUrl !== undefined) {
        return parseRepositorySlugFromGitUrl(originUrl);
    }
    return null;
}

/**
 * Resolve the repository identity and fail when nothing yields one.
 *
 * Fails with a `ConfigError` naming every candidate variable — for a load that misses nothing but
 * the repository identity, this is the one message the operator must read.
 *
 * @param env - Environment source supplied by the caller.
 * @param sources - Explicit non-environment sources (CLI flag, checkout origin URL).
 * @returns The resolved slug.
 */
export function requireRepositoryIdentity(
    env: Readonly<Record<string, string | undefined>>,
    sources: RepositoryIdentitySources = {},
): RepositorySlug {
    const slug = resolveRepositoryIdentity(env, sources);
    if (slug === null) {
        throw new ConfigError(missingIdentityMessage());
    }
    return slug;
}
