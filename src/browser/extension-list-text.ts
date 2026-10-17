/**
 * The build's own text of a built-in filter list, and the lines of it a slice session runs. The MV3
 * builds ship every list's complete text inside their declarative ruleset JSON:
 * `metadata.filterContent` in the 5.5 line and `metadata.rawFilterList` in the 5.4 line, byte for
 * byte the published list. A slice is a line range of that text re-issued as a custom filter, so
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
 * The extension manifest lists the authoritative bundled rulesets, including metadata resources.
 */
const MANIFEST_FILENAME = 'manifest.json';

/**
 * The converter's metadata ruleset carries the other rulesets' checksums, not a filter list, so the
 * human-fix guard excludes it when reading list text.
 */
export const BUNDLED_METADATA_RULESET_ID = 0;

/**
 * The trusted build manifest's authoritative declarative ruleset resources.
 */
interface BundledRulesetManifest {
    /**
     * Declarative request rules registered by the build.
     */
    declarative_net_request: {
        /**
         * The bundled rulesets, including the converter's metadata ruleset.
         */
        rule_resources: {
            /**
             * The converter's ruleset name, suffixed with its numeric filter id.
             */
            id: string;
        }[];
    };
}

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
        /**
         * The whole list text in the 5.4 build line, before it was named `filterContent`.
         */
        rawFilterList?: string;
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
 * Lists the manifest's declarative ruleset ids in ascending order, including the converter's
 * metadata ruleset. Unreferenced files on disk do not participate. A missing manifest throws with
 * its path rather than representing a build with no lists.
 *
 * @param extensionPath - Unpacked extension root of the prepared build.
 * @returns The declared ruleset ids in the extension's own registry numbering.
 */
export function listBundledListIds(extensionPath: string): number[] {
    const manifest = JSON.parse(
        readFileSync(join(extensionPath, MANIFEST_FILENAME), 'utf8'),
    ) as BundledRulesetManifest;
    return manifest.declarative_net_request.rule_resources
        .map((resource) => Number(resource.id.slice(RULESET_NAME_PREFIX.length)))
        .sort((left, right) => left - right);
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
    const metadata = ruleset[0]?.metadata;
    const filterContent = metadata?.filterContent ?? metadata?.rawFilterList;
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
