/**
 * The repository mutation a locked candidate makes, as it serializes into a run result.
 *
 * Every edit type here is derived from its schema, so the runtime edit types and the serialized
 * contract cannot drift: a field added to one side is a field of the other.
 */
import * as v from 'valibot';
import {
    MAX_PLACEMENT_CONDITION_CHARACTERS,
    MAX_PLACEMENT_HEADING_CHARACTERS,
    MAX_PLACEMENT_REASON_CHARACTERS,
    PLACEMENT_BASIS_VALUES,
} from './placement-basis';
import { RepositoryEditKind } from './repository-edit-kind';
import { SINGLE_LINE_TEXT_PATTERN, nonBlankSingleLineText } from './single-line-text';

/**
 * A new rule inserted where the agent named its position.
 */
export const InsertRepositoryEditSchema = v.object({
    /**
     * Discriminator for a new rule insertion.
     */
    kind: v.literal(RepositoryEditKind.Insert),

    /**
     * Zero-based line index the agent's position resolves to; absent for an end-of-file insert.
     */
    insertionPoint: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),

    /**
     * Exact repository line immediately following the insertion point.
     *
     * A chosen line may itself be blank, so the empty string is a valid anchor: it still pins the
     * exact boundary the edit was planned against.
     */
    anchorRule: v.optional(v.pipe(v.string(), v.regex(SINGLE_LINE_TEXT_PATTERN))),

    /**
     * How the agent named the insertion position.
     */
    basis: v.optional(v.picklist(PLACEMENT_BASIS_VALUES)),

    /**
     * Comment line written immediately before the inserted rule, when the run instruction's
     * placement declaration asks for one.
     */
    precedingComment: v.optional(
        v.pipe(v.string(), v.minLength(1), v.regex(SINGLE_LINE_TEXT_PATTERN)),
    ),

    /**
     * Nearest heading above the line the agent chose that is still open there, when the file holds
     * one. Repository text: the report renders it as untrusted.
     */
    heading: v.optional(nonBlankSingleLineText(MAX_PLACEMENT_HEADING_CHARACTERS)),

    /**
     * The legacy name of {@link heading}, written by earlier builds.
     *
     * A locked result that carries it must still parse, and every renderer falls back to it when
     * `heading` is absent; new runs write only `heading`.
     */
    section: v.optional(nonBlankSingleLineText(MAX_PLACEMENT_HEADING_CHARACTERS)),

    /**
     * The agent's own justification for an end-of-file insert; the report renders it as untrusted
     * text.
     */
    reason: v.optional(nonBlankSingleLineText(MAX_PLACEMENT_REASON_CHARACTERS)),

    /**
     * The platform condition enclosing the chosen line (`!#if …`), when the line sits inside one;
     * absent otherwise. Repository text: the report renders it as untrusted.
     */
    condition: v.optional(nonBlankSingleLineText(MAX_PLACEMENT_CONDITION_CHARACTERS)),
});

/**
 * A repository edit that adds the candidate domain to an existing shared rule.
 */
export const ExtendDomainsRepositoryEditSchema = v.object({
    /**
     * Discriminator for extending an existing rule domain list.
     */
    kind: v.literal(RepositoryEditKind.ExtendDomains),

    /**
     * One-based line number of the exact source rule.
     */
    line: v.pipe(v.number(), v.integer(), v.minValue(1)),

    /**
     * Exact source line that must still exist before applying the edit.
     */
    originalRule: v.pipe(v.string(), v.minLength(1), v.regex(SINGLE_LINE_TEXT_PATTERN)),

    /**
     * Exact replacement line with the new domain included.
     */
    replacementRule: v.pipe(v.string(), v.minLength(1), v.regex(SINGLE_LINE_TEXT_PATTERN)),
});

/**
 * A repository edit that replaces one exact existing line.
 */
export const ReplaceRepositoryEditSchema = v.object({
    /**
     * Discriminator for an exact line replacement.
     */
    kind: v.literal(RepositoryEditKind.Replace),

    /**
     * One-based line number of the exact source rule.
     */
    line: v.pipe(v.number(), v.integer(), v.minValue(1)),

    /**
     * Exact source line that must still exist before applying the edit.
     */
    originalRule: v.pipe(v.string(), v.minLength(1), v.regex(SINGLE_LINE_TEXT_PATTERN)),

    /**
     * Complete replacement line.
     */
    replacementRule: v.pipe(v.string(), v.minLength(1), v.regex(SINGLE_LINE_TEXT_PATTERN)),
});

/**
 * A repository edit that removes one exact existing line.
 */
export const RemoveRepositoryEditSchema = v.object({
    /**
     * Discriminator for an exact line removal.
     */
    kind: v.literal(RepositoryEditKind.Remove),

    /**
     * One-based line number of the exact source rule.
     */
    line: v.pipe(v.number(), v.integer(), v.minValue(1)),

    /**
     * Exact source line that must still exist before applying the edit.
     */
    originalRule: v.pipe(v.string(), v.minLength(1), v.regex(SINGLE_LINE_TEXT_PATTERN)),
});

/**
 * Deterministic repository mutation selected after the candidate rule is locked.
 */
export const RepositoryEditSchema = v.variant('kind', [
    InsertRepositoryEditSchema,
    ExtendDomainsRepositoryEditSchema,
    ReplaceRepositoryEditSchema,
    RemoveRepositoryEditSchema,
]);

/**
 * A new rule inserted where the agent named its position.
 */
export type InsertRepositoryEdit = v.InferOutput<typeof InsertRepositoryEditSchema>;

/**
 * A repository edit that adds the candidate domain to an existing shared rule.
 */
export type ExtendDomainsRepositoryEdit = v.InferOutput<typeof ExtendDomainsRepositoryEditSchema>;

/**
 * A repository edit that replaces one exact existing line.
 */
export type ReplaceRepositoryEdit = v.InferOutput<typeof ReplaceRepositoryEditSchema>;

/**
 * A repository edit that removes one exact existing line.
 */
export type RemoveRepositoryEdit = v.InferOutput<typeof RemoveRepositoryEditSchema>;

/**
 * Deterministic repository mutation selected after the candidate rule is locked.
 */
export type RepositoryEdit = v.InferOutput<typeof RepositoryEditSchema>;
