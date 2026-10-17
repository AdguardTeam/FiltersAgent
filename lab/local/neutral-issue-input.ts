import type { AgentIssueInput } from '../../src/local/issue-snapshot';
import { IssueState } from '../../src/types/issue-state';

/**
 * Assignment labels disclose how maintainers resolved an issue after its original report.
 */
const ASSIGNMENT_LABEL_PREFIX = 'A:';

/**
 * Project a historical report into an unresolved issue without changing the saved snapshot.
 *
 * @param issue - Prompt-safe issue derived from the historical snapshot.
 * @returns A neutral issue preserving the report and its product, platform, and type labels.
 */
export function neutralAgentIssueInput(issue: AgentIssueInput): AgentIssueInput {
    return {
        ...issue,
        state: IssueState.Open,
        labels: issue.labels.filter((label) => !label.startsWith(ASSIGNMENT_LABEL_PREFIX)),
        assignee: null,
    };
}
