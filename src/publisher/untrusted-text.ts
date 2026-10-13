/**
 * Untrusted-text slot of the Publisher.
 *
 * The bounded single-line escape every untrusted fill renders through — the machinery
 * `report-render.ts` builds its fills with, kept in its own module so the render plumbing stays
 * within its size budget. Comment bodies on GitHub sanitize most HTML, but the escape is defense in
 * depth: one reader-dependent renderer decides what `{{tokens}}` in a template become, so untrusted
 * text is escaped, flattened, and bounded before entering any fill.
 *
 * The escape is the one shared renderer for untrusted text in public comments, and other renderers
 * of fix-agent prose apply the same mapping, so every surface neutralizes model-authored text
 * identically. Beyond the plain HTML metacharacters, it also neutralizes what GitHub turns into an
 * action or a link: mentions, issue references, autolinked URLs, links and images (see
 * {@link ESCAPED_CHARACTERS} and {@link AUTOLINK_PREFIX_PATTERN}).
 */

/**
 * Character ceiling for one escaped untrusted fill in the report.
 *
 * Model-authored text is bounded, not dropped: a whole-sentence summary usually fits, and a longer
 * run still ends in the artifacts.
 */
const MAX_UNTRUSTED_TEXT_CHARACTERS = 500;

/**
 * Marker appended when escaping stops at the character ceiling, so a truncated fill is visible.
 */
const TRUNCATION_MARK = '…';

/**
 * U+2060 WORD JOINER: invisible and zero-width, and GitHub resolves no mention, issue reference or
 * autolink across it, so it keeps the text a reader sees while leaving it inert.
 */
const WORD_JOINER = '\u2060';

/**
 * The autolink prefixes no single reserved character covers: `www.` (GitHub links `www.host`
 * without a scheme) and `GH-` before a number (GitHub's alternative issue reference). A
 * {@link WORD_JOINER} goes between the prefix and its separator.
 */
const AUTOLINK_PREFIX_PATTERN = /\b(www|gh)(?=\.|-\d)/giu;

/**
 * HTML entity replacements applied to untrusted text, one reserved character each.
 *
 * `[` and `]` are escaped because a link and an image need them literally. An entity alone does not
 * stop a mention or a reference: GitHub decodes `&#64;user` and `&#35;123` before it resolves them,
 * so it still notifies the user and cross-references the issue. `@` and `#` are therefore followed
 * by a {@link WORD_JOINER}, which GitHub's resolvers do not cross. `:` is escaped because an entity
 * between a scheme and `//` does stop GitHub autolinking `https://…`, `ftp://…` and `mailto:…`.
 *
 * `\` and `` ` `` are escaped because Markdown would otherwise reread text this module already
 * decided on: a backslash before an entity's `&` makes GitHub show the entity as text (a model's
 * `\"` read as `\&quot;`), and a backtick left outside every complete span could pair with another
 * one and open a code span that shows the entities inside it literally.
 */
const ESCAPED_CHARACTERS: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
    '@': `&#64;${WORD_JOINER}`,
    '[': '&#91;',
    ']': '&#93;',
    '#': `&#35;${WORD_JOINER}`,
    ':': '&#58;',
    '\\': '&#92;',
    '`': '&#96;',
};

/**
 * A Markdown inline code span: a backtick run, content that neither starts nor ends with a
 * backtick, and a closing run of the same length. The opening run is a whole run, and one after a
 * backslash opens nothing, since Markdown reads that backtick literally.
 */
const CODE_SPAN_PATTERN = /(?<![\\`])(`+)(?!`)[^`]*?(?:`+[^`]+?)*?\1(?!`)/gu;

/**
 * Escape one character of untrusted text for safe inclusion in the comment body.
 *
 * @param character - One Unicode character from the flattened source text.
 * @returns The HTML entity for a reserved character, else the character itself.
 */
function escapeUntrustedCharacter(character: string): string {
    return ESCAPED_CHARACTERS[character] ?? character;
}

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
 * Render untrusted model-authored text as bounded single-line escaped content.
 *
 * Why escaping and not plain inclusion: the text comes from the model and must never steer comment
 * structure (headings, marks, injected tags) no matter what it contains, and control characters
 * plus line breaks are dropped so the fill stays one line inside a `{{placeholder}}` slot. Why
 * bounding and not rejecting: the run's full text lives in the artifacts; the short report needs it
 * bounded, never absent.
 *
 * @param input - Raw model-authored text.
 * @returns Escaped single-line text at most `MAX_UNTRUSTED_TEXT_CHARACTERS` characters (ellipsis
 *   included), or the empty string for empty input.
 */
export function renderUntrustedText(input: string): string {
    const singleLine = input
        .replace(/\p{Cc}+/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
    if (singleLine.length === 0) {
        return '';
    }
    const budget = MAX_UNTRUSTED_TEXT_CHARACTERS - TRUNCATION_MARK.length;
    let escaped = '';
    let truncated = false;
    let index = 0;
    for (const span of singleLine.matchAll(CODE_SPAN_PATTERN)) {
        const plain = escapeWithin(singleLine.slice(index, span.index), budget - escaped.length);
        escaped += plain.text;
        if (plain.truncated) {
            truncated = true;
            break;
        }
        // A code span shows its content literally, so an entity inside it would show as one: the
        // span goes in unescaped, whole. One that does not fit is escaped like plain text instead,
        // since a cut span would leave its tail outside the code.
        if (escaped.length + span[0].length <= budget) {
            escaped += span[0];
        } else {
            const cut = escapeWithin(span[0], budget - escaped.length);
            escaped += cut.text;
            truncated = cut.truncated;
            break;
        }
        index = span.index + span[0].length;
    }
    if (!truncated) {
        const rest = escapeWithin(singleLine.slice(index), budget - escaped.length);
        escaped += rest.text;
        truncated = rest.truncated;
    }
    return truncated ? `${escaped}${TRUNCATION_MARK}` : escaped;
}

/**
 * Plain text escaped up to the room it was given.
 */
interface EscapedSlice {
    /**
     * The escaped text that fits.
     */
    text: string;

    /**
     * Whether escaping stopped before the end of the text.
     */
    truncated: boolean;
}

/**
 * Escape plain untrusted text character by character until the next character would overflow.
 *
 * @param text - Flattened plain text outside any code span.
 * @param room - Characters still available for the escaped output.
 * @returns The escaped text, and whether escaping stopped before the end.
 */
function escapeWithin(text: string, room: number): EscapedSlice {
    let escaped = '';
    for (const character of breakAutolinkPrefixes(text)) {
        const safeCharacter = escapeUntrustedCharacter(character);
        if (escaped.length + safeCharacter.length > room) {
            return { text: escaped, truncated: true };
        }
        escaped += safeCharacter;
    }
    return { text: escaped, truncated: false };
}

/**
 * Flatten untrusted text to one line without escaping it, bounded the same way
 * {@link renderUntrustedText} is — shared so a code-span renderer and the plain-text renderer
 * truncate identically.
 *
 * @param input - Raw untrusted text.
 * @returns The flattened, length-bounded text, unescaped.
 */
function flattenAndBoundUntrustedText(input: string): string {
    const singleLine = input
        .replace(/\p{Cc}+/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
    if (singleLine.length <= MAX_UNTRUSTED_TEXT_CHARACTERS) {
        return singleLine;
    }
    return (
        singleLine.slice(0, MAX_UNTRUSTED_TEXT_CHARACTERS - TRUNCATION_MARK.length) +
        TRUNCATION_MARK
    );
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
 * the fence must be one backtick longer than the longest run already inside the rule.
 *
 * @param rule - Raw filter rule text, single line.
 * @returns The bounded rule wrapped in a delimiter-safe inline code span, or the empty string for
 *   empty input.
 */
export function renderUntrustedRuleCodeSpan(rule: string): string {
    const flattened = flattenAndBoundUntrustedText(rule);
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
