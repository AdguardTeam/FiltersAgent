/**
 * GitHub issue states.
 */
export const IssueState = {
    Open: 'open',
    Closed: 'closed',
} as const;

/**
 * Every issue state value, for schemas and exhaustive listings.
 */
export const ISSUE_STATE_VALUES = Object.values(IssueState);

/**
 * GitHub issue state value.
 */
export type IssueState = (typeof IssueState)[keyof typeof IssueState];
