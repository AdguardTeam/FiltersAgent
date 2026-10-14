import { describe, it, expect } from 'vitest';
import {
    redactNetworkLog,
    redactSensitiveText,
    redactStorageValues,
    STORAGE_SENSITIVE_KEY_PATTERNS,
} from '../../src/browser/har-redactor';
import { redactPayload } from '../../src/tracer/redactor';
import type { NetworkRequestEntry } from '../../src/browser/browser-interfaces';

/**
 * Walk untrusted structured evidence the way every consumer of this module does: the single payload
 * redactor, told to read the browser layer's key table on top of the credential rules.
 *
 * @param value - Untrusted structured evidence.
 * @param configuredSecrets - Exact Host-configured secrets.
 * @returns Deep sanitized copy.
 */
function redactUntrustedEvidence(value: unknown, configuredSecrets: readonly string[] = []) {
    return redactPayload(value, configuredSecrets, {
        sensitiveKeyPatterns: STORAGE_SENSITIVE_KEY_PATTERNS,
    });
}

describe('redactNetworkLog', () => {
    it('scrubs Cookie request header', () => {
        const entries: NetworkRequestEntry[] = [
            {
                url: 'https://example.com/api',
                method: 'GET',
                resourceType: 'xhr',
                statusCode: 200,
                requestHeaders: { Cookie: 'session=abc123' },
                responseHeaders: {},
            },
        ];
        const redacted = redactNetworkLog(entries);
        expect(redacted[0].requestHeaders['Cookie']).toBe('[redacted]');
    });

    it('scrubs Set-Cookie response header', () => {
        const entries: NetworkRequestEntry[] = [
            {
                url: 'https://example.com/api',
                method: 'GET',
                resourceType: 'xhr',
                statusCode: 200,
                requestHeaders: {},
                responseHeaders: { 'Set-Cookie': 'session=xyz; HttpOnly' },
            },
        ];
        const redacted = redactNetworkLog(entries);
        expect(redacted[0].responseHeaders['Set-Cookie']).toBe('[redacted]');
    });

    it('scrubs Authorization header', () => {
        const entries: NetworkRequestEntry[] = [
            {
                url: 'https://example.com/api',
                method: 'POST',
                resourceType: 'fetch',
                statusCode: 200,
                requestHeaders: { Authorization: 'Bearer eyJhbGciOi...' },
                responseHeaders: {},
            },
        ];
        const redacted = redactNetworkLog(entries);
        expect(redacted[0].requestHeaders['Authorization']).toBe('[redacted]');
    });

    it('scrubs token-like query params from URLs', () => {
        const entries: NetworkRequestEntry[] = [
            {
                url: 'https://ad.example.com/pixel?token=secret123&id=5',
                method: 'GET',
                resourceType: 'image',
                statusCode: 200,
                requestHeaders: {},
                responseHeaders: {},
            },
        ];
        const redacted = redactNetworkLog(entries);
        expect(redacted[0].url).toContain('token=[redacted]');
        expect(redacted[0].url).toContain('id=5');
    });

    it('preserves non-sensitive headers', () => {
        const entries: NetworkRequestEntry[] = [
            {
                url: 'https://example.com/',
                method: 'GET',
                resourceType: 'document',
                statusCode: 200,
                requestHeaders: { Accept: 'text/html', 'User-Agent': 'Chrome' },
                responseHeaders: { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' },
            },
        ];
        const redacted = redactNetworkLog(entries);
        expect(redacted[0].requestHeaders['Accept']).toBe('text/html');
        expect(redacted[0].responseHeaders['Content-Type']).toBe('text/html');
    });

    it('returns a new array (does not mutate input)', () => {
        const entries: NetworkRequestEntry[] = [
            {
                url: 'https://example.com/',
                method: 'GET',
                resourceType: 'document',
                statusCode: 200,
                requestHeaders: { Cookie: 'sess=1' },
                responseHeaders: {},
            },
        ];
        const redacted = redactNetworkLog(entries);
        expect(entries[0].requestHeaders['Cookie']).toBe('sess=1');
        expect(redacted[0].requestHeaders['Cookie']).toBe('[redacted]');
    });
});

describe('redactStorageValues', () => {
    it('redacts localStorage values with sensitive keys', () => {
        const values: Record<string, string> = {
            theme: 'dark',
            access_token: 'eyJfakeheader.eyJfakepayload',
            user_email: 'user@example.com',
            userId: '12345',
            ab_test_group: 'B',
        };
        const redacted = redactStorageValues(values);
        expect(redacted.theme).toBe('dark');
        expect(redacted.access_token).toBe('[redacted]');
        expect(redacted.user_email).toBe('[redacted]');
        expect(redacted.userId).toBe('[redacted]');
        expect(redacted.ab_test_group).toBe('B');
    });

    it('redacts sessionStorage values with sensitive keys', () => {
        const values: Record<string, string> = {
            session_secret: '0xdeadbeef',
            oauth_state: 'random-nonce',
            csrftoken: 'csrf-abc',
            ui_layout: 'compact',
        };
        const redacted = redactStorageValues(values);
        expect(redacted.session_secret).toBe('[redacted]');
        expect(redacted.oauth_state).toBe('[redacted]');
        expect(redacted.csrftoken).toBe('[redacted]');
        expect(redacted.ui_layout).toBe('compact');
    });

    it('detects base64-encoded JWT values', () => {
        const values: Record<string, string> = {
            app_data: 'eyJfakeheader.eyJfakepayload.fakesignature',
            config: 'not-a-jwt',
        };
        const redacted = redactStorageValues(values);
        expect(redacted.app_data).toBe('[redacted]');
        expect(redacted.config).toBe('not-a-jwt');
    });

    it('returns empty object for empty input', () => {
        expect(redactStorageValues({})).toEqual({});
    });

    it('does not mutate input', () => {
        const values = { token: 'secret' };
        const redacted = redactStorageValues(values);
        expect(values.token).toBe('secret');
        expect(redacted.token).toBe('[redacted]');
    });

    it('redacts nested JSON values that contain sensitive keys', () => {
        const values: Record<string, string> = {
            'persist:root': '{"auth":{"token":"abc"},"prefs":{"theme":"dark"}}',
        };
        const redacted = redactStorageValues(values);
        // The whole value is redacted because parsing reveals sensitive sub-keys
        expect(redacted['persist:root']).toBe('[redacted]');
    });
});

describe('generic evidence redaction', () => {
    it('redacts nested mixed-case keys, URL credentials, case-insensitive query names, and secrets', () => {
        const redacted = redactUntrustedEvidence(
            {
                nested: {
                    AuThOrIzAtIoN: 'Bearer configured-secret',
                    url: 'https://user:pass@example.test/?ToKeN=configured-secret&safe=1',
                },
            },
            ['configured-secret'],
        );
        const serialized = JSON.stringify(redacted);

        expect(serialized).not.toContain('configured-secret');
        expect(serialized).not.toContain('user:pass');
        expect(serialized).toContain('[redacted]');
        expect(serialized).toContain('safe=1');
    });

    it('redacts sensitive header lines and configured secrets in plain text', () => {
        const redacted = redactSensitiveText(
            'Authorization: Bearer configured-secret\nvalue=configured-secret\n',
            ['configured-secret'],
        );

        expect(redacted).not.toContain('configured-secret');
        expect(redacted).toContain('Authorization: [redacted]');
    });

    it('keeps finite numeric token metrics while redacting token-named strings', () => {
        const redacted = redactUntrustedEvidence({
            summary: { inputTokens: 1200, total_tokens: 3400, imageTokens: 0 },
            storage: { accessToken: 'secret-string', inputTokens: 'not-a-number' },
        }) as {
            summary: Record<string, unknown>;
            storage: Record<string, unknown>;
        };

        expect(redacted.summary.inputTokens).toBe(1200);
        expect(redacted.summary.total_tokens).toBe(3400);
        expect(redacted.summary.imageTokens).toBe(0);
        expect(redacted.storage.accessToken).toBe('[redacted]');
        expect(redacted.storage.inputTokens).toBe('[redacted]');
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

        expect(redactUntrustedEvidence(failedAttempt)).toStrictEqual(failedAttempt);
    });

    it('never converts absence under a sensitive key into the placeholder string', () => {
        const redacted = redactUntrustedEvidence({
            token: null,
            session: null,
            password: 'still-hidden',
        }) as Record<string, unknown>;

        expect(redacted.token).toBeNull();
        expect(redacted.session).toBeNull();
        expect(redacted.password).toBe('[redacted]');
    });
});
