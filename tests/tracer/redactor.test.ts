import { describe, it, expect } from 'vitest';
import { RedactionScope, redactText, REDACTED } from '../../src/tracer/redact-text';
import { redactPayload } from '../../src/tracer/redactor';

function hasUnsafeControl(value: string): boolean {
    return Array.from(value).some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return (
            (codePoint >= 0 && codePoint <= 8) ||
            (codePoint >= 11 && codePoint <= 31) ||
            (codePoint >= 127 && codePoint <= 159)
        );
    });
}

describe('redactPayload', () => {
    it('returns null/undefined/numbers as-is', () => {
        expect(redactPayload(null)).toBeNull();
        expect(redactPayload(undefined)).toBeUndefined();
        expect(redactPayload(42)).toBe(42);
        expect(redactPayload(true)).toBe(true);
    });

    it('redacts top-level sensitive keys', () => {
        const result = redactPayload({
            authorization: 'Bearer xyz',
            cookie: 'session=abc',
            token: 'tok123',
            apikey: 'key456',
            secret: 's3cr3t',
            normal: 'keep-me',
        }) as Record<string, unknown>;

        expect(result.authorization).toBe(REDACTED);
        expect(result.cookie).toBe(REDACTED);
        expect(result.token).toBe(REDACTED);
        expect(result.apikey).toBe(REDACTED);
        expect(result.secret).toBe(REDACTED);
        expect(result.normal).toBe('keep-me');
    });

    it('redacts keys containing token/secret/password/credential substrings', () => {
        const result = redactPayload({
            myTokenField: 'abc',
            userSecretCode: 'xyz',
            oldPasswordHash: 'hash123',
            credentialStore: 'store',
            normalKey: 'ok',
        }) as Record<string, unknown>;

        expect(result.myTokenField).toBe(REDACTED);
        expect(result.userSecretCode).toBe(REDACTED);
        expect(result.oldPasswordHash).toBe(REDACTED);
        expect(result.credentialStore).toBe(REDACTED);
        expect(result.normalKey).toBe('ok');
    });

    it('preserves numeric LLM token-usage metrics while redacting actual credentials', () => {
        const result = redactPayload({
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 120,
            cachedInputTokens: 40,
            reasoningTokens: 5,
            promptTokens: 'credential-disguised-as-a-metric',
            accessToken: 'secret-value',
        }) as Record<string, unknown>;

        expect(result).toEqual({
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 120,
            cachedInputTokens: 40,
            reasoningTokens: 5,
            promptTokens: REDACTED,
            accessToken: REDACTED,
        });
    });

    it('keeps null token counters from a failed provider attempt as null', () => {
        const failedAttempt = {
            outcome: 'failed',
            errorCategory: 'request_timeout',
            inputTokens: null,
            cachedInputTokens: null,
            outputTokens: null,
            reasoningTokens: null,
            totalTokens: null,
        };

        expect(redactPayload(failedAttempt)).toStrictEqual(failedAttempt);
    });

    it('never converts absence under a sensitive key into the placeholder string', () => {
        const result = redactPayload({
            token: null,
            apiKey: undefined,
            secret: 'still-hidden',
        }) as Record<string, unknown>;

        expect(result.token).toBeNull();
        expect(result.apiKey).toBeUndefined();
        expect(result.secret).toBe(REDACTED);
    });

    it('redacts nested sensitive keys', () => {
        const result = redactPayload({
            outer: {
                authorization: 'Bearer nested-token',
                data: 'keep',
                inner: {
                    api_key: 'deep-secret',
                    ok: 'fine',
                },
            },
        }) as Record<string, unknown>;

        const outer = result.outer as Record<string, unknown>;
        expect(outer.authorization).toBe(REDACTED);
        expect(outer.data).toBe('keep');
        const inner = outer.inner as Record<string, unknown>;
        expect(inner.api_key).toBe(REDACTED);
        expect(inner.ok).toBe('fine');
    });

    it('redacts arrays of sensitive objects', () => {
        const result = redactPayload([
            { name: 'a', token: 't1' },
            { name: 'b', token: 't2' },
        ]) as Array<Record<string, unknown>>;

        expect(result).toHaveLength(2);
        expect(result[0].name).toBe('a');
        expect(result[0].token).toBe(REDACTED);
        expect(result[1].name).toBe('b');
        expect(result[1].token).toBe(REDACTED);
    });

    it('redacts Bearer token string values', () => {
        const result = redactPayload({
            auth: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgN2HG3zz3g',
        }) as Record<string, unknown>;

        expect(result.auth).toBe(REDACTED);
    });

    it('redacts JWT-looking string values', () => {
        const result = redactPayload({
            data: 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyIjoiYWxpY2UifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
        }) as Record<string, unknown>;

        expect(result.data).toBe(REDACTED);
    });

    it('redacts API key prefix patterns', () => {
        const result = redactPayload({
            key1: 'sk-proj-abc123def456',
            key2: 'ghp_abc123def4567890',
            key3: 'github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZ',
            key4: 'glpat-abcdefghijklmnop',
            key5: 'xoxb-123456789012-123456789012-abcdefghijklmnopqrstuv',
        }) as Record<string, unknown>;

        expect(result.key1).toBe(REDACTED);
        expect(result.key2).toBe(REDACTED);
        expect(result.key3).toBe(REDACTED);
        expect(result.key4).toBe(REDACTED);
        expect(result.key5).toBe(REDACTED);
    });

    it('redacts sensitive query params in URL strings', () => {
        const result = redactPayload({
            url: 'https://example.com/page?token=secret123&page=1&auth=abc',
        }) as Record<string, unknown>;

        expect(result.url).toBe('https://example.com/page?token=[redacted]&page=1&auth=[redacted]');
    });

    it('redacts exact host secrets embedded in nested diagnostics', () => {
        const result = redactPayload(
            {
                failure: {
                    message: 'Provider rejected company-managed-key during retry.',
                },
            },
            ['company-managed-key'],
        ) as { failure: { message: string } };

        expect(result.failure.message).toBe('Provider rejected [redacted] during retry.');
    });

    it('redacts embedded token-like values and unsafe controls in nested model text', () => {
        const result = redactPayload({
            rationale: 'Prefix sk-agent-secret suffix\u0000\u001f\u007f\u0085.',
            evidence: ['line one\nline two\tkept'],
        }) as { rationale: string; evidence: string[] };

        expect(result.rationale).toBe('Prefix [redacted] suffix    .');
        expect(result.evidence).toEqual(['line one\nline two\tkept']);
        expect(hasUnsafeControl(result.rationale)).toBe(false);
    });

    it('applies exact-secret and control sanitization through the shared text boundary', () => {
        expect(redactText('before exact-secret\u0001 after', ['exact-secret'])).toBe(
            'before [redacted]  after',
        );
    });

    it('scrubs header lines, URL credentials, mixed-case token params and embedded JWTs', () => {
        // One text rule table: these four scrubs used to exist only in the browser evidence
        // redactor, so a diagnostic reaching disk through the trace/publication path kept the
        // credential the evidence path removed.
        const result = redactPayload({
            transcript:
                'Authorization: Bearer live-key\n' +
                'GET https://user:pass@example.test/cb?ToKeN=live-key&page=2\n' +
                'cookie eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyIjoiYWxpY2UifQ.SflKxwRJSMeKKF2QT4fw seen',
        }) as { transcript: string };

        expect(result.transcript).toContain('Authorization: [redacted]');
        expect(result.transcript).not.toContain('user:pass');
        expect(result.transcript).toContain('ToKeN=[redacted]');
        expect(result.transcript).toContain('page=2');
        expect(result.transcript).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    });

    it('keeps page-authored evidence the model needs, while the persisted copy scrubs it', () => {
        // The header-line and URL rules match on SHAPE, not on secrecy, so they also match
        // evidence: a consent banner's DOM line and a URL the reporter quoted in the issue.
        // Rewriting those in a persisted artifact is right; rewriting them in the tool result the
        // model is investigating removes the very bytes the selector and the repro come from.
        // `url` is the same URL as the one quoted in `dom`, and the two must reach the model as
        // the same string: a tool result reporting the page's address and the issue text quoting
        // it cannot disagree, or the model reads one page as two.
        const evidence = {
            dom: 'Cookie: settings\nSee https://shop.example/checkout?sid=abc&step=2',
            url: 'https://shop.example/checkout?sid=abc&step=2',
            credential: 'Bearer live-key',
            log: 'stored eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyIjoiYWxpY2UifQ.SflKxwRJSMeKKF2QT4fw now',
        };

        const modelFacing = redactPayload(evidence, [], {
            scope: RedactionScope.ModelFacing,
        }) as typeof evidence;
        expect(modelFacing.dom).toContain('Cookie: settings');
        expect(modelFacing.dom).toContain('sid=abc');
        expect(modelFacing.url).toBe(evidence.url);
        expect(modelFacing.dom).toContain(modelFacing.url);
        // Credentials are scrubbed in both scopes: what differs is page-authored text, not secrets.
        expect(modelFacing.credential).toBe(REDACTED);
        expect(modelFacing.log).not.toContain('eyJhbGciOiJIUzI1NiJ9');

        const persisted = redactPayload(evidence) as typeof evidence;
        expect(persisted.dom).toContain('Cookie: [redacted]');
        expect(persisted.dom).toContain('sid=[redacted]');
        expect(persisted.url).toBe('https://shop.example/checkout?sid=[redacted]&step=2');
        expect(persisted.credential).toBe(REDACTED);
        expect(persisted.log).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    });

    it('still scrubs an exact host secret carried inside a model-facing URL', () => {
        // The scope relaxes the shape rules, never the secrets: a configured host value that
        // happens to travel in a URL query is a credential wherever it appears.
        const result = redactPayload(
            { url: 'https://api.example/v1?apiKey=live-key&page=2' },
            ['live-key'],
            { scope: RedactionScope.ModelFacing },
        ) as { url: string };

        expect(result.url).toBe('https://api.example/v1?apiKey=[redacted]&page=2');
    });

    it('does not mutate the input', () => {
        const input = { token: 'secret', nested: { password: 'pw' } };
        const result = redactPayload(input) as Record<string, unknown>;

        expect(input.token).toBe('secret');
        expect((input.nested as Record<string, string>).password).toBe('pw');
        expect(result.token).toBe(REDACTED);
    });

    it('handles empty objects and arrays', () => {
        expect(redactPayload({})).toEqual({});
        expect(redactPayload([])).toEqual([]);
    });

    it('keeps requested identifiers distinct while still hiding their values', () => {
        const payload = {
            sessions: [{ sessionId: 'alpha' }, { sessionId: 'beta' }, { sessionId: 'alpha' }],
            binding: { sessionId: 'beta' },
            token: 'ghp_secret',
        };

        const result = redactPayload(payload, [], { pseudonymizeKeys: ['sessionId'] }) as {
            sessions: Array<{ sessionId: string }>;
            binding: { sessionId: string };
            token: string;
        };

        // Cross-field invariants bind evidence to exactly one session, so equal ids must stay
        // equal and distinct ids must stay distinct — while no raw value survives.
        expect(result.sessions[0].sessionId).toBe(result.sessions[2].sessionId);
        expect(result.sessions[0].sessionId).not.toBe(result.sessions[1].sessionId);
        expect(result.binding.sessionId).toBe(result.sessions[1].sessionId);
        expect(JSON.stringify(result)).not.toContain('alpha');
        expect(JSON.stringify(result)).not.toContain('beta');
        expect(result.token).toBe('[redacted]');
    });

    it('still blanks identifiers that were not requested as pseudonyms', () => {
        const result = redactPayload({
            sessions: [{ sessionId: 'alpha' }, { sessionId: 'beta' }],
        }) as { sessions: Array<{ sessionId: string }> };

        expect(result.sessions[0].sessionId).toBe('[redacted]');
        expect(result.sessions[1].sessionId).toBe('[redacted]');
    });

    it('does not redact normal string content', () => {
        const result = redactPayload({
            message: 'Hello world',
            url: 'https://example.com/page?q=search',
            count: '42',
        }) as Record<string, unknown>;

        expect(result.message).toBe('Hello world');
        expect(result.url).toBe('https://example.com/page?q=search');
        expect(result.count).toBe('42');
    });
});

describe('cache counters', () => {
    it('keeps the per-response cache counters a run needs to measure its context size', () => {
        const out = redactPayload({
            promptTokens: 10_138,
            cacheReadTokens: 93_000,
            cacheWriteTokens: 4_200,
            apiToken: 'sk-live-secret',
        }) as Record<string, unknown>;
        expect(out.cacheReadTokens).toBe(93_000);
        expect(out.cacheWriteTokens).toBe(4_200);
        expect(out.apiToken).not.toBe('sk-live-secret');
    });
});
