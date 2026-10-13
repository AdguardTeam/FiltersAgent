import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BlockerVerificationMethod } from '../../src/environment/environment-proofs';
import { GuidanceDocumentOrigin, GuidanceDocumentRole } from '../../src/knowledge/guidance-source';
import { parseRuleApplication } from '../../src/knowledge/instruction-application';
import { linkedDocumentFetchUrl } from '../../src/knowledge/linked-document-downloader';
import { DEFAULT_INSTRUCTION_PATH, loadInstruction } from '../../src/knowledge/instruction-loader';
import {
    extractInstructionSection,
    extractPreparationSection,
} from '../../src/knowledge/instruction-preparation';
import {
    parseInstructionPlacement,
    PlacementPlaceholder,
    renderInstructionPlacement,
} from '../../src/knowledge/instruction-placement';
import {
    ISSUE_SELECTION_SECTION_KEYWORDS,
    parseIssueSelectionNarrowing,
} from '../../src/knowledge/instruction-selection';
import { renderReportComment } from '../../src/publisher/report-render';
import {
    REPORT_TEMPLATE_FILL,
    extractReportTemplateSection,
    ReportTemplateSource,
    resolveReportTemplate,
} from '../../src/publisher/report-template';
import { createPromptDocumentLoader, PromptDocumentName } from '../../src/prompts/prompt-documents';
import { extractPlaceholders } from '../../src/prompts/template';

/**
 * UBlock Origin static-filter syntax wiki page URL prefix.
 *
 * The shipped uBOL instruction binds its syntax guidance by role to a page under this prefix. The
 * prefix (not one exact URL) is the contract: the shipped document may link any page under it.
 */
const UBO_STATIC_FILTER_SYNTAX_WIKI_PREFIX =
    'https://github.com/gorhill/uBlock/wiki/Static-filter-syntax';

/**
 * UAssets filtering-policy document URL prefix: the repository's contributing guide, the only
 * policy text uAssets publishes (the repository has no wiki).
 *
 * The shipped uBOL instruction binds its policy guidance by role to a document under this prefix.
 * The prefix (not one exact URL) is the contract: the shipped document may link any section of it.
 */
const UASSETS_FILTERING_POLICY_PREFIX =
    'https://github.com/uBlockOrigin/uAssets/blob/master/CONTRIBUTING.md';

/**
 * Body the fetch stub serves for every linked guidance document, so the loader proves it fetched
 * the remote documents instead of reading the checkout.
 */
const LINKED_DOCUMENT_STUB_BODY = 'stub linked document body';

/**
 * Markdown link shape the instruction loader binds roles by, mirrored from its grammar: a non-empty
 * label and a space-free target.
 */
const MARKDOWN_LINK_PATTERN = /\[([^\]\r\n]+)\]\(([^)(\s]+)\)/gu;

/**
 * The AC2 caveat the report for a uBOL run must carry, matched on the rendered comment — fixed
 * template text proven as rendered data, never as document source.
 */
const UBO_LITE_CAVEAT_PATTERN = /does not replace the full uBlock Origin/iu;

/**
 * The report render's fill skeleton. The shipped document's placeholders must match exactly this
 * set — the fills the report render always computes — and must live only in the report-template
 * section.
 */
const REPORT_TEMPLATE_FILLS = Object.keys(REPORT_TEMPLATE_FILL).sort();

const loader = createPromptDocumentLoader();

/**
 * Read the shipped uBlock Origin Lite instruction through the prompt document loader.
 *
 * @returns The document's exact file text.
 */
function instructionDocument(): string {
    return loader.read(PromptDocumentName.InstructionsUblockOriginLite);
}

describe('application contract of the shipped uBlock Origin Lite instruction', () => {
    it('declares a user-rules-file read-back with a non-empty target and digests its application steps', () => {
        const parsed = parseRuleApplication(instructionDocument());
        if (!('application' in parsed)) {
            throw new Error(
                `expected a parsed application contract, received the refusal ${parsed.gap}: ${parsed.detail}`,
            );
        }
        expect(parsed.verification.method).toBe(BlockerVerificationMethod.UserRulesFile);
        const target = parsed.verification.target ?? '';
        expect(target.length).toBeGreaterThan(0);
        expect(parsed.application.sha256).toMatch(/^[0-9a-f]{64}$/u);
    });
});

describe('entity inventory of the shipped uBlock Origin Lite instruction', () => {
    it('carries every section of the instruction-for-the-agent entity', () => {
        const content = instructionDocument();
        expect(extractPreparationSection(content)).toBeDefined();
        const selection = extractInstructionSection(content, ISSUE_SELECTION_SECTION_KEYWORDS);
        expect(selection).toBeDefined();
        expect(() => parseIssueSelectionNarrowing(selection ?? '')).not.toThrow();
        expect(extractReportTemplateSection(content)).toBeDefined();
        expect(resolveReportTemplate(content).source).toBe(ReportTemplateSource.Instruction);
    });

    it("declares the placement its report template promises: the current year's file behind an issue-URL comment", () => {
        const declared = parseInstructionPlacement(instructionDocument());

        expect(declared).toStrictEqual({
            byRuleType: {},
            unqualified: {
                pathTemplate: 'filters/filters-{{year}}.txt',
                commentTemplate: '! {{issueUrl}}',
            },
        });
        expect(
            renderInstructionPlacement(declared!, {
                now: new Date(Date.UTC(2026, 0, 2)),
                issueUrl: 'https://github.com/uBlockOrigin/uAssets/issues/29471',
            }),
        ).toStrictEqual({
            byRuleType: {},
            unqualified: {
                filePath: 'filters/filters-2026.txt',
                commentLine: '! https://github.com/uBlockOrigin/uAssets/issues/29471',
            },
        });
    });

    it('carries the report fill list in the report-template section and nothing unfillable outside it', () => {
        const content = instructionDocument();
        const section = extractReportTemplateSection(content);
        expect(section).toBeDefined();
        expect(extractPlaceholders(section ?? '').sort()).toEqual(REPORT_TEMPLATE_FILLS);
        // Outside the report template the only placeholders are the placement declaration's own,
        // which the declared-placement render fills. Anything else would reach the model as
        // literal `{{...}}` text that nothing in the run ever substitutes.
        expect(extractPlaceholders(content).sort()).toEqual(
            [
                ...REPORT_TEMPLATE_FILLS,
                PlacementPlaceholder.Year,
                PlacementPlaceholder.IssueUrl,
            ].sort(),
        );
    });
});

describe('guidance links of the shipped uBlock Origin Lite instruction', () => {
    it('binds the syntax and policy roles to the uBO syntax and uAssets policy wiki documents', async () => {
        const checkoutRoot = mkdtempSync(join(tmpdir(), 'ubol-instruction-'));
        try {
            const checkoutInstructionPath = join(checkoutRoot, DEFAULT_INSTRUCTION_PATH);
            mkdirSync(dirname(checkoutInstructionPath), { recursive: true });
            writeFileSync(checkoutInstructionPath, instructionDocument(), 'utf8');
            const fetchedUrls: string[] = [];
            const fetchImpl: typeof fetch = async (url) => {
                fetchedUrls.push(String(url));
                return new Response(LINKED_DOCUMENT_STUB_BODY, { status: 200 });
            };
            const instruction = await loadInstruction({
                checkoutRoot,
                instructionPath: DEFAULT_INSTRUCTION_PATH,
                fetchImpl,
            });
            if (instruction === null) {
                throw new Error('the shipped instruction must load from the temp checkout');
            }
            const syntax = instruction.documents.find(
                (document) => document.role === GuidanceDocumentRole.Syntax,
            );
            const policy = instruction.documents.find(
                (document) => document.role === GuidanceDocumentRole.Policy,
            );
            if (syntax === undefined || policy === undefined) {
                const boundRoles = JSON.stringify(
                    instruction.documents.map((document) => document.role),
                );
                throw new Error(
                    `expected syntax and policy bound, instruction bound ${boundRoles}`,
                );
            }
            expect(syntax.origin).toBe(GuidanceDocumentOrigin.Url);
            expect(syntax.url.startsWith(UBO_STATIC_FILTER_SYNTAX_WIKI_PREFIX)).toBe(true);
            expect(policy.origin).toBe(GuidanceDocumentOrigin.Url);
            expect(policy.url.startsWith(UASSETS_FILTERING_POLICY_PREFIX)).toBe(true);
            expect(syntax.content).toBe(LINKED_DOCUMENT_STUB_BODY);
            // The wiki pages are fetched as their raw Markdown source; the rewrite itself is
            // the downloader's own contract, so the roles are checked against it rather than
            // restating it here.
            expect(fetchedUrls).toContain(linkedDocumentFetchUrl(syntax.url));
            expect(fetchedUrls).toContain(linkedDocumentFetchUrl(policy.url));
        } finally {
            rmSync(checkoutRoot, { recursive: true, force: true });
        }
    });
});

describe('link hygiene of the shipped uBlock Origin Lite instruction', () => {
    it('exposes only https links', () => {
        const content = instructionDocument();
        const targets = [...content.matchAll(MARKDOWN_LINK_PATTERN)].map((match) => match[2] ?? '');
        expect(targets.length).toBeGreaterThan(0);
        for (const target of targets) {
            expect(target.startsWith('https://')).toBe(true);
        }
    });
});

describe('report caveat of the shipped uBlock Origin Lite instruction', () => {
    it('carries the reduced-engine caveat through the production report render', () => {
        const resolved = resolveReportTemplate(instructionDocument());
        const rendered = renderReportComment(resolved.template, REPORT_TEMPLATE_FILL);
        expect(rendered).toMatch(UBO_LITE_CAVEAT_PATTERN);
    });
});
