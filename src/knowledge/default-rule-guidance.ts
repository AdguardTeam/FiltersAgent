import {
    GuidanceDocumentOrigin,
    GuidanceDocumentRole,
    RuleGuidanceSourceKind,
    type InstructionGuidanceSource,
} from './guidance-source';
import { downloadLinkedDocument } from './linked-document-downloader';

/**
 * The rule-syntax document a run without an instruction is served: AdGuard's filter syntax at a
 * pinned KnowledgeBase commit, so every run reads the same text.
 *
 * Only the syntax role is served. A filter policy is the repository's own decision and lives in its
 * instruction; serving AdGuard's policy document here would apply AdGuard's rules to a repository
 * that never chose them.
 */
export const DEFAULT_SYNTAX_DOCUMENT_URL =
    'https://github.com/AdguardTeam/KnowledgeBase/blob/8443dbf9c43501f60113bcdf4d762b3d84e9dc1b/' +
    'docs/general/ad-filtering/create-own-filters.md';

/**
 * The path the default guidance source names in citations and not-linked notices, where an
 * instruction source names its file.
 */
export const DEFAULT_RULE_GUIDANCE_PATH = 'the built-in rule guidance (no run instruction)';

/**
 * Download the default rule guidance: the pinned syntax document as the one served role.
 *
 * @param fetchImpl - Fetch implementation; production uses global fetch.
 * @returns The guidance source lookup_rule_guidance serves for a run without an instruction.
 * @throws {LinkedDocumentDownloadError} When the document cannot be downloaded.
 */
export async function loadDefaultRuleGuidance(
    fetchImpl: typeof fetch = fetch,
): Promise<InstructionGuidanceSource> {
    const document = await downloadLinkedDocument(DEFAULT_SYNTAX_DOCUMENT_URL, fetchImpl);
    return {
        kind: RuleGuidanceSourceKind.Instruction,
        path: DEFAULT_RULE_GUIDANCE_PATH,
        sha256: document.sha256,
        documents: [
            {
                role: GuidanceDocumentRole.Syntax,
                origin: GuidanceDocumentOrigin.Url,
                url: DEFAULT_SYNTAX_DOCUMENT_URL,
                content: document.content,
                sha256: document.sha256,
            },
        ],
    };
}
