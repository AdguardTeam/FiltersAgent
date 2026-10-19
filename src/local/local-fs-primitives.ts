/**
 * Filesystem primitives the local run output builds on: a no-follow `lstat`, a race-tolerant
 * private directory, and a directory fsync.
 */
import {
    closeSync,
    constants,
    fstatSync,
    fsyncSync,
    lstatSync,
    mkdirSync,
    openSync,
} from 'node:fs';
import type { Stats } from 'node:fs';

/**
 * Read path metadata without following a final symlink.
 *
 * @param path - Absolute path to inspect.
 * @returns Path metadata, or null when the path does not exist.
 */
export function lstatIfExists(path: string): Stats | null {
    try {
        return lstatSync(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}

/**
 * Create one private directory unless something already sits at its path.
 *
 * Creating first and tolerating `EEXIST` keeps concurrent runs that share a fresh output root from
 * failing on each other's parent directories: an existence check before `mkdir` leaves a window in
 * which another process creates the same component. `mkdir` never follows a final symlink, so the
 * caller's `lstat` afterwards still sees and rejects one.
 *
 * @param path - Directory to create.
 * @returns True when this call created the directory, false when the path already existed.
 */
export function createDirectoryIfMissing(path: string): boolean {
    try {
        mkdirSync(path, { mode: 0o700 });
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            return false;
        }
        throw error;
    }
}

/**
 * Fsync one exact owned directory.
 *
 * @param path - Directory path.
 */
export function fsyncDirectory(path: string): void {
    let descriptor: number | undefined;
    try {
        descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        if (!fstatSync(descriptor).isDirectory()) {
            throw new Error('Publication path is not a directory.');
        }
        fsyncSync(descriptor);
    } finally {
        if (descriptor !== undefined) {
            closeSync(descriptor);
        }
    }
}
