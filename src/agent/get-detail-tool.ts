/**
 * The `get_detail` tool: the byte-bounded window onto a persisted artifact, so a large tool result
 * (DOM, HAR, ad-slot facts, evaluate_js payload) can be inspected in slices instead of being pasted
 * back into the session whole.
 */
import type { IArtifactStore } from '../tracer/artifact-store';
import { registeredParameters } from './registered-parameters';
import { ToolName } from './tool-names';
import type { ToolRegistry } from './tool-registry';
import { truncateUtf8 } from './truncate-utf8';

/**
 * Maximum byte size of a model-facing detail response.
 */
const MAX_MODEL_DETAIL_BYTES = 6 * 1024;

/**
 * Register the `get_detail` tool against an artifact store.
 *
 * @param registry - Registry receiving the tool.
 * @param artifactStore - Store the persisted artifacts are read back from.
 */
export function registerGetDetailTool(registry: ToolRegistry, artifactStore: IArtifactStore): void {
    registry.register({
        definition: {
            type: 'function',
            function: {
                name: ToolName.GetDetail,
                description:
                    'Retrieve a byte-bounded filtered slice of a persisted artifact by ID. Use this to inspect large tool results (DOM, HAR, ad-slot facts, evaluate_js results) that were stored as referenced artifacts. Narrow key and limit before requesting detail.',
                parameters: registeredParameters(ToolName.GetDetail),
            },
        },
        handler: async (args) => {
            const artifactId = typeof args.artifactId === 'string' ? args.artifactId : '';
            if (artifactId.length === 0) {
                return { error: 'Invalid input: artifactId must be a non-empty string' };
            }

            const filter =
                typeof args.filter === 'object' && args.filter !== null
                    ? (args.filter as Record<string, unknown>)
                    : {};

            const key = typeof filter.key === 'string' ? filter.key : undefined;
            const limit =
                typeof filter.limit === 'number' &&
                Number.isFinite(filter.limit) &&
                filter.limit >= 0
                    ? filter.limit
                    : undefined;

            const content = artifactStore.read(artifactId);
            if (content === undefined) {
                return { error: `Artifact not found: ${artifactId}` };
            }

            if (key !== undefined || limit !== undefined) {
                const filtered = artifactStore.getFiltered(artifactId, { key, limit });
                return {
                    artifactId,
                    filtered: true,
                    content:
                        filtered === undefined
                            ? undefined
                            : truncateUtf8(filtered, MAX_MODEL_DETAIL_BYTES),
                    ...(filtered !== undefined &&
                    Buffer.byteLength(filtered) > MAX_MODEL_DETAIL_BYTES
                        ? {
                              truncated: true,
                              totalBytes: Buffer.byteLength(filtered),
                              metaHint:
                                  'Detail is still too large. Use a narrower key or smaller limit.',
                          }
                        : {}),
                };
            }

            return {
                artifactId,
                filtered: false,
                content: truncateUtf8(content, MAX_MODEL_DETAIL_BYTES),
                ...(Buffer.byteLength(content) > MAX_MODEL_DETAIL_BYTES
                    ? {
                          truncated: true,
                          totalBytes: Buffer.byteLength(content),
                          metaHint:
                              'Detail is still too large. Use key or limit to retrieve a bounded slice.',
                      }
                    : {}),
            };
        },
    });
}
