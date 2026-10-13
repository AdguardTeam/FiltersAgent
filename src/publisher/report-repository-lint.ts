/**
 * The report's repository-lint reading: what the repository's own lint command said about the
 * published rule, when it flagged it or could not run. A clean lint, or a run without a lint
 * command, renders nothing and the section drops out of the comment.
 */
import { RepositoryLintStatus, type RepositoryLintNote } from '../types/repository-lint';
import {
    renderUntrustedCodeBlock,
    renderUntrustedRuleCodeSpan,
    renderUntrustedText,
} from './untrusted-text';

/**
 * Render the repository-lint note as the block its report section carries.
 *
 * The command line is repository configuration and goes in a code span; the output is the linter's
 * own text and goes in a fenced block, cut where the run cut it.
 *
 * @param note - The run's lint note, or undefined when there is nothing to say.
 * @returns The block, or the empty string.
 */
export function composeRepositoryLint(note: RepositoryLintNote | undefined): string {
    if (note === undefined) {
        return '';
    }
    const command = renderUntrustedRuleCodeSpan(note.command);
    const lines: string[] = [
        note.status === RepositoryLintStatus.Problems
            ? `The repository lint command ${command} flagged the rule (exit code ${String(note.exitCode)}).`
            : `The repository lint command ${command} could not run: ${renderUntrustedText(note.detail ?? '')}.`,
    ];
    const output = renderUntrustedCodeBlock(note.output);
    if (output.length > 0) {
        lines.push('', output);
    }
    if (note.outputTruncated) {
        lines.push('', 'The output is cut short here; the workflow log has all of it.');
    }
    return lines.join('\n');
}
