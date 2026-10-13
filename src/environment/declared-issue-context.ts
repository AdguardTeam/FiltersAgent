/**
 * What the issue declares about itself, kept beside the model's own classification: the type the
 * report form named and the labels the issue carries.
 *
 * Every label travels, not only one repository's type-label prefix: label conventions differ from
 * one filter list to the next, and the model reads labels as evidence only, never as a routing
 * command.
 */

import * as v from 'valibot';
import type { IssueFacts } from '../types/issue-facts';

/**
 * Most labels the declared context keeps, in the issue's own order.
 *
 * An issue rarely carries more than a handful; the bound only keeps a label-spammed issue from
 * flooding the selection snapshot and the model's context.
 */
const DECLARED_LABEL_MAX_COUNT = 20;

/**
 * Most characters of one label the declared context keeps.
 *
 * A label name is short; the bound only keeps one oversized entry from dominating the snapshot.
 */
const DECLARED_LABEL_MAX_LENGTH = 200;

/**
 * Most characters of the declared issue-form type, the bound the report schema already applies.
 */
const DECLARED_ISSUE_FORM_TYPE_MAX_LENGTH = 100;

export const DeclaredIssueContextSchema = v.strictObject({
    issueFormType: v.nullable(
        v.pipe(v.string(), v.minLength(1), v.maxLength(DECLARED_ISSUE_FORM_TYPE_MAX_LENGTH)),
    ),
    labels: v.pipe(
        v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(DECLARED_LABEL_MAX_LENGTH))),
        v.maxLength(DECLARED_LABEL_MAX_COUNT),
    ),
});

/**
 * The issue's declared context.
 */
export type DeclaredIssueContext = v.InferOutput<typeof DeclaredIssueContextSchema>;

/**
 * Build the declared context from the extracted issue facts, bounding the labels.
 *
 * @param facts - The extracted issue facts.
 * @returns The validated declared context.
 */
export function declaredIssueContext(
    facts: Pick<IssueFacts, 'declaredIssueType' | 'labels'>,
): DeclaredIssueContext {
    return v.parse(DeclaredIssueContextSchema, {
        issueFormType: facts.declaredIssueType ?? null,
        labels: facts.labels
            .slice(0, DECLARED_LABEL_MAX_COUNT)
            .map((label) => label.slice(0, DECLARED_LABEL_MAX_LENGTH)),
    });
}
