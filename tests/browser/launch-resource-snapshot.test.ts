import { describe, expect, it } from 'vitest';
import { readLaunchResourceSnapshot } from '../../src/browser/launch-resource-snapshot';

const LIMITS = [
    'Limit                     Soft Limit           Hard Limit           Units',
    'Max cpu time              unlimited            unlimited            seconds',
    'Max open files            1024                 4096                 files',
    'Max processes             unlimited            unlimited            processes',
].join('\n');

const MEMINFO = [
    'MemTotal:       65536000 kB',
    'MemFree:         1024000 kB',
    'MemAvailable:   32544256 kB',
].join('\n');

describe('readLaunchResourceSnapshot', () => {
    it('reads the fd limit, /dev/shm size, and available memory of the launch host', () => {
        const snapshot = readLaunchResourceSnapshot({
            readText: (path) => {
                if (path === '/proc/self/limits') {
                    return LIMITS;
                }
                if (path === '/proc/meminfo') {
                    return MEMINFO;
                }
                throw new Error('ENOENT');
            },
            statFs: (path) => {
                if (path === '/dev/shm') {
                    return { blockSize: 4096, blocks: 16384 };
                }
                throw new Error('ENOENT');
            },
        });

        expect(snapshot).toEqual({
            nofileSoftLimit: 1024,
            nofileHardLimit: 4096,
            devShmBytes: 4096 * 16384,
            memAvailableBytes: 32544256 * 1024,
        });
    });

    it('omits fields whose source is unreadable, as on macOS runners', () => {
        const snapshot = readLaunchResourceSnapshot({
            readText: () => {
                throw new Error('ENOENT');
            },
            statFs: () => {
                throw new Error('ENOENT');
            },
        });

        expect(snapshot).toEqual({});
    });

    it('omits an unlimited fd limit instead of inventing a number', () => {
        const snapshot = readLaunchResourceSnapshot({
            readText: (path) => {
                if (path === '/proc/self/limits') {
                    return 'Max open files            unlimited            unlimited            files';
                }
                throw new Error('ENOENT');
            },
            statFs: () => {
                throw new Error('ENOENT');
            },
        });

        expect(snapshot).toEqual({});
        expect(snapshot).not.toHaveProperty('nofileSoftLimit');
    });
});
