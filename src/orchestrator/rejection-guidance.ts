/**
 * Renders the Markdown guidance documents a `finish_fix` rejection carries.
 *
 * Model-facing prose lives in Markdown, never in code; every rejection that guides the model
 * renders its document here, so the documents read as the lists the model receives.
 */
import { createPromptDocumentLoader, PromptDocumentName } from '../prompts/prompt-documents';
import type { PlaceholderValues } from '../prompts/template';

/**
 * The rejection guidance documents; the loader reads each document once and memoizes it.
 */
const prompts = createPromptDocumentLoader();

/**
 * Render one guidance document into a rejection's guidance lines: one line per non-empty line of
 * the document, so the Markdown reads as the list the model receives.
 *
 * @param name - The registered guidance document.
 * @param values - Its placeholder fills.
 * @returns Ordered guidance lines for the model.
 */
export function renderGuidance(name: PromptDocumentName, values?: PlaceholderValues): string[] {
    return prompts
        .render(name, values)
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}

/**
 * Guidance for a requirement whose closest session is closed and still lacks its capture: name that
 * session and ask for its environment again.
 *
 * @param sessionOrdinal - The closed session's 1-based launch order.
 * @param sessionDescription - What the closed session ran, for the model.
 * @returns Ordered guidance lines.
 */
export function closedSessionGuidance(
    sessionOrdinal: number | null,
    sessionDescription: string,
): string[] {
    return renderGuidance(PromptDocumentName.RejectionClosedQualifyingSession, {
        sessionOrdinal: String(sessionOrdinal),
        sessionDescription,
    });
}
