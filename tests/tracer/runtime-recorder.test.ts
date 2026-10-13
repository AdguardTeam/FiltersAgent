import { describe, expect, it } from 'vitest';
import { createRuntimeTraceRecorder } from '../../src/tracer/runtime-recorder';

describe('createRuntimeTraceRecorder', () => {
    it('redacts secrets from tool and LLM payloads before serialization', () => {
        const recorder = createRuntimeTraceRecorder({
            runId: 'runtime-redaction',
            issueNumber: 1,
            mode: 'fix',
            now: () => '2026-01-01T00:00:00.000Z',
            exactSecrets: ['company-managed-key'],
        });

        recorder.recordToolCall(
            'example',
            { authorization: 'Bearer secret' },
            { nested: { apiKey: 'sk-secret' } },
        );
        recorder.recordLlmTurn(
            { url: 'https://example.com/?token=secret' },
            { content: 'ok', promptTokens: 1, completionTokens: 1 },
        );
        recorder.record('error', {
            message: 'Provider rejected company-managed-key during retry.',
        });

        const serialized = JSON.stringify(recorder.toJSON());
        expect(serialized).not.toContain('Bearer secret');
        expect(serialized).not.toContain('sk-secret');
        expect(serialized).not.toContain('token=secret');
        expect(serialized).not.toContain('company-managed-key');
        expect(serialized).toContain('[redacted]');
    });
});
