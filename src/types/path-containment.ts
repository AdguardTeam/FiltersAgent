import { isAbsolute, relative, sep } from 'node:path';

/**
 * The relative-path segment that steps out of a directory.
 */
const PARENT_SEGMENT = '..';

/**
 * Check whether one path is the same as or nested below another.
 *
 * A lexical relative-path test, never a raw string prefix: `skills-other` does not sit below
 * `skills`, while a file named `..notes.md` does. `path.relative` resolves both arguments against
 * the working directory itself, and an absolute result (another drive on Windows) is outside. The
 * caller decides whether to realpath-resolve the arguments first; this check does not follow
 * symlinks.
 *
 * @param parentPath - Boundary directory.
 * @param candidatePath - Path tested against the boundary.
 * @returns True when the candidate is the parent itself or a descendant of it.
 */
export function isPathAtOrBelow(parentPath: string, candidatePath: string): boolean {
    const relativePath = relative(parentPath, candidatePath);
    return (
        relativePath !== PARENT_SEGMENT &&
        !relativePath.startsWith(`${PARENT_SEGMENT}${sep}`) &&
        !isAbsolute(relativePath)
    );
}
