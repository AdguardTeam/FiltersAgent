import { JWT_VALUE_PATTERN, REDACTED, redactText, redactUrl } from '../tracer/redact-text';
import type { NetworkRequestEntry } from './browser-interfaces';

/**
 * Browser-evidence redaction: the network-log and storage scrubbers, and the key table that names
 * the PII shapes (`email`, `userId`, bare `id`/`user`) the generic credential rules do not.
 *
 * There is no second walker and no second rule table here any more. Every TEXT rule lives in
 * `tracer/redact-text.ts` — this module's `redactSensitiveText` is that function under the name the
 * browser layer calls it by — and a pass that must walk untrusted structured evidence hands
 * {@link STORAGE_SENSITIVE_KEY_PATTERNS} to `redactPayload`, so the exemptions (absent values,
 * finite token metrics, preserved schema containers) are decided once for every artifact.
 */

/**
 * Header names (lowercase) to scrub from request records.
 */
const REDACT_REQUEST_HEADERS = ['cookie', 'authorization'];

/**
 * Header names (lowercase) to scrub from response records.
 */
const REDACT_RESPONSE_HEADERS = ['set-cookie'];

/**
 * Patterns matching keys that carry sensitive or personal data in page-derived evidence.
 *
 * Two passes read this table: the storage scrubber below, and `redactPayload` whenever it walks
 * untrusted structured evidence (a storage dump, a HAR, a safe-interaction record). The generic
 * credential rules already cover `token`/`secret`/`password`/`credential`; what these add is the
 * PII half — a bare `id`, a `user`, an `email` — plus the substring forms (`sessionKey`, `myJwt`,
 * `csrfValue`) the exact-name credential table does not reach.
 */
export const STORAGE_SENSITIVE_KEY_PATTERNS = [
    /token/i,
    /jwt/i,
    /auth/i,
    /password/i,
    /secret/i,
    /email/i,
    /userid/i,
    /^id$/i,
    /^user$/i,
    /session/i,
    /oauth/i,
    /csrf/i,
    /credential/i,
    /apikey/i,
    /^key$/i,
    /^bearer/i,
];

/**
 * Redact sensitive data from network log entries before persisting to disk.
 *
 * Scrubs Cookie, Authorization, and Set-Cookie headers, plus sensitive query parameters (token,
 * auth, key, secret, apikey, session, sid) from URLs.
 *
 * @param entries - The raw network request entries collected during the session.
 * @returns A deep copy of the entries with sensitive values replaced by `[redacted]`.
 */
export function redactNetworkLog(entries: NetworkRequestEntry[]): NetworkRequestEntry[] {
    return entries.map((entry) => ({
        ...entry,
        url: redactUrl(entry.url),
        requestHeaders: redactHeaders(entry.requestHeaders, REDACT_REQUEST_HEADERS),
        responseHeaders: redactHeaders(entry.responseHeaders, REDACT_RESPONSE_HEADERS),
    }));
}

/**
 * Redact blacklisted header values in a headers record.
 *
 * @param headers - The original headers record.
 * @param blacklist - Header names (lowercase) whose values should be scrubbed.
 * @returns A new headers record with sensitive values replaced by `[redacted]`.
 */
function redactHeaders(
    headers: Record<string, string>,
    blacklist: string[],
): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
        result[key] = blacklist.includes(key.toLowerCase()) ? REDACTED : value;
    }
    return result;
}

/**
 * Redact sensitive URL and header-shaped values from arbitrary text evidence.
 *
 * The browser layer's name for {@link redactText}, kept because the evidence pipeline and the page
 * probes call it by this name; the rules themselves have exactly one implementation.
 *
 * @param value - Untrusted text artifact or nested string value.
 * @param configuredSecrets - Exact Host-configured secrets.
 * @returns Sanitized text.
 */
export function redactSensitiveText(
    value: string,
    configuredSecrets: readonly string[] = [],
): string {
    return redactText(value, configuredSecrets);
}

/**
 * Heuristic check: does a value look like a base64-encoded JWT?
 *
 * JWTs have three dot-separated base64url parts; the first two always start with `eyJ` (the
 * base64url encoding of `{"`).
 *
 * @param value - The storage value to check.
 * @returns `true` if the value appears to be a JWT.
 */
function looksLikeJwt(value: string): boolean {
    return JWT_VALUE_PATTERN.test(value);
}

/**
 * Redact sensitive values from a storage key-value record before returning to the LLM or persisting
 * in the trace.
 *
 * Redacts entries whose key matches a known sensitive pattern (token, jwt, auth, password, secret,
 * email, id, user, session, oauth, csrf, credential, apikey, key, bearer) or whose value looks like
 * a base64-encoded JWT. Also inspects JSON-encoded values for nested sensitive keys.
 *
 * @param values - The raw storage record from `page.evaluate()`.
 * @returns A new record with sensitive values replaced by `[redacted]`.
 */
export function redactStorageValues(values: Record<string, string>): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) {
        if (STORAGE_SENSITIVE_KEY_PATTERNS.some((p) => p.test(key))) {
            result[key] = REDACTED;
        } else if (looksLikeJwt(value)) {
            result[key] = REDACTED;
        } else {
            // Attempt to detect sensitive sub-keys inside JSON-encoded values (e.g. Redux persist)
            try {
                const parsed = JSON.parse(value);
                if (typeof parsed === 'object' && parsed !== null) {
                    const keyStr = JSON.stringify(Object.keys(parsed)).toLowerCase();
                    if (STORAGE_SENSITIVE_KEY_PATTERNS.some((p) => p.test(keyStr))) {
                        result[key] = REDACTED;
                        continue;
                    }
                }
            } catch {
                /* not JSON, keep as-is */
            }
            result[key] = value;
        }
    }
    return result;
}
