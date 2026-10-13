/**
 * Backlog issue-selection narrowing resolution: load the run instruction once, before selection,
 * and hand its `## Issue selection` section to the queue — the same instruction a per-issue run
 * loads again for its own task prompt, but read here first so the narrowing actually reaches
 * `selectBacklogIssues` instead of being computed too late to matter.
 */

import { extractInstructionSection } from '../knowledge/instruction-preparation';
import { loadInstruction } from '../knowledge/instruction-loader';
import {
    ISSUE_SELECTION_SECTION_KEYWORDS,
    parseIssueSelectionNarrowing,
    type IssueSelectionNarrowing,
} from '../knowledge/instruction-selection';

/**
 * Resolve one backlog run's issue-selection narrowing.
 *
 * @param checkoutRoot - Checkout the instruction is read from: the action's own workspace, the
 *   caller's configured checkout, or the process working directory as the last resort.
 * @param instructionPath - Explicit instruction path override, when the run configured one.
 * @returns The parsed narrowing, or undefined when the run carries no instruction or its selection
 *   section is empty.
 * @throws {InstructionLoadError} When an explicitly configured instruction path cannot be read.
 * @throws {SelectionNarrowingError} When the selection section's items are malformed.
 */
export async function resolveBacklogNarrowing(
    checkoutRoot: string,
    instructionPath: string | undefined,
): Promise<IssueSelectionNarrowing | undefined> {
    const instruction = await loadInstruction({ checkoutRoot, instructionPath });
    if (instruction === null) {
        return undefined;
    }
    const section = extractInstructionSection(
        instruction.content,
        ISSUE_SELECTION_SECTION_KEYWORDS,
    );
    if (section === undefined) {
        return undefined;
    }
    return parseIssueSelectionNarrowing(section);
}
