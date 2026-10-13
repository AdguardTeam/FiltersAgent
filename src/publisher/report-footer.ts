/**
 * Footer of the report comment.
 *
 * Every report ends with one `<sub>` line naming the filters commit the run analyzed and saying the
 * comment is automated. It sits outside the report template, so an instruction's own template can
 * never drop it, and it is always the last element of the comment.
 */

/**
 * Abbreviated commit length in the footer; matches how git and GitHub abbreviate commits.
 */
const SHORT_COMMIT_LENGTH = 7;

/**
 * Append the footer to a rendered report body.
 *
 * @param body - Rendered report body.
 * @param filtersCommit - Commit of the filter lists the run analyzed.
 * @returns The body ending with the footer line.
 */
export function withReportFooter(body: string, filtersCommit: string): string {
    const footer =
        `<sub>Automated analysis against filters at \`${filtersCommit.slice(0, SHORT_COMMIT_LENGTH)}\`. ` +
        'Posted by a filters agent; a maintainer reviews before anything is merged.</sub>';
    return `${body.trimEnd()}\n\n${footer}\n`;
}
