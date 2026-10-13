import { RedactionScope } from '../tracer/redact-text';
import { redactPayload } from '../tracer/redactor';

/**
 * The wire ceiling on one tool result and the envelope that replaces an oversized one: how a tool
 * result is redacted, serialized and bounded before it becomes a provider message. Separate from
 * the adapter that calls it because two other layers own the same ceiling — `page-state-budget.ts`
 * sizes a page-state payload against it, and the run evidence keeps whatever the envelope cut.
 */

/**
 * Ceiling on one serialized tool result delivered to the model, in UTF-8 bytes.
 *
 * The largest legitimate tool result observed across the live corpus is 10.5 KB, so 64 KiB is a
 * six-fold allowance. Without a ceiling a single call can end the run: get_storage on a site
 * caching its whole movie catalog in localStorage can return 5.9 MB, pushing the next request past
 * the model's 1,048,576-token limit, and the deterministic HTTP 400 then burns every paid attempt
 * of the report. Only the wire message to the provider is bounded: the full redacted result rides
 * on `SessionToolResult.details`, which `session-trace.ts` records in preference to the
 * model-facing prose, so the run evidence keeps everything the envelope cut.
 */
export const MAX_TOOL_RESULT_BYTES = 64 * 1024;

/**
 * Leading slice of an oversized serialized result kept inside the truncation envelope.
 *
 * Large enough for the model to recognize what the result was and decide how to narrow the query,
 * small enough that the envelope never approaches the ceiling itself.
 */
export const TRUNCATED_TOOL_RESULT_HEAD_CHARS = 8 * 1024;

/**
 * A tool result serialized for the model, with the redaction byproducts kept for evidence.
 */
export interface ModelFacingToolResult {
    /**
     * The JSON text the model receives — the truncation envelope when the result was oversized.
     */
    content: string;

    /**
     * The redacted result `content` was serialized from (full, never envelope-cut), for
     * trace/summary plumbing.
     */
    redacted: Record<string, unknown>;

    /**
     * Pre-envelope serialized byte count, present exactly when the envelope replaced the result.
     */
    truncatedFromBytes?: number;
}

/**
 * Redact and serialize one tool result for the model, applying the truncation envelope.
 *
 * The redaction runs in the model-facing scope; see the note at the call below for what that
 * changes and why.
 *
 * @param result - The raw tool result.
 * @returns The model-facing JSON text plus the redacted result and truncation provenance.
 */
export function serializeToolResultForModel(
    result: Record<string, unknown>,
): ModelFacingToolResult {
    // Model-facing scope: credentials still go, but the two rules that match on SHAPE — the
    // header-line rule and the embedded-URL rule — would rewrite the page's own evidence here (a
    // consent banner's `Cookie: settings` DOM line, a reporter-quoted `?sid=` URL in an issue
    // body), and those bytes are what the investigation is made of. The full result is persisted
    // separately under the persisted scope, where both rules do apply.
    const redacted = redactPayload(result, [], {
        scope: RedactionScope.ModelFacing,
    }) as Record<string, unknown>;
    const serialized = JSON.stringify(redacted);
    const serializedBytes = Buffer.byteLength(serialized, 'utf8');
    if (serializedBytes <= MAX_TOOL_RESULT_BYTES) {
        return { content: serialized, redacted };
    }
    // Replace the payload with a structural envelope instead of cutting the JSON mid-token: the
    // model gets a valid object, the head to recognize what came back, and an explicit
    // instruction to narrow the query.
    let head = serialized.slice(0, TRUNCATED_TOOL_RESULT_HEAD_CHARS);
    const lastCode = head.charCodeAt(head.length - 1);
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
        head = head.slice(0, -1);
    }
    return {
        content: JSON.stringify({
            truncated: true,
            originalBytes: serializedBytes,
            head,
            note:
                `Result exceeded the ${MAX_TOOL_RESULT_BYTES}-byte tool-result limit. ` +
                'The full result is preserved in run evidence. Repeat the call with a ' +
                'narrower query instead of requesting everything at once.',
        }),
        redacted,
        truncatedFromBytes: serializedBytes,
    };
}
