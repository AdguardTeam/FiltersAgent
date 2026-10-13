/**
 * Stable tag naming whether the per-run rule-guidance documents come from the built-in pinned
 * KnowledgeBase or from the run instruction's linked documents.
 *
 * The two branches are mutually exclusive: instruction-driven runs replace the KnowledgeBase behind
 * lookup_rule_guidance entirely, so every source reaching the guidance session carries exactly one
 * of these tags.
 */
export const RuleGuidanceSourceKind = {
    /**
     * Pinned AdGuard KnowledgeBase checkout plus the filters contributing guide.
     */
    KnowledgeBase: 'knowledge_base',

    /**
     * Documents linked by the run instruction, downloaded or read from the checkout.
     */
    Instruction: 'instruction',
} as const;

/**
 * RuleGuidanceSourceKind value.
 */
export type RuleGuidanceSourceKind =
    (typeof RuleGuidanceSourceKind)[keyof typeof RuleGuidanceSourceKind];

/**
 * Role an instruction-linked document plays in the run's rule guidance.
 *
 * The instruction binds its links to roles by keyword in the link label; the serving side maps
 * guidance topics onto roles, so the vocabulary is shared by loader and serving.
 */
export const GuidanceDocumentRole = {
    /**
     * Filter syntax reference covering candidate rule construction.
     */
    Syntax: 'syntax',

    /**
     * Filter policy document constraining which rules may be proposed.
     */
    Policy: 'policy',

    /**
     * Contributing guide covering repository structure and rule placement.
     */
    Contributing: 'contributing',
} as const;

/**
 * Every GuidanceDocumentRole value, for schemas and exhaustive listings.
 */
export const GUIDANCE_DOCUMENT_ROLE_VALUES = Object.values(GuidanceDocumentRole);

/**
 * GuidanceDocumentRole value.
 */
export type GuidanceDocumentRole = (typeof GuidanceDocumentRole)[keyof typeof GuidanceDocumentRole];

/**
 * Where an instruction-linked document's text came from.
 */
export const GuidanceDocumentOrigin = {
    /**
     * Downloaded at run start from an http(s) URL named by the instruction link.
     */
    Url: 'url',

    /**
     * Read at run start from a checkout-relative path named by the instruction link.
     */
    CheckoutFile: 'checkout_file',
} as const;

/**
 * Every GuidanceDocumentOrigin value, for schemas and exhaustive listings.
 */
export const GUIDANCE_DOCUMENT_ORIGIN_VALUES = Object.values(GuidanceDocumentOrigin);

/**
 * GuidanceDocumentOrigin value.
 */
export type GuidanceDocumentOrigin =
    (typeof GuidanceDocumentOrigin)[keyof typeof GuidanceDocumentOrigin];

/**
 * Largest accepted roster of instruction-linked documents.
 *
 * Flood guard: roles bind one document each, so the live bound is the role count; the cap keeps the
 * roster bounded if the role vocabulary grows, and the guidance session re-asserts it so a
 * hand-built source cannot bypass the loader. The bound roster is served, not a trimmed error.
 */
export const MAX_LINKED_DOCUMENTS = 8;

/**
 * Per-response character ceiling that keeps documentation tool output bounded, shared by the
 * KnowledgeBase section serving and the instruction document serving.
 */
export const MAX_GUIDANCE_CHARACTERS = 8_000;

/**
 * One document the run instruction linked, loaded at run start exactly as found.
 */
export interface InstructionLinkedDocument {
    /**
     * Serving role the link label named.
     */
    role: GuidanceDocumentRole;

    /**
     * Whether the text was downloaded from the named URL or read from the checkout.
     */
    origin: GuidanceDocumentOrigin;

    /**
     * Locator named by the instruction link: the http(s) URL for url origin, the checkout-relative
     * target as written for checkout_file origin.
     */
    url: string;

    /**
     * Complete document text as loaded; the guidance serves it whole, \r\n-normalized and bounded.
     */
    content: string;

    /**
     * SHA-256 over the exact loaded bytes, so a run can state what it served.
     */
    sha256: string;
}

/**
 * Trusted immutable document set loaded from one run instruction.
 *
 * Travels the same `AgentRuntimeOptions.knowledgeGuidanceSource` field that carries the
 * KnowledgeBase source; the receiving session dispatches on {@link RuleGuidanceSourceKind}.
 */
export interface InstructionGuidanceSource {
    /**
     * Union tag; instruction sources replace the KnowledgeBase for the whole run.
     */
    kind: typeof RuleGuidanceSourceKind.Instruction;

    /**
     * Instruction file path as reported at load: checkout-relative when it resolves inside the
     * checkout, absolute for an operator-supplied out-of-tree override.
     */
    path: string;

    /**
     * SHA-256 over the exact instruction bytes as loaded.
     */
    sha256: string;

    /**
     * Documents bound by the instruction's role links, in binding order.
     */
    documents: readonly InstructionLinkedDocument[];
}

/**
 * One missing-information record: what the run instruction lacks, carried identically by the
 * deterministic not-linked guidance notice and the run result block.
 */
export interface RuleGuidanceMissingInformation {
    /**
     * Bounded human-readable subject naming the absent document kind and topic.
     */
    subject: string;

    /**
     * Longer deterministic description of the gap: the requested topic, the roles its serving
     * requires, and the roster this run's instruction actually linked.
     */
    detail: string;
}
