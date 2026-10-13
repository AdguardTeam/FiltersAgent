import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ArtifactRef } from '../types/trace';
import type { TraceRecorder } from './trace-recorder';

/**
 * Filter criteria for {@link IArtifactStore.getFiltered}.
 */
export interface ArtifactFilter {
    /**
     * A dot-separated key path to extract from a JSON artifact (e.g. `events.0.type`).
     */
    key?: string;

    /**
     * Maximum number of items or lines to return from an array or text artifact.
     */
    limit?: number;
}

/**
 * Abstract artifact storage for large tool-result blobs.
 *
 * Artifacts are persisted by id and referenced by {@link ArtifactRef} in trace events, never inlined
 * into the LLM context.
 */
export interface IArtifactStore {
    /**
     * Persist content and return an artifact reference suitable for trace registration.
     *
     * @param content - The raw content to store.
     * @param type - The artifact type (e.g. `dom`, `har`, `tool_result`).
     * @returns The artifact reference with generated id, path, type, and byte count.
     */
    write(content: string, type: string): ArtifactRef;

    /**
     * Read the full content of a stored artifact.
     *
     * @param id - The artifact id.
     * @returns The stored content, or `undefined` if not found.
     */
    read(id: string): string | undefined;

    /**
     * Return a filtered slice of a stored artifact.
     *
     * If the artifact is JSON, `filter.key` resolves a dot-separated path (e.g. `events`).
     * `filter.limit` truncates arrays to the first N elements or text to the first N lines. When
     * both are provided, the key is resolved first, then the limit is applied to the extracted
     * value.
     *
     * @param id - The artifact id.
     * @param filter - The filter criteria.
     * @returns The filtered content as a string, or `undefined` if the artifact is not found.
     */
    getFiltered(id: string, filter: ArtifactFilter): string | undefined;
}

/**
 * Resolve a bounded key-path and item limit against one serialized artifact.
 *
 * @param content - Raw artifact content.
 * @param filter - Optional JSON key-path and item/line limit.
 * @returns Filtered content, or undefined when the requested key does not exist.
 */
function filterArtifactContent(content: string, filter: ArtifactFilter): string | undefined {
    let value: unknown = content;

    if (filter.key) {
        try {
            value = JSON.parse(content);
        } catch {
            return filter.key === '' ? content : undefined;
        }

        const parts = filter.key.split('.');
        for (const part of parts) {
            if (value === null || value === undefined) {
                return undefined;
            }
            if (Array.isArray(value)) {
                const index = Number(part);
                if (Number.isInteger(index) && index >= 0 && index < value.length) {
                    value = value[index];
                } else {
                    return undefined;
                }
            } else if (typeof value === 'object') {
                value = (value as Record<string, unknown>)[part];
            } else {
                return undefined;
            }
        }
    } else {
        try {
            value = JSON.parse(content);
        } catch {
            // The original string is the useful value for a non-JSON artifact.
        }
    }

    if (filter.limit !== undefined) {
        if (Array.isArray(value) && filter.limit < value.length) {
            return JSON.stringify(value.slice(0, filter.limit));
        }
        if (typeof value === 'string') {
            const lines = value.split('\n');
            if (lines.length > filter.limit) {
                return lines.slice(0, filter.limit).join('\n');
            }
        }
    }

    if (typeof value === 'string') {
        return value;
    }
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
        return String(value);
    }
    return JSON.stringify(value);
}

/**
 * A stored artifact entry in memory.
 */
interface StoredEntry {
    /**
     * The raw artifact content.
     */
    content: string;

    /**
     * The artifact type (e.g. `dom`, `har`, `tool_result`).
     */
    type: string;
}

/**
 * In-memory artifact store.
 *
 * Stores artifacts as strings keyed by id. Suitable for single-run usage where persistence across
 * process restarts is not required. Can be swapped for a disk-backed implementation without
 * changing the {@link IArtifactStore} contract.
 */
export class ArtifactStore implements IArtifactStore {
    /**
     * In-memory storage mapping artifact ids to their entries.
     */
    private readonly storage: Map<string, StoredEntry> = new Map();

    /**
     * Persist content and return an artifact reference.
     *
     * @param content - The raw content to store.
     * @param type - The artifact type (e.g. `dom`, `har`, `tool_result`).
     * @returns The artifact reference.
     */
    write(content: string, type: string): ArtifactRef {
        const id = randomUUID();
        this.storage.set(id, { content, type });
        return {
            id,
            path: `artifact://${id}`,
            type,
            bytes: Buffer.byteLength(content),
        };
    }

    /**
     * Read the full content of a stored artifact.
     *
     * @param id - The artifact id.
     * @returns The stored content, or `undefined` if not found.
     */
    read(id: string): string | undefined {
        return this.storage.get(id)?.content;
    }

    /**
     * Return a filtered slice of a stored artifact.
     *
     * If the artifact is JSON, `filter.key` resolves a dot-separated path (e.g. `events`).
     * `filter.limit` truncates arrays to the first N elements or text to the first N lines. When
     * both are provided, the key is resolved first, then the limit is applied to the extracted
     * value.
     *
     * @param id - The artifact id.
     * @param filter - The filter criteria.
     * @returns The filtered content as a string, or `undefined` if the artifact is not found.
     */
    getFiltered(id: string, filter: ArtifactFilter): string | undefined {
        const entry = this.storage.get(id);
        if (!entry) {
            return undefined;
        }
        return filterArtifactContent(entry.content, filter);
    }
}

/**
 * Disk-backed artifact store that exposes only artifacts already registered by one trace.
 *
 * It lets model-facing summaries refer to complete browser and repository evidence through
 * `get_detail` while retaining the same append-only artifact provenance used by the run trace.
 */
export class TraceArtifactStore implements IArtifactStore {
    /**
     * Construct a store rooted in the run's artifact directory.
     *
     * @param artifactsDir - Directory in which new serialized tool-result artifacts are written.
     * @param recorder - Recorder that owns the allowlisted readable artifact identities.
     */
    constructor(
        private readonly artifactsDir: string,
        private readonly recorder: TraceRecorder,
    ) {}

    /**
     * Persist one serialized tool result and register it in the trace.
     *
     * @param content - Raw serialized content to preserve.
     * @param type - Trace artifact type.
     * @returns Registered artifact reference.
     */
    write(content: string, type: string): ArtifactRef {
        mkdirSync(this.artifactsDir, { recursive: true });
        const id = randomUUID();
        const path = join(this.artifactsDir, `${id}.json`);
        writeFileSync(path, content);
        const artifact: ArtifactRef = {
            id,
            path,
            type,
            bytes: Buffer.byteLength(content),
        };
        this.recorder.addArtifact(artifact);
        return artifact;
    }

    /**
     * Read one trace-registered artifact by opaque identity.
     *
     * @param id - Registered artifact identifier.
     * @returns Artifact content, or undefined for an unknown or unavailable artifact.
     */
    read(id: string): string | undefined {
        const artifact = this.recorder.getArtifacts().find((candidate) => candidate.id === id);
        if (!artifact || !existsSync(artifact.path)) {
            return undefined;
        }
        return readFileSync(artifact.path, 'utf8');
    }

    /**
     * Read a filtered slice from one trace-registered artifact.
     *
     * @param id - Registered artifact identifier.
     * @param filter - Optional JSON key-path and item/line limit.
     * @returns Filtered content, or undefined when the artifact or key is unavailable.
     */
    getFiltered(id: string, filter: ArtifactFilter): string | undefined {
        const content = this.read(id);
        return content === undefined ? undefined : filterArtifactContent(content, filter);
    }
}
