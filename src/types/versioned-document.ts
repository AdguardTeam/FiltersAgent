import * as v from 'valibot';

/**
 * Reading one persisted document whose shape is chosen by the `schemaVersion` it declares itself.
 *
 * Every artifact this project versions on disk — the run usage summary, the locked run manifest —
 * needs the same three steps: take the version tag before assuming any shape, parse against the one
 * schema that version selects, and refuse an unknown version by number instead of reporting a
 * shapeless parse error. Written once here so a second versioned artifact inherits the behaviour
 * rather than restating it, and so every refusal reads the same way in a failed verification.
 */

/**
 * Envelope every versioned document shares: the version tag alone, read before any shape is
 * assumed. `v.unknown()` on purpose — a non-numeric or absent tag must reach the typed rejection
 * rather than fail as a shape error.
 */
const VersionedDocumentEnvelopeSchema = v.object({ schemaVersion: v.unknown() });

/**
 * Rejection of a persisted document whose declared version this build has no reader for.
 *
 * Names the artifact and the exact `schemaVersion` found: a document written by a different build
 * must fail loudly and identifiably, never be coerced into the shape this build happens to expect,
 * and the operator reading the failure has to be told which artifact and which format it was.
 */
export class UnsupportedArtifactVersionError extends Error {
    /**
     * Create a rejection naming the artifact and the refused version.
     *
     * @param artifact - Human-readable name of the versioned artifact, capitalized for the message.
     * @param version - The persisted `schemaVersion` value, or undefined when the document carried
     *   none at all.
     * @param supported - Versions the refusing reader accepts.
     */
    constructor(
        readonly artifact: string,
        readonly version: unknown,
        readonly supported: readonly number[],
    ) {
        super(
            `${artifact} schemaVersion ${JSON.stringify(version) ?? 'undefined'} cannot be read ` +
                `here; supported: ${supported.join(', ')}.`,
        );
        this.name = 'UnsupportedArtifactVersionError';
    }
}

/**
 * One versioned artifact's complete reader: what to call it, and the schema each version selects.
 */
export interface VersionedDocumentReader<TSchema extends v.GenericSchema> {
    /**
     * Human-readable artifact name opening the rejection message (e.g. `Locked run manifest`).
     */
    artifact: string;

    /**
     * Schema per persisted version. Total over the versions this build reads: a version absent here
     * is refused by number, which is what makes a rollout over an older or newer evidence tree fail
     * identifiably instead of silently misreading it.
     */
    schemas: Readonly<Record<number, TSchema>>;
}

/**
 * Parse one persisted document against the schema its own declared version selects.
 *
 * @param value - Decoded JSON read from the versioned artifact.
 * @param reader - Artifact name and the schema each readable version selects.
 * @returns The parsed document, typed as the union of the reader's schemas.
 * @throws UnsupportedArtifactVersionError When the document declares no version the reader knows.
 */
export function readVersionedDocument<TSchema extends v.GenericSchema>(
    value: unknown,
    reader: VersionedDocumentReader<TSchema>,
): v.InferOutput<TSchema> {
    const envelope = v.safeParse(VersionedDocumentEnvelopeSchema, value);
    const version = envelope.success ? envelope.output.schemaVersion : undefined;
    const schema = typeof version === 'number' ? reader.schemas[version] : undefined;
    if (schema === undefined) {
        throw new UnsupportedArtifactVersionError(
            reader.artifact,
            version,
            Object.keys(reader.schemas).map(Number),
        );
    }
    return v.parse(schema, value) as v.InferOutput<TSchema>;
}
