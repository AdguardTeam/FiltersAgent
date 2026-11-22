import { runTokenValues } from '../../src/config/run-token';
import { gitHttpBasicCredential } from '../../src/local/git-http-auth';

/**
 * Placeholder written in place of diagnostic secrets.
 */
const REDACTED = '[redacted]';

/**
 * Token shapes that must be removed even when the exact environment value is unavailable.
 */
const TOKEN_PATTERNS = [
    /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    /\bsk-[A-Za-z0-9_-]{8,}/g,
    /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{8,}/g,
    /\bglpat-[A-Za-z0-9_-]{8,}/g,
    /\bxox[baprs]-[A-Za-z0-9-]{8,}/g,
];

/**
 * Collect exact credentials and endpoint values that must not enter retained diagnostics.
 *
 * Retired provider environment names stay scrubbed so a stale local `.env` can never leak its
 * values into retained diagnostics, even though the configuration loader ignores them.
 *
 * @param env - Runtime environment containing optional GitHub and LLM configuration.
 * @returns Exact values supplied to the text redactor.
 */
export function diagnosticSecretsFromEnvironment(
    env: Record<string, string | undefined>,
): Array<string | undefined> {
    return [
        // Every token the environment holds, its variable unread here: a conflicting environment
        // still carries two secrets the resolver never returns. Git sends each one base64-encoded
        // inside a basic-auth header, so that form is masked too.
        ...runTokenValues(env).flatMap((token) => [token, gitHttpBasicCredential(token)]),
        env.LLM_API_KEY,
        env.ADGUARD_LICENSE_KEY,
        env.LLM_BASE_URL,
        env.OPENROUTER_API_KEY,
        env.OPENROUTER_BASE_URL,
    ];
}

/**
 * Deduplicate exact secrets and order longer values first to prevent partial replacement.
 *
 * @param secrets - Optional environment secret values.
 * @returns Non-empty unique secrets ordered from longest to shortest.
 */
function orderExactSecrets(secrets: Array<string | undefined>): string[] {
    const ordered: string[] = [];
    for (const secret of new Set(secrets.filter((value): value is string => Boolean(value)))) {
        const insertionIndex = ordered.findIndex((value) => value.length < secret.length);
        if (insertionIndex === -1) {
            ordered.push(secret);
        } else {
            ordered.splice(insertionIndex, 0, secret);
        }
    }
    return ordered;
}

/**
 * Redact one diagnostic text fragment using exact secrets and known token shapes.
 *
 * @param text - Diagnostic text that may contain credentials.
 * @param secrets - Exact secret values read from environment variables by the caller.
 * @returns Diagnostic text safe to persist in retained workflow artifacts.
 */
export function redactDiagnosticText(text: string, secrets: Array<string | undefined>): string {
    const exactSecrets = orderExactSecrets(secrets);
    let redacted = text;
    for (const secret of exactSecrets) {
        redacted = redacted.split(secret).join(REDACTED);
    }
    for (const pattern of TOKEN_PATTERNS) {
        redacted = redacted.replace(pattern, REDACTED);
    }
    return redacted;
}
