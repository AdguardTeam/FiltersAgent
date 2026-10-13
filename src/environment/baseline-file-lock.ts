import { constants, createReadStream } from 'node:fs';
import { open, lstat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';

/**
 * Stable metadata used to detect unsafe files and changes around streaming.
 */
export interface BaselineFileMetadata {
    /**
     * Exact byte length.
     */
    size: number;

    /**
     * Filesystem device identity.
     */
    device: number;

    /**
     * Filesystem inode identity.
     */
    inode: number;

    /**
     * Last modification time in milliseconds.
     */
    modifiedMs: number;

    /**
     * Whether the entry is a regular file.
     */
    regular: boolean;

    /**
     * Whether the entry is a symbolic link.
     */
    symbolicLink: boolean;
}

/**
 * Injectable no-follow filesystem boundary for baseline locking.
 */
export interface BaselineFileSystemPort {
    /**
     * Inspect one path without following its final symbolic link.
     *
     * @param path - Absolute path to inspect.
     * @returns Stable file metadata.
     */
    inspect(path: string): Promise<BaselineFileMetadata>;

    /**
     * Resolve one existing path to its canonical location.
     *
     * @param path - Existing path to resolve.
     * @returns Canonical absolute path.
     */
    realpath(path: string): Promise<string>;

    /**
     * Read one already-size-bounded file through a no-follow descriptor.
     *
     * @param path - Absolute path to read.
     * @param maximumBytes - Maximum accepted bytes.
     * @returns UTF-8 document contents.
     */
    readBounded(path: string, maximumBytes: number): Promise<string>;

    /**
     * Open one no-follow descriptor used for both metadata checks and byte streaming.
     *
     * @param path - Absolute path to open.
     * @returns One owned descriptor boundary.
     */
    openNoFollow(path: string): Promise<OpenedBaselineFile>;
}

/**
 * One no-follow descriptor whose identity remains observable around its exact byte stream.
 */
export interface OpenedBaselineFile {
    /**
     * Inspect the already-open descriptor without resolving its path again.
     *
     * @returns Current descriptor metadata.
     */
    stat(): Promise<BaselineFileMetadata>;

    /**
     * Stream bytes from this exact descriptor.
     *
     * @returns Async byte chunks.
     */
    stream(): AsyncIterable<Uint8Array>;

    /**
     * Close this descriptor.
     *
     * @returns Nothing after the descriptor closes.
     */
    close(): Promise<void>;
}

/**
 * Inspect one path using lstat so final symbolic links remain visible.
 *
 * @param path - Absolute path to inspect.
 * @returns Stable metadata used around streaming.
 */
async function inspectFile(path: string): Promise<BaselineFileMetadata> {
    const metadata = await lstat(path);
    return {
        size: metadata.size,
        device: metadata.dev,
        inode: metadata.ino,
        modifiedMs: metadata.mtimeMs,
        regular: metadata.isFile(),
        symbolicLink: metadata.isSymbolicLink(),
    };
}

/**
 * Read a bounded file from a no-follow descriptor.
 *
 * @param path - Absolute file path.
 * @param maximumBytes - Maximum permitted bytes.
 * @returns UTF-8 contents.
 */
async function readNoFollow(path: string, maximumBytes: number): Promise<string> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const metadata = await handle.stat();
        if (!metadata.isFile() || metadata.size > maximumBytes) {
            throw new Error('bounded file metadata mismatch');
        }
        return (await handle.readFile({ encoding: 'utf8' })).slice(0, maximumBytes + 1);
    } finally {
        await handle.close();
    }
}

/**
 * Open one file through no-follow semantics for descriptor-bound streaming.
 *
 * @param path - Absolute file path.
 * @returns One descriptor exposing fstat before and after its byte stream.
 */
async function openNoFollow(path: string): Promise<OpenedBaselineFile> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let closed = false;
    return {
        stat: async () => {
            const value = await handle.stat();
            return {
                size: value.size,
                device: value.dev,
                inode: value.ino,
                modifiedMs: value.mtimeMs,
                regular: value.isFile(),
                symbolicLink: value.isSymbolicLink(),
            };
        },
        stream: async function* (): AsyncGenerator<Uint8Array> {
            if (closed) {
                throw new Error('baseline descriptor is closed');
            }
            const stream = createReadStream(path, { fd: handle.fd, autoClose: false });
            for await (const chunk of stream) {
                yield typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
            }
        },
        close: async () => {
            if (closed) {
                return;
            }
            closed = true;
            await handle.close();
        },
    };
}

export const nodeBaselineFileSystem: BaselineFileSystemPort = {
    inspect: inspectFile,
    realpath,
    readBounded: readNoFollow,
    openNoFollow,
};

/**
 * Compare preflight and post-stream file identities.
 *
 * @param left - Earlier metadata.
 * @param right - Later metadata.
 * @returns Whether identity, length, and timestamp remain equal.
 */
export function sameMetadata(left: BaselineFileMetadata, right: BaselineFileMetadata): boolean {
    return (
        left.size === right.size &&
        left.device === right.device &&
        left.inode === right.inode &&
        left.modifiedMs === right.modifiedMs &&
        left.regular === right.regular &&
        left.symbolicLink === right.symbolicLink
    );
}

/**
 * Hash a preflight-bounded resource through streaming and reject byte-count drift.
 *
 * @param expectedBytes - Preflight byte count.
 * @param opened - Already-open no-follow descriptor.
 * @returns Lowercase SHA-256 digest or null on byte-count drift.
 */
export async function hashStream(
    expectedBytes: number,
    opened: OpenedBaselineFile,
): Promise<string | null> {
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of opened.stream()) {
        bytes += chunk.byteLength;
        if (bytes > expectedBytes) {
            return null;
        }
        hash.update(chunk);
    }
    return bytes === expectedBytes ? hash.digest('hex') : null;
}
