/**
 * Section headings of the issue form that AdGuard's intake bot relays into every user report.
 *
 * The bot renders all reports from one fixed template, so the presence of these headings is what
 * separates a complete structured report from ordinary discussion. Live intake, automatic upstream
 * sync, and the trusted-evidence gate in `prompt-safety.ts` each answer that same question, and
 * before this table each spelled the headings independently — a reworded template silently agreed
 * with only some of them. The spellings live here so one template change is one edit.
 *
 * Every pattern is line-anchored (`m`), case-insensitive because the bot's Markdown is not
 * normalized, and `u` because report bodies carry arbitrary Unicode. None carries `g`, so the
 * shared instances hold no `lastIndex` state between callers.
 */
export const StructuredReportHeadingPattern = {
    /**
     * Complete `### Issue URL (<type>)` line for any problem type the reporter form offers.
     */
    IssueUrl: /^###\s+Issue URL\s*\([^)]+\)\s*$/imu,

    /**
     * Same heading without the end-of-line anchor, so a relayed report whose heading line carries
     * trailing text still counts as trusted structured reporter evidence.
     */
    IssueUrlStart: /^###\s+Issue URL\s*\([^)]+\)/imu,

    /**
     * The heading narrowed to the exact `Anti Adblock Script` declaration, the parenthetical that
     * maps to the canonical issue type label.
     */
    IssueUrlAntiAdblock: /^###\s+Issue URL\s*\(Anti Adblock Script\)\s*$/imu,

    /**
     * The heading narrowed to the exact `Incorrect Blocking` declaration, the one other
     * parenthetical with its own canonical issue type label.
     */
    IssueUrlIncorrectBlocking: /^###\s+Issue URL\s*\(Incorrect Blocking\)\s*$/imu,

    /**
     * The heading narrowed to the two problem types automatic upstream sync mirrors; every other
     * reported type is deliberately left outside automatic intake.
     */
    MirroredIssueUrl: /^###\s+Issue URL\s*\((?:Ads|Anti Adblock Script)\)\s*$/imu,

    /**
     * `### System configuration`, the heading above the reporter's product and version table.
     */
    SystemConfiguration: /^###\s+System configuration\s*$/imu,

    /**
     * `### Issue configuration`, the heading above the reporter's filter and settings table.
     */
    IssueConfiguration: /^###\s+Issue configuration\s*$/imu,
} as const;
