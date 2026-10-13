import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { AgentObservation } from '../../src/types/agent-run-artifacts';
import { ToolName } from '../../src/agent/tool-names';
import {
    collectMissingInformation,
    logMissingInformation,
} from '../../src/orchestrator/fix-run-missing-information';
import { RuleGuidanceNotice } from '../../src/knowledge/instruction-serving';
import {
    MAX_MISSING_INFORMATION_ENTRIES,
    MAX_MISSING_INFORMATION_SUBJECT_CHARACTERS,
} from '../../src/types/missing-information';

/**
 * The not-linked notice payload a lookup_rule_guidance result carries for an unbound topic.
 */
const NOT_LINKED_RESULT = {
    topic: 'element_hiding',
    guidance: 'No syntax document is linked by this run instruction.',
    maxCharacters: 8000,
    citations: [],
    notice: RuleGuidanceNotice.NotLinked,
    missingInformation: {
        subject: 'No syntax document is linked for rule guidance topic element_hiding',
        detail:
            'Rule guidance topic element_hiding is defined by the run instruction syntax ' +
            'document(s), but the instruction links no role documents at all.',
    },
};

/**
 * Build one observation as the delivered-frontier sink produces it.
 *
 * @param tool - Tool that produced the result.
 * @param result - Sanitized structured result.
 * @param sequence - Ordered sequence stamp.
 * @returns The observation.
 */
function observation(
    tool: string,
    result: Record<string, unknown>,
    sequence = 0,
): AgentObservation {
    return {
        sequence,
        toolCallId: `obs-${sequence}`,
        tool,
        result,
    };
}

describe('collectMissingInformation', () => {
    it('parses report_missing_information observations into capped entries', () => {
        const entries = [
            ...collectMissingInformation([
                observation(ToolName.ReportMissingInformation, {
                    subject: 'The instruction lacks a contributing guide link',
                    detail: 'The run cannot state where placement rules belong.',
                }),
            ]).entries,
        ];

        expect(entries).toEqual([
            {
                subject: 'The instruction lacks a contributing guide link',
                detail: 'The run cannot state where placement rules belong.',
            },
        ]);
    });

    it('parses the deterministic not-linked guidance notice observation', () => {
        const harvest = collectMissingInformation([
            observation(ToolName.LookupRuleGuidance, NOT_LINKED_RESULT),
        ]);

        expect(harvest.entries).toEqual([NOT_LINKED_RESULT.missingInformation]);
    });

    it('yields a served excerpt guidance result without any entry', () => {
        const harvest = collectMissingInformation([
            observation(ToolName.LookupRuleGuidance, {
                topic: 'network',
                guidance: 'Basic rule syntax excerpt.',
                maxCharacters: 8000,
                citations: [],
            }),
        ]);

        expect(harvest.entries).toEqual([]);
        expect(harvest.droppedCount).toBe(0);
    });

    it('ignores an entry-shaped result that is not its own channel', () => {
        // A served guidance excerpt could accidentally resemble a record; only the signed
        // channels (the report tool and the typed notice) count.
        const harvest = collectMissingInformation([
            observation(ToolName.LookupRuleGuidance, {
                topic: 'network',
                guidance: 'excerpt',
                notice: 'malformed',
                missingInformation: { subject: 'x', detail: 'y', extra: true },
            }),
        ]);

        expect(harvest.entries).toEqual([]);
    });

    it('keeps the first of identical subjects in dispatch order', () => {
        const harvest = collectMissingInformation([
            observation(
                ToolName.ReportMissingInformation,
                { subject: 'No syntax document', detail: 'first detail' },
                0,
            ),
            observation(ToolName.LookupRuleGuidance, NOT_LINKED_RESULT, 1),
            observation(
                ToolName.ReportMissingInformation,
                { subject: 'No syntax document', detail: 'duplicate detail' },
                2,
            ),
        ]);

        expect(harvest.entries.map((entry) => entry.detail)).toEqual([
            'first detail',
            NOT_LINKED_RESULT.missingInformation.detail,
        ]);
    });

    it('caps the block at the report ceiling and reports the dropped count', () => {
        const observations = Array.from(
            { length: MAX_MISSING_INFORMATION_ENTRIES + 3 },
            (_v, index) =>
                observation(
                    ToolName.ReportMissingInformation,
                    { subject: `Gap number ${index}`, detail: `Detail ${index}` },
                    index,
                ),
        );

        const harvest = collectMissingInformation(observations);

        expect(harvest.entries).toHaveLength(MAX_MISSING_INFORMATION_ENTRIES);
        expect(harvest.entries[0]).toEqual({ subject: 'Gap number 0', detail: 'Detail 0' });
        expect(harvest.droppedCount).toBe(3);
    });

    it('ignores malformed entries without failing the harvest', () => {
        const harvest = collectMissingInformation([
            observation(ToolName.ReportMissingInformation, { detail: 'no subject' }),
            observation(ToolName.ReportMissingInformation, {
                subject: 's'.repeat(MAX_MISSING_INFORMATION_SUBJECT_CHARACTERS + 1),
                detail: 'over-bounded',
            }),
            observation(
                ToolName.LookupRuleGuidance,
                'not-an-object' as unknown as Record<string, unknown>,
            ),
        ]);

        expect(harvest.entries).toEqual([]);
        expect(harvest.droppedCount).toBe(0);
    });

    it('returns an empty harvest for observations of unrelated tools', () => {
        const harvest = collectMissingInformation([
            observation('fetch_issue', { raw: {} }),
            observation('apply_rule', { candidate: 'example.com##.ad' }),
        ]);

        expect(harvest).toEqual({ entries: [], droppedCount: 0 });
    });
});

describe('logMissingInformation', () => {
    it('logs each entry with rich context and names the dropped count', () => {
        const info = vi.fn();
        const warn = vi.fn();
        const logger = { info, warn, error: vi.fn() } as unknown as Logger;
        const overflow = Array.from(
            { length: MAX_MISSING_INFORMATION_ENTRIES - 2 },
            (_entry, index) => ({
                subject: `Overflow gap number ${index}`,
                detail: `Overflow detail number ${index}.`,
            }),
        );
        const harvest = collectMissingInformation([
            observation(ToolName.ReportMissingInformation, {
                subject: 'No syntax document',
                detail: 'The run could not consult syntax guidance.',
            }),
            observation(ToolName.LookupRuleGuidance, NOT_LINKED_RESULT),
            ...overflow.map((entry, index) =>
                observation(ToolName.ReportMissingInformation, entry, index + 2),
            ),
            observation(
                ToolName.ReportMissingInformation,
                { subject: 'Gap overflow', detail: 'dropped' },
                MAX_MISSING_INFORMATION_ENTRIES,
            ),
        ]);

        expect(harvest.entries).toHaveLength(MAX_MISSING_INFORMATION_ENTRIES);
        expect(harvest.droppedCount).toBe(1);
        logMissingInformation(logger, harvest);

        expect(info).toHaveBeenCalledTimes(MAX_MISSING_INFORMATION_ENTRIES);
        expect(info).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                subject: 'No syntax document',
                detail: 'The run could not consult syntax guidance.',
            }),
            'missing information recorded',
        );
        expect(info).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                subject: NOT_LINKED_RESULT.missingInformation.subject,
            }),
            'missing information recorded',
        );
        expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({ droppedCount: 1 }),
            'missing information records dropped at the report ceiling',
        );
    });
});
