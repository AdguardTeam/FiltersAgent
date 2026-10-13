/**
 * The vocabulary of the repository's own lint command, run over a candidate rule.
 *
 * The action bundles no linter: a filter-list repository pins its own (AdguardFilters an AGLint 4
 * beta, other repositories AGLint 3), and any bundled version breaks somebody's configuration. The
 * blocker and the in-browser phases already prove a rule works; the repository's linter adds the
 * repository's own policy on top, so its verdict annotates the report and never decides anything.
 */
import * as v from 'valibot';

/**
 * How one run of the repository's lint command ended.
 */
export const RepositoryLintStatus = {
    /**
     * The command exited 0: the repository's linter has nothing to say about the rule.
     */
    Clean: 'clean',

    /**
     * The command exited non-zero: the repository's linter flagged the rule.
     */
    Problems: 'problems',

    /**
     * The command could not be run to a verdict: the candidate file could not be placed, the shell
     * could not start or find the command, or it outlived its time bound.
     */
    NotRun: 'not_run',
} as const;

/**
 * RepositoryLintStatus value.
 */
export type RepositoryLintStatus = (typeof RepositoryLintStatus)[keyof typeof RepositoryLintStatus];

export const RepositoryLintNoteSchema = v.object({
    status: v.picklist([RepositoryLintStatus.Problems, RepositoryLintStatus.NotRun]),
    command: v.pipe(v.string(), v.minLength(1)),
    exitCode: v.optional(v.pipe(v.number(), v.integer())),
    detail: v.optional(v.pipe(v.string(), v.minLength(1))),
    output: v.string(),
    outputTruncated: v.boolean(),
});

/**
 * What the report says about the published candidate when the repository's lint command flagged it
 * or could not run; a clean lint leaves no note at all.
 */
export type RepositoryLintNote = v.InferOutput<typeof RepositoryLintNoteSchema>;
