import * as v from 'valibot';

/**
 * A query describing a candidate rule target to search for in the AdguardFilters checkout.
 */
export const SearchQuerySchema = v.object({
    /**
     * A domain to search for (e.g. "ads.example.com").
     */
    domain: v.optional(v.pipe(v.string(), v.minLength(1))),

    /**
     * A CSS selector to search for in cosmetic rules.
     */
    selector: v.optional(v.pipe(v.string(), v.minLength(1))),

    /**
     * A network URL pattern to search for (e.g. "||ads.example.com^").
     */
    urlPattern: v.optional(v.pipe(v.string(), v.minLength(1))),

    /**
     * A scriptlet name to search for in scriptlet rules.
     */
    scriptlet: v.optional(v.pipe(v.string(), v.minLength(1))),
});
export type SearchQuery = v.InferOutput<typeof SearchQuerySchema>;

/**
 * A section within a filter file, bounded by comment headers.
 */
export const FilterSectionSchema = v.object({
    /**
     * Display name of the section, derived from its header comment.
     */
    name: v.pipe(v.string(), v.minLength(1)),

    /**
     * 1-based line number where the section's rules begin.
     */
    startLine: v.pipe(v.number(), v.integer(), v.minValue(1)),

    /**
     * 1-based line number of the last rule in the section (inclusive).
     */
    endLine: v.pipe(v.number(), v.integer(), v.minValue(1)),
});
export type FilterSection = v.InferOutput<typeof FilterSectionSchema>;

/**
 * A filter file entry in the placement map.
 */
export const FilterFileEntrySchema = v.object({
    /**
     * Filter name, derived from the file's top-level directory (e.g. "BaseFilter").
     */
    filter: v.pipe(v.string(), v.minLength(1)),

    /**
     * Path to the filter file, relative to the checkout root.
     */
    relativePath: v.pipe(v.string(), v.minLength(1)),

    /**
     * Sections detected in the file.
     */
    sections: v.array(FilterSectionSchema),
});
export type FilterFileEntry = v.InferOutput<typeof FilterFileEntrySchema>;

/**
 * The generated placement map for an AdguardFilters checkout.
 */
export const PlacementMapSchema = v.object({
    /**
     * Absolute path of the checkout the map was generated from.
     */
    checkoutPath: v.pipe(v.string(), v.minLength(1)),

    /**
     * ISO 8601 timestamp when the map was generated.
     */
    generatedAt: v.pipe(v.string(), v.minLength(1)),

    /**
     * All filter file entries discovered in the checkout.
     */
    files: v.array(FilterFileEntrySchema),
});
export type PlacementMap = v.InferOutput<typeof PlacementMapSchema>;

/**
 * A single rule match returned by search_rules.
 */
export const RuleMatchSchema = v.object({
    /**
     * The full text of the matched rule line.
     */
    rule: v.pipe(v.string(), v.minLength(1)),

    /**
     * Repository-relative path of the list file containing the rule: the path a draft names to
     * place its rule in that file.
     */
    filePath: v.pipe(v.string(), v.minLength(1)),

    /**
     * 1-based line number of the rule in the file.
     */
    line: v.pipe(v.number(), v.integer(), v.minValue(1)),

    /**
     * Filter name the file belongs to.
     */
    filter: v.pipe(v.string(), v.minLength(1)),

    /**
     * Section name the rule falls within, if any.
     */
    section: v.optional(v.string()),
});
export type RuleMatch = v.InferOutput<typeof RuleMatchSchema>;
