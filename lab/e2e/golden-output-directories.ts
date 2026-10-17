import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';

/**
 * Determine whether two real directories are equal or nested in either direction.
 *
 * @param first - First canonical real directory.
 * @param second - Second canonical real directory.
 * @returns True when the directories overlap.
 */
export function goldenDirectoriesOverlap(first: string, second: string): boolean {
    const firstToSecond = relative(first, second);
    const secondToFirst = relative(second, first);
    const firstContainsSecond =
        firstToSecond === '' || (!firstToSecond.startsWith('..') && !isAbsolute(firstToSecond));
    const secondContainsFirst =
        secondToFirst === '' || (!secondToFirst.startsWith('..') && !isAbsolute(secondToFirst));
    return firstContainsSecond || secondContainsFirst;
}

/**
 * Resolve an existing path or its nearest existing ancestor without creating the destination.
 *
 * @param path - Absolute prospective directory path.
 * @returns Canonical prospective path with existing symlink components resolved.
 */
export function canonicalProspectiveDirectory(path: string): string {
    let ancestor = resolve(path);
    const missingComponents: string[] = [];
    while (!existsSync(ancestor)) {
        const parent = dirname(ancestor);
        if (parent === ancestor) {
            break;
        }
        missingComponents.unshift(basename(ancestor));
        ancestor = parent;
    }
    return resolve(realpathSync(ancestor), ...missingComponents);
}
