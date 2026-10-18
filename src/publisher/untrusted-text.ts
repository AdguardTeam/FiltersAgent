/**
 * Untrusted-text slot of the Publisher.
 *
 * The bounded single-line escape every untrusted fill renders through — the machinery
 * `report-render.ts` builds its fills with, kept in its own module so the render plumbing stays
 * within its size budget. Comment bodies on GitHub sanitize most HTML, but the escape is defense in
 * depth: one reader-dependent renderer decides what `{{tokens}}` in a template become, so untrusted
 * text is escaped, flattened, and bounded before entering any fill.
 *
 * The escape is the one shared renderer for untrusted text in public comments. It neutralizes the
 * plain HTML metacharacters and what GitHub turns into an action or a link: mentions, issue
 * references, autolinked URLs, links and images (see {@link NEUTRALIZED_CHARACTERS} and
 * {@link AUTOLINK_PREFIX_PATTERN}). It does so without HTML character references: GitHub's own page
 * decodes them, but the comment's Markdown is read as written too — in the run artifacts, in
 * notification e-mails, through the API — and there `the site&#39;s` is what a reader sees.
 */

import { MAX_MISSING_INFORMATION_DETAIL_CHARACTERS } from '../types/missing-information';

/**
 * Character ceiling for one untrusted fill in the report, counted in the characters a reader sees:
 * the source text, never its escaped form.
 *
 * The longest model-authored field a schema bounds is a missing-information detail; the run
 * summary, the unverified reason and a review's remaining instance are shorter. Every bounded field
 * therefore renders whole, as its schema promises the model, and only text no schema bounds — the
 * policy reasons, the evidence summary, the run's own reasoning — can reach the ceiling.
 *
 * For ordinary prose this keeps a report far inside GitHub's comment limit. It does not guarantee
 * it: ten missing-information entries and five remaining instances, every one at its schema maximum
 * and dense with reserved characters, pass the limit, and the publisher then refuses the body by
 * name before posting anything (`report-publisher.ts`).
 */
const MAX_UNTRUSTED_TEXT_CHARACTERS = MAX_MISSING_INFORMATION_DETAIL_CHARACTERS;

/**
 * Marker appended where text past the ceiling was cut, so a reader knows the fill is not whole and
 * where the rest is.
 */
const SHORTENED_MARK = ' (shortened; the full text is in the run artifacts)';

/**
 * Sentence boundaries of untrusted text, where a fill past the ceiling is cut.
 */
const SENTENCE_SEGMENTER = new Intl.Segmenter('en', { granularity: 'sentence' });

/**
 * U+2060 WORD JOINER: invisible and zero-width, and GitHub resolves no mention, issue reference or
 * autolink across it, so it keeps the text a reader sees while leaving it inert.
 */
const WORD_JOINER = '\u2060';

/**
 * The autolink prefixes no single reserved character covers: `www.` (GitHub links `www.host`
 * without a scheme) and `GH-` before a number (GitHub's alternative issue reference). A
 * {@link WORD_JOINER} goes between the prefix and its separator. Only a letter or a digit before
 * the prefix makes it part of a longer word: GitHub still links `x_www.host` and `_GH-13_`, which a
 * word boundary would miss after the underscore.
 */
const AUTOLINK_PREFIX_PATTERN = /(?<![\p{L}\p{N}])(www|gh)(?=\.|-\d)/giu;

/**
 * How each reserved character of untrusted text is made inert, one reserved character each.
 *
 * Every construct GitHub reads into plain text needs two characters side by side: `@` before a
 * login, `#` before an issue number or a heading's space, a scheme's `:` before `//`, `&` before an
 * entity name, `<` before a tag name, `[` or `]` against the rest of a link, an image, a link
 * definition or a footnote. A {@link WORD_JOINER} between the two breaks the construct and shows
 * nothing. GitHub decodes an entity such as `&#64;user` before it resolves mentions and references,
 * so `&` is broken the same way. A quote at the start of a line is broken by a joiner before its
 * `>`.
 *
 * A backslash is followed by a joiner too, so a backslash the model wrote can never escape the
 * character after it — a joiner, or one of the characters below. A backtick that opens no complete
 * span and a tilde are what a joiner cannot neutralize: Markdown pairs backtick runs whatever is
 * next to them, and three tildes at the start of a line open a code block that runs to the end of
 * the comment, so both are escaped with a backslash, which the joiner rule above leaves free to do.
 * Quotes mean nothing in Markdown text and stay as written.
 */
const NEUTRALIZED_CHARACTERS: Record<string, string> = {
    '@': `@${WORD_JOINER}`,
    '#': `#${WORD_JOINER}`,
    ':': `:${WORD_JOINER}`,
    '&': `&${WORD_JOINER}`,
    '<': `<${WORD_JOINER}`,
    '>': `${WORD_JOINER}>`,
    '[': `[${WORD_JOINER}`,
    ']': `]${WORD_JOINER}`,
    '\\': `\\${WORD_JOINER}`,
    '`': '\\`',
    '~': '\\~',
};

/**
 * A Markdown inline code span: a backtick run, content that neither starts nor ends with a
 * backtick, and a closing run of the same length. The opening run is a whole run, and one after a
 * backslash opens nothing, since Markdown reads that backtick literally.
 */
const CODE_SPAN_PATTERN = /(?<![\\`])(`+)(?!`)[^`]*?(?:`+[^`]+?)*?\1(?!`)/gu;

/**
 * A UTF-16 low surrogate: the second half of a character outside the Basic Multilingual Plane,
 * which a cut must never separate from its first half.
 */
const LOW_SURROGATE_PATTERN = /[\uDC00-\uDFFF]/u;

/**
 * Put a {@link WORD_JOINER} after every autolink prefix in untrusted text.
 *
 * @param text - Untrusted text outside any code span.
 * @returns The text with each `www.` and `GH-<number>` prefix broken.
 */
function breakAutolinkPrefixes(text: string): string {
    return text.replace(AUTOLINK_PREFIX_PATTERN, `$1${WORD_JOINER}`);
}

/**
 * Flatten untrusted text to one line: control characters and line breaks become spaces, so the fill
 * stays one line inside a `{{placeholder}}` slot.
 *
 * @param input - Raw untrusted text.
 * @returns The flattened text, unescaped and unbounded.
 */
function flattenUntrustedText(input: string): string {
    return input
        .replace(/\p{Cc}+/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
}

/**
 * Render untrusted model-authored text as bounded single-line escaped content.
 *
 * Why escaping and not plain inclusion: the text comes from the model and must never steer comment
 * structure (headings, marks, injected tags) no matter what it contains. Why bounding and not
 * rejecting: the run's full text lives in the artifacts; the short report needs it bounded, never
 * absent. Text past {@link MAX_UNTRUSTED_TEXT_CHARACTERS} is cut at its last sentence end that
 * fits, else between two words, never inside a code span, and says so with {@link SHORTENED_MARK}.
 *
 * @param input - Raw model-authored text.
 * @returns Escaped single-line text, or the empty string for empty input.
 */
export function renderUntrustedText(input: string): string {
    const singleLine = flattenUntrustedText(input);
    if (singleLine.length === 0) {
        return '';
    }
    const cut = untrustedTextCut(singleLine);
    const escaped = escapeUntrustedLine(singleLine.slice(0, cut));
    return cut < singleLine.length ? `${escaped}${SHORTENED_MARK}` : escaped;
}

/**
 * Where flattened untrusted text ends in the report.
 *
 * A cut inside a code span would leave its tail outside the code, so no cut lands inside one. A
 * sentence ends only where a space follows it: the segmenter also breaks after the `?` of a query
 * string, the `.` of a selector and the `!` of `!important`, and a cut there would end a URL or a
 * rule halfway. When not even a single word fits outside the spans, the cut falls at the ceiling
 * itself; a span it opens has no closing run left, and {@link escapeUntrustedLine} escapes it as
 * plain text.
 *
 * @param text - Flattened untrusted text.
 * @returns The length of the prefix the report shows: the whole text when it fits the ceiling.
 */
function untrustedTextCut(text: string): number {
    if (text.length <= MAX_UNTRUSTED_TEXT_CHARACTERS) {
        return text.length;
    }
    const spans = [...text.matchAll(CODE_SPAN_PATTERN)].map((span) => ({
        start: span.index,
        end: span.index + span[0].length,
    }));
    const outsideSpans = (index: number): boolean => {
        return spans.every((span) => index <= span.start || index >= span.end);
    };
    let sentenceEnd = 0;
    for (const { index, segment } of SENTENCE_SEGMENTER.segment(text)) {
        const end = index + segment.trimEnd().length;
        if (end > MAX_UNTRUSTED_TEXT_CHARACTERS) {
            break;
        }
        if (end < index + segment.length && outsideSpans(end)) {
            sentenceEnd = end;
        }
    }
    if (sentenceEnd > 0) {
        return sentenceEnd;
    }
    for (let index = MAX_UNTRUSTED_TEXT_CHARACTERS; index > 0; index -= 1) {
        if (text[index] === ' ' && outsideSpans(index)) {
            return index;
        }
    }
    return LOW_SURROGATE_PATTERN.test(text[MAX_UNTRUSTED_TEXT_CHARACTERS] ?? '')
        ? MAX_UNTRUSTED_TEXT_CHARACTERS - 1
        : MAX_UNTRUSTED_TEXT_CHARACTERS;
}

/**
 * Escape one flattened line of untrusted text, keeping its complete code spans as written.
 *
 * A code span shows its content literally, so anything the escape put inside one would show: each
 * complete span goes in unescaped, whole, and only the text around the spans is escaped.
 *
 * @param text - Flattened untrusted text, already cut to the length the report shows.
 * @returns The escaped line.
 */
function escapeUntrustedLine(text: string): string {
    let escaped = '';
    let index = 0;
    for (const span of text.matchAll(CODE_SPAN_PATTERN)) {
        escaped += escapePlainText(text.slice(index, span.index)) + span[0];
        index = span.index + span[0].length;
    }
    return escaped + escapePlainText(text.slice(index));
}

/**
 * Escape plain untrusted text outside any code span, character by character.
 *
 * @param text - Flattened plain text outside any code span.
 * @returns The escaped text.
 */
function escapePlainText(text: string): string {
    let escaped = '';
    for (const character of breakAutolinkPrefixes(text)) {
        escaped += NEUTRALIZED_CHARACTERS[character] ?? character;
    }
    return escaped;
}

/**
 * Render a filter rule as a Markdown inline code span that cannot be broken out of.
 *
 * A rule is repository content, not model-authored prose, but it is still untrusted Markdown: an
 * AdGuard network rule wildcarding a path segment on both sides carries a bare asterisk on each
 * side of a slash, which CommonMark reads as a pair of emphasis markers unless the whole value
 * stays inside a code span. A code span's content is taken literally by the Markdown parser — no
 * character inside it needs HTML escaping — except for its own delimiter: a rule may itself contain
 * a run of backticks, and CommonMark only closes a span on a run of exactly the opening length, so
 * the fence must be one backtick longer than the longest run already inside the rule. The rule is
 * never shortened: a cut rule is a different rule.
 *
 * @param rule - Raw filter rule text, single line.
 * @returns The rule wrapped in a delimiter-safe inline code span, or the empty string for empty
 *   input.
 */
export function renderUntrustedRuleCodeSpan(rule: string): string {
    const flattened = flattenUntrustedText(rule);
    if (flattened.length === 0) {
        return '';
    }
    const longestBacktickRun =
        flattened.match(/`+/gu)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0;
    const fence = '`'.repeat(longestBacktickRun + 1);
    const padded =
        flattened.startsWith('`') || flattened.endsWith('`') ? ` ${flattened} ` : flattened;
    return `${fence}${padded}${fence}`;
}

/**
 * The shortest fence CommonMark accepts for a fenced code block.
 */
const MIN_CODE_FENCE_LENGTH = 3;

/**
 * Control characters dropped from a code block: every C0/C1 control except the tab and the line
 * feed that give the block its layout.
 */
const CODE_BLOCK_CONTROL_PATTERN = /[^\P{Cc}\t\n]/gu;

/**
 * Render untrusted multi-line text — a command's output — as a fenced code block that cannot be
 * broken out of.
 *
 * Inside a fenced block GitHub reads nothing as Markdown or HTML, so mentions, links and tags stay
 * inert without escaping. The one way out is a line holding the fence itself, so the fence is one
 * backtick longer than the longest backtick run in the text. Line endings are normalized and
 * control characters other than tab and newline are dropped, so terminal escape sequences cannot
 * survive.
 *
 * @param text - Untrusted multi-line text, already bounded by its producer.
 * @returns The fenced block, or the empty string when the text is blank.
 */
export function renderUntrustedCodeBlock(text: string): string {
    const cleaned = text.replace(/\r\n?/gu, '\n').replace(CODE_BLOCK_CONTROL_PATTERN, '').trimEnd();
    if (cleaned.trim().length === 0) {
        return '';
    }
    const longestBacktickRun =
        cleaned.match(/`+/gu)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0;
    const fence = '`'.repeat(Math.max(MIN_CODE_FENCE_LENGTH, longestBacktickRun + 1));
    return `${fence}\n${cleaned}\n${fence}`;
}
