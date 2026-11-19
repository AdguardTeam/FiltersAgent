/**
 * Turn the position the agent named for a new rule into the exact insert edit, or refuse it with
 * the reason.
 *
 * The agent decides where inside the list file the rule goes; this module only computes the edit
 * the position resolves to and refuses the positions that would break the file. Nothing here picks
 * a position on the model's behalf.
 */
import { buildFileOutline, type FileOutline } from './file-outline';
import { openHeadingAt } from './file-heading';
import { openConditionAt } from './file-condition';
import type { InsertRepositoryEdit } from '../types/repository-edit';
import { findSortedInsertion, type RuleRegion } from './sorted-insertion';
import {
    MAX_PLACEMENT_CONDITION_CHARACTERS,
    MAX_PLACEMENT_HEADING_CHARACTERS,
    PlacementBasis,
} from '../types/placement-basis';
import { RepositoryEditKind } from '../types/repository-edit-kind';
import { PlacementPositionKind, type PlacementPosition } from '../types/rule-proposal';

/**
 * A platform hint line (`!+ NOT_PLATFORM(…)`, `!+ PLATFORM(…)`): it applies to the rule directly
 * beneath it, so a new line between the two would move the hint onto the new rule.
 */
const PLATFORM_HINT_PATTERN = /^\s*!\+/u;

/**
 * The zero-based inclusive line range of one outline region.
 */
type OutlineRegion = RuleRegion;

/**
 * The region before a file's first marker.
 *
 * @param outline - The file's outline.
 * @param lineCount - Number of lines in the file.
 * @returns The leading region, empty when the first line is already a marker.
 */
function leadingRegion(outline: FileOutline, lineCount: number): OutlineRegion {
    const firstMarker = outline.markers[0]?.line;
    return { startIndex: 0, endIndex: firstMarker === undefined ? lineCount - 1 : firstMarker - 2 };
}

/**
 * The region one marker opens, up to the next marker or the end of the file.
 *
 * @param outline - The file's outline.
 * @param markerIndex - Zero-based position of the marker among the outline's markers.
 * @param lineCount - Number of lines in the file.
 * @returns The marker's region.
 */
function markerRegion(outline: FileOutline, markerIndex: number, lineCount: number): OutlineRegion {
    const marker = outline.markers[markerIndex];
    const nextMarker = outline.markers[markerIndex + 1]?.line;
    return {
        startIndex: marker.line,
        endIndex: nextMarker === undefined ? lineCount - 1 : nextMarker - 2,
    };
}

/**
 * Resolve the outline region a sorted position names, or explain why it names none.
 *
 * A numeric line has to be exactly an outline marker line whose region the outline flagged as kept
 * sorted. Any other line is refused rather than rounded to the nearest region: the agent reads the
 * outline, and a region it did not name is a decision this planner does not make. An omitted line
 * names the leading region, which must be flagged the same way.
 *
 * @param lines - Exact repository lines in the {@link filterFileLines} model.
 * @param filePath - Checkout-relative path of the file, named in the refusals.
 * @param line - The 1-based marker line the agent named, or undefined for the leading region.
 * @returns The region the rule may sort inside.
 * @throws {Error} Naming the line and why the outline does not flag a region there.
 */
function sortedRegion(
    lines: readonly string[],
    filePath: string,
    line: number | undefined,
): OutlineRegion {
    const outline = buildFileOutline(lines);
    if (line === undefined) {
        if (!outline.leadingSorted) {
            throw new Error(
                `${PlacementPositionKind.Sorted} was named without a line for ${filePath}, and ` +
                    'the rules before its first outline marker are not kept sorted. Name the line ' +
                    'of an outline marker whose region the outline flags as sorted (s), or choose ' +
                    `${PlacementPositionKind.BeforeLine} from the outline, or ` +
                    `${PlacementPositionKind.FileEnd} with the reason.`,
            );
        }
        return leadingRegion(outline, lines.length);
    }
    const markerIndex = outline.markers.findIndex((marker) => marker.line === line);
    if (markerIndex < 0) {
        throw new Error(
            `${PlacementPositionKind.Sorted} names line ${line} of ${filePath}, but no outline ` +
                'marker starts there. Name the line of an outline marker whose region the outline ' +
                'flags as sorted (s), or leave line out for the region before the first marker.',
        );
    }
    if (!outline.markers[markerIndex].sorted) {
        throw new Error(
            `${PlacementPositionKind.Sorted} names line ${line} of ${filePath}, but the region ` +
                'below that marker is not kept sorted. Name the line of a marker the outline ' +
                `flags as sorted (s), or choose ${PlacementPositionKind.BeforeLine} from the ` +
                `outline, or ${PlacementPositionKind.FileEnd} with the reason.`,
        );
    }
    return markerRegion(outline, markerIndex, lines.length);
}

/**
 * Describe why a chosen line lies past the last line of its file.
 *
 * The schema already guarantees a positive integer, so only the file's own length can refuse the
 * line. The place directly after the last line is the end-of-file position, which carries the
 * agent's reason; a file with no lines has no line range to offer at all.
 *
 * @param filePath - Checkout-relative path of the file, named in the refusal.
 * @param line - The 1-based line the agent named.
 * @param lineCount - Number of lines in the file.
 * @returns The model-facing refusal.
 */
function beforeLineOutsideMessage(filePath: string, line: number, lineCount: number): string {
    if (lineCount === 0) {
        return (
            `${PlacementPositionKind.BeforeLine} ${line} names a line of ${filePath}, which is ` +
            `empty. Choose ${PlacementPositionKind.FileEnd} with the reason.`
        );
    }
    if (line === lineCount + 1) {
        return (
            `${PlacementPositionKind.BeforeLine} ${line} is the place after the last line of ` +
            `${filePath}: choose ${PlacementPositionKind.FileEnd} with the reason.`
        );
    }
    return (
        `${PlacementPositionKind.BeforeLine} ${line} is outside ${filePath}, which has ` +
        `${lineCount} lines. Choose a line between 1 and ${lineCount}, or ` +
        `${PlacementPositionKind.FileEnd} with the reason.`
    );
}

/**
 * Plan the insert one named position resolves to inside an already read list file.
 *
 * @param lines - Exact repository lines in the `filterFileLines` model.
 * @param filePath - Checkout-relative path of the file the lines belong to, named in the refusals.
 * @param candidateRule - Locked candidate rule.
 * @param position - The position the agent named, or undefined when it named none.
 * @returns The insert edit carrying the basis and, where the file holds them, the heading and
 *   condition enclosing the inserted rule.
 * @throws {Error} Naming the offending line, or the file's line count, when the position cannot be
 *   used.
 */
export function planPositionedInsert(
    lines: readonly string[],
    filePath: string,
    candidateRule: string,
    position: PlacementPosition | undefined,
): InsertRepositoryEdit {
    if (position === undefined) {
        throw new Error(
            `No position was named for the new rule in ${filePath}. Choose ` +
                `${PlacementPositionKind.BeforeLine} from the file outline or a window, ` +
                `${PlacementPositionKind.Sorted} for a region the outline flags as sorted, or ` +
                `${PlacementPositionKind.FileEnd} with the reason.`,
        );
    }
    switch (position.kind) {
        case PlacementPositionKind.BeforeLine: {
            const line = position.line;
            if (line > lines.length) {
                throw new Error(beforeLineOutsideMessage(filePath, line, lines.length));
            }
            const preceding = lines[line - 2];
            if (preceding !== undefined && PLATFORM_HINT_PATTERN.test(preceding)) {
                throw new Error(
                    `${PlacementPositionKind.BeforeLine} ${line} would insert the rule directly ` +
                        `under the platform hint "${preceding.trim()}", which must stay above the ` +
                        'rule it applies to. Choose another line.',
                );
            }
            const heading = openHeadingAt(lines, line);
            const condition = openConditionAt(lines, line);
            return {
                kind: RepositoryEditKind.Insert,
                insertionPoint: line - 1,
                anchorRule: lines[line - 1],
                basis: PlacementBasis.ChosenLine,
                ...(heading === undefined
                    ? {}
                    : { heading: heading.slice(0, MAX_PLACEMENT_HEADING_CHARACTERS) }),
                ...(condition === undefined
                    ? {}
                    : { condition: condition.slice(0, MAX_PLACEMENT_CONDITION_CHARACTERS) }),
            };
        }
        case PlacementPositionKind.Sorted: {
            const region = sortedRegion(lines, filePath, position.line);
            const sorted = findSortedInsertion(lines, candidateRule, region);
            if (sorted === undefined) {
                throw new Error(
                    `${PlacementPositionKind.Sorted} was chosen for ${filePath}, but the named ` +
                        "region holds no sorted run of this rule's kind. Choose " +
                        `${PlacementPositionKind.BeforeLine} from the outline, or ` +
                        `${PlacementPositionKind.FileEnd} with the reason.`,
                );
            }
            // The rule lands on the 1-based line the zero-based insertion point opens, so that is
            // the line whose enclosing heading and condition it inherits.
            const landingLine = sorted.insertionPoint + 1;
            const heading = openHeadingAt(lines, landingLine);
            const condition = openConditionAt(lines, landingLine);
            return {
                kind: RepositoryEditKind.Insert,
                insertionPoint: sorted.insertionPoint,
                ...(sorted.anchorRule === undefined ? {} : { anchorRule: sorted.anchorRule }),
                basis: PlacementBasis.SortedPosition,
                ...(heading === undefined
                    ? {}
                    : { heading: heading.slice(0, MAX_PLACEMENT_HEADING_CHARACTERS) }),
                ...(condition === undefined
                    ? {}
                    : { condition: condition.slice(0, MAX_PLACEMENT_CONDITION_CHARACTERS) }),
            };
        }
        case PlacementPositionKind.FileEnd:
            return {
                kind: RepositoryEditKind.Insert,
                basis: PlacementBasis.AppendEof,
                reason: position.reason,
            };
        default:
            throw new Error(`Unknown placement position: ${JSON.stringify(position)}`);
    }
}
