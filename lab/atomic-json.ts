import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Restrict locally generated evaluation artifacts to their owner.
 */
const PRIVATE_JSON_FILE_MODE = 0o600;

/**
 * Persist a complete JSON artifact by replacing its destination atomically.
 *
 * @param destination - Absolute or relative destination file, whose parent is created if needed.
 * @param value - Trusted JSON-serializable artifact to persist.
 * @returns Nothing after replacing the destination and removing any temporary file.
 */
export function writeAtomicJson(destination: string, value: unknown): void {
    mkdirSync(dirname(destination), { recursive: true });
    const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
    try {
        writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
            encoding: 'utf8',
            mode: PRIVATE_JSON_FILE_MODE,
        });
        renameSync(temporary, destination);
    } finally {
        rmSync(temporary, { force: true });
    }
}
