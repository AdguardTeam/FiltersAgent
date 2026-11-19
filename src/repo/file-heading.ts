/**
 * The heading one line of a list file sits under.
 *
 * One stack holds every open heading, so a closing marker removes the right one: a `! !SECTION:`
 * closes its section, the notes and the banners opened above it, a `! NOTE: … end` closes its note
 * and banner, and a `! END:` closes the innermost open group with everything opened inside it. A
 * note or a banner names the lines up to the next heading: that heading ends it, so no older note
 * or banner comes back when the newer heading closes.
 *
 * A group is named only where the file bounds it: the group starts that no end marker closes name
 * nothing, so an old group without an end never becomes the heading of the lines below it. A bare
 * dashed frame ends the banner it does not frame, so a labelled banner stops at its closing frame.
 */
import {
    OutlineMarkerKind,
    classifyMarker,
    outlineMarkerLabel,
    type MarkerLine,
} from './file-outline';

/**
 * One marker line of a list file, with its position.
 */
interface HeadingMarker {
    /**
     * Zero-based line index of the marker.
     */
    index: number;

    /**
     * The marker's classification.
     */
    marker: MarkerLine;
}

/**
 * One open heading, kept in a single stack so a closing marker removes the right one.
 */
interface HeadingEntry {
    /**
     * What kind of heading opened it.
     */
    kind: OutlineMarkerKind;

    /**
     * The heading's label.
     */
    text: string;

    /**
     * Zero-based line index of the marker that opened the heading.
     */
    line: number;
}

/**
 * Classify every marker line of a list file once.
 *
 * One pass over the whole file, so a group start can be matched against the end marker below it
 * without a second look at the lines under each start.
 *
 * @param lines - Exact repository lines in the filter-file line model.
 * @returns The file's marker lines with their zero-based indexes, in file order.
 */
function collectMarkers(lines: readonly string[]): HeadingMarker[] {
    const markers: HeadingMarker[] = [];
    for (const [index, line] of lines.entries()) {
        const marker = classifyMarker(line);
        if (marker !== undefined) {
            markers.push({ index, marker });
        }
    }
    return markers;
}

/**
 * Find the group starts that an end marker closes.
 *
 * The end markers pair with the innermost open group, the section markers open scopes of their own,
 * and a section boundary drops the groups its scope held. A group start therefore stays unmatched
 * when no end closes it inside its scope, and an end outside that scope cannot close it.
 *
 * @param markers - Every marker line of the file, in file order.
 * @returns Zero-based indexes of the group start lines an end marker closes.
 */
function matchedGroupStarts(markers: readonly HeadingMarker[]): ReadonlySet<number> {
    const scopes: number[][] = [[]];
    const matched = new Set<number>();
    for (const { index, marker } of markers) {
        switch (marker.kind) {
            case OutlineMarkerKind.Section:
                scopes.push([]);
                break;
            case OutlineMarkerKind.SectionEnd:
                if (scopes.length > 1) {
                    scopes.pop();
                }
                break;
            case OutlineMarkerKind.Group:
                scopes[scopes.length - 1].push(index);
                break;
            case OutlineMarkerKind.GroupEnd: {
                for (let scope = scopes.length - 1; scope >= 0; scope -= 1) {
                    const start = scopes[scope].pop();
                    if (start !== undefined) {
                        matched.add(start);
                        break;
                    }
                }
                break;
            }
            case OutlineMarkerKind.Note:
            case OutlineMarkerKind.NoteEnd:
            case OutlineMarkerKind.Banner:
            case OutlineMarkerKind.Condition:
            case OutlineMarkerKind.ConditionEnd:
                break;
        }
    }
    return matched;
}

/**
 * Remove every Note and Banner heading open above the innermost section.
 *
 * @param stack - The open heading stack.
 */
function closeNotesAndBanners(stack: HeadingEntry[]): void {
    for (let index = stack.length - 1; index >= 0; index -= 1) {
        const kind = stack[index].kind;
        if (kind === OutlineMarkerKind.Section) {
            return;
        }
        if (kind === OutlineMarkerKind.Note || kind === OutlineMarkerKind.Banner) {
            stack.splice(index, 1);
        }
    }
}

/**
 * Close the innermost open group inside one scope, with the headings that scope opened after it.
 *
 * A nested section is a new scope, so a section entry after the group is left where it is: the
 * group closes only the headings of its own scope, exactly as the separate root/section scopes
 * did.
 *
 * @param stack - The open heading stack.
 * @param start - Zero-based first index of the scope's heading entries.
 * @param end - Zero-based index just after the scope's last heading entry.
 * @returns Whether the scope held an open group.
 */
function closeGroupInScope(stack: HeadingEntry[], start: number, end: number): boolean {
    for (let index = end - 1; index >= start; index -= 1) {
        if (stack[index].kind === OutlineMarkerKind.Group) {
            stack.splice(index, end - index);
            return true;
        }
    }
    return false;
}

/**
 * Close the innermost open group, searching the scopes from the innermost section outward.
 *
 * @param stack - The open heading stack.
 */
function closeInnermostGroup(stack: HeadingEntry[]): void {
    let end = stack.length;
    for (let index = stack.length - 1; index >= 0; index -= 1) {
        if (stack[index].kind !== OutlineMarkerKind.Section) {
            continue;
        }
        if (closeGroupInScope(stack, index + 1, end)) {
            return;
        }
        end = index;
    }
    closeGroupInScope(stack, 0, end);
}

/**
 * Remove the innermost open banner with the headings opened inside it.
 *
 * A three-line banner is framed by its label: bare dashes, the label line, bare dashes. A bare
 * frame anywhere further down ends the banner, so a labelled banner never names the old part of the
 * list below its closing frame. The frame stays in its own scope: a bare line inside a nested
 * section closes no banner of the enclosing one, and never removes the section it sits in.
 *
 * @param stack - The open heading stack.
 * @param frameIndex - Zero-based line index of the bare frame.
 */
function closeFramedBanner(stack: HeadingEntry[], frameIndex: number): void {
    for (let index = stack.length - 1; index >= 0; index -= 1) {
        const kind = stack[index].kind;
        if (kind === OutlineMarkerKind.Section) {
            return;
        }
        if (kind !== OutlineMarkerKind.Banner) {
            continue;
        }
        if (stack[index].line !== frameIndex - 1) {
            stack.length = index;
        }
        return;
    }
}

/**
 * Open one heading that names the lines below it.
 *
 * A note or a banner names the lines between it and the next heading, so that heading ends the ones
 * opened before it in the same scope: a section ends the notes and banners of the scope it opens
 * in, and nothing older comes back when the newer heading closes.
 *
 * @param stack - The open heading stack.
 * @param entry - The heading to open.
 */
function pushHeading(stack: HeadingEntry[], entry: HeadingEntry): void {
    closeNotesAndBanners(stack);
    stack.push(entry);
}

/**
 * Name the nearest heading that is still open above one line.
 *
 * @param lines - Exact repository lines in the filter-file line model.
 * @param line - One-based line whose enclosing heading is asked for.
 * @returns The heading's label, or undefined when none is open there.
 */
export function openHeadingAt(lines: readonly string[], line: number): string | undefined {
    const markers = collectMarkers(lines);
    const closedGroups = matchedGroupStarts(markers);
    const stack: HeadingEntry[] = [];
    for (const { index, marker } of markers) {
        if (index >= line - 1) {
            break;
        }
        switch (marker.kind) {
            case OutlineMarkerKind.Section:
            case OutlineMarkerKind.Note: {
                const text = outlineMarkerLabel(marker);
                if (text !== undefined) {
                    pushHeading(stack, { kind: marker.kind, text, line: index });
                }
                break;
            }
            case OutlineMarkerKind.Group: {
                const text = outlineMarkerLabel(marker);
                if (text !== undefined && closedGroups.has(index)) {
                    pushHeading(stack, { kind: marker.kind, text, line: index });
                }
                break;
            }
            case OutlineMarkerKind.Banner: {
                const text = outlineMarkerLabel(marker);
                if (text === undefined) {
                    closeFramedBanner(stack, index);
                } else {
                    pushHeading(stack, { kind: marker.kind, text, line: index });
                }
                break;
            }
            case OutlineMarkerKind.SectionEnd: {
                for (let stackIndex = stack.length - 1; stackIndex >= 0; stackIndex -= 1) {
                    if (stack[stackIndex].kind === OutlineMarkerKind.Section) {
                        stack.length = stackIndex;
                        break;
                    }
                }
                break;
            }
            case OutlineMarkerKind.NoteEnd:
                closeNotesAndBanners(stack);
                break;
            case OutlineMarkerKind.GroupEnd:
                closeInnermostGroup(stack);
                break;
            case OutlineMarkerKind.Condition:
            case OutlineMarkerKind.ConditionEnd:
                break;
        }
    }
    return stack.at(-1)?.text;
}
