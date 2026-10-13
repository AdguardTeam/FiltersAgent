import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { AgentRunArtifactsSchema } from '../../src/types/agent-run-artifacts';

describe('AgentRunArtifactsSchema', () => {
    it('accepts an exact model decision and the tool results shown before it', () => {
        const parsed = v.parse(AgentRunArtifactsSchema, {
            decision: {
                outcome: 'analysis_only',
                reasoning: 'The browser evidence was inconclusive.',
            },
            observations: [
                {
                    sequence: 0,
                    toolCallId: 'fetch-1',
                    tool: 'fetch_issue',
                    result: { number: 4, title: 'Ad remains visible' },
                },
            ],
        });

        expect(parsed.decision?.outcome).toBe('analysis_only');
        expect(parsed.observations[0]?.tool).toBe('fetch_issue');
    });

    it('allows a missing model decision when the Host had to stop the loop', () => {
        const parsed = v.parse(AgentRunArtifactsSchema, {
            decision: null,
            observations: [],
        });

        expect(parsed.decision).toBeNull();
    });
});
