import * as v from 'valibot';

/**
 * Pattern every durable lowercase identifier obeys: one word in the bounded code vocabularies the
 * environment layer publishes — executor names, limitation codes, preparation stages. Declared once
 * because every role that adopts it must keep the same shape, and a second spelling would have to
 * change with it.
 *
 * Deliberately flagless: the selection tools' parameter schemas convert to JSON Schema for the
 * model surface, and `@valibot/to-json-schema` rejects flagged patterns outright. The character
 * class needs no unicode semantics, so a flag would only break the advertised tool schema.
 */
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * The bounded lowercase-identifier shape shared by executor names and durable code vocabularies.
 */
export const BoundedIdentifierSchema = v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(64),
    v.regex(IDENTIFIER_PATTERN),
);

/**
 * A validated executor name: the registry key one filtering executor is registered under.
 *
 * The vocabulary is deliberately open — this tree registers the browser-extension executor, and
 * other callers may register executors of their own beside it — so any bounded identifier is a
 * legal name and no closed picklist can spell the set. The shape is exactly
 * `BoundedIdentifierSchema`'s, declared once there and reused here rather than repeated.
 */
export const ExecutorNameSchema = BoundedIdentifierSchema;

/**
 * ExecutorName value.
 */
export type ExecutorName = v.InferOutput<typeof ExecutorNameSchema>;

/**
 * Executor name of the browser-extension executor every public run registers.
 *
 * Declared here so the vocabulary and every consumer share one spelling.
 */
export const BrowserExtensionExecutorName = 'browser_extension' as const;

/**
 * BrowserExtensionExecutorName value.
 */
export type BrowserExtensionExecutorName = typeof BrowserExtensionExecutorName;
