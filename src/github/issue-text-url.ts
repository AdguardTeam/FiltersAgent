/**
 * A query separator as Markdown-rendered issue text escapes it.
 */
const HTML_ESCAPED_QUERY_SEPARATOR = /&amp;/giu;

/**
 * Decode the query separators of a URL copied from issue text.
 *
 * GitHub issue bodies write a link's query separators as `&amp;`, and an extraction or the model
 * may copy the link verbatim. Read raw, every parameter after the first is named `amp;<name>`, and
 * the page or settings it addresses are not the ones the reporter had. Every reader of a URL from
 * issue text decodes it here, so each sees the same parameters.
 *
 * @param url - URL text from the issue, its extraction, or the model's copy of either.
 * @returns The URL text with `&amp;` separators decoded.
 */
export function decodeIssueTextUrl(url: string): string {
    return url.replace(HTML_ESCAPED_QUERY_SEPARATOR, '&');
}
