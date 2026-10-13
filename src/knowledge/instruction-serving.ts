import {
    GuidanceDocumentOrigin,
    GuidanceDocumentRole,
    MAX_GUIDANCE_CHARACTERS,
    type InstructionGuidanceSource,
    type InstructionLinkedDocument,
} from './guidance-source';
import {
    headingIndexLines,
    isContainedSection,
    splitMarkdownSections,
    type MarkdownSection,
} from './markdown-sections';
import type {
    KnowledgeGuidanceCitation,
    RuleGuidanceResult,
    RuleGuidanceTopic,
} from './rule-guidance';

/**
 * Stable marker distinguishing a typed not-linked notice from a served excerpt.
 */
export const RuleGuidanceNotice = {
    /**
     * The requested topic maps to roles the run instruction did not link.
     */
    NotLinked: 'not_linked',
} as const;

/**
 * RuleGuidanceNotice value.
 */
export type RuleGuidanceNotice = (typeof RuleGuidanceNotice)[keyof typeof RuleGuidanceNotice];

/**
 * Anchor naming a citation that covers a served-whole instruction document instead of a pinned
 * KnowledgeBase section heading.
 */
export const WHOLE_DOCUMENT_ANCHOR = 'whole-document';

/**
 * Instruction-serving map from every public guidance topic to the run instruction's roles that
 * define it, in serving order: a topic serves whichever of those role documents the instruction
 * links, in this order, and only a topic with none of its roles linked turns the lookup into the
 * typed not-linked notice.
 */
export const INSTRUCTION_TOPIC_ROLES: Record<RuleGuidanceTopic, readonly GuidanceDocumentRole[]> = {
    element_hiding: [GuidanceDocumentRole.Syntax],
    css_injection: [GuidanceDocumentRole.Syntax],
    extended_css: [GuidanceDocumentRole.Syntax],
    network: [GuidanceDocumentRole.Syntax],
    scriptlet: [GuidanceDocumentRole.Syntax],
    exception: [GuidanceDocumentRole.Syntax],
    compatibility: [GuidanceDocumentRole.Syntax],
    placement: [GuidanceDocumentRole.Policy, GuidanceDocumentRole.Contributing],
    policy: [GuidanceDocumentRole.Policy, GuidanceDocumentRole.Contributing],
};

/**
 * Keywords identifying which sections of an instruction document belong to each guidance topic, in
 * the vocabulary such references actually use: prose names ("cosmetic", "procedural") beside the
 * syntax tokens a section is about (`##`, `+js`, `@@`).
 *
 * These decide WHICH part of a long reference answers a topic. Serving a document's first
 * {@link MAX_GUIDANCE_CHARACTERS} characters instead answered every topic with the document's
 * opening: asked for `scriptlet`, a run got the uBlock Origin "Static filter syntax" page cut
 * inside "Pre-parsing directives" and filed a missing-information report saying the scriptlet
 * section was unreachable — from a page that documents scriptlet injection at length, tens of
 * kilobytes further down.
 *
 * A model adds its own keywords per call through the tool's `query` argument, for a subject the
 * fixed topics do not name (`removeparam`, `redirect-rule`).
 */
export const INSTRUCTION_TOPIC_KEYWORDS: Record<RuleGuidanceTopic, readonly string[]> = {
    element_hiding: ['cosmetic', 'element hiding', '##', 'hide'],
    css_injection: ['style', 'css injection', ':style'],
    extended_css: [
        'procedural',
        'extended',
        ':has',
        ':matches-css',
        ':upward',
        ':remove',
        'action operators',
    ],
    network: ['network', '||', 'options', 'modifier'],
    scriptlet: ['scriptlet', '+js', 'resources'],
    exception: ['exception', '@@', 'badfilter', 'allow'],
    compatibility: ['not supported', 'supported', 'compatibility', 'abp', 'syntax differences'],
    // Not a syntax topic: placement is answered by the policy and contributing documents, whose
    // sections are about where a rule goes rather than how it is written.
    placement: ['placement', 'section', 'file', 'structure', 'directory'],
    // Also answered by the policy and contributing documents, but from their other half: the
    // sections stating what the repository takes and what it turns away.
    policy: [
        'policy',
        'accept',
        'refuse',
        'allowed',
        'not allowed',
        'scope',
        'anti-adblock',
        'detection',
        'exception',
        'criteria',
        'quality',
        'guidelines',
    ],
};

/**
 * What one keyword found in a section's HEADING contributes to its score.
 *
 * A heading names what its section is about; a body mention only proves the subject came up. Ten
 * keeps a single heading hit ahead of everything the body can contribute for that keyword (see
 * {@link MAX_COUNTED_BODY_HITS}), so "Scriptlet injection" outranks a network section that happens
 * to mention scriptlets three times.
 */
const HEADING_KEYWORD_SCORE = 10;

/**
 * Body occurrences of one keyword that count toward a section's score.
 *
 * Capped, because uncapped it measures length instead of relevance: the longest section of a syntax
 * reference mentions every token dozens of times and would win every topic. Three separates a
 * section that is about a subject from one that mentions it in passing.
 */
const MAX_COUNTED_BODY_HITS = 3;

/**
 * Label the narrowed response puts in front of the document's heading index.
 */
const HEADING_INDEX_LABEL = 'All headings in this document:';

/**
 * Largest share of one document's response budget its heading index may take.
 *
 * The index names what the response left out, so it earns room — but it is navigation, not the
 * answer, and it must never take the room the answer needs. Reserving the whole index first did
 * exactly that: the AdGuard `create-own-filters.md` syntax reference has 187 headings whose index
 * is about 8.8k characters, larger than the entire {@link MAX_GUIDANCE_CHARACTERS} response, so
 * every syntax topic served zero characters of section text — an index and a truncation marker —
 * and blew past the response bound doing it. A third leaves two thirds of the budget for the
 * sections the topic actually asked for while still listing dozens of headings.
 */
const MAX_HEADING_INDEX_BUDGET_FRACTION = 1 / 3;

/**
 * Marker appended to a section the response had to cut, so a model reading it knows the text ends
 * early rather than that the section says nothing more.
 */
const TRUNCATION_MARKER = '\n…';

/**
 * Separator between served blocks — the blank line Markdown puts between them.
 */
const SECTION_SEPARATOR = '\n\n';

/**
 * Separator between the heading index's own lines: one newline, so the index reads as a list.
 */
const INDEX_LINE_SEPARATOR = '\n';

/**
 * Longest accepted `query` on one guidance lookup.
 *
 * The argument adds a few keywords, it does not carry a paragraph: 120 characters holds several
 * modifier names with room to spare, while prose of any length would contribute a keyword per word
 * and match every section equally.
 */
export const MAX_GUIDANCE_QUERY_CHARACTERS = 120;

/**
 * Split a model-supplied query into scoring keywords.
 *
 * @param query - The optional query argument of one lookup.
 * @returns Its whitespace-separated words, lowercased. A token stays whole, so a modifier name such
 *   as `removeparam` or `$redirect-rule` is one keyword.
 */
function queryKeywords(query: string | undefined): string[] {
    if (query === undefined) {
        return [];
    }
    return query
        .toLowerCase()
        .split(/\s+/u)
        .filter((word) => word.length > 0);
}

/**
 * Count occurrences of one keyword in a text, stopping at the counted maximum.
 *
 * @param text - Lowercased haystack.
 * @param keyword - Lowercased keyword.
 * @returns Occurrences found, at most {@link MAX_COUNTED_BODY_HITS}.
 */
function countHits(text: string, keyword: string): number {
    let hits = 0;
    let from = 0;
    while (hits < MAX_COUNTED_BODY_HITS) {
        const at = text.indexOf(keyword, from);
        if (at < 0) {
            return hits;
        }
        hits += 1;
        from = at + keyword.length;
    }
    return hits;
}

/**
 * Score one section's relevance to a set of keywords.
 *
 * @param section - The section under test.
 * @param keywords - Lowercased topic and query keywords.
 * @returns The score; zero when no keyword appears in the section at all.
 */
function scoreSection(section: MarkdownSection, keywords: readonly string[]): number {
    const heading = section.heading.toLowerCase();
    const body = section.body.toLowerCase();
    let score = 0;
    for (const keyword of keywords) {
        if (heading.includes(keyword)) {
            score += HEADING_KEYWORD_SCORE;
        }
        score += countHits(body, keyword);
    }
    return score;
}

/**
 * One document's contribution to a narrowed guidance response.
 */
interface NarrowedDocument {
    /**
     * Text to serve for this document: its matching sections — or, when none matched or none fit,
     * its cut best match or its preamble — followed by the document's heading index.
     */
    text: string;

    /**
     * Headings of the sections that text carries, in document order.
     */
    headings: string[];
}

/**
 * Guidance served for one topic, and which of its sections that text carries.
 */
export interface ServedInstructionGuidance {
    /**
     * The guidance text, within {@link MAX_GUIDANCE_CHARACTERS}.
     */
    text: string;

    /**
     * Headings of the sections served, in document order; absent when the documents fit the bound
     * and were served whole, so nothing was left out.
     */
    servedSectionHeadings?: string[];
}

/**
 * Marker closing a heading index the response could not list in full, naming how many headings it
 * left out — so a model reading a cut index knows the document has more of them and can ask for a
 * subject the listed part does not name.
 *
 * @param omitted - Headings the index left out.
 * @returns The marker line appended to the cut index.
 */
function indexTruncationMarker(omitted: number): string {
    return `\n… and ${omitted} more headings not listed here`;
}

/**
 * Render one document's heading index, bounded to the share of the budget an index may take.
 *
 * @param sections - Sections of the document, as {@link splitMarkdownSections} returned them.
 * @param budget - Characters this document may contribute to the response.
 * @returns The labelled index — whole when it fits its share, otherwise cut at a heading boundary
 *   and closed by the count it omitted; the empty string for a document with no headings, and for a
 *   budget too small to list even one.
 */
function boundedHeadingIndex(sections: readonly MarkdownSection[], budget: number): string {
    const lines = headingIndexLines(sections);
    if (lines.length === 0) {
        return '';
    }
    const label = `${HEADING_INDEX_LABEL}${INDEX_LINE_SEPARATOR}`;
    const whole = `${label}${lines.join(INDEX_LINE_SEPARATOR)}`;
    const reserve = Math.floor(budget * MAX_HEADING_INDEX_BUDGET_FRACTION);
    if (whole.length <= reserve) {
        return whole;
    }
    // The marker names how many headings were omitted, so its own length depends on how many lines
    // fit; reserving room for the widest count it could carry keeps that from circling.
    const markerRoom = indexTruncationMarker(lines.length).length;
    const kept: string[] = [];
    let used = label.length;
    for (const line of lines) {
        const cost = line.length + (kept.length === 0 ? 0 : INDEX_LINE_SEPARATOR.length);
        if (used + cost + markerRoom > reserve) {
            break;
        }
        kept.push(line);
        used += cost;
    }
    if (kept.length === 0) {
        return '';
    }
    return (
        `${label}${kept.join(INDEX_LINE_SEPARATOR)}` +
        indexTruncationMarker(lines.length - kept.length)
    );
}

/**
 * Narrow one document to the sections matching a set of keywords, always naming the rest.
 *
 * The heading index is bounded before the sections are chosen, so what remains is always enough to
 * carry section text: a narrowed answer that is only an index answers nothing.
 *
 * @param document - Normalized document text.
 * @param keywords - Lowercased topic and query keywords.
 * @param budget - Characters this document may contribute to the response.
 * @returns The text to serve and the headings of the sections it carries, in document order.
 */
function narrowDocument(
    document: string,
    keywords: readonly string[],
    budget: number,
): NarrowedDocument {
    const sections = splitMarkdownSections(document);
    const tail = boundedHeadingIndex(sections, budget);
    const room = Math.max(0, budget - (tail === '' ? 0 : tail.length + SECTION_SEPARATOR.length));
    const ranked = sections
        .filter((section) => section.heading !== '')
        .map((section, order) => ({ section, order, score: scoreSection(section, keywords) }))
        .filter((entry) => entry.score > 0)
        // oxlint-disable-next-line unicorn/no-array-sort -- ES2023 toSorted is outside this project target.
        .sort((left, right) => right.score - left.score || left.order - right.order)
        .map((entry) => entry.section);
    const taken: MarkdownSection[] = [];
    let used = 0;
    for (const candidate of ranked) {
        // Sections nest, so a parent and its child would serve the same text twice. Whichever of
        // the two is dropped is still named by the index.
        const overlaps = taken.some(
            (section) =>
                isContainedSection(candidate, section) || isContainedSection(section, candidate),
        );
        if (overlaps) {
            continue;
        }
        const cost = candidate.text.length + (taken.length === 0 ? 0 : SECTION_SEPARATOR.length);
        if (used + cost > room) {
            continue;
        }
        taken.push(candidate);
        used += cost;
    }
    if (taken.length === 0) {
        // Either nothing matched or the best match alone is bigger than the room. A cut best match
        // still answers the topic; the document's preamble is what is left when nothing matched.
        const fallback = ranked[0] ?? sections[0];
        const text = fallback?.text ?? '';
        const cut = text.slice(0, Math.max(0, room - TRUNCATION_MARKER.length));
        const opening = cut.length < text.length ? `${cut}${TRUNCATION_MARKER}` : cut;
        return {
            text: [opening, tail].filter((part) => part !== '').join(SECTION_SEPARATOR),
            headings: ranked[0] === undefined ? [] : [ranked[0].heading],
        };
    }
    // oxlint-disable-next-line unicorn/no-array-sort -- ES2023 toSorted is outside this project target.
    const ordered = [...taken].sort((left, right) => left.startLine - right.startLine);
    return {
        text: [...ordered.map((section) => section.text), tail]
            .filter((part) => part !== '')
            .join(SECTION_SEPARATOR),
        headings: ordered.map((section) => section.heading),
    };
}

/**
 * Serve the instruction's role documents for one topic, narrowed to the matching sections when they
 * do not fit whole.
 *
 * Documents that fit the response bound together are served whole and unchanged — the bound is what
 * narrowing exists for, and a policy document that fits has nothing to narrow. Past the bound each
 * document is served as its sections matching the topic's keywords plus the model's own query, in
 * document order, followed by an index of the document's headings: the model can then see what it
 * did not get and ask again for it, instead of concluding the guidance is absent. The index is
 * bounded to its own share of the response, and says how many headings it left out when it cannot
 * list them all, so a document with hundreds of headings still gets section text served.
 *
 * @param documents - The topic's bound role documents, in serving order.
 * @param topic - Validated lookup subject, whose keywords drive the scoring.
 * @param query - Optional model-supplied keywords for a subject the topics do not name.
 * @returns The guidance text and, when any document was narrowed, the headings actually served.
 */
export function serveInstructionDocuments(
    documents: readonly InstructionLinkedDocument[],
    topic: RuleGuidanceTopic,
    query?: string,
): ServedInstructionGuidance {
    const normalized = documents.map((document) =>
        document.content.replace(/\r\n/gu, '\n').replace(/\n+$/u, ''),
    );
    const whole = normalized.join(SECTION_SEPARATOR);
    if (whole.length <= MAX_GUIDANCE_CHARACTERS) {
        return { text: whole };
    }
    const keywords = [...INSTRUCTION_TOPIC_KEYWORDS[topic], ...queryKeywords(query)];
    const separators = SECTION_SEPARATOR.length * Math.max(0, normalized.length - 1);
    const budget = Math.floor((MAX_GUIDANCE_CHARACTERS - separators) / normalized.length);
    const narrowed = normalized.map((document) => narrowDocument(document, keywords, budget));
    return {
        text: narrowed
            .map((document) => document.text)
            .filter((text) => text !== '')
            .join(SECTION_SEPARATOR),
        servedSectionHeadings: narrowed.flatMap((document) => document.headings),
    };
}

/**
 * Build the typed not-linked notice for a topic whose roles the instruction did not link.
 *
 * This notice is the deterministic record point for the missing-information flow: the guidance tool
 * result itself carries the subject/detail a run harvests, so the gap reaches the run result even
 * when the model never calls the missing-information tool.
 *
 * @param topic - Validated lookup subject the agent asked for.
 * @param source - Instruction source that lacks the linked role document.
 * @param missing - Roles of the topic that no linked document fills.
 * @returns The notice result carrying the missing-information subject and detail.
 */
export function notLinkedResult(
    topic: RuleGuidanceTopic,
    source: InstructionGuidanceSource,
    missing: readonly GuidanceDocumentRole[],
): RuleGuidanceResult {
    const missingNames = missing.join(' or ');
    const roleNames = INSTRUCTION_TOPIC_ROLES[topic].join(' and ');
    const linkedRoles = source.documents.map((document) => document.role);
    const rosterText =
        linkedRoles.length === 0
            ? 'no role documents at all'
            : `only the ${linkedRoles.join(', ')} document(s)`;
    const subject = `No ${missingNames} document is linked for rule guidance topic ${topic}`;
    const guidance =
        `No ${missingNames} document is linked by this run's instruction, so the ${topic} topic ` +
        'has no authoritative text to serve. Work from the instruction itself and the documents ' +
        `it does link (${rosterText}), and record exactly what is missing.`;
    const detail =
        `Rule guidance topic ${topic} is defined by the run instruction's ${roleNames} ` +
        `document(s), but the instruction at ${source.path} links ${rosterText}. The ` +
        `${missingNames} guidance is absent for this run; record exactly what is missing so the ` +
        'run report can name the gap.';
    return {
        topic,
        guidance,
        maxCharacters: MAX_GUIDANCE_CHARACTERS,
        citations: [],
        notice: RuleGuidanceNotice.NotLinked,
        missingInformation: { subject, detail },
    };
}

/**
 * GitHub URL pattern isolating the owner and repository of a document hosted on GitHub: the one
 * host whose URLs name a repository slug a citation can carry.
 */
const GITHUB_DOCUMENT_URL_PATTERN =
    /^https:\/\/(?:github\.com|raw\.githubusercontent\.com)\/([^/#?\s]+)\/([^/#?\s]+)/iu;

/**
 * Build the citation of one served instruction document.
 *
 * A URL-sourced document carries a commit-less citation — it has no immutable revision to name —
 * located by the source URL and the whole-document anchor. A checkout-origin document carries no
 * citation at all: its locator is a moving local path, and the document's identity rides the source
 * digest instead.
 *
 * @param document - Instruction document served for the requested topic.
 * @returns The citation when the document has a stable URL locator, otherwise undefined.
 */
export function instructionDocumentCitation(
    document: InstructionLinkedDocument,
): KnowledgeGuidanceCitation | undefined {
    if (document.origin !== GuidanceDocumentOrigin.Url) {
        return undefined;
    }
    let parsed: URL;
    try {
        parsed = new URL(document.url);
    } catch {
        return undefined;
    }
    const githubMatch = GITHUB_DOCUMENT_URL_PATTERN.exec(document.url);
    const repository =
        githubMatch?.[1] !== undefined && githubMatch?.[2] !== undefined
            ? `${githubMatch[1]}/${githubMatch[2]}`
            : parsed.host;
    let filePath = decodeURIComponent(parsed.pathname).replace(/^\//u, '');
    if (filePath.length === 0) {
        filePath = parsed.host;
    }
    return {
        repository,
        commit: undefined,
        filePath,
        anchor: WHOLE_DOCUMENT_ANCHOR,
        url: document.url,
    };
}
