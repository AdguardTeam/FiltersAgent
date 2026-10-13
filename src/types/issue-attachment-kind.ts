/**
 * Classification of one issue attachment produced by the local snapshot exporter.
 */
export const IssueAttachmentKind = {
    IssueScreenshot: 'issue_screenshot',
    Attachment: 'attachment',
} as const;

/**
 * Every IssueAttachmentKind value, for schemas and exhaustive listings.
 */
export const ISSUE_ATTACHMENT_KIND_VALUES = Object.values(IssueAttachmentKind);

/**
 * IssueAttachmentKind value.
 */
export type IssueAttachmentKind = (typeof IssueAttachmentKind)[keyof typeof IssueAttachmentKind];
