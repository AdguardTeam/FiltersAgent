import { describe, expect, it } from 'vitest';
import {
    diagnosticSecretsFromEnvironment,
    redactDiagnosticText,
} from '../../../lab/benchmark/diagnostic-redactor';

describe('redactDiagnosticText', () => {
    it('replaces exact environment secrets without exposing their values', () => {
        const output = redactDiagnosticText(
            'github=actions-token-value llm=provider-secret-value',
            ['actions-token-value', 'provider-secret-value'],
        );

        expect(output).toBe('github=[redacted] llm=[redacted]');
    });

    it('redacts bearer, OpenAI-style, GitHub, GitLab, and Slack token patterns', () => {
        const output = redactDiagnosticText(
            [
                'Authorization: Bearer abcdefghijklmnopqrstuvwxyz.123456789',
                'key=sk-proj-abcdefghijklmno',
                'github=ghs_abcdefghijklmnopqrstuvwxyz',
                'gitlab=glpat-abcdefghijklmnop',
                'slack=xoxb-1234567890-abcdefghijklmno',
            ].join('\n'),
            [],
        );

        expect(output).not.toMatch(/Bearer abc|sk-proj|ghs_|glpat-|xoxb-/);
        expect(output.match(/\[redacted\]/g)).toHaveLength(5);
    });

    it('leaves ordinary diagnostics unchanged and ignores empty secret values', () => {
        expect(redactDiagnosticText('browser unavailable: timeout', ['', undefined])).toBe(
            'browser unavailable: timeout',
        );
    });

    it('collects provider credentials, the AdGuard licence, and legacy aliases for workflow redaction', () => {
        expect(
            diagnosticSecretsFromEnvironment({
                GITHUB_TOKEN: 'github-token',
                LLM_API_KEY: 'generic-key',
                ADGUARD_LICENSE_KEY: 'licence-key',
                LLM_BASE_URL: 'https://generic.example/v1?credential=secret',
                OPENROUTER_API_KEY: 'legacy-key',
                OPENROUTER_BASE_URL: 'https://openrouter.example/v1',
            }),
        ).toEqual([
            'github-token',
            // The base64 basic-auth form git sends on the wire must be masked as well.
            Buffer.from('x-access-token:github-token').toString('base64'),
            'generic-key',
            'licence-key',
            'https://generic.example/v1?credential=secret',
            'legacy-key',
            'https://openrouter.example/v1',
        ]);
    });
});
