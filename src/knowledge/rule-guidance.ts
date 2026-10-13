import * as v from 'valibot';
import { REPOSITORY_SLUG_PATTERN } from '../types/repository-slug';
import {
    GUIDANCE_DOCUMENT_ORIGIN_VALUES,
    GUIDANCE_DOCUMENT_ROLE_VALUES,
    MAX_GUIDANCE_CHARACTERS,
    MAX_LINKED_DOCUMENTS,
    RuleGuidanceSourceKind,
    type InstructionGuidanceSource,
    type InstructionLinkedDocument,
    type RuleGuidanceMissingInformation,
} from './guidance-source';
import { extractSection, GUIDANCE_SECTIONS, resolveDocument } from './knowledge-base-serving';
import {
    INSTRUCTION_TOPIC_ROLES,
    instructionDocumentCitation,
    MAX_GUIDANCE_QUERY_CHARACTERS,
    notLinkedResult,
    serveInstructionDocuments,
    type RuleGuidanceNotice,
} from './instruction-serving';

export const RULE_GUIDANCE_TOPICS = [
    'element_hiding',
    'css_injection',
    'extended_css',
    'network',
    'scriptlet',
    'exception',
    'compatibility',
    'placement',
    // What this repository accepts, refuses or requires for a rule: scope, anti-adblock and
    // rewarded-ad gates, exceptions, quality bar. Every topic above is about how a rule is
    // written, so all of them but `placement` resolve to the syntax document; without this topic a
    // run that asks `exception` and then `scriptlet` for a repository's anti-adblock policy gets
    // syntax sections both times and reports the repository's CONTRIBUTING.md policy as
    // unreachable.
    'policy',
] as const;

export const RuleGuidanceTopicSchema = v.picklist(RULE_GUIDANCE_TOPICS);

export const RuleGuidanceQuerySchema = v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(MAX_GUIDANCE_QUERY_CHARACTERS),
);

/**
 * One bounded documentation subject exposed to the reasoning model.
 */
export type RuleGuidanceTopic = v.InferOutput<typeof RuleGuidanceTopicSchema>;

/**
 * Trusted immutable documents prepared outside the model boundary.
 */
export interface KnowledgeGuidanceSource {
    /**
     * Union tag; KnowledgeBase sources serve today's pinned AdGuard documentation.
     */
    kind: typeof RuleGuidanceSourceKind.KnowledgeBase;

    /**
     * Exact KnowledgeBase commit containing the syntax and policy documents.
     */
    knowledgeBaseCommit: string;

    /**
     * Exact commit of the filters repository containing the contributing guide.
     */
    filtersCommit: string;

    /**
     * `owner/repo` slug of the repository the KnowledgeBase documents were cloned from; citations
     * and their GitHub URLs are built from it.
     */
    knowledgeBaseRepository: string;

    /**
     * `owner/repo` slug of the repository the contributing guide was taken from; citations and
     * their GitHub URLs are built from it.
     */
    filtersRepository: string;

    /**
     * Trusted local path to create-own-filters.md in the disposable checkout.
     */
    syntaxPath: string;

    /**
     * Trusted local path to filter-policy.md in the disposable checkout.
     */
    policyPath: string;

    /**
     * Trusted local path to CONTRIBUTING.md in the exact filters checkout.
     */
    contributingPath: string;
}

/**
 * The rule-guidance source variant this run carries: the pinned KnowledgeBase checkout or the
 * instruction's linked documents. Both travel the same knowledgeGuidanceSource option field and are
 * dispatched on their kind tag inside KnowledgeGuidanceSession.
 */
export type RuleGuidanceSource = KnowledgeGuidanceSource | InstructionGuidanceSource;

/**
 * Immutable source reference returned beside one guidance excerpt.
 */
export interface KnowledgeGuidanceCitation {
    /**
     * `owner/repo` GitHub slug of the repository containing the cited document.
     */
    repository: string;

    /**
     * Exact commit of the cited document; absent for instruction documents fetched by URL or read
     * from a moving checkout, which carry no immutable commit to cite.
     */
    commit?: string;

    /**
     * Repository-relative document path.
     */
    filePath: string;

    /**
     * Stable locator of the cited span: a Markdown heading anchor for a KnowledgeBase section,
     * `whole-document` for an instruction document served in full.
     */
    anchor: string;

    /**
     * Immutable GitHub URL for the cited section.
     */
    url: string;
}

/**
 * Bounded response returned by lookup_rule_guidance.
 */
export interface RuleGuidanceResult {
    /**
     * Validated requested subject.
     */
    topic: RuleGuidanceTopic;

    /**
     * Relevant Markdown excerpts within the declared maximum, or the human-readable explanation
     * carried by a not-linked notice.
     */
    guidance: string;

    /**
     * Maximum number of characters that may be returned in guidance.
     */
    maxCharacters: number;

    /**
     * Immutable sources used to create the response; empty for a checkout-origin instruction
     * document and for a not-linked notice.
     */
    citations: KnowledgeGuidanceCitation[];

    /**
     * Headings of the instruction-document sections this response carries, in document order;
     * present exactly when a document was too long to serve whole and had to be narrowed to the
     * requested topic. Absence therefore reads "nothing was left out" — a whole document, a pinned
     * KnowledgeBase excerpt, or a not-linked notice — and any value tells a run's trace which part
     * of a long reference the model was actually shown.
     */
    servedSectionHeadings?: string[];

    /**
     * Exact repository revisions consulted by this lookup; present for KnowledgeBase lookups only,
     * because instruction documents carry no repository revision.
     */
    provenance?: {
        /**
         * Exact KnowledgeBase commit.
         */
        knowledgeBaseCommit: string;

        /**
         * Exact filters repository commit.
         */
        filtersCommit: string;
    };

    /**
     * Typed marker present exactly when this result is a not-linked notice rather than a served
     * excerpt; the deterministic record point a run harvests the missing-information gap from.
     */
    notice?: typeof RuleGuidanceNotice.NotLinked;

    /**
     * Deterministic missing-information record carried by a not-linked notice; present exactly
     * together with {@link RuleGuidanceResult.notice}.
     */
    missingInformation?: RuleGuidanceMissingInformation;
}

/**
 * Validate an exact full commit before it can appear in a citation.
 *
 * @param commit - Commit string supplied by the trusted preparer.
 * @param label - Human-readable repository label used in errors.
 */
function assertFullCommit(commit: string, label: string): void {
    if (!/^[0-9a-f]{40}$/iu.test(commit)) {
        throw new Error(`${label} commit must be a full 40-character SHA.`);
    }
}

/**
 * Validate a 64-hex SHA-256 digest over loaded instruction bytes.
 *
 * Instruction sources are plain files, not git objects: the loader digests them with SHA-256, the
 * 64-hex width the provenance schemas pin, so re-asserting the 40-hex git width here would reject
 * every source the loader produces.
 *
 * @param digest - SHA-256 over the loaded instruction or document bytes.
 * @param label - Human-readable repository label used in errors.
 */
function assertLoadedDocumentDigest(digest: string, label: string): void {
    if (!/^[0-9a-f]{64}$/iu.test(digest)) {
        throw new Error(`${label} must be a full 64-character SHA-256 digest.`);
    }
}

/**
 * Validate an `owner/repo` repository slug before citations are built from it.
 *
 * @param repository - Slug string supplied by the trusted preparer.
 * @param label - Human-readable repository label used in errors.
 */
function assertRepositorySlug(repository: string, label: string): void {
    if (!REPOSITORY_SLUG_PATTERN.test(repository)) {
        throw new Error(`${label} must be a validated owner/repo slug.`);
    }
}

/**
 * Stateful bounded rule-guidance reader for a single isolated agent run.
 *
 * Dispatches on the source kind: a KnowledgeBase source serves today's pinned AdGuard sections; an
 * instruction source serves its linked role documents — whole when they fit the response bound,
 * otherwise narrowed to the sections matching the topic plus an index of the document's other
 * headings — and answers topics without a linked role with the typed not-linked notice.
 */
export class KnowledgeGuidanceSession {
    private consulted = false;

    constructor(private readonly source: RuleGuidanceSource) {
        if (source.kind === RuleGuidanceSourceKind.Instruction) {
            this.assertInstructionSourceBounds(source);
        } else {
            assertFullCommit(source.knowledgeBaseCommit, 'KnowledgeBase');
            assertFullCommit(source.filtersCommit, 'Filters');
            assertRepositorySlug(source.knowledgeBaseRepository, 'KnowledgeBase repository');
            assertRepositorySlug(source.filtersRepository, 'Filters repository');
            this.assertEveryTopicResolves(source);
        }
    }

    /**
     * Re-assert the loader's bounds on an instruction source before serving.
     *
     * The loader produces consistent sources, but the source can be hand-built or drifted through
     * the option field; failing at construction names the broken bound before any lookup serves
     * what would be a silently wrong document set.
     *
     * @param source - Instruction-branch source reaching the session.
     * @throws {Error} When the path or any document bound is broken.
     */
    private assertInstructionSourceBounds(source: InstructionGuidanceSource): void {
        if (source.path.trim().length === 0) {
            throw new Error('Instruction guidance source path must not be empty.');
        }
        assertLoadedDocumentDigest(source.sha256, 'Instruction digest');
        if (source.documents.length > MAX_LINKED_DOCUMENTS) {
            throw new Error(
                `Instruction guidance source carries ${source.documents.length} linked ` +
                    `documents, above the ${MAX_LINKED_DOCUMENTS}-document cap.`,
            );
        }
        for (const document of source.documents) {
            if (!GUIDANCE_DOCUMENT_ROLE_VALUES.includes(document.role)) {
                throw new Error(
                    `Instruction document for ${document.url} carries unknown role ${document.role}.`,
                );
            }
            if (!GUIDANCE_DOCUMENT_ORIGIN_VALUES.includes(document.origin)) {
                throw new Error(
                    `Instruction document for ${document.url} carries unknown origin ` +
                        `${document.origin}.`,
                );
            }
            if (document.url.trim().length === 0) {
                throw new Error('Instruction document URL must not be empty.');
            }
            assertLoadedDocumentDigest(
                document.sha256,
                `Instruction document ${document.url} digest`,
            );
            if (document.content.trim().length === 0) {
                throw new Error(`Instruction document for ${document.url} is empty.`);
            }
        }
    }

    /**
     * Fail at construction when any pinned section no longer exists upstream.
     *
     * Documents are checked out per run, so a renamed heading only surfaces when the model happens
     * to request that topic — after a full run has already been paid for. Resolving every topic up
     * front turns that into an immediate, named startup failure.
     *
     * @param source - KnowledgeBase source whose pinned sections are resolved.
     * @throws {Error} When one or more topics cannot resolve all of their pinned sections.
     */
    private assertEveryTopicResolves(source: KnowledgeGuidanceSource): void {
        const broken: string[] = [];
        for (const topic of RULE_GUIDANCE_TOPICS) {
            for (const section of GUIDANCE_SECTIONS[topic]) {
                try {
                    const document = resolveDocument(source, section);
                    extractSection(document.content, section);
                } catch (error) {
                    broken.push(
                        `${topic} → ${section.document}#${section.anchor}: ` +
                            (error as Error).message,
                    );
                }
            }
        }
        if (broken.length > 0) {
            throw new Error(
                `Pinned rule guidance is stale at KnowledgeBase ${source.knowledgeBaseCommit}: ` +
                    broken.join('; '),
            );
        }
    }

    /**
     * Read only the allowlisted sections mapped to one validated topic.
     *
     * @param topic - Bounded public lookup subject.
     * @param query - Optional extra keywords narrowing a long instruction document to the sections
     *   that match them; ignored by the KnowledgeBase branch, whose sections are pinned per topic.
     * @returns Excerpts, immutable citations, and exact source revisions.
     */
    lookup(topic: RuleGuidanceTopic, query?: string): RuleGuidanceResult {
        const parsed = v.safeParse(RuleGuidanceTopicSchema, topic);
        if (!parsed.success) {
            throw new Error(`Unsupported guidance topic: ${String(topic)}`);
        }
        if (this.source.kind === RuleGuidanceSourceKind.Instruction) {
            return this.lookupInstruction(parsed.output, this.source, query);
        }
        return this.lookupKnowledgeBase(parsed.output, this.source);
    }

    /**
     * Serve the pinned KnowledgeBase sections mapped to one topic.
     *
     * @param topic - Validated lookup subject.
     * @param source - KnowledgeBase source narrowed by the dispatcher.
     * @returns Excerpts, immutable citations, and exact source revisions.
     */
    private lookupKnowledgeBase(
        topic: RuleGuidanceTopic,
        source: KnowledgeGuidanceSource,
    ): RuleGuidanceResult {
        const sections = GUIDANCE_SECTIONS[topic];
        const resolved = sections.map((section) => {
            const document = resolveDocument(source, section);
            return {
                excerpt: extractSection(document.content, section),
                citation: document.citation,
            };
        });
        const guidance = resolved
            .map((item) => item.excerpt)
            .join('\n\n')
            .slice(0, MAX_GUIDANCE_CHARACTERS);
        this.consulted = true;
        return {
            topic,
            guidance,
            maxCharacters: MAX_GUIDANCE_CHARACTERS,
            citations: resolved.map((item) => item.citation),
            provenance: {
                knowledgeBaseCommit: source.knowledgeBaseCommit,
                filtersCommit: source.filtersCommit,
            },
        };
    }

    /**
     * Serve the instruction's role documents mapped to one topic, or the typed not-linked notice
     * when any of the topic's roles is unbound.
     *
     * @param topic - Validated lookup subject.
     * @param source - Instruction source narrowed by the dispatcher.
     * @param query - Optional extra keywords for the section scoring.
     * @returns The served documents — whole when they fit, otherwise narrowed to the topic's
     *   sections with an index of the rest — or the notice carrying the missing-information
     *   record.
     */
    private lookupInstruction(
        topic: RuleGuidanceTopic,
        source: InstructionGuidanceSource,
        query?: string,
    ): RuleGuidanceResult {
        const roles = INSTRUCTION_TOPIC_ROLES[topic];
        // A topic serves whichever of its role documents the instruction links, in role order;
        // only a topic with none of them linked becomes the not-linked notice. A repository with
        // one document for policy and contributing alike (uAssets: CONTRIBUTING.md) links it once,
        // under one role, and must still be able to answer `placement` from it.
        const served = roles
            .map((role) => source.documents.find((document) => document.role === role))
            .filter((document): document is InstructionLinkedDocument => document !== undefined);
        this.consulted = true;
        if (served.length === 0) {
            return notLinkedResult(topic, source, roles);
        }
        const { text, servedSectionHeadings } = serveInstructionDocuments(served, topic, query);
        return {
            topic,
            guidance: text,
            maxCharacters: MAX_GUIDANCE_CHARACTERS,
            citations: served
                .map((document) => instructionDocumentCitation(document))
                .filter((citation) => citation !== undefined),
            ...(servedSectionHeadings === undefined ? {} : { servedSectionHeadings }),
        };
    }

    /**
     * Report whether at least one successful guidance lookup preceded candidate work.
     *
     * @returns True after the first successful bounded lookup.
     */
    hasConsultedGuidance(): boolean {
        return this.consulted;
    }
}
