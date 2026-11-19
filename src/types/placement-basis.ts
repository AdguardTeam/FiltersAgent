/**
 * How the agent named the in-file position of a planned rule insertion. Recorded on the candidate
 * so the proposed comment and the report page can state where the agent put the rule and why, from
 * the position it named rather than from an inferred block.
 */
export const PlacementBasis = {
    /**
     * The agent named the line the rule becomes; the host checked it and computed the insert.
     */
    ChosenLine: 'chosen_line',

    /**
     * The section the rule belongs to keeps its rules sorted; the rule takes its sorted place.
     *
     * The agent names this position explicitly; the host only computes the line it resolves to.
     */
    SortedPosition: 'sorted_position',

    /**
     * The target file already holds rules for the candidate's domain; the rule joins them.
     *
     * Earlier builds wrote this basis; it stays so their results parse and render, and new runs
     * never write it.
     */
    DomainBlock: 'domain_block',

    /**
     * The file ends with a named section; the rule is anchored at the end of the regular rules,
     * before that section's footer or banner.
     *
     * Earlier builds wrote this basis; it stays so their results parse and render, and new runs
     * never write it.
     */
    TerminalSection: 'terminal_section',

    /**
     * The agent put the rule at the end of the file and stated its reason; the host appends it
     * there.
     */
    AppendEof: 'append_eof',
} as const;

/**
 * Every PlacementBasis value, for schemas and exhaustive listings.
 */
export const PLACEMENT_BASIS_VALUES = Object.values(PlacementBasis);

/**
 * PlacementBasis value.
 */
export type PlacementBasis = (typeof PlacementBasis)[keyof typeof PlacementBasis];

/**
 * Ceiling on the agent's reason for an end-of-file placement.
 *
 * Short enough to read inside the report's one placement sentence, generous enough for the one fact
 * that justifies the end of the file — no section keeps rules of this kind. The bound is enforced
 * at the schema, so a submission that fits it is never cut downstream.
 */
export const MAX_PLACEMENT_REASON_CHARACTERS = 300;

/**
 * Ceiling on the heading text recorded with a chosen-line placement.
 *
 * A real list heading is one marker line, and the longest one seen in the busiest AdguardFilters
 * lists stays well inside this; the cap only stops a malformed heading from displacing the rest of
 * the recorded edit.
 */
export const MAX_PLACEMENT_HEADING_CHARACTERS = 200;

/**
 * Ceiling on the platform condition recorded with a chosen-line placement.
 *
 * A condition is one `!#if …` marker line; the cap bounds a malformed one the same way the heading
 * cap does, without cutting any condition the lists actually carry.
 */
export const MAX_PLACEMENT_CONDITION_CHARACTERS = 300;
