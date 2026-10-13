import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    GuidanceDocumentOrigin,
    GuidanceDocumentRole,
    MAX_GUIDANCE_CHARACTERS,
    MAX_LINKED_DOCUMENTS,
    RuleGuidanceSourceKind,
    type InstructionGuidanceSource,
    type InstructionLinkedDocument,
} from '../../src/knowledge/guidance-source';
import { RuleGuidanceNotice, WHOLE_DOCUMENT_ANCHOR } from '../../src/knowledge/instruction-serving';
import {
    KnowledgeGuidanceSession,
    RULE_GUIDANCE_TOPICS,
    type KnowledgeGuidanceCitation,
    type KnowledgeGuidanceSource,
    type RuleGuidanceTopic,
} from '../../src/knowledge/rule-guidance';

const KNOWLEDGE_COMMIT = '1'.repeat(40);
const FILTERS_COMMIT = '2'.repeat(40);

/**
 * Assert a citation URL is assembled from its own working components without pinning the serialized
 * string: it must carry the cited slug, commit, path, and anchor inside the repository's blob
 * shape.
 *
 * @param citation - The citation whose URL is checked against its own identity components.
 */
function expectCitationUrlIdentifiesComponents(citation: KnowledgeGuidanceCitation): void {
    expect(citation.url.startsWith('https://github.com/')).toBe(true);
    expect(citation.url).toContain(`/${citation.repository}/blob/`);
    expect(citation.url).toContain(`/${citation.commit}/${citation.filePath}#${citation.anchor}`);
}

function createSource(): KnowledgeGuidanceSource {
    const root = mkdtempSync(join(tmpdir(), 'rule-guidance-'));
    const syntaxPath = join(root, 'create-own-filters.md');
    const policyPath = join(root, 'filter-policy.md');
    const contributingPath = join(root, 'CONTRIBUTING.md');
    mkdirSync(root, { recursive: true });
    writeFileSync(
        syntaxPath,
        [
            '## Basic rules',
            '### Basic rule syntax {#basic-rules-syntax}',
            'Network guidance.',
            '### Special characters',
            '## Cosmetic rules',
            '### Element hiding rules {#cosmetic-elemhide-rules}',
            'Use ## to hide an element.',
            '### CSS rules {#cosmetic-css-rules}',
            'Use #$# only when hiding is insufficient.',
            '### Extended CSS selectors {#extended-css-selectors}',
            'Extended selector guidance.',
            '## Scriptlet rules {#scriptlets}',
            'Scriptlet guidance.',
            '## Exception rules modifiers {#exception-modifiers}',
            'Exception rules begin with @@.',
            '## Restrictions and limitations',
            'Platform restrictions.',
            '## Compatibility tables legend {#compatibility-tables-legend}',
            'Compatibility guidance.',
        ].join('\n'),
    );
    writeFileSync(
        policyPath,
        [
            '## Common criteria',
            'Rules must not break websites.',
            '## Ad blocking filters',
            'Ad leftovers should be blocked.',
        ].join('\n'),
    );
    writeFileSync(
        contributingPath,
        [
            '## Workflow for submitting changes',
            'Follow the contribution workflow.',
            '### Rule placement',
            'Inspect similar rules.',
            '## Repository structure',
            'Place rules in the proper section.',
        ].join('\n'),
    );
    return {
        kind: RuleGuidanceSourceKind.KnowledgeBase,
        knowledgeBaseCommit: KNOWLEDGE_COMMIT,
        filtersCommit: FILTERS_COMMIT,
        knowledgeBaseRepository: 'fork-owner/knowledge-base',
        filtersRepository: 'fork-owner/adguard-filters',
        syntaxPath,
        policyPath,
        contributingPath,
    };
}

describe('KnowledgeGuidanceSession', () => {
    it('supports only the bounded guidance topic allowlist', () => {
        expect(RULE_GUIDANCE_TOPICS).toEqual([
            'element_hiding',
            'css_injection',
            'extended_css',
            'network',
            'scriptlet',
            'exception',
            'compatibility',
            'placement',
            'policy',
        ]);
    });

    it('resolves a section for every allowlisted topic', () => {
        const session = new KnowledgeGuidanceSession(createSource());

        for (const topic of RULE_GUIDANCE_TOPICS) {
            const result = session.lookup(topic);

            expect(result.citations.length, `topic ${topic} resolved no section`).toBeGreaterThan(
                0,
            );
            expect(result.guidance.length, `topic ${topic} returned no guidance`).toBeGreaterThan(
                0,
            );
        }
    });

    it('refuses to start when a pinned section no longer exists upstream', () => {
        // A stale anchor used to surface only when the model happened to request that topic,
        // mid-run, after the run had already been paid for.
        const source = createSource();
        writeFileSync(source.syntaxPath, ['## Basic rules', 'Nothing else survived.'].join('\n'));

        expect(() => new KnowledgeGuidanceSession(source)).toThrow(/stale/i);
    });

    it('returns pinned immutable citations and only the requested sections', () => {
        const session = new KnowledgeGuidanceSession(createSource());

        const result = session.lookup('element_hiding');

        expect(result.topic).toBe('element_hiding');
        expect(result.guidance).toContain('Use ## to hide an element.');
        expect(result.guidance).not.toContain('Extended selector guidance.');
        expect(result.citations).toHaveLength(1);
        const [citation] = result.citations;
        expect(citation).toMatchObject({
            repository: 'fork-owner/knowledge-base',
            commit: KNOWLEDGE_COMMIT,
            filePath: 'docs/general/ad-filtering/create-own-filters.md',
            anchor: 'cosmetic-elemhide-rules',
        });
        expectCitationUrlIdentifiesComponents(citation);
        expect(result.guidance.length).toBeLessThanOrEqual(result.maxCharacters);
        expect(session.hasConsultedGuidance()).toBe(true);
    });

    it('uses the exact filters checkout for placement guidance', () => {
        const session = new KnowledgeGuidanceSession(createSource());

        const result = session.lookup('placement');

        expect(result.guidance).toContain('Inspect similar rules.');
        expect(result.guidance).toContain('Place rules in the proper section.');
        expect(result.citations).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    repository: 'fork-owner/adguard-filters',
                    commit: FILTERS_COMMIT,
                    filePath: 'CONTRIBUTING.md',
                    anchor: 'rule-placement',
                }),
                expect.objectContaining({
                    repository: 'fork-owner/adguard-filters',
                    commit: FILTERS_COMMIT,
                    filePath: 'CONTRIBUTING.md',
                    anchor: 'repository-structure',
                }),
            ]),
        );
        for (const citation of result.citations) {
            expectCitationUrlIdentifiesComponents(citation);
        }
    });

    it('rejects a source whose citation repository is not an owner/repo slug', () => {
        const source: KnowledgeGuidanceSource = {
            ...createSource(),
            knowledgeBaseRepository: 'knowledge-base',
            filtersRepository: 'https://github.com/fork-owner/adguard-filters',
        };

        expect(() => new KnowledgeGuidanceSession(source)).toThrow(/owner\/repo/i);
    });

    it('rejects unknown topics without reading arbitrary files', () => {
        const session = new KnowledgeGuidanceSession(createSource());

        expect(() => session.lookup('secrets' as never)).toThrow(/unsupported guidance topic/i);
        expect(session.hasConsultedGuidance()).toBe(false);
    });
});

const INSTRUCTION_SYNTAX_URL =
    'https://github.com/instruction-owner/instruction-repo/refs/heads/master/README.md';

function instructionDocument(
    role: GuidanceDocumentRole,
    content: string,
    options?: { url?: string; origin?: GuidanceDocumentOrigin },
): InstructionLinkedDocument {
    const isRemote = (options?.origin ?? GuidanceDocumentOrigin.Url) === GuidanceDocumentOrigin.Url;
    return {
        role,
        origin: options?.origin ?? GuidanceDocumentOrigin.Url,
        url:
            options?.url ??
            (isRemote
                ? `https://github.com/instruction-owner/docs/master/${role}-doc.md`
                : `${role}-doc.md`),
        content,
        // The loader digests instruction documents with SHA-256, the 64-hex width the serving
        // session re-asserts; a git-style 40-hex digest is loader-nonconformant.
        sha256: 'a'.repeat(64),
    };
}

function createInstructionSource(overrides?: {
    documents?: readonly InstructionLinkedDocument[];
}): InstructionGuidanceSource {
    return {
        kind: RuleGuidanceSourceKind.Instruction,
        path: 'AGENTS.md',
        sha256: 'b'.repeat(64),
        documents: overrides?.documents ?? [
            instructionDocument(GuidanceDocumentRole.Syntax, '# Syntax\nSyntax text.\n'),
            instructionDocument(GuidanceDocumentRole.Policy, '# Policy\nPolicy text.\n'),
            instructionDocument(
                GuidanceDocumentRole.Contributing,
                '# Contributing\nContributing text.\n',
            ),
        ],
    };
}

/**
 * Padding carrying no guidance-topic keyword, so a padded section scores on its heading alone and
 * the fixture's ranking is about the headings under test rather than about its filler.
 */
const PADDING_SENTENCE = 'Padding sentence with no topic keyword. ';

/**
 * Characters of padding put in front of the modifier subsections, so that both the section naming
 * the modifiers and its parent are too long to serve whole. Only then does reaching one individual
 * modifier depend on the query.
 */
const DEEP_PADDING_CHARACTERS = 9_000;

const SCRIPTLET_HEADING_TEXT = 'Scriptlet injection';
const SCRIPTLET_HEADING = `## ${SCRIPTLET_HEADING_TEXT}`;
const SCRIPTLET_BODY_MARKER = 'Inject a scriptlet with';
const REMOVEPARAM_HEADING = '#### removeparam';
const REMOVEPARAM_BODY_MARKER = 'Strips the named query parameter';
const TAIL_HEADING = '## Response header filtering';
const TAIL_BODY_MARKER = 'The last thing this page documents.';
const FENCED_EXAMPLE_HEADING = '## Example heading inside a fenced block';
const FENCED_SECTION_TAIL = 'The block above is an example, not a section of this page.';

/**
 * Padding of a given length.
 *
 * @param characters - Roughly how many characters of padding to produce.
 * @returns The padding text.
 */
function padding(characters: number): string {
    return PADDING_SENTENCE.repeat(Math.ceil(characters / PADDING_SENTENCE.length));
}

/**
 * A syntax reference shaped like the document the live failure came from: far past the response
 * bound, nested `##`/`###`/`####` headings, and the section a topic asks for sitting tens of
 * thousands of characters past the cut point.
 *
 * @returns The fixture document text.
 */
function longSyntaxDocument(): string {
    return [
        '# Static filter syntax',
        'Introduction.',
        '',
        '## Pre-parsing directives',
        padding(DEEP_PADDING_CHARACTERS),
        '',
        '## Static network filtering',
        padding(DEEP_PADDING_CHARACTERS),
        'Network rules take options.',
        '',
        '### Modifier filters',
        padding(DEEP_PADDING_CHARACTERS),
        'Each modifier is described below.',
        '',
        REMOVEPARAM_HEADING,
        `${REMOVEPARAM_BODY_MARKER} from the request URL.`,
        '',
        '#### csp',
        'Sets a content security policy on the response.',
        '',
        '## Static extended filtering',
        '',
        '### Cosmetic filters',
        'Use ## to hide an element on a page.',
        '',
        `${SCRIPTLET_HEADING}`,
        `${SCRIPTLET_BODY_MARKER} the +js form; the bundled resources name every scriptlet.`,
        '',
        TAIL_HEADING,
        TAIL_BODY_MARKER,
    ].join('\n');
}

/**
 * Headings the index-overflow fixture carries. The AdGuard `create-own-filters.md` syntax reference
 * has 187, whose index is around 8.8k characters — larger than the whole response — and the test
 * asserts the overflow rather than trusting this count to keep producing it.
 */
const INDEX_OVERFLOW_HEADING_COUNT = 200;

/**
 * One heading of the index-overflow fixture, as long as a real reference's option headings and
 * carrying no guidance-topic keyword, so the fixture's sections score on nothing at all and only
 * the scriptlet section can answer the topic.
 *
 * @param ordinal - Position of the heading in the document.
 * @returns The heading line.
 */
function indexOverflowHeading(ordinal: number): string {
    return `## Rule detail number ${ordinal} and what it changes about a request`;
}

/**
 * Every `##` heading line of the index-overflow fixture, in document order — all but two lines of
 * the index the document renders, so their joined length is a lower bound on it.
 *
 * @returns The heading lines.
 */
function indexOverflowHeadings(): string[] {
    return Array.from({ length: INDEX_OVERFLOW_HEADING_COUNT }, (_unused, ordinal) =>
        indexOverflowHeading(ordinal),
    );
}

/**
 * A syntax reference with so many headings that the index naming them all does not fit the response
 * on its own, with the section one topic asks for at the far end of it.
 *
 * @returns The fixture document text.
 */
function indexOverflowSyntaxDocument(): string {
    const lines = ['# Filter rule reference', 'Introduction.'];
    for (const heading of indexOverflowHeadings()) {
        lines.push('', heading, PADDING_SENTENCE);
    }
    lines.push('', SCRIPTLET_HEADING, `${SCRIPTLET_BODY_MARKER} the +js form.`);
    return lines.join('\n');
}

describe('KnowledgeGuidanceSession instruction serving', () => {
    it('serves the whole role document for each topic mapped to it', () => {
        const session = new KnowledgeGuidanceSession(createInstructionSource());
        const repositoryTopics: readonly RuleGuidanceTopic[] = ['placement', 'policy'];
        const syntaxTopics = RULE_GUIDANCE_TOPICS.filter(
            (topic) => !repositoryTopics.includes(topic),
        );

        for (const topic of syntaxTopics) {
            const result = session.lookup(topic);
            expect(result.guidance, `topic ${topic}`).toBe('# Syntax\nSyntax text.');
        }
        for (const topic of repositoryTopics) {
            expect(session.lookup(topic).guidance, `topic ${topic}`).toBe(
                '# Policy\nPolicy text.\n\n# Contributing\nContributing text.',
            );
        }
    });

    it('normalizes CRLF line endings when serving instruction documents', () => {
        const session = new KnowledgeGuidanceSession(
            createInstructionSource({
                documents: [
                    instructionDocument(GuidanceDocumentRole.Syntax, 'line one\r\nline two\r\n'),
                ],
            }),
        );

        const result = session.lookup('network');

        expect(result.guidance).toBe('line one\nline two');
        expect(result.guidance).not.toContain('\r');
    });

    it('serves the topic\u2019s own section of an oversized document, not its opening', () => {
        // The live failure: the syntax document was the 75 KB uBlock Origin "Static filter syntax"
        // wiki page, lookup_rule_guidance('scriptlet') returned its first 8000 characters \u2014 cut
        // inside "Pre-parsing directives" \u2014 and the run filed report_missing_information saying
        // the scriptlet section was unreachable, from a page that documents it at length.
        const session = new KnowledgeGuidanceSession(
            createInstructionSource({
                documents: [instructionDocument(GuidanceDocumentRole.Syntax, longSyntaxDocument())],
            }),
        );

        const result = session.lookup('scriptlet');

        expect(result.guidance).toContain(SCRIPTLET_HEADING);
        expect(result.guidance).toContain(SCRIPTLET_BODY_MARKER);
        // Nothing of the padded opening: that is what used to consume the whole response.
        expect(result.guidance).not.toContain(PADDING_SENTENCE);
        expect(result.guidance.length).toBeLessThanOrEqual(result.maxCharacters);
        expect(result.servedSectionHeadings).toContain(SCRIPTLET_HEADING_TEXT);
    });

    it('names the headings it did not serve so the model can ask for them', () => {
        // Without the index a narrowed response is indistinguishable from an absent section, which
        // is precisely the mistake the live run made.
        const session = new KnowledgeGuidanceSession(
            createInstructionSource({
                documents: [instructionDocument(GuidanceDocumentRole.Syntax, longSyntaxDocument())],
            }),
        );

        const result = session.lookup('scriptlet');

        // A heading from the far end of the document, whose body was not served: the index names
        // it, the section itself is absent.
        expect(result.guidance).toContain(TAIL_HEADING);
        expect(result.guidance).not.toContain(TAIL_BODY_MARKER);
    });

    it('still serves section text when the document has more headings than the response can name', () => {
        // The AdGuard syntax reference is this document: 187 headings whose index is larger than
        // the whole 8000-character response. Reserving the index in full left zero room, so every
        // syntax topic was answered with an index and no guidance at all — and overran the bound
        // the answer promises. The index is navigation; the section is the answer.
        const document = indexOverflowSyntaxDocument();
        expect(indexOverflowHeadings().join('\n').length).toBeGreaterThan(MAX_GUIDANCE_CHARACTERS);
        const session = new KnowledgeGuidanceSession(
            createInstructionSource({
                documents: [instructionDocument(GuidanceDocumentRole.Syntax, document)],
            }),
        );

        const result = session.lookup('scriptlet');

        expect(result.guidance).toContain(SCRIPTLET_HEADING);
        expect(result.guidance).toContain(SCRIPTLET_BODY_MARKER);
        expect(result.servedSectionHeadings).toContain(SCRIPTLET_HEADING_TEXT);
        expect(result.guidance.length).toBeLessThanOrEqual(result.maxCharacters);
        // The index was cut rather than dropped: the model must still learn that the document has
        // headings this answer could not name, or a narrowed answer reads as an exhaustive one.
        expect(result.guidance).toContain(indexOverflowHeading(0));
        expect(result.guidance).not.toContain(
            indexOverflowHeading(INDEX_OVERFLOW_HEADING_COUNT - 1),
        );
    });

    it('narrows an oversized document to the section a query names', () => {
        const session = new KnowledgeGuidanceSession(
            createInstructionSource({
                documents: [instructionDocument(GuidanceDocumentRole.Syntax, longSyntaxDocument())],
            }),
        );

        const queried = session.lookup('network', 'removeparam');
        const topicOnly = session.lookup('network');

        // The fixed topics do not name individual modifiers, and the modifier's own section sits
        // deep under two oversized parents: the query is the only way to reach it.
        expect(queried.guidance).toContain(REMOVEPARAM_HEADING);
        expect(queried.guidance).toContain(REMOVEPARAM_BODY_MARKER);
        expect(topicOnly.guidance).not.toContain(REMOVEPARAM_BODY_MARKER);
    });

    it('does not mistake a heading inside a fenced block for a section', () => {
        // A syntax reference is mostly fenced examples. Read as headings they split a real section
        // in two \u2014 the served part stops at the fence \u2014 and add sections to the index that the
        // document does not have.
        const session = new KnowledgeGuidanceSession(
            createInstructionSource({
                documents: [
                    instructionDocument(
                        GuidanceDocumentRole.Syntax,
                        [
                            '# Syntax',
                            padding(DEEP_PADDING_CHARACTERS),
                            '',
                            SCRIPTLET_HEADING,
                            `${SCRIPTLET_BODY_MARKER} the +js form.`,
                            '```markdown',
                            FENCED_EXAMPLE_HEADING,
                            '```',
                            FENCED_SECTION_TAIL,
                        ].join('\n'),
                    ),
                ],
            }),
        );

        const result = session.lookup('scriptlet');

        expect(result.servedSectionHeadings).toEqual([SCRIPTLET_HEADING_TEXT]);
        // The section runs past its own fenced example instead of ending at it.
        expect(result.guidance).toContain(FENCED_SECTION_TAIL);
    });

    it('returns the typed not-linked notice with the missing-information record', () => {
        const session = new KnowledgeGuidanceSession(
            createInstructionSource({
                documents: [
                    instructionDocument(GuidanceDocumentRole.Syntax, '# Syntax\nSyntax text.\n'),
                ],
            }),
        );

        const result = session.lookup('placement');

        expect(result.notice).toBe(RuleGuidanceNotice.NotLinked);
        expect(result.missingInformation?.subject).toContain('policy');
        expect(result.missingInformation?.subject).toContain('contributing');
        expect(result.missingInformation?.subject).toContain('placement');
        expect(result.missingInformation?.detail).toContain('placement');
        expect(result.missingInformation?.detail).toContain('AGENTS.md');
        expect(result.missingInformation?.detail).toContain('syntax');
        expect(result.guidance).toContain('policy');
        expect(result.citations).toEqual([]);
        expect(session.hasConsultedGuidance()).toBe(true);
    });

    it('serves placement from whichever of its role documents is linked', () => {
        // uAssets links its CONTRIBUTING.md once, as the policy document: a live run asked for
        // placement and was told the topic was not linked because no separate contributing
        // document existed. One linked role answers the topic; the notice is for none.
        const session = new KnowledgeGuidanceSession(
            createInstructionSource({
                documents: [
                    instructionDocument(GuidanceDocumentRole.Policy, '# Policy\nPolicy text.\n'),
                ],
            }),
        );

        const result = session.lookup('placement');

        expect(result.notice).toBeUndefined();
        expect(result.missingInformation).toBeUndefined();
        expect(result.guidance).toContain('Policy text.');
        expect(result.citations).toHaveLength(1);
    });

    it('answers a policy question from the linked policy document, never the syntax reference', () => {
        // A shellshock.io run: the instruction linked uAssets' CONTRIBUTING.md as the
        // policy document, the run asked `exception` and then `scriptlet` for how this repository
        // treats anti-adblock detection, got syntax sections both times, and filed
        // report_missing_information saying the filtering policy was not served at all.
        const session = new KnowledgeGuidanceSession(
            createInstructionSource({
                documents: [
                    instructionDocument(GuidanceDocumentRole.Syntax, '# Syntax\nSyntax text.\n'),
                    instructionDocument(
                        GuidanceDocumentRole.Policy,
                        '# Contributing\nAnti-adblock detection is out of scope for this list.\n',
                    ),
                ],
            }),
        );

        const served = session.lookup('policy', 'anti-adblock detection policy exceptions');

        expect(served.notice).toBeUndefined();
        expect(served.guidance).toContain('Anti-adblock detection is out of scope for this list.');
        expect(served.guidance).not.toContain('Syntax text.');
        expect(served.citations).toHaveLength(1);

        const withoutPolicy = new KnowledgeGuidanceSession(
            createInstructionSource({
                documents: [
                    instructionDocument(GuidanceDocumentRole.Syntax, '# Syntax\nSyntax text.\n'),
                ],
            }),
        ).lookup('policy');

        expect(withoutPolicy.notice).toBe(RuleGuidanceNotice.NotLinked);
        expect(withoutPolicy.missingInformation?.subject).toContain('policy');
    });

    it('cites a served https document without a commit', () => {
        const session = new KnowledgeGuidanceSession(
            createInstructionSource({
                documents: [
                    instructionDocument(GuidanceDocumentRole.Syntax, '# Syntax\nSyntax text.\n', {
                        url: INSTRUCTION_SYNTAX_URL,
                    }),
                ],
            }),
        );

        const result = session.lookup('element_hiding');

        expect(result.citations).toEqual([
            {
                repository: 'instruction-owner/instruction-repo',
                commit: undefined,
                filePath: 'instruction-owner/instruction-repo/refs/heads/master/README.md',
                anchor: WHOLE_DOCUMENT_ANCHOR,
                url: INSTRUCTION_SYNTAX_URL,
            },
        ]);
    });

    it('serves a checkout-origin document without a citation', () => {
        const session = new KnowledgeGuidanceSession(
            createInstructionSource({
                documents: [
                    instructionDocument(GuidanceDocumentRole.Syntax, '# Syntax\nSyntax text.\n', {
                        origin: GuidanceDocumentOrigin.CheckoutFile,
                    }),
                ],
            }),
        );

        const result = session.lookup('element_hiding');

        expect(result.guidance).toBe('# Syntax\nSyntax text.');
        expect(result.citations).toEqual([]);
    });

    it('rejects an instruction source above the linked-document cap', () => {
        const documents = Array.from({ length: MAX_LINKED_DOCUMENTS + 1 }, (_, index) =>
            instructionDocument(GuidanceDocumentRole.Syntax, `document ${index}\n`),
        );

        expect(() => new KnowledgeGuidanceSession(createInstructionSource({ documents }))).toThrow(
            new RegExp(`above the ${MAX_LINKED_DOCUMENTS}-document cap`),
        );
    });

    it('rejects an instruction source with an unknown role or a partial digest', () => {
        const unknownRole: InstructionLinkedDocument = {
            ...instructionDocument(GuidanceDocumentRole.Syntax, 'text\n'),
            role: 'recipes' as never,
        };
        const partialDigest = {
            ...instructionDocument(GuidanceDocumentRole.Syntax, 'text\n'),
            sha256: 'zz',
        };

        expect(
            () =>
                new KnowledgeGuidanceSession(createInstructionSource({ documents: [unknownRole] })),
        ).toThrow();
        expect(
            () =>
                new KnowledgeGuidanceSession(
                    createInstructionSource({ documents: [partialDigest] }),
                ),
        ).toThrow();
    });
});
