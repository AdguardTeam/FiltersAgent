import { readFileSync, statfsSync } from 'node:fs';

/**
 * Best-effort resource facts of the host a browser is about to launch on.
 *
 * Strict-route launch crashes clustered with parallel CI job matrices, so every launch records the
 * constraints a container tightens without telling anyone: the fd limit, the `/dev/shm` size, and
 * the memory headroom. Every field is optional — the snapshot must never break a launch, and on
 * non-Linux hosts the proc files simply do not exist.
 */
export interface LaunchResourceSnapshot {
    /**
     * Soft RLIMIT_NOFILE of the launching process, when readable.
     */
    nofileSoftLimit?: number;

    /**
     * Hard RLIMIT_NOFILE of the launching process, when readable.
     */
    nofileHardLimit?: number;

    /**
     * Total bytes of the `/dev/shm` mount, when readable.
     */
    devShmBytes?: number;

    /**
     * Kernel-reported available memory in bytes, when readable.
     */
    memAvailableBytes?: number;
}

/**
 * Total capacity facts of one mounted filesystem.
 */
export interface FilesystemCapacity {
    /**
     * Filesystem block size in bytes.
     */
    blockSize: number;

    /**
     * Total block count.
     */
    blocks: number;
}

/**
 * Injectable OS seams so tests can pin exact proc-file contents.
 */
export interface LaunchResourceSnapshotDeps {
    /**
     * Read a proc file as text.
     *
     * @param path - Absolute proc file path.
     * @returns File contents.
     */
    readText?(path: string): string;

    /**
     * Stat a filesystem for total size.
     *
     * @param path - Any path on the mounted filesystem.
     * @returns Block size and block count.
     */
    statFs?(path: string): FilesystemCapacity;
}

/**
 * Parse one numeric limit column, tolerating the `unlimited` keyword.
 *
 * @param value - Raw soft or hard column from `/proc/self/limits`.
 * @returns The parsed limit, or undefined when unlimited or malformed.
 */
function parseLimit(value: string | undefined): number | undefined {
    if (value === undefined || value === 'unlimited') {
        return undefined;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Read a proc file as UTF-8 text.
 *
 * @param path - Absolute proc file path.
 * @returns File contents.
 */
function readProcText(path: string): string {
    return readFileSync(path, 'utf8');
}

/**
 * Stat a filesystem for its total capacity.
 *
 * @param path - Any path on the mounted filesystem.
 * @returns Block size and block count.
 */
function statFilesystem(path: string): FilesystemCapacity {
    const stats = statfsSync(path);
    return { blockSize: stats.bsize, blocks: stats.blocks };
}

/**
 * Capture the launch-host resource snapshot, omitting anything unreadable.
 *
 * @param deps - Optional OS seams for tests.
 * @returns Populated fields only; empty object on hosts without procfs.
 */
export function readLaunchResourceSnapshot(
    deps: LaunchResourceSnapshotDeps = {},
): LaunchResourceSnapshot {
    const readText = deps.readText ?? readProcText;
    const statFs = deps.statFs ?? statFilesystem;
    const snapshot: LaunchResourceSnapshot = {};
    try {
        const limitsLine = readText('/proc/self/limits')
            .split('\n')
            .find((line) => line.startsWith('Max open files'));
        const columns = limitsLine?.split(/\s+/u);
        const soft = parseLimit(columns?.[3]);
        const hard = parseLimit(columns?.[4]);
        if (soft !== undefined) {
            snapshot.nofileSoftLimit = soft;
        }
        if (hard !== undefined) {
            snapshot.nofileHardLimit = hard;
        }
    } catch {
        // No procfs on this host — the field set simply stays smaller.
    }
    try {
        const memLine = readText('/proc/meminfo')
            .split('\n')
            .find((line) => line.startsWith('MemAvailable:'));
        const kib = memLine ? Number(memLine.split(/\s+/u)[1]) : Number.NaN;
        if (Number.isFinite(kib)) {
            snapshot.memAvailableBytes = kib * 1024;
        }
    } catch {
        // Same contract: an unreadable source omits its field.
    }
    try {
        const shm = statFs('/dev/shm');
        snapshot.devShmBytes = shm.blockSize * shm.blocks;
    } catch {
        // No /dev/shm mount (macOS, some containers) — omitted.
    }
    return snapshot;
}
