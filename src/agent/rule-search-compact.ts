/**
 * The compact shapes `search_rules` returns to the model: the bounded rule inventory and the
 * bounded outline and window, plus the byte caps that keep each result inside the tool-result
 * ceiling.
 */
import { MAX_TOOL_RESULT_BYTES } from '../pi/tool-result-envelope';
import type { OutlineMarker, OutlineMarkerKind } from '../repo/file-outline';
import { outlineMarkerLabel } from '../repo/file-outline';
import type { RuleMatch } from '../types/repo-context';
import { FILE_WINDOW_RADIUS_LINES } from '../repo/search';
import type { ListFileOutline, ListFileWindow } from '../repo/search';
import { RuleKind, normalizeRule } from '../repo/rule-normalizer';
import type { IArtifactStore } from '../tracer/artifact-store';
import { truncateUtf8 } from './truncate-utf8';

/**
 * Maximum number of domain-inventory matches shown directly to the model.
 */
const MAX_AGENT_DOMAIN_INVENTORY_MATCHES = 8;

/**
 * Maximum UTF-8 bytes of an individual domain-inventory rule preview.
 */
const MAX_DOMAIN_INVENTORY_RULE_PREVIEW_BYTES = 384;

/**
 * Maximum UTF-8 bytes of a filter label echoed back with an inventory match.
 *
 * These are repository-authored file titles, not rule text: a couple of words in every real filter
 * list. The cap only stops a malformed list header from displacing the match facts the model
 * actually chooses a follow-up query from.
 */
const MAX_INVENTORY_LABEL_BYTES = 128;

/**
 * Maximum UTF-8 bytes of one label in a file outline.
 *
 * Real section names run to about 50 bytes, but `!#if` conditions reach past that often enough that
 * a tighter cap merges distinct regions into one label. The byte loop already bounds the whole
 * result, so this cap only stops one malformed line from dominating it.
 */
export const MAX_OUTLINE_LABEL_BYTES = 256;

/**
 * Maximum UTF-8 bytes of the leading comment header in a file outline.
 *
 * A real header is a handful of list-policy lines (`! Title:`, `! Good:`, `! Bad:`); 4 KiB bounds a
 * malformed file while leaving even a zero-marker outline far below the tool-result ceiling after
 * JSON escaping.
 */
export const MAX_OUTLINE_HEADER_BYTES = 4096;

/**
 * Number of lines one full window carries: the chosen line plus the radius on either side.
 */
const WINDOW_LINE_COUNT = 2 * FILE_WINDOW_RADIUS_LINES + 1;

/**
 * Initial maximum UTF-8 bytes of one line in a file window.
 *
 * A real filter line is far shorter; the cap keeps one rule carrying a wall of domains from
 * consuming the window. It bounds raw bytes, not serialized bytes: JSON writes a control character
 * as a six-byte escape, so a window of such lines can exceed the tool-result ceiling even when
 * every line respects the cap. {@link compactListFileWindow} then lowers the cap until the
 * serialized window fits, keeping every numbered line.
 */
export const MAX_WINDOW_LINE_BYTES = 1024;

/**
 * Inventory families of repository rules as counted for the model-facing domain inventory.
 *
 * The three actionable kinds map straight onto their rule kinds; everything else (comments, empty
 * lines, unparsable text) collapses into `other`.
 */
const RuleInventoryKind = {
    Cosmetic: RuleKind.Cosmetic,
    Network: RuleKind.Network,
    Scriptlet: RuleKind.Scriptlet,
    Other: 'other',
} as const;

/**
 * Inventory family of one repository rule.
 */
type RuleInventoryKind = (typeof RuleInventoryKind)[keyof typeof RuleInventoryKind];

/**
 * One marker line of a compact outline, as the model reads it.
 */
export interface CompactOutlineMarker {
    /**
     * One-based line number of the marker.
     */
    l: number;

    /**
     * What kind of marker the line is.
     */
    k: OutlineMarkerKind;

    /**
     * The marker's label, cut at {@link MAX_OUTLINE_LABEL_BYTES}; absent when it has none.
     */
    t?: string;

    /**
     * Number of rules in the region after this marker; absent when there are none.
     */
    r?: number;

    /**
     * Whether the region after this marker is kept sorted; absent when it is not.
     */
    s?: boolean;

    /**
     * Whether `t` was cut to fit {@link MAX_OUTLINE_LABEL_BYTES}.
     */
    tt?: boolean;
}

/**
 * The rules before the first marker of a compact outline.
 */
export interface CompactOutlineLeading {
    /**
     * Number of rules before the first marker; absent when there are none.
     */
    r?: number;

    /**
     * Whether those rules are kept sorted; absent when they are not.
     */
    s?: boolean;
}

/**
 * One list-file outline in the compact shape the model reads.
 */
export interface CompactOutline extends Record<string, unknown> {
    /**
     * Checkout-relative path of the file, exactly as the placement map records it.
     */
    filePath: string;

    /**
     * Number of lines in the file.
     */
    lineCount: number;

    /**
     * The leading comment header above the first rule or marker; absent when the file has none.
     */
    header?: string;

    /**
     * Whether `header` was cut to fit {@link MAX_OUTLINE_HEADER_BYTES} or the result budget.
     */
    headerTruncated?: boolean;

    /**
     * The rules before the first marker.
     */
    leading: CompactOutlineLeading;

    /**
     * The file's marker lines, in file order.
     */
    markers: CompactOutlineMarker[];

    /**
     * Whether the tool-result budget cut markers from the end of this outline.
     */
    truncated?: boolean;
}

/**
 * One list-file window in the compact shape the model reads.
 */
export interface CompactWindow extends Record<string, unknown> {
    /**
     * Checkout-relative path of the file, exactly as the placement map records it.
     */
    filePath: string;

    /**
     * Number of lines in the file.
     */
    lineCount: number;

    /**
     * The window's lines, in file order.
     */
    lines: Array<{
        /**
         * One-based line number inside the file.
         */
        line: number;

        /**
         * Exact line text, cut at {@link MAX_WINDOW_LINE_BYTES}.
         */
        text: string;

        /**
         * Whether the line was cut.
         */
        truncated?: boolean;
    }>;
}

/**
 * Return the main syntactic family of one normalized filter rule for an inventory count.
 *
 * @param rule - Raw repository rule text.
 * @returns Stable inventory family name.
 */
function ruleInventoryKind(rule: string): RuleInventoryKind {
    const normalized = normalizeRule(rule);
    if (
        normalized.kind === RuleKind.Cosmetic ||
        normalized.kind === RuleKind.Network ||
        normalized.kind === RuleKind.Scriptlet
    ) {
        return normalized.kind;
    }
    return RuleInventoryKind.Other;
}

/**
 * Reduce one domain-inventory match to facts useful for choosing a focused follow-up query.
 *
 * Domain-only results are not an exact rule-edit instruction. The complete rule remains in the
 * trace artifact, while this preview prevents one unusually long rule from consuming the model's
 * entire fixed response budget. The file path stays whole: it is what a draft names to place a rule
 * beside the site's existing ones.
 *
 * @param match - Full repository match.
 * @returns Compact representative inventory match.
 */
function compactDomainInventoryMatch(match: RuleMatch): Record<string, unknown> {
    const rulePreview = truncateUtf8(match.rule, MAX_DOMAIN_INVENTORY_RULE_PREVIEW_BYTES);
    return {
        rulePreview,
        rulePreviewTruncated: rulePreview !== match.rule,
        filePath: match.filePath,
        filter: truncateUtf8(match.filter, MAX_INVENTORY_LABEL_BYTES),
        line: match.line,
        syntaxKind: ruleInventoryKind(match.rule),
    };
}

/**
 * Produce the compact, grouped form of a domain-only rule inventory.
 *
 * The complete inventory remains in an artifact. This response intentionally offers a small
 * representative sample so the model can choose a focused selector, pattern, or scriptlet query.
 *
 * @param matches - All applicable repository matches for one domain.
 * @param effectiveDomain - Runner-bound domain used for the search.
 * @param artifactStore - Optional trace-backed store for the complete inventory.
 * @returns Bounded model-facing inventory response.
 */
export function compactDomainRuleInventory(
    matches: RuleMatch[],
    effectiveDomain: string | undefined,
    artifactStore: IArtifactStore | undefined,
): Record<string, unknown> {
    const grouped: Record<RuleInventoryKind, number> = {
        [RuleInventoryKind.Cosmetic]: 0,
        [RuleInventoryKind.Network]: 0,
        [RuleInventoryKind.Scriptlet]: 0,
        [RuleInventoryKind.Other]: 0,
    };
    for (const match of matches) {
        grouped[ruleInventoryKind(match.rule)] += 1;
    }
    const fullInventory = {
        effectiveDomain,
        totalMatches: matches.length,
        matches,
    };
    const artifactRef = artifactStore?.write(
        JSON.stringify(fullInventory, null, 2),
        'rule-search-inventory',
    );
    const topMatches = matches
        .slice(0, MAX_AGENT_DOMAIN_INVENTORY_MATCHES)
        .map(compactDomainInventoryMatch);
    return {
        effectiveDomain,
        totalMatches: matches.length,
        truncated: matches.length > topMatches.length,
        groupedInventory: grouped,
        topMatches,
        ...(artifactRef
            ? {
                  artifactId: artifactRef.id,
                  metaArtifact: {
                      id: artifactRef.id,
                      type: artifactRef.type,
                      bytes: artifactRef.bytes,
                  },
                  metaHint:
                      `Complete domain inventory is persisted. Use get_detail("${artifactRef.id}") ` +
                      'with a key or limit only when a focused follow-up needs it.',
              }
            : {}),
    };
}

/**
 * Reduce one outline marker to the compact shape the model reads.
 *
 * @param marker - The outline marker.
 * @returns Compact marker with its line, kind, cut label, rule count and sortedness.
 */
function compactOutlineMarker(marker: OutlineMarker): CompactOutlineMarker {
    const compact: CompactOutlineMarker = { l: marker.line, k: marker.kind };
    const label = outlineMarkerLabel(marker);
    if (label !== undefined) {
        const text = truncateUtf8(label, MAX_OUTLINE_LABEL_BYTES);
        compact.t = text;
        if (text !== label) {
            compact.tt = true;
        }
    }
    if (marker.ruleCount !== 0) {
        compact.r = marker.ruleCount;
    }
    if (marker.sorted) {
        compact.s = true;
    }
    return compact;
}

/**
 * Reduce one list-file outline to the compact shape the model reads.
 *
 * The header and every marker are kept when they fit. Past the tool-result ceiling the markers are
 * dropped from the end, because a file is read from its start; a header that still overflows the
 * ceiling on its own is cut down to fit and flagged with `headerTruncated`.
 *
 * @param outline - The file's full outline and canonical path.
 * @returns Bounded model-facing outline.
 */
export function compactListFileOutline(outline: ListFileOutline): CompactOutline {
    const allMarkers = outline.markers.map(compactOutlineMarker);
    let header = truncateUtf8(outline.header, MAX_OUTLINE_HEADER_BYTES);
    let headerTruncated = header !== outline.header;
    let truncated = false;
    const render = (markers: readonly CompactOutlineMarker[], cut: boolean): CompactOutline => ({
        filePath: outline.filePath,
        lineCount: outline.lineCount,
        ...(header === '' ? {} : { header }),
        ...(headerTruncated ? { headerTruncated: true } : {}),
        leading: {
            ...(outline.leadingRuleCount === 0 ? {} : { r: outline.leadingRuleCount }),
            ...(outline.leadingSorted ? { s: true } : {}),
        },
        markers: [...markers],
        ...(cut ? { truncated: true } : {}),
    });
    const fits = (markers: readonly CompactOutlineMarker[], cut: boolean): boolean =>
        Buffer.byteLength(JSON.stringify(render(markers, cut)), 'utf8') <= MAX_TOOL_RESULT_BYTES;
    let markers = allMarkers;
    if (!fits(markers, false)) {
        let low = 0;
        let high = markers.length;
        while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            if (fits(markers.slice(0, middle), middle < markers.length)) {
                low = middle;
            } else {
                high = middle - 1;
            }
        }
        markers = markers.slice(0, low);
        truncated = markers.length < allMarkers.length;
    }
    while (!fits(markers, truncated) && header !== '') {
        header = truncateUtf8(header, Math.floor(Buffer.byteLength(header, 'utf8') / 2));
        headerTruncated = true;
    }
    return render(markers, truncated);
}

/**
 * Build one compact window with every line bounded by a given raw byte cap.
 *
 * @param window - The window's verbatim lines.
 * @param entries - The window's lines, already cut to {@link WINDOW_LINE_COUNT}.
 * @param lineCap - Maximum UTF-8 bytes of each line's text.
 * @returns The compact window, every cut line flagged.
 */
function renderWindow(
    window: ListFileWindow,
    entries: ListFileWindow['lines'],
    lineCap: number,
): CompactWindow {
    return {
        filePath: window.filePath,
        lineCount: window.lineCount,
        lines: entries.map((entry) => {
            const text = truncateUtf8(entry.text, lineCap);
            return text === entry.text
                ? { line: entry.line, text }
                : { line: entry.line, text, truncated: true };
        }),
    };
}

/**
 * Reduce one file window to the compact shape the model reads, cutting overlong lines.
 *
 * The lines are bounded to {@link MAX_WINDOW_LINE_BYTES} first. That cap measures raw UTF-8, while
 * the ceiling measures the serialized JSON, where escaping can multiply a control character
 * six-fold; when the rendered window still exceeds the ceiling the cap shrinks until the result
 * fits. Every numbered line stays: the window's purpose is to show what surrounds the chosen line,
 * so the per-line text gives way, not the lines themselves.
 *
 * @param window - The window's verbatim lines.
 * @returns Bounded model-facing window with every cut line flagged.
 */
export function compactListFileWindow(window: ListFileWindow): CompactWindow {
    const entries = window.lines.slice(0, WINDOW_LINE_COUNT);
    const render = (lineCap: number): CompactWindow => renderWindow(window, entries, lineCap);
    const fits = (lineCap: number): boolean =>
        Buffer.byteLength(JSON.stringify(render(lineCap)), 'utf8') <= MAX_TOOL_RESULT_BYTES;
    if (fits(MAX_WINDOW_LINE_BYTES)) {
        return render(MAX_WINDOW_LINE_BYTES);
    }
    // A cap of 0 leaves every line as an empty text, which is the smallest this window can get;
    // when even that overshoots, the file path itself is the cost and no per-line cut can help.
    let low = 0;
    let high = MAX_WINDOW_LINE_BYTES;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (fits(middle)) {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    return render(low);
}
