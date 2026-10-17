import type { LlmConfig } from '../src/config/config';

/**
 * Resolve the vision model for a run without a command-line model override.
 *
 * @param llm - Provider configuration used to create the runtime.
 * @returns Explicit vision model or the text model, matching the runtime fallback.
 */
export function effectiveVisionModel(llm: LlmConfig): string {
    return llm.visionModel ?? llm.model;
}
