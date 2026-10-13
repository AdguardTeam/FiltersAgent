/**
 * Strict placeholder substitution for prompt documents.
 *
 * Placeholders are `{{camelCase}}` tokens. Substitution is strict in both directions: every
 * placeholder a template declares must be filled and every fill must match a declared placeholder,
 * so a wording edit and its wiring can never drift apart silently.
 */

/**
 * Why this shape: mustache-style tokens read naturally inside Markdown prose, collide with nothing
 * else in the prompt corpus, and the camelCase start keeps names consistent with the code
 * identifiers that fill them.
 */
const PLACEHOLDER_PATTERN = /\{\{([a-z][A-Za-z0-9]*)\}\}/gu;

/**
 * How much of a malformed token is quoted in the error: enough to find it in the document, short
 * enough to keep the message on one line.
 */
const MALFORMED_SNIPPET_LENGTH = 40;

/**
 * The failure kinds of the strict rendering contract.
 */
export const PromptRenderErrorKind = {
    /**
     * A document name outside the `PromptDocumentName` registry was requested.
     */
    UnknownDocument: 'unknown-document',

    /**
     * A `{{` sequence in the document is not a well-formed `{{camelCase}}` placeholder.
     */
    MalformedPlaceholder: 'malformed-placeholder',

    /**
     * A declared placeholder received no fill.
     */
    MissingPlaceholder: 'missing-placeholder',

    /**
     * A fill was supplied for a placeholder the document does not declare.
     */
    UnknownPlaceholder: 'unknown-placeholder',
} as const;

/**
 * PromptRenderErrorKind value.
 */
export type PromptRenderErrorKind =
    (typeof PromptRenderErrorKind)[keyof typeof PromptRenderErrorKind];

/**
 * Fill values for one render call, keyed by placeholder name. An empty string is a valid fill (an
 * absent optional context); only a missing key is an error.
 */
export type PlaceholderValues = Record<string, string>;

/**
 * A violation of the strict rendering contract. The message always names the offending placeholder
 * or document so a broken render is diagnosable in one read.
 */
export class PromptRenderError extends Error {
    /**
     * Which contract clause was violated.
     */
    readonly kind: PromptRenderErrorKind;

    constructor(kind: PromptRenderErrorKind, message: string) {
        super(message);
        this.name = 'PromptRenderError';
        this.kind = kind;
    }
}

/**
 * Reject any `{{` in the template that does not start a well-formed placeholder.
 *
 * Validated by occurrence, not by a strip pass: every index where `{{` appears must be the start
 * index of a well-formed match. Stripping well-formed tokens once would accept `{{{name}}}` — its
 * match starts one character late, the residue is `{}`, and the token would render silently as
 * `{value}`.
 *
 * @param template - The raw document text.
 * @param source - Label identifying the document in error messages.
 */
const assertNoMalformedPlaceholders = (template: string, source: string): void => {
    const wellFormedStarts = new Set<number>();
    for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
        if (match.index !== undefined) {
            wellFormedStarts.add(match.index);
        }
    }
    for (let at = template.indexOf('{{'); at !== -1; at = template.indexOf('{{', at + 2)) {
        if (wellFormedStarts.has(at)) {
            continue;
        }
        const snippet = template.slice(at, at + MALFORMED_SNIPPET_LENGTH);
        throw new PromptRenderError(
            PromptRenderErrorKind.MalformedPlaceholder,
            `${source}: malformed placeholder '${snippet}' — placeholders must match {{camelCase}}`,
        );
    }
};

/**
 * List the placeholders a template declares, in first-appearance order, deduplicated.
 *
 * @param template - The raw document text.
 * @param source - Label identifying the document in error messages.
 * @returns The declared placeholder names.
 */
export function extractPlaceholders(template: string, source = 'prompt template'): string[] {
    assertNoMalformedPlaceholders(template, source);
    const names: string[] = [];
    for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
        const name = match[1];
        if (!names.includes(name)) {
            names.push(name);
        }
    }
    return names;
}

/**
 * Render a template with strict placeholder substitution.
 *
 * @param template - The raw document text.
 * @param values - Fill values keyed by placeholder name.
 * @param source - Label identifying the document in error messages.
 * @returns The rendered text.
 */
export function renderTemplate(
    template: string,
    values: PlaceholderValues,
    source = 'prompt template',
): string {
    const declared = extractPlaceholders(template, source);
    for (const key of Object.keys(values)) {
        if (!declared.includes(key)) {
            throw new PromptRenderError(
                PromptRenderErrorKind.UnknownPlaceholder,
                `${source}: unknown placeholder '${key}' — the document declares only: ${declared.join(', ') || '(none)'}`,
            );
        }
    }
    for (const name of declared) {
        if (!Object.hasOwn(values, name)) {
            throw new PromptRenderError(
                PromptRenderErrorKind.MissingPlaceholder,
                `${source}: placeholder '${name}' declared by the document was not filled`,
            );
        }
    }
    return template.replace(PLACEHOLDER_PATTERN, (_match, name: string) => values[name]);
}
