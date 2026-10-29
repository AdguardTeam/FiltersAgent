/**
 * Repository steering for local runs: everything a local run takes from the filters checkout's own
 * content to steer the agent, which is the run instruction and the skills directory. The runner
 * composes this one seam, so the instruction's refusal rules and the skills that ride with it stay
 * in one file.
 */
import { fileBackedApplicationRefusalDetail } from '../../src/knowledge/instruction-application';
import type { LoadedInstruction } from '../../src/knowledge/instruction-loader';
import { resolveRepositorySkillsDir } from '../../src/knowledge/repository-skills';
import type { Logger } from '../../src/logger/logger';
import { loadRunInstruction, refuseLoadedRunInstruction } from './instruction-provisioning';
import { FileBackedApplicationRefusalError } from './local-failure-stage';

/**
 * What the checkout steers one local run with.
 */
export interface RepositorySteering {
    /**
     * The loaded run instruction, or null when the run stays in built-in mode.
     */
    instruction: LoadedInstruction | null;

    /**
     * The checkout's skills directory, or undefined when the checkout ships none or the run refuses
     * the repository's own instruction.
     */
    skillsDir: string | undefined;
}

/**
 * Load the run instruction and the skills directory from the prepared checkout, and refuse a run
 * that cannot proceed before the core's paid investigation.
 *
 * The skills directory rides the run unless this face refuses the repository's own instruction: the
 * benchmark refuses that instruction so a case is reproduced against the action alone, and skills
 * steer the agent from the same checkout content, so they are omitted with it rather than silently
 * kept.
 *
 * @param checkoutRoot - Absolute root of the run's prepared filters checkout.
 * @param instructionPath - Optional operator-supplied instruction override from the case file.
 * @param refuseRepositoryInstruction - Whether this run refuses the repository's own instruction.
 * @param logger - Run logger carrying the instruction roster and every refusal.
 * @returns The instruction and the skills directory the run carries.
 * @throws {InstructionLoadError} When an explicitly supplied instruction cannot be loaded.
 * @throws {RepositoryInstructionRefusalError} When the run refuses a loaded instruction.
 * @throws {FileBackedApplicationRefusalError} When the instruction declares a file-backed
 *   verification method, which can never be honoured yet.
 */
export async function loadRepositorySteering(
    checkoutRoot: string,
    instructionPath: string | undefined,
    refuseRepositoryInstruction: boolean,
    logger: Logger,
): Promise<RepositorySteering> {
    const instruction = await loadRunInstruction(checkoutRoot, instructionPath, logger);
    const skillsDir = resolveRepositorySkillsDir(checkoutRoot);
    if (refuseRepositoryInstruction) {
        if (skillsDir !== undefined) {
            logger.info(
                { skillsDir },
                'repository instructions are refused; the checkout skills directory is not listed to the agent',
            );
        }
        refuseLoadedRunInstruction(instruction, logger);
    }
    // The same gate the public entry applies: a file-backed verification method can never be
    // honoured yet.
    const fileBackedRefusal = instruction
        ? fileBackedApplicationRefusalDetail(instruction.content)
        : undefined;
    if (fileBackedRefusal !== undefined) {
        logger.warn(
            { instructionPath: instruction?.path, detail: fileBackedRefusal },
            'run instruction declares an unsupported file-backed verification method; refusing before the investigation',
        );
        throw new FileBackedApplicationRefusalError(fileBackedRefusal);
    }
    return { instruction, skillsDir: refuseRepositoryInstruction ? undefined : skillsDir };
}
