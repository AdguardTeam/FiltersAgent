import type { BaseIssue } from 'valibot';

/**
 * The one rendering of Valibot validation issues into model-facing text.
 *
 * Three places refuse a payload for the same reason and must describe it the same way: the session
 * tool adapter's `validation_error` envelope, the terminal tool's rejection reason (whose equality
 * drives the repeated-rejection streak cap), and the single-shot repair prompt. They lived as two
 * separate formatters until this module; a leaf module rather than a section of `session-tools.ts`,
 * because the single-shot path is not part of the agent-session tool surface and must not import it
 * to format an error. This file imports nothing but Valibot's issue type.
 */

/**
 * Convert Valibot issues into compact model-facing reasons.
 *
 * @param issues - The validation issues emitted by Valibot.
 * @returns A semicolon-joined, path-prefixed reason list.
 */
export function formatIssues(issues: readonly BaseIssue<unknown>[]): string {
    return issues
        .map((issue) => {
            const path = issue.path
                ?.map((item) => String(item.key))
                .filter(Boolean)
                .join('.');
            return path ? `${path}: ${issue.message}` : issue.message;
        })
        .join('; ');
}
