import { describe, expect, it } from 'vitest';
import {
    DEFAULT_RULE_GUIDANCE_PATH,
    DEFAULT_SYNTAX_DOCUMENT_URL,
    loadDefaultRuleGuidance,
} from '../../src/knowledge/default-rule-guidance';
import { GuidanceDocumentRole, RuleGuidanceSourceKind } from '../../src/knowledge/guidance-source';
import { LinkedDocumentDownloadError } from '../../src/knowledge/linked-document-downloader';

const SYNTAX_BODY = '## Basic rules\n\nA basic rule blocks a request: `||example.org^`.\n';

describe('loadDefaultRuleGuidance', () => {
    it('serves the pinned syntax document as the only role', async () => {
        const fetched: string[] = [];
        const fetchImpl = (async (input: unknown) => {
            fetched.push(String(input));
            return new Response(SYNTAX_BODY, { status: 200 });
        }) as typeof fetch;

        const source = await loadDefaultRuleGuidance(fetchImpl);

        expect(source.kind).toBe(RuleGuidanceSourceKind.Instruction);
        expect(source.path).toBe(DEFAULT_RULE_GUIDANCE_PATH);
        // A policy is the repository's own decision: the default never serves one.
        expect(source.documents.map((document) => document.role)).toEqual([
            GuidanceDocumentRole.Syntax,
        ]);
        expect(source.documents[0]!.content).toBe(SYNTAX_BODY);
        // Pinned to a commit, so every run reads the same text.
        expect(DEFAULT_SYNTAX_DOCUMENT_URL).toMatch(/\/blob\/[0-9a-f]{40}\//u);
        expect(fetched).toHaveLength(1);
        expect(fetched[0]).toContain('raw.githubusercontent.com');
    });

    it('fails with the typed download error when the document is unreachable', async () => {
        const fetchImpl = (async () => new Response('gone', { status: 404 })) as typeof fetch;

        await expect(loadDefaultRuleGuidance(fetchImpl)).rejects.toBeInstanceOf(
            LinkedDocumentDownloadError,
        );
    });
});
