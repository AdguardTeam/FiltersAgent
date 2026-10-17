/**
 * Instruction provisioning for local runs: the one seam that loads the run instruction from the
 * prepared filters checkout, logs its roster for post-mortem diagnosis, and maps it onto the
 * provenance block the local record stores. Extracted from the runner so the instruction's contract
 * stays in one file that the runner composes.
 */
import type { LoadedInstruction } from '../../src/knowledge/instruction-loader';
import { loadInstruction } from '../../src/knowledge/instruction-loader';
import type { Logger } from '../../src/logger/logger';
import type { LocalCoreExecution } from './local-run-record';
import { collectKnowledgeGuidanceCitations } from './local-run-record';
import type { LocalInstructionProvenance } from '../../src/local/run-record-guidance-schemas';
import { RepositoryInstructionRefusalError } from './local-failure-stage';

/**
 * Refuse repository-provided guidance when a run requires the built-in preparation path.
 *
 * @param instruction - Loaded repository instruction, or null for built-in mode.
 * @param logger - Run logger preserving the refusal path for diagnosis.
 * @returns Nothing when the run has no repository instruction.
 */
export function refuseLoadedRunInstruction(
    instruction: LoadedInstruction | null,
    logger: Logger,
): void {
    if (instruction === null) {
        return;
    }
    logger.warn(
        { instructionPath: instruction.path },
        'repository instruction is forbidden for this run; refusing before the investigation',
    );
    throw new RepositoryInstructionRefusalError(instruction.path);
}

/**
 * Load the run instruction from the prepared checkout, or null for built-in mode.
 *
 * The built-in default (no instruction file, no override) is absence: null keeps the run on the
 * KnowledgeBase provisioning path. An explicitly supplied path that is missing or unreadable is a
 * typed instruction-load failure naming the path — never a silent built-in fallback.
 *
 * @param checkoutRoot - Absolute root of the run's prepared filters checkout.
 * @param instructionPath - Optional operator-supplied override from the case file.
 * @param logger - Run logger carrying the roster with digests for diagnosis.
 * @returns The loaded instruction, or null when the run stays in built-in mode.
 * @throws {InstructionLoadError} With a stable code naming the failed path or link.
 */
export async function loadRunInstruction(
    checkoutRoot: string,
    instructionPath: string | undefined,
    logger: Logger,
): Promise<LoadedInstruction | null> {
    const instruction = await loadInstruction({
        checkoutRoot,
        ...(instructionPath !== undefined ? { instructionPath } : {}),
    });
    if (!instruction) {
        return null;
    }
    // Digests are opaque file identifiers — no redaction is needed or possible on them, so the
    // full roster lands in the log for post-mortem diagnosis.
    logger.info(
        {
            instruction: {
                path: instruction.path,
                digest: instruction.sha256,
                documents: instruction.documents.map((document) => ({
                    role: document.role,
                    origin: document.origin,
                    url: document.url,
                    digest: document.sha256,
                })),
            },
        },
        'run instruction loaded; its linked documents replace the KnowledgeBase',
    );
    return instruction;
}

/**
 * Map one loaded instruction onto the provenance block the local record stores beside the run: the
 * roster digest-by-digest, plus the citations the agent actually received — commit-absent for
 * URL-sourced instruction documents, absent entirely for checkout-sourced ones.
 *
 * @param instruction - Instruction loaded from the prepared checkout.
 * @param executions - Locked local core executions whose traces carry the tool results.
 * @returns The instruction provenance block for the run record.
 */
export function toInstructionProvenance(
    instruction: LoadedInstruction,
    executions: LocalCoreExecution[],
): LocalInstructionProvenance {
    return {
        path: instruction.path,
        sha256: instruction.sha256,
        documents: instruction.documents.map((document) => ({
            role: document.role,
            origin: document.origin,
            url: document.url,
            digest: document.sha256,
        })),
        citations: collectKnowledgeGuidanceCitations(executions),
    };
}
