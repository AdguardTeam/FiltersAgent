import { describe, expect, it, vi } from 'vitest';
import {
    GuidanceDocumentOrigin,
    GuidanceDocumentRole,
    RuleGuidanceSourceKind,
    type InstructionGuidanceSource,
} from '../../src/knowledge/guidance-source';
import {
    LinkedDocumentDownloadError,
    LinkedDocumentDownloadFailureCode,
} from '../../src/knowledge/linked-document-downloader';
import type { LoadedInstruction } from '../../src/knowledge/instruction-loader';
import type { Logger } from '../../src/logger/logger';
import { resolveRunRuleGuidance } from '../../src/orchestrator/fix-core-inputs';

const DEFAULT_SOURCE: InstructionGuidanceSource = {
    kind: RuleGuidanceSourceKind.Instruction,
    path: 'default',
    sha256: 'b'.repeat(64),
    documents: [
        {
            role: GuidanceDocumentRole.Syntax,
            origin: GuidanceDocumentOrigin.Url,
            url: 'https://example.test/syntax.md',
            content: '## Syntax',
            sha256: 'b'.repeat(64),
        },
    ],
};

const INSTRUCTION = {
    path: 'AGENTS.md',
    content: '# Run instruction',
    sha256: 'a'.repeat(64),
    documents: [],
} as LoadedInstruction;

/**
 * Build a logger whose warnings a test can read.
 *
 * @returns The logger and its warn spy.
 */
function recordingLogger(): { logger: Logger; warn: ReturnType<typeof vi.fn> } {
    const warn = vi.fn();
    return { logger: { warn } as unknown as Logger, warn };
}

describe('resolveRunRuleGuidance', () => {
    it('serves the default guidance when the run has no instruction', async () => {
        const { logger } = recordingLogger();
        const resolved = await resolveRunRuleGuidance(
            { loadDefaultRuleGuidance: async () => DEFAULT_SOURCE },
            logger,
        );

        expect(resolved).toStrictEqual(DEFAULT_SOURCE);
    });

    it('never loads the default when an instruction supplies the guidance', async () => {
        const { logger } = recordingLogger();
        const loadDefaultRuleGuidance = vi.fn(async () => DEFAULT_SOURCE);

        const resolved = await resolveRunRuleGuidance(
            { instruction: INSTRUCTION, loadDefaultRuleGuidance },
            logger,
        );

        expect(resolved?.kind).toBe(RuleGuidanceSourceKind.Instruction);
        expect(resolved).toMatchObject({ path: 'AGENTS.md' });
        expect(loadDefaultRuleGuidance).not.toHaveBeenCalled();
    });

    it('continues without guidance, and says why, when the default cannot be downloaded', async () => {
        const { logger, warn } = recordingLogger();
        const resolved = await resolveRunRuleGuidance(
            {
                loadDefaultRuleGuidance: async () => {
                    throw new LinkedDocumentDownloadError(
                        LinkedDocumentDownloadFailureCode.DocumentUnavailable,
                        'https://example.test/syntax.md',
                        'HTTP 503',
                    );
                },
            },
            logger,
        );

        expect(resolved).toBeUndefined();
        expect(warn).toHaveBeenCalledTimes(1);
    });
});
