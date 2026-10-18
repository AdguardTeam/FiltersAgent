/**
 * How a report comment reads, for the suites that check what the publisher renders: as a person
 * reads its raw Markdown, and as GitHub's grammar reads it.
 */

/**
 * U+2060 WORD JOINER: zero-width and invisible, so a reader of the raw comment does not see it.
 */
export const WORD_JOINER = '\u2060';

/**
 * An HTML character reference, which a reader of the raw comment sees as `&#39;` and GitHub decodes
 * before it resolves mentions and references.
 */
export const CHARACTER_REFERENCE_PATTERN = /&(?:#\d+|#x[\da-f]+|[a-z][\da-z]*);/iu;

/**
 * A Markdown code span, whose content GitHub shows literally and resolves nothing in.
 */
export const CODE_SPAN_PATTERN = /(?<![\\`])(`+)(?!`).*?(?<!`)\1(?!`)/gu;

/**
 * What GitHub turns plain comment text into, by its own grammar: a mention is `@` before a login,
 * an issue reference `#` before a number, an autolink a scheme before `//` or a bare `www.`, a link
 * or an image `](` or `][`, and a heading, a quote or a code block a marker at the start of a
 * line.
 */
const LIVE_GITHUB_CONSTRUCTS: Record<string, RegExp> = {
    mention: /@[\p{L}\p{N}_]/u,
    issueReference: /#\d/u,
    alternativeIssueReference: /(?<![\p{L}\p{N}])GH-\d/iu,
    schemeAutolink: /[a-z]:\/\//iu,
    wwwAutolink: /(?<![\p{L}\p{N}])www\./iu,
    linkOrImage: /\][([]/u,
    linkReferenceDefinition: /^\s{0,3}\[[^\]]+\]:/mu,
    htmlTag: /<[!/?a-z]/iu,
    characterReference: CHARACTER_REFERENCE_PATTERN,
    heading: /^\s{0,3}#{1,6}(?:\s|$)/mu,
    blockquote: /^\s{0,3}>/mu,
    codeBlockFence: /^\s{0,3}(?:`{3,}|~{3,})/mu,
};

/**
 * The raw comment as a person reads it — in the artifact, in a notification e-mail, in the API
 * body: the word joiners are invisible.
 *
 * @param markdown - Rendered Markdown.
 * @returns The Markdown without its word joiners.
 */
export function readerView(markdown: string): string {
    return markdown.replaceAll(WORD_JOINER, '');
}

/**
 * Name every GitHub construct left live in rendered text, outside its code spans.
 *
 * @param markdown - Rendered Markdown.
 * @returns The names of the live constructs, empty when the text is inert.
 */
export function liveGitHubConstructs(markdown: string): string[] {
    const outsideCode = markdown.replace(CODE_SPAN_PATTERN, '');
    return Object.entries(LIVE_GITHUB_CONSTRUCTS)
        .filter(([, pattern]) => pattern.test(outsideCode))
        .map(([name]) => name);
}

/**
 * The longest common prefix of two strings.
 *
 * @param left - One string.
 * @param right - The other string.
 * @returns The characters both start with.
 */
export function commonPrefix(left: string, right: string): string {
    let index = 0;
    while (index < left.length && index < right.length && left[index] === right[index]) {
        index += 1;
    }
    return left.slice(0, index);
}
