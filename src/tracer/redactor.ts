import { REDACTED, RedactionScope, redactText } from './redact-text';
import { UsageModelRatesSchema } from '../types/usage-summary';

/**
 * The structured half of redaction: the sensitive-key table and the recursive payload walk every
 * artifact this codebase persists goes through.
 *
 * Objects and arrays are walked key by key; every string that survives its key's verdict is handed
 * to `redactText` in `redact-text.ts`, which owns the ONE text rule table (whole-value credential
 * verdicts, header lines, URLs, JWTs, token prefixes, exact host secrets, control characters). This
 * module therefore decides only WHICH values are hidden wholesale by name, never how a string is
 * scrubbed.
 */

/**
 * Key names (lowercase, exact match) whose values are unconditionally redacted.
 */
const REDACT_KEYS = new Set([
    'authorization',
    'cookie',
    'set-cookie',
    'token',
    'apikey',
    'api_key',
    'secret',
    'password',
    'passwd',
    'credential',
    'jwt',
    'accesstoken',
    'access_token',
    'refreshtoken',
    'refresh_token',
    'sessionid',
    'session_id',
    'x-api-key',
    'x-csrf-token',
    'csrf',
    'csrf-token',
    'bearer',
    'auth',
]);

/**
 * Key names (lowercase, substring match) whose values are unconditionally redacted.
 */
const REDACT_KEY_SUBSTRINGS = ['token', 'secret', 'password', 'credential'];

/**
 * Normalized numeric usage fields whose names contain "token" but whose values are metrics or
 * prices rather than credentials. Shared with the generic evidence redactor so every redaction pass
 * agrees on which finite numbers survive.
 */
export const SAFE_TOKEN_METRIC_KEYS = new Set([
    'prompttokens',
    'completiontokens',
    'inputtokens',
    'outputtokens',
    'totaltokens',
    'cachedinputtokens',
    'reasoningtokens',
    'imagetokens',
    // Context sizes pi reports around a compaction. Without them the compaction trace event reads
    // "[redacted]" exactly where it should say how much context the rewrite traded away.
    'tokensbefore',
    'estimatedtokensafter',
    // Per-response cache counters. They are the only per-turn evidence of the real context size
    // (the pi path reports prompt tokens cache-exclusive), so scrubbing them hid how close a run
    // sat to the window.
    'cachereadtokens',
    'cachewritetokens',
    // The Usage Summary's per-model price table, every key `UsageModelRatesSchema` declares.
    // These are configured USD prices, not credentials, and the schema requires numbers: without
    // the exemption every rate published beside a run becomes "[redacted]" and the artifact fails
    // its own re-parse, which fails the whole publication closed after the run has already been
    // paid for. Read from the schema rather than listed here: a hand-copied list misses a key the
    // schema gains (such as `cacheWriteUsdPerMillionTokens`), and every finished analysis of the
    // run is then thrown away on exactly that key.
    ...Object.keys(UsageModelRatesSchema.entries).map((key) => key.toLowerCase()),
]);

/**
 * Determine whether a string key should have its value redacted.
 *
 * @param key - The key name to check.
 * @param value - Value stored under the key; absent values and finite metric numbers are exempt.
 * @param extraKeyPatterns - Caller-supplied key patterns applied on top of the generic rules; a
 *   pass that carries PII the credential rules do not name (see `RedactPayloadOptions`) states them
 *   here so the preserved-container exemption still governs both.
 * @returns `true` if the key matches a redaction rule.
 */
function isSensitiveKey(
    key: string,
    value: unknown,
    extraKeyPatterns: readonly RegExp[] = [],
): boolean {
    // Absence carries no secret content, and the placeholder string breaks `number | null`
    // schema fields downstream: a timed-out provider attempt records null token counters, and
    // the publish workflow rejects `"[redacted]"` where the usage schema requires a number.
    if (value === null || value === undefined) {
        return false;
    }
    const lower = key.toLowerCase().trim();
    const normalized = lower.replace(/[^a-z0-9]/gu, '');
    if (
        SAFE_TOKEN_METRIC_KEYS.has(normalized) &&
        typeof value === 'number' &&
        Number.isFinite(value)
    ) {
        return false;
    }
    if (REDACT_KEYS.has(lower)) {
        return true;
    }
    if (REDACT_KEY_SUBSTRINGS.some((sub) => lower.includes(sub))) {
        return true;
    }
    return extraKeyPatterns.some((pattern) => pattern.test(key));
}

/**
 * Bound one failure diagnostic after applying shared secret and control-character redaction.
 *
 * Lives beside the payload walk rather than with the text rules because it is the other value-level
 * entry point callers reach for: a caught error, like a payload, is a value of unknown shape that
 * has to become one bounded safe string.
 *
 * @param error - Error or arbitrary failure value raised by a runtime boundary.
 * @param exactSecrets - Exact host-only values that must not be serialized.
 * @param maxLength - Maximum persisted diagnostic length.
 * @returns Non-empty bounded diagnostic safe for local persistence.
 */
export function sanitizeFailureMessage(
    error: unknown,
    exactSecrets: readonly string[],
    maxLength = 1_000,
): string {
    const source = error instanceof Error ? error.message : String(error);
    const message = redactText(source, exactSecrets).trim();
    return (message || 'Unknown failure.').slice(0, maxLength);
}

/**
 * Options controlling how one redaction pass hides values.
 */
export interface RedactPayloadOptions {
    /**
     * Sensitive keys whose values become stable per-pass placeholders instead of one shared
     * `[redacted]`. The raw value never survives, but equal values stay equal and distinct values
     * stay distinct, so invariants that compare identifiers across a document still hold.
     */
    pseudonymizeKeys?: readonly string[];

    /**
     * Lowercase schema-required keys exempted from whole-value key redaction: their contents are
     * still walked and redacted value-by-value, but the container itself survives. Used for
     * structural keys whose names accidentally match the generic sensitive-key heuristics (e.g. a
     * usage summary's numeric `tokens` container).
     */
    preservedStructuredKeys?: ReadonlySet<string>;

    /**
     * Extra key patterns whose values are blanked, applied on top of the generic credential rules
     * and subject to the same `preservedStructuredKeys` exemption. The generic rules name
     * credentials; a pass that must also hide PII the credential rules say nothing about — a
     * reporter's login, an address, an account id — declares those patterns at its own call site,
     * next to the artifacts it is about to publish.
     */
    sensitiveKeyPatterns?: readonly RegExp[];

    /**
     * What this pass is producing. Defaults to `persisted`; a pass answering the model mid-run
     * passes `model-facing` so page-authored evidence survives (see {@link RedactionScope}).
     */
    scope?: RedactionScope;
}

/**
 * Recursively redact sensitive values from a payload.
 *
 * Returns a deep copy; never mutates the input. Handles nested objects, arrays, and primitive
 * values. Redacts both by sensitive key name and by sensitive value pattern.
 *
 * @param payload - The payload to redact (objects, arrays, primitives).
 * @param exactSecrets - Exact host-only values to remove from arbitrary nested strings.
 * @param options - Preserved containers, pseudonymized and extra sensitive keys, and the scope.
 * @returns A deep copy with sensitive values replaced by `[redacted]`.
 */
export function redactPayload(
    payload: unknown,
    exactSecrets: readonly string[] = [],
    options: RedactPayloadOptions = {},
): unknown {
    const seen = new WeakMap<object, unknown>();
    const pseudonymKeys = new Set(
        (options.pseudonymizeKeys ?? []).map((key) => key.toLowerCase().replace(/[^a-z0-9]/gu, '')),
    );
    const preservedStructuredKeys = options.preservedStructuredKeys;
    const extraKeyPatterns = options.sensitiveKeyPatterns ?? [];
    const scope = options.scope ?? RedactionScope.Persisted;
    const pseudonyms = new Map<string, string>();

    /**
     * Replace one identifier with a stable placeholder that keeps distinct values distinct.
     *
     * @param value - Raw identifier being hidden.
     * @returns Deterministic placeholder for this redaction pass.
     */
    function pseudonym(value: string): string {
        const existing = pseudonyms.get(value);
        if (existing !== undefined) {
            return existing;
        }
        const assigned = `[redacted-${pseudonyms.size + 1}]`;
        pseudonyms.set(value, assigned);
        return assigned;
    }

    /**
     * Apply generic credential rules to one already scoped-redacted value.
     *
     * @param current - Current nested value.
     * @returns Independent generic-redacted projection.
     */
    function visit(current: unknown): unknown {
        if (current === null || current === undefined) {
            return current;
        }
        if (Array.isArray(current)) {
            const prior = seen.get(current);
            if (prior !== undefined) {
                return prior;
            }
            const result: unknown[] = [];
            seen.set(current, result);
            for (const item of current) {
                result.push(visit(item));
            }
            return result;
        }
        if (typeof current === 'object') {
            const prior = seen.get(current);
            if (prior !== undefined) {
                return prior;
            }
            const result: Record<string, unknown> = {};
            seen.set(current, result);
            for (const [key, value] of Object.entries(current as Record<string, unknown>)) {
                const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/gu, '');
                const isPreserved =
                    preservedStructuredKeys !== undefined &&
                    preservedStructuredKeys.has(key.toLowerCase());
                if (isPreserved) {
                    // Structure must survive (schema-required); string values follow the same
                    // pseudonym/text redaction as their non-preserved counterparts, contents of
                    // containers are still walked below.
                    result[key] =
                        typeof value === 'string'
                            ? pseudonymKeys.has(normalizedKey)
                                ? pseudonym(value)
                                : redactText(value, exactSecrets, scope)
                            : visit(value);
                } else if (isSensitiveKey(key, value, extraKeyPatterns)) {
                    result[key] =
                        typeof value === 'string' && pseudonymKeys.has(normalizedKey)
                            ? pseudonym(value)
                            : REDACTED;
                } else if (typeof value === 'string') {
                    result[key] = redactText(value, exactSecrets, scope);
                } else {
                    result[key] = visit(value);
                }
            }
            return result;
        }
        if (typeof current === 'string') {
            return redactText(current, exactSecrets, scope);
        }
        return current;
    }

    return visit(payload);
}
