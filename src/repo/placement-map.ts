import { readdirSync, writeFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import * as v from 'valibot';
import { PlacementMapSchema, type PlacementMap, type FilterFileEntry } from '../types/repo-context';

/**
 * Directories skipped during checkout traversal.
 */
const SKIP_DIRS = new Set(['.git', 'node_modules']);

/**
 * The one file extension a checked-in filter list carries.
 */
const TXT_SUFFIX = '.txt';

/**
 * Recursively collect `.txt` file paths under a root.
 *
 * @param root - Directory to walk.
 * @returns Absolute paths of all `.txt` files.
 */
function collectTxtFiles(root: string): string[] {
    const results: string[] = [];
    for (const entry of readdirSync(root)) {
        if (SKIP_DIRS.has(entry)) {
            continue;
        }
        const full = join(root, entry);
        const st = statSync(full);
        if (st.isDirectory()) {
            results.push(...collectTxtFiles(full));
        } else if (entry.endsWith(TXT_SUFFIX)) {
            results.push(full);
        }
    }
    return results;
}

/**
 * Count the list files sitting directly in each directory of the checkout.
 *
 * @param relPaths - Every list file path relative to the checkout root.
 * @returns How many list files each directory holds directly, keyed by the directory's own relative
 *   path; the checkout root itself is the empty string.
 */
function listFilesPerDirectory(relPaths: readonly string[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const relPath of relPaths) {
        const lastSep = relPath.lastIndexOf(sep);
        const directory = lastSep === -1 ? '' : relPath.slice(0, lastSep);
        counts.set(directory, (counts.get(directory) ?? 0) + 1);
    }
    return counts;
}

/**
 * Derive a filter name from a file's path relative to the checkout root.
 *
 * Two real repository layouts have to be told apart, and the checkout's own shape is what tells
 * them apart:
 *
 * - One directory per filter, as AdguardFilters ships it — a single `filter.txt`, or a `sections/`
 *   subtree of parts that all belong to the same distributed list. The top-level directory names
 *   the filter (`BaseFilter/filter.txt` and `BaseFilter/sections/foreign.txt` → `BaseFilter`).
 * - One directory of independent lists, as a uAssets-style repository ships it — `filters/*.txt`,
 *   each file a separately distributed list. Naming them all after `filters` would collapse them
 *   into one filter, which loses every alternative placement and every cross-list selector. Each
 *   file is its own list instead, named by its path.
 *
 * The discriminator is a directory holding more than one list file directly at the top level: that
 * is a container of lists, not a filter split into sections.
 *
 * @param relPath - Path relative to the checkout root.
 * @param listFilesPerDir - How many list files each directory holds directly.
 * @returns The filter name.
 */
function filterNameFromRelPath(
    relPath: string,
    listFilesPerDir: ReadonlyMap<string, number>,
): string {
    const firstSep = relPath.indexOf(sep);
    if (firstSep === -1) {
        return relPath;
    }
    const topLevel = relPath.slice(0, firstSep);
    const parent = relPath.slice(0, relPath.lastIndexOf(sep));
    if (parent === topLevel && (listFilesPerDir.get(parent) ?? 0) > 1) {
        return relPath.slice(0, relPath.length - TXT_SUFFIX.length);
    }
    return topLevel;
}

/**
 * Generate a placement map by scanning a filter-list checkout.
 *
 * Every `.txt` file the checkout holds is a list file, keyed by its checkout-relative path; how
 * those files group into filters follows the checkout's own layout (see
 * {@link filterNameFromRelPath}), so an AdguardFilters tree and a uAssets-style tree are both
 * described correctly.
 *
 * @param checkoutPath - Absolute path to the local filter-list checkout.
 * @returns The generated placement map.
 */
export function generatePlacementMap(checkoutPath: string): PlacementMap {
    const relPaths = collectTxtFiles(checkoutPath)
        .sort()
        .map((absPath) => relative(checkoutPath, absPath));
    const listFilesPerDir = listFilesPerDirectory(relPaths);
    const files = relPaths.map(
        (relPath): FilterFileEntry => ({
            filter: filterNameFromRelPath(relPath, listFilesPerDir),
            relativePath: relPath,
        }),
    );
    const map = {
        checkoutPath,
        generatedAt: new Date().toISOString(),
        files,
    };
    return v.parse(PlacementMapSchema, map);
}

/**
 * Write a placement map to a JSON file.
 *
 * @param map - The map to write.
 * @param outPath - Output path (defaults to `placement-map.json` in the checkout root).
 */
export function writePlacementMap(map: PlacementMap, outPath?: string): void {
    const target = outPath ?? join(map.checkoutPath, 'placement-map.json');
    writeFileSync(target, JSON.stringify(map, null, 2) + '\n', 'utf8');
}
