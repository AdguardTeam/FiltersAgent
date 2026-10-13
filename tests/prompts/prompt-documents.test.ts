import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolName } from '../../src/agent/tool-names';
import {
    createPromptDocumentLoader,
    PROMPT_DOCUMENT_NAMES,
    PromptDocumentName,
} from '../../src/prompts/prompt-documents';
import {
    extractPlaceholders,
    PromptRenderError,
    PromptRenderErrorKind,
} from '../../src/prompts/template';

describe('createPromptDocumentLoader', () => {
    it('rejects an unknown document name, naming it', () => {
        const loader = createPromptDocumentLoader();
        try {
            loader.render('bogus' as PromptDocumentName);
            expect.unreachable();
        } catch (error) {
            expect(error).toBeInstanceOf(PromptRenderError);
            expect((error as PromptRenderError).kind).toBe(PromptRenderErrorKind.UnknownDocument);
            expect((error as Error).message).toContain('bogus');
        }
    });

    it('renders documents from an override directory and memoizes reads', () => {
        const dir = mkdtempSync(join(tmpdir(), 'prompt-docs-'));
        const documentPath = join(dir, 'system.md');
        writeFileSync(documentPath, 'Hello {{name}}');
        const loader = createPromptDocumentLoader({ documentsDir: dir });
        expect(loader.render(PromptDocumentName.System, { name: 'world' })).toBe('Hello world');
        rmSync(documentPath);
        // The second render must come from the memo, not the (now deleted) file.
        expect(loader.render(PromptDocumentName.System, { name: 'world' })).toBe('Hello world');
    });

    it('threads the document name into rendering errors', () => {
        const dir = mkdtempSync(join(tmpdir(), 'prompt-docs-'));
        writeFileSync(join(dir, 'nudge.md'), 'Call {{terminalToolName}} now.');
        const loader = createPromptDocumentLoader({ documentsDir: dir });
        expect(() => loader.render(PromptDocumentName.Nudge, {})).toThrowError(
            /nudge.*terminalToolName/s,
        );
    });
});

describe('the shipped prompt documents', () => {
    const loader = createPromptDocumentLoader();

    it('declares one placeholder-free system document that renders byte-identically', () => {
        // The cross-mode byte-identity contract holds by construction: a single system document
        // with zero placeholders has no input that could alter its bytes.
        expect(extractPlaceholders(loader.read(PromptDocumentName.System))).toEqual([]);
        expect(loader.render(PromptDocumentName.System)).toBe(
            loader.render(PromptDocumentName.System),
        );
    });

    it('renders every document when exactly its declared placeholders are filled', () => {
        for (const name of PROMPT_DOCUMENT_NAMES) {
            const declared = extractPlaceholders(loader.read(name));
            const values = Object.fromEntries(declared.map((p) => [p, `fill:${p}`]));
            const rendered = loader.render(name, values);
            expect(rendered).not.toContain('{{');
            for (const placeholder of declared) {
                expect(rendered).toContain(`fill:${placeholder}`);
            }
            expect(() => loader.render(name, { ...values, bogusPlaceholder: 'x' })).toThrowError(
                /bogusPlaceholder/,
            );
        }
    });

    it('fails a task document render that leaves a declared placeholder unfilled', () => {
        expect(extractPlaceholders(loader.read(PromptDocumentName.FixTask)).length).toBeGreaterThan(
            0,
        );
        expect(() => loader.render(PromptDocumentName.FixTask, {})).toThrowError(PromptRenderError);
    });
});

describe('the fix task environment context split', () => {
    const loader = createPromptDocumentLoader();

    it('declares exactly the path-neutral placeholder set on the fix task', () => {
        expect(extractPlaceholders(loader.read(PromptDocumentName.FixTask)).sort()).toEqual(
            [
                'candidateConfirmation',
                'environmentContext',
                'instructionContext',
                'preAgentEvidenceContext',
                'screenshotContext',
                'settingsContext',
                'targetingGuidance',
                'terminalToolName',
            ].sort(),
        );
    });

    it('renders the run-instruction snippet from its data fills', () => {
        const rendered = loader.render(PromptDocumentName.FixTaskInstructionContext, {
            instructionText: 'Investigate the header banner on the reported page first.',
            linkedDocuments: '- syntax (url): https://wiki.example.test/filter-syntax',
            preparationContext: '',
        });
        expect(rendered).toContain('Investigate the header banner on the reported page first.');
        expect(rendered).toContain('- syntax (url): https://wiki.example.test/filter-syntax');
        // The standing line must name the missing-information tool by its registry name and tell
        // the agent the result itself may already carry the topic guidance, so a gap is recorded
        // even when the serving side answers before the model writes anything.
        expect(rendered).toContain(ToolName.ReportMissingInformation);
        expect(rendered).toMatch(/exactly what is missing/u);
        expect(rendered).toMatch(/guidance/u);
        expect(rendered).not.toContain('{{');
    });

    it('renders the selection-first framing only from its snippet fill', () => {
        const selectionFirst = loader.render(PromptDocumentName.FixContextSelectionFirst, {
            issueNumber: '4',
        });
        expect(selectionFirst).toContain('select_environment');
        expect(selectionFirst).toContain('#4');
        const preOrchestrated = loader.render(PromptDocumentName.FixContextPreOrchestrated, {
            issueNumber: '4',
        });
        expect(preOrchestrated).toContain('#4');
        expect(preOrchestrated).not.toContain('select_environment');
        // The wording-gate guard: the pre-orchestrated opener must not promise prepared live
        // evidence on a reasoning-only run — it qualifies preparation by live-evidence
        // possibility (fix-core.test.ts runs this shape with browserMode 'off').
        expect(preOrchestrated).toContain('live evidence is possible');
        expect(preOrchestrated).not.toContain('prepared the filtering environment');
    });

    it('renders the candidate confirmation with the exact candidate JSON', () => {
        const rendered = loader.render(PromptDocumentName.FixContextCandidateConfirmation, {
            candidateJson: '{"rule":"example.com##.ad"}',
        });
        expect(rendered).toContain('reporter-profile confirmation pass');
        expect(rendered).toContain('{"rule":"example.com##.ad"}');
        expect(rendered).not.toContain('{{');
    });
});
