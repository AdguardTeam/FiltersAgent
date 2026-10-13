/**
 * The ONE text rule table this codebase redacts strings with.
 *
 * Whole-value credential verdicts, sensitive header lines, URL userinfo and query parameters, JWTs
 * embedded anywhere in free text, token prefixes, exact host secrets and unsafe control characters.
 * Keeping one table matters: with a second copy of the header/URL/JWT half (in the browser evidence
 * redactor, say) every new exemption has to be taught twice and one pass can scrub what the other
 * preserves.
 *
 * One table, two scopes: {@link RedactionScope} says whether a pass is writing an artifact to disk
 * or answering the model mid-run, and the rules that rewrite PAGE-AUTHORED text rather than
 * credentials — the header-line rule and the URL rule — apply only to the former. See the scope's
 * own note for why.
 *
 * The structured walk that applies these rules key by key lives next door in `redactor.ts`; this
 * module knows nothing about payload shapes.
 */

/**
 * What a redaction pass is producing, which decides how aggressively page-authored text may be
 * rewritten.
 *
 * Both scopes scrub every credential form: a whole value that IS a credential, a JWT anywhere in
 * the text, a token prefix, and the exact host secrets. They differ on two rules that match on
 * SHAPE rather than on secrecy, and that therefore also match evidence:
 *
 * - The header-line rule blanks any line whose first token is `cookie`/`authorization`/`api-key`
 *   followed by `:` or `=` — including a consent banner's DOM line `Cookie: settings`; and
 * - The URL rule scrubs `key`/`session`/`sid`/`auth`/`token` query values out of any URL, whether the
 *   URL is the whole value or quoted inside free text — including the reporter's URL in the issue
 *   body the agent is investigating.
 *
 * In a persisted artifact that trade is right: the artifact leaves the machine, and a blanked
 * consent line costs nothing once the run is over. In a tool result answering the model mid-run it
 * is not: those bytes ARE the investigation — the DOM line the selector is derived from, the URL
 * whose parameters the report is about — and a model that cannot see them cannot find the defect.
 * The URL rule is skipped whole rather than only for embedded URLs so the model never sees the same
 * URL two ways: `fetch_issue`'s `url` field and the copy of it quoted in the issue body are the
 * same string, and a model comparing them must not be told they differ.
 */
export const RedactionScope = {
    /**
     * A value on its way to a file: run traces, evidence artifacts, publication bundles, logs.
     */
    Persisted: 'persisted',

    /**
     * A tool result on its way back to the model inside a live run.
     */
    ModelFacing: 'model-facing',
} as const;

/**
 * RedactionScope value.
 */
export type RedactionScope = (typeof RedactionScope)[keyof typeof RedactionScope];

/**
 * The placeholder string used for redacted values.
 */
export const REDACTED = '[redacted]';

/**
 * Whole value that opens with two base64url-encoded JSON objects: a JWT header and payload.
 *
 * `eyJ` is the base64url encoding of `{"`, so a value beginning `eyJ….eyJ…` is a JWT with near
 * certainty. The leading anchor is what makes this a verdict about the entire value rather than a
 * substring hit, which is why it can drive a whole-value replacement. The browser storage scrubber
 * in `browser/har-redactor.ts` decides the same question against it, so a heuristic that only one
 * of them learned would leave the same token class leaking out of the other artifact.
 */
export const JWT_VALUE_PATTERN = /^eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+/;

/**
 * Complete JWT appearing anywhere inside a free-text artifact.
 *
 * Deliberately not {@link JWT_VALUE_PATTERN}: that one answers "is this whole value a JWT" and is
 * anchored, while this one has to find tokens embedded in log lines, so it is unanchored, global,
 * and demands the third (signature) segment as the terminator that tells it where the token ends.
 * Loosening it the way the anchored form is loose would swallow the surrounding text.
 */
const EMBEDDED_JWT_PATTERN = /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/gu;

/**
 * One credential-bearing header line inside a multi-line text artifact.
 *
 * Line-anchored and multiline so only the header's VALUE is dropped: a subprocess transcript or a
 * diagnostic dump keeps the line that names the header, which is what makes the redacted log still
 * readable as a transcript.
 */
const SENSITIVE_HEADER_LINE_PATTERN =
    /^(\s*(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)\s*[:=]).*$/gimu;

/**
 * Longest scheme this scanner will recognize before the `://`.
 *
 * The bound is what keeps the scan linear, not a statement about scheme names: an unbounded `*`
 * here makes every character of a long value a candidate scheme start that consumes the rest of the
 * value and then backtracks to look for the colon, which is quadratic — a 70 KiB tool-result blob
 * took the redaction pass past a five-second test timeout. Sixteen clears every scheme in use
 * (`https`, `wss`, `chrome-extension`) with room to spare.
 */
const MAX_URL_SCHEME_CHARS = 15;

/**
 * Any absolute URL embedded in free text, up to the first character that cannot be part of one.
 *
 * Scheme-agnostic on purpose: a websocket or file URL carries a query string exactly like an HTTP
 * one, and the scrubber below is a no-op for a URL with nothing sensitive in it, so widening the
 * find costs nothing and closes the gap a scheme allowlist leaves open.
 */
const EMBEDDED_URL_PATTERN = new RegExp(
    `[a-z][a-z0-9+.-]{0,${MAX_URL_SCHEME_CHARS}}://[^\\s"'<>]+`,
    'giu',
);

/**
 * Query parameter names whose values are replaced with the placeholder, matched case-insensitively.
 */
const SENSITIVE_QUERY_PARAMS = [
    'token',
    'auth',
    'key',
    'secret',
    'apikey',
    'api_key',
    'session',
    'sid',
];

/**
 * Strip URL credentials and sensitive query parameter values from one URL.
 *
 * @param url - A URL found as a whole value or embedded in free text.
 * @returns The URL with userinfo dropped and sensitive parameter values replaced, or the input
 *   unchanged when it does not parse or carries nothing sensitive.
 */
export function redactUrl(url: string): string {
    try {
        const parsed = new URL(url);
        let changed = false;
        if (parsed.username.length > 0 || parsed.password.length > 0) {
            parsed.username = '';
            parsed.password = '';
            changed = true;
        }
        for (const param of parsed.searchParams.keys()) {
            if (SENSITIVE_QUERY_PARAMS.includes(param.toLowerCase())) {
                parsed.searchParams.set(param, REDACTED);
                changed = true;
            }
        }
        // `searchParams.set` percent-encodes the placeholder's brackets; the artifacts (and the
        // tests that read them) want the literal placeholder back.
        return changed ? parsed.toString().replaceAll('%5Bredacted%5D', REDACTED) : url;
    } catch {
        return url;
    }
}

/**
 * Patterns that, when matched in a string value, cause the entire value to be redacted.
 */
const SENSITIVE_VALUE_PATTERNS = [
    JWT_VALUE_PATTERN, // JWT header.payload
    /^Bearer\s+/i, // Bearer token
    /^Basic\s+/i, // Basic auth
    /^ghp_/, // GitHub personal access token (classic)
    /^github_pat_/, // GitHub fine-grained token
    /^glpat-/, // GitLab personal access token
    /^sk-/, // OpenAI / LLM API key prefix
    /^xox[bprs]-/, // Slack token
];

/**
 * Determine whether a string value contains sensitive content and should be redacted.
 *
 * @param value - The value to check.
 * @returns `true` if the value matches a known sensitive pattern.
 */
function isSensitiveValue(value: string): boolean {
    return SENSITIVE_VALUE_PATTERNS.some((p) => p.test(value));
}

/**
 * Redact sensitive values from a string.
 *
 * A whole-value credential verdict wins outright; otherwise the value is scrubbed in place, so a
 * log line, a subprocess transcript and a nested model rationale all keep everything around the
 * credential. The passes run in order — header lines, then URLs, then JWTs, then token prefixes —
 * because each later pass must also see what an earlier one rewrote (a JWT inside a URL path
 * survives the URL pass and is caught by the JWT pass).
 *
 * The model-facing scope skips the two shape-matching rules (see {@link RedactionScope}) and keeps
 * only the verdicts that say a value IS a credential.
 *
 * @param value - The string to redact.
 * @param scope - What this pass is producing.
 * @returns The redacted string.
 */
function redactStringValue(value: string, scope: RedactionScope): string {
    if (isSensitiveValue(value)) {
        return REDACTED;
    }
    const shapeRedacted =
        scope === RedactionScope.Persisted
            ? value
                  .replace(SENSITIVE_HEADER_LINE_PATTERN, '$1 [redacted]')
                  .replace(EMBEDDED_URL_PATTERN, (url) => redactUrl(url))
            : value;
    const jwtRedacted = shapeRedacted.replace(EMBEDDED_JWT_PATTERN, REDACTED);
    return jwtRedacted.replace(
        /\b(?:sk-|ghp_|github_pat_|glpat-|xox[bprs]-)[A-Za-z0-9_-]+/gu,
        REDACTED,
    );
}

/**
 * Deduplicate exact host secrets and order longer values before their substrings.
 *
 * @param secrets - Host-only values that must not enter persisted diagnostics.
 * @returns Non-empty unique values ordered from longest to shortest.
 */
function orderedExactSecrets(secrets: readonly string[]): string[] {
    const ordered: string[] = [];
    for (const secret of new Set(secrets.filter((value) => value.length > 0))) {
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
 * Replace unsafe C0, DEL, and C1 controls while preserving tabs and line breaks.
 *
 * @param value - Text that may contain unsafe control characters.
 * @returns Text whose unsafe controls are replaced with spaces.
 */
function replaceUnsafeControls(value: string): string {
    return Array.from(value, (character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        const isUnsafe =
            (codePoint >= 0 && codePoint <= 8) ||
            (codePoint >= 11 && codePoint <= 31) ||
            (codePoint >= 127 && codePoint <= 159);
        return isUnsafe ? ' ' : character;
    }).join('');
}

/**
 * Redact known sensitive forms and exact host secrets from one text fragment.
 *
 * @param value - Text that may contain a credential or sensitive URL.
 * @param exactSecrets - Exact host-only values unavailable to pattern-based redaction.
 * @param scope - What this pass is producing; persisted by default, which is the stricter of the
 *   two and therefore the safe default for a caller that does not say.
 * @returns Text safe to persist in results, reports, and traces.
 */
export function redactText(
    value: string,
    exactSecrets: readonly string[] = [],
    scope: RedactionScope = RedactionScope.Persisted,
): string {
    if (typeof value !== 'string') {
        throw new Error('Scoped text redaction returned an invalid projection.');
    }
    let redacted = redactStringValue(value, scope);
    for (const secret of orderedExactSecrets(exactSecrets)) {
        redacted = redacted.split(secret).join(REDACTED);
    }
    return replaceUnsafeControls(redacted);
}
