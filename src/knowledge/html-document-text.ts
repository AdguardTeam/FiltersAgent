/**
 * Reduction of an HTML document to the readable text a guidance document is served as.
 *
 * A guidance link that answers with HTML, stored verbatim, would serve the page's `<head>` — meta
 * tags, preload hints and inline scripts — through `lookup_rule_guidance`, and the model would get
 * no guidance at all. The run reads these documents as prose, so a document that arrives as markup
 * is reduced to its text before it is stored: the invisible parts are dropped, the structural ones
 * become line breaks, and everything else keeps its own words.
 */

/**
 * Elements whose content is never readable prose: it is either machine instructions (script, style,
 * template) or document metadata (head), and a `<head>` dump is exactly the defect this reduction
 * prevents.
 */
const DROPPED_ELEMENTS = ['head', 'script', 'style', 'noscript', 'template', 'svg'] as const;

/**
 * Elements whose boundaries are a line break in the reduced text, so lists, paragraphs, headings
 * and table rows do not run together into one unreadable line.
 */
const LINE_BREAKING_ELEMENTS = [
    'p',
    'br',
    'div',
    'section',
    'article',
    'header',
    'footer',
    'nav',
    'aside',
    'li',
    'ul',
    'ol',
    'dl',
    'dt',
    'dd',
    'tr',
    'table',
    'thead',
    'tbody',
    'pre',
    'blockquote',
    'hr',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
] as const;

/**
 * The named character references that carry meaning in filter-syntax prose: the markup-reserved
 * five plus the space entity. Everything else arrives as a numeric reference or as its own
 * character; a name this map does not know is left exactly as written rather than guessed at.
 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
};

/**
 * Highest code point a numeric character reference may name, above which it is not a character.
 */
const MAX_CODE_POINT = 0x10_ff_ff;

/**
 * Matcher for one HTML comment, including the conditional-comment form.
 */
const HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/gu;

/**
 * Matcher for a doctype or processing instruction.
 */
const DOCTYPE_PATTERN = /<![^>]*>/gu;

/**
 * Matcher for any remaining tag, once the dropped elements and comments are gone.
 */
const ANY_TAG_PATTERN = /<\/?[A-Za-z][^>]*>/gu;

/**
 * Matcher for one character reference, named or numeric.
 */
const ENTITY_PATTERN = /&(#[Xx]?[0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);/gu;

/**
 * Build the matcher dropping one element together with everything inside it.
 *
 * @param tag - Element name to drop.
 * @returns A global, case-insensitive matcher for the element and its content.
 */
function droppedElementPattern(tag: string): RegExp {
    return new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\s*>|<${tag}\\b[^>]*/>`, 'giu');
}

/**
 * Build the matcher marking one element's boundaries as line breaks.
 *
 * @param tag - Element name whose open and close tags break the line.
 * @returns A global, case-insensitive matcher for either boundary of the element.
 */
function lineBreakingElementPattern(tag: string): RegExp {
    return new RegExp(`</?${tag}\\b[^>]*/?>`, 'giu');
}

/**
 * Decode one character reference.
 *
 * @param reference - The reference body between `&` and `;`.
 * @returns The character it names, or undefined when the name is unknown or out of range.
 */
function decodeEntity(reference: string): string | undefined {
    if (!reference.startsWith('#')) {
        return NAMED_ENTITIES[reference.toLowerCase()];
    }
    const hexadecimal = reference[1] === 'x' || reference[1] === 'X';
    const digits = hexadecimal ? reference.slice(2) : reference.slice(1);
    const code = Number.parseInt(digits, hexadecimal ? 16 : 10);
    if (!Number.isInteger(code) || code <= 0 || code > MAX_CODE_POINT) {
        return undefined;
    }
    try {
        return String.fromCodePoint(code);
    } catch {
        // A lone surrogate is a valid integer but not a character; leaving the reference as
        // written is closer to the source than substituting a replacement character.
        return undefined;
    }
}

/**
 * Reduce an HTML document to readable text.
 *
 * @param html - The document as fetched.
 * @returns The document's readable text: no markup, structural breaks kept, whitespace collapsed.
 */
export function reduceHtmlToText(html: string): string {
    let text = html.replace(HTML_COMMENT_PATTERN, '');
    for (const tag of DROPPED_ELEMENTS) {
        text = text.replace(droppedElementPattern(tag), '');
    }
    for (const tag of LINE_BREAKING_ELEMENTS) {
        text = text.replace(lineBreakingElementPattern(tag), '\n');
    }
    text = text.replace(DOCTYPE_PATTERN, '').replace(ANY_TAG_PATTERN, '');
    text = text.replace(ENTITY_PATTERN, (match, reference: string) => {
        return decodeEntity(reference) ?? match;
    });
    return text
        .replace(/\r\n?/gu, '\n')
        .replace(/[^\S\n]+/gu, ' ')
        .replace(/ *\n */gu, '\n')
        .replace(/\n{3,}/gu, '\n\n')
        .trim();
}
