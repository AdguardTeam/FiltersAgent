import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BlockerVerificationMethod } from '../../src/environment/environment-proofs';
import { GuidanceDocumentOrigin, GuidanceDocumentRole } from '../../src/knowledge/guidance-source';
import {
    parseRuleApplication,
    STATE_VERIFICATION_SECTION_KEYWORDS,
} from '../../src/knowledge/instruction-application';
import { DEFAULT_INSTRUCTION_PATH, loadInstruction } from '../../src/knowledge/instruction-loader';
import {
    extractInstructionSection,
    extractPreparationSection,
} from '../../src/knowledge/instruction-preparation';
import {
    ISSUE_SELECTION_SECTION_KEYWORDS,
    parseIssueSelectionNarrowing,
} from '../../src/knowledge/instruction-selection';
import {
    REPORT_TEMPLATE_FILL,
    extractReportTemplateSection,
    ReportTemplateSource,
    resolveReportTemplate,
} from '../../src/publisher/report-template';
import { createPromptDocumentLoader, PromptDocumentName } from '../../src/prompts/prompt-documents';
import { extractPlaceholders } from '../../src/prompts/template';

/**
 * AdGuard filter-syntax Knowledge Base page URL prefix.
 *
 * The shipped Edge instruction binds its syntax guidance by role to a page under this prefix. The
 * prefix (not one exact URL) is the contract: the shipped document may link any page under it.
 */
const ADGUARD_FILTER_SYNTAX_GUIDE_PREFIX =
    'https://adguard.com/kb/general/ad-filtering/create-own-filters/';

/**
 * AdGuard filter-policy Knowledge Base page URL prefix.
 *
 * The shipped Edge instruction binds its policy guidance by role to a page under this prefix. The
 * prefix (not one exact URL) is the contract: the shipped document may link any page under it.
 */
const ADGUARD_FILTER_POLICY_GUIDE_PREFIX =
    'https://adguard.com/kb/general/ad-filtering/filter-policy/';

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
 * The public MV2 build asset the preparation must name: the instruction that ships a wrong asset
 * name fails every run's preparation, so the asset name is a delivery contract on the document,
 * in-kind with the link-prefix contracts above.
 */
const EDGE_MV2_ASSET_NAME_PATTERN = /edge\.zip/u;

/**
 * The public releases API the preparation must name for the current release: the document must
 * point acquisition at the current-release endpoint, never at a frozen tag (D21).
 */
const RELEASES_LATEST_ENDPOINT_PATTERN = /releases\/latest/u;

/**
 * `read:` declaration grammar mirrored from the application-contract parser: the method token, then
 * the trailing state qualifier (a path for the file-backed methods, the state family for the live
 * extension read).
 */
const READ_DECLARATION_LINE_PATTERN = /^read:\s*(\S+)(?:\s+(.*\S))?\s*$/u;

/**
 * The report render's fill skeleton. The shipped document's placeholders must match exactly this
 * set — the fills the report render always computes — and must live only in the report-template
 * section.
 */
const REPORT_TEMPLATE_FILLS = Object.keys(REPORT_TEMPLATE_FILL).sort();

const loader = createPromptDocumentLoader();

/**
 * Read the shipped Edge MV2 instruction through the prompt document loader.
 *
 * @returns The document's exact file text.
 */
function instructionDocument(): string {
    return loader.read(PromptDocumentName.InstructionsEdgeMv2);
}

/**
 * The state qualifier the document's `read:` declaration line names after the method token — for
 * the live extension-state read-back, the state family the host must read (never a path).
 *
 * @param content - Instruction text as loaded.
 * @returns The trailing qualifier of the verification section's `read:` line, or the empty string
 *   when the section carries no qualified `read:` line.
 */
function declaredStateQualifier(content: string): string {
    const section = extractInstructionSection(content, STATE_VERIFICATION_SECTION_KEYWORDS);
    if (section === undefined) {
        return '';
    }
    const declarationLine = section
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.startsWith('read:'));
    if (declarationLine === undefined) {
        return '';
    }
    const match = READ_DECLARATION_LINE_PATTERN.exec(declarationLine);
    return match === null ? '' : (match[2] ?? '').trim();
}

describe('application contract of the shipped Edge MV2 instruction', () => {
    it('declares a live extension-state read-back naming its state family and digests its application steps', () => {
        const content = instructionDocument();
        const parsed = parseRuleApplication(content);
        if (!('application' in parsed)) {
            throw new Error(
                `expected a parsed application contract, received the refusal ${parsed.gap}: ${parsed.detail}`,
            );
        }
        expect(parsed.verification.method).toBe(BlockerVerificationMethod.ExtensionState);
        // The parser never exposes a target path for the live extension read: its trailing words
        // are the state family declaration itself, so the qualifier is asserted on the declared
        // line — the declaration must not end at a bare method token.
        expect(declaredStateQualifier(content).length).toBeGreaterThan(0);
        expect(parsed.application.sha256).toMatch(/^[0-9a-f]{64}$/u);
    });
});

describe('entity inventory of the shipped Edge MV2 instruction', () => {
    it('carries every section of the instruction-for-the-agent entity', () => {
        const content = instructionDocument();
        expect(extractPreparationSection(content)).toBeDefined();
        const selection = extractInstructionSection(content, ISSUE_SELECTION_SECTION_KEYWORDS);
        expect(selection).toBeDefined();
        expect(() => parseIssueSelectionNarrowing(selection ?? '')).not.toThrow();
        expect(extractReportTemplateSection(content)).toBeDefined();
        expect(resolveReportTemplate(content).source).toBe(ReportTemplateSource.Instruction);
    });

    it('carries the report fill list in the report-template section and nowhere else', () => {
        const content = instructionDocument();
        const section = extractReportTemplateSection(content);
        expect(section).toBeDefined();
        expect(extractPlaceholders(content).sort()).toEqual(REPORT_TEMPLATE_FILLS);
        expect(extractPlaceholders(section ?? '').sort()).toEqual(REPORT_TEMPLATE_FILLS);
    });
});

describe('guidance links of the shipped Edge MV2 instruction', () => {
    it('binds the syntax and policy roles to the AdGuard syntax and filter-policy documents', async () => {
        const checkoutRoot = mkdtempSync(join(tmpdir(), 'edge-mv2-instruction-'));
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
            expect(syntax.url.startsWith(ADGUARD_FILTER_SYNTAX_GUIDE_PREFIX)).toBe(true);
            expect(policy.origin).toBe(GuidanceDocumentOrigin.Url);
            expect(policy.url.startsWith(ADGUARD_FILTER_POLICY_GUIDE_PREFIX)).toBe(true);
            expect(syntax.content).toBe(LINKED_DOCUMENT_STUB_BODY);
            expect(fetchedUrls).toContain(syntax.url);
            expect(fetchedUrls).toContain(policy.url);
        } finally {
            rmSync(checkoutRoot, { recursive: true, force: true });
        }
    });
});

describe('preparation names the real acquisition of the shipped Edge MV2 instruction', () => {
    it('names the current-release edge.zip asset through the public releases API', () => {
        const preparation = extractPreparationSection(instructionDocument());
        expect(preparation).toBeDefined();
        expect(preparation?.content ?? '').toMatch(EDGE_MV2_ASSET_NAME_PATTERN);
        expect(preparation?.content ?? '').toMatch(RELEASES_LATEST_ENDPOINT_PATTERN);
    });
});

describe('link hygiene of the shipped Edge MV2 instruction', () => {
    it('exposes only https links', () => {
        const content = instructionDocument();
        const targets = [...content.matchAll(MARKDOWN_LINK_PATTERN)].map((match) => match[2] ?? '');
        expect(targets.length).toBeGreaterThan(0);
        for (const target of targets) {
            expect(target.startsWith('https://')).toBe(true);
        }
    });
});
