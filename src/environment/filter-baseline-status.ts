/**
 * Whether a run's filter baseline can execute, and where it came from: the vocabulary the official
 * catalog decision, the declared baseline and every consumer of a selection snapshot share.
 */
export const FilterBaselineStatus = {
    /**
     * The reported filters resolved to official lists the run executes.
     */
    Executable: 'executable',

    /**
     * The report names no official list the run could execute.
     */
    NotExecutable: 'not_executable',

    /**
     * The run instruction declared the baseline itself.
     */
    Declared: 'declared',
} as const;

/**
 * FilterBaselineStatus value.
 */
export type FilterBaselineStatus = (typeof FilterBaselineStatus)[keyof typeof FilterBaselineStatus];
