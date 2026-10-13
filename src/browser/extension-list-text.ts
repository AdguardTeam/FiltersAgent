/**
 * The build's own text of a built-in filter list, and the lines of it a slice session runs. The
 * pinned MV3 build ships every list's complete text inside its declarative ruleset JSON, byte for
 * byte the published list; a slice is a line range of that text re-issued as a custom filter, so
 * line numbers the agent quotes mean the same thing in the build, in the launch answer and in the
 * filtering log.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ListSlice } from '../environment/list-slice';

/**
 * Where the pinned MV3 build keeps its built-in lists, relative to the unpacked extension root: one
 * declarative ruleset folder per list.
 */
const BUNDLED_RULESETS_DIRECTORY = join('filters', 'declarative');

/**
 * The build names a list's ruleset folder and file after its filter id, the same `ruleset_<id>` the
 * manifest's `declarative_net_request` resources use.
 */
const RULESET_NAME_PREFIX = 'ruleset_';

/**
 * Splits the bundled text into lines. The build stores lists with CRLF line ends (the text is
 * byte-identical to the published list); splitting on either end keeps line numbers right for a
 * list that was published with LF.
 */
const LINE_BREAK = /\r?\n/;

/**
 * Joins a slice's lines. The extension's custom-filter loader takes LF; re-issuing CRLF would only
 * carry the build's line ends into a filter that is never checksummed.
 */
const SLICE_LINE_BREAK = '\n';

/**
 * A `! Checksum:` line, anywhere and in any spelling. The extension's custom-filter loader
 * validates a checksum line found at the start of a downloaded filter against the whole body, and a
 * slice's body is never the whole list, so no checksum line may survive in a slice.
 */
const CHECKSUM_LINE = /^!\s*checksum\b/i;

/**
 * The dummy first rule of a bundled ruleset: the build hangs the list's metadata on it, among it
 * the whole list text. Typed only as far as this module reads it.
 */
interface BundledMetadataRule {
    /**
     * The metadata the build attached to its dummy rule.
     */
    metadata?: {
        /**
         * The whole list text, byte-identical to the published list, CRLF line ends included.
         */
        filterContent?: string;
    };
}

/**
 * Where the pinned build stores one list's declarative ruleset, the list's whole text inside it.
 *
 * @param extensionPath - Unpacked extension root of the prepared build.
 * @param filterId - The built-in list, in the extension's own registry numbering.
 * @returns The ruleset JSON path.
 */
export function bundledRulesetPath(extensionPath: string, filterId: number): string {
    const rulesetName = `${RULESET_NAME_PREFIX}${filterId}`;
    return join(extensionPath, BUNDLED_RULESETS_DIRECTORY, rulesetName, `${rulesetName}.json`);
}

/**
 * The build's own text of one built-in list, as lines. Reads the ruleset JSON on every call and
 * keeps nothing: the largest list is megabytes of text inside a file several times that size, and
 * the caller reads each list at most a few times per run.
 *
 * The ruleset is trusted build data, so a missing file or a ruleset whose first rule carries no
 * list text throws, naming the file: a build without the text is a build this session cannot slice,
 * not a list with no lines.
 *
 * @param extensionPath - Unpacked extension root of the prepared build.
 * @param filterId - The built-in list, in the extension's own registry numbering.
 * @returns The list's lines, line ends stripped, without the empty element a final line break would
 *   leave.
 */
export function readBundledListLines(extensionPath: string, filterId: number): string[] {
    const rulesetPath = bundledRulesetPath(extensionPath, filterId);
    let raw: string;
    try {
        raw = readFileSync(rulesetPath, 'utf8');
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
            `Cannot read the bundled text of list ${filterId}: ${rulesetPath} (${detail})`,
            { cause: error },
        );
    }
    const ruleset = JSON.parse(raw) as BundledMetadataRule[];
    const filterContent = ruleset[0]?.metadata?.filterContent;
    if (typeof filterContent !== 'string') {
        throw new Error(
            `The bundled ruleset of list ${filterId} carries no list text in its first rule: ` +
                rulesetPath,
        );
    }
    const lines = filterContent.split(LINE_BREAK);
    if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
    }
    return lines;
}

/**
 * The text a slice session installs as its custom filter: the slice's lines of the list, minus
 * every checksum line, LF-joined with a trailing newline. Line numbers are 1-based and inclusive,
 * into the lines `readBundledListLines` returned. The range is trusted here: the launch refused a
 * range outside the list before any browser started (`listSliceRefusal`), against the same build
 * text, and the request schema admits positive integers only.
 *
 * @param lines - The whole list's lines.
 * @param slice - Which lines to keep.
 * @returns The slice's text.
 */
export function sliceListText(lines: readonly string[], slice: ListSlice): string {
    const kept = lines
        .slice(slice.firstLine - 1, slice.lastLine)
        .filter((line) => !CHECKSUM_LINE.test(line));
    return `${kept.join(SLICE_LINE_BREAK)}${SLICE_LINE_BREAK}`;
}
