import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import * as v from 'valibot';
import {
    LocalRunArtifactDigestSchema,
    collectEvidenceDigests,
    readImmutableFile,
    sha256Bytes,
    sha256Text,
} from './run-artifact-digest';
import { readRunUsageSummary } from '../types/usage-summary';
import { readVersionedDocument } from '../types/versioned-document';
import { LOCAL_RUN_OUTPUT_MARKER_NAME } from './output-directory';

/**
 * The digest-bound lock of one local fix-agent run directory: its versioned manifest schema, the
 * artifact digest helpers that build it, and the verifier that re-proves a locked run from disk.
 *
 * One version is readable: the one this build writes. A version-2 directory, locked by an earlier
 * build, binds a per-attempt `llm-usage.jsonl` ledger and a ledger-shaped summary this build does
 * not write, so it is refused by number rather than half-verified against an artifact set this
 * build cannot produce.
 */

/**
 * Canonical file name of the aggregate usage summary bound by every locked run version.
 */
export const LLM_USAGE_SUMMARY_FILE_NAME = 'llm-usage-summary.json';

/**
 * Canonical file name of the lock manifest itself.
 */
export const LOCAL_RUN_MANIFEST_FILE_NAME = 'agent-run-manifest.json';

/**
 * Persisted `schemaVersion` of a locked run manifest.
 *
 * A version names one exact artifact set, because that set is what verification re-proves. Version
 * 3 drops a bound artifact (`llm-usage.jsonl`) and changes the meaning of another, so it has its
 * own number: a build reading only version 2 must reject a version 3 run outright rather than
 * verify a manifest whose missing ledger it cannot notice, and this build rejects a version 2 run
 * for the mirror-image reason.
 */
export const LocalRunManifestVersion = {
    /**
     * Usage-summary era: no attempt ledger; `llm-usage-summary.json` holds the pi-sourced Usage
     * Summary (usage-summary version 2). The only version written or verified here.
     */
    UsageSummary: 3,
} as const;

/**
 * Every locked run manifest version, for diagnostics and exhaustive listings.
 */
export const LOCAL_RUN_MANIFEST_VERSION_VALUES = Object.values(LocalRunManifestVersion);

/**
 * LocalRunManifestVersion value.
 */
export type LocalRunManifestVersion =
    (typeof LocalRunManifestVersion)[keyof typeof LocalRunManifestVersion];

/**
 * Canonical artifacts bound by every locked run version, in the exact key order both writers
 * serialized them in. The order is load-bearing: the run identifier is the digest of this object as
 * JSON, so re-serializing a parsed manifest in a different order would fail an old run's identity
 * check.
 */
const LOCKED_RUN_COMMON_ARTIFACT_ENTRIES = {
    agentDecision: v.nullable(LocalRunArtifactDigestSchema),
    agentObservations: LocalRunArtifactDigestSchema,
    agentReport: LocalRunArtifactDigestSchema,
    runResult: LocalRunArtifactDigestSchema,
    candidatePatch: v.nullable(LocalRunArtifactDigestSchema),
};

/**
 * Recursive browser and diagnostic evidence digests, constrained to the run's own subtree.
 */
const LockedRunEvidenceSchema = v.array(
    v.pipe(
        LocalRunArtifactDigestSchema,
        v.check(
            (digest) =>
                digest.path.startsWith('artifacts/') &&
                !isAbsolute(digest.path) &&
                !digest.path.includes('\\') &&
                !digest.path.split('/').includes('..'),
            'Locked evidence paths must stay under artifacts/.',
        ),
    ),
);

/**
 * Content-addressed run identifier shared by both manifest versions.
 */
const LockedRunIdSchema = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u));

export const UsageSummaryLocalRunManifestSchema = v.object({
    schemaVersion: v.literal(LocalRunManifestVersion.UsageSummary),
    runId: LockedRunIdSchema,
    artifacts: v.object({
        ...LOCKED_RUN_COMMON_ARTIFACT_ENTRIES,
        llmUsageSummary: LocalRunArtifactDigestSchema,
    }),
    evidence: LockedRunEvidenceSchema,
});

/**
 * Digest-bound lock written after every canonical fix-agent artifact is durable, and the only lock
 * shape this build reads.
 */
export type LocalRunManifest = v.InferOutput<typeof UsageSummaryLocalRunManifestSchema>;

/**
 * Artifact name opening every rejection of a locked manifest this build cannot verify.
 */
const LOCAL_RUN_MANIFEST_ARTIFACT = 'Locked run manifest';

/**
 * Top-level names a locked run directory may contain. Anything else — the version-2
 * `llm-usage.jsonl` included — is a foreign artifact in a run this build locked.
 */
const LOCKED_RUN_TOP_LEVEL_PATHS: ReadonlySet<string> = new Set([
    LOCAL_RUN_OUTPUT_MARKER_NAME,
    'agent-decision.json',
    'agent-observations.json',
    'agent-report.md',
    LOCAL_RUN_MANIFEST_FILE_NAME,
    'artifacts',
    'candidate.patch',
    LLM_USAGE_SUMMARY_FILE_NAME,
    'run-result.json',
]);

/**
 * Parse one locked run manifest against the schema its declared version selects.
 *
 * @param value - Decoded JSON read from a run manifest artifact.
 * @returns The parsed manifest.
 * @throws UnsupportedArtifactVersionError When the manifest declares any other version, the
 *   ledger-shaped version 2 included.
 */
export function parseLocalRunManifest(value: unknown): LocalRunManifest {
    return readVersionedDocument(value, {
        artifact: LOCAL_RUN_MANIFEST_ARTIFACT,
        schemas: {
            [LocalRunManifestVersion.UsageSummary]: UsageSummaryLocalRunManifestSchema,
        },
    });
}

/**
 * Derive a stable run identifier from the complete artifact digest set.
 *
 * @param artifacts - Canonical text artifact digests included in the run.
 * @param evidence - Recursive browser and diagnostic evidence digests included in the run.
 * @returns Content-addressed run identifier.
 */
export function createRunId(
    artifacts: LocalRunManifest['artifacts'],
    evidence: LocalRunManifest['evidence'],
): string {
    return sha256Text(JSON.stringify({ artifacts, evidence }));
}

/**
 * Verify one digest-bound artifact against its exact on-disk bytes.
 *
 * @param outputPath - Absolute run output directory.
 * @param expectedPath - Required canonical file name.
 * @param digest - Manifest entry to verify.
 */
function verifyArtifactDigest(
    outputPath: string,
    expectedPath: string,
    digest: v.InferOutput<typeof LocalRunArtifactDigestSchema>,
): void {
    if (digest.path !== expectedPath) {
        throw new Error(`Run manifest path mismatch for ${expectedPath}.`);
    }
    const content = readImmutableFile(join(outputPath, expectedPath), expectedPath);
    if (digest.sha256 !== sha256Bytes(content) || digest.bytes !== content.byteLength) {
        throw new Error(`Run artifact digest mismatch for ${expectedPath}.`);
    }
}

/**
 * Verify the usage accounting a locked run binds: the pi-sourced Usage Summary, proven by digest
 * and then read in the one shape this build interprets.
 *
 * A summary in the version-2 ledger shape under a current manifest is a mixed pair — a forged or
 * hand-edited run — and reaches the caller as the typed version rejection naming it, never as a
 * half-verified run.
 *
 * @param outputPath - Canonical locked run directory.
 * @param manifest - Parsed manifest of the run.
 */
function verifyLockedUsageAccounting(outputPath: string, manifest: LocalRunManifest): void {
    verifyArtifactDigest(
        outputPath,
        LLM_USAGE_SUMMARY_FILE_NAME,
        manifest.artifacts.llmUsageSummary,
    );
    const summaryBytes = readImmutableFile(
        join(outputPath, LLM_USAGE_SUMMARY_FILE_NAME),
        LLM_USAGE_SUMMARY_FILE_NAME,
    );
    let decodedSummary: unknown;
    try {
        decodedSummary = JSON.parse(summaryBytes.toString('utf8'));
    } catch (error) {
        throw new Error(`Cannot parse locked run usage summary: ${(error as Error).message}`, {
            cause: error,
        });
    }
    // Deliberately unwrapped: an unreadable version must reach the caller as the typed
    // UnsupportedArtifactVersionError naming it, not as a generic verification failure.
    readRunUsageSummary(decodedSummary);
}

/**
 * Validate the final manifest and every canonical fix-agent artifact it binds.
 *
 * @param outputPath - Absolute completed run directory.
 * @returns Schema-validated, content-addressed run manifest.
 */
export function verifyLocalRunManifest(outputPath: string): LocalRunManifest {
    const canonicalOutputPath = realpathSync(outputPath);
    const outputStats = lstatSync(canonicalOutputPath);
    if (!outputStats.isDirectory() || outputStats.isSymbolicLink()) {
        throw new Error('Locked fix-agent run path must be a regular directory.');
    }
    const manifestPath = join(canonicalOutputPath, LOCAL_RUN_MANIFEST_FILE_NAME);
    let serializedManifest: unknown;
    try {
        serializedManifest = JSON.parse(
            readImmutableFile(manifestPath, LOCAL_RUN_MANIFEST_FILE_NAME).toString('utf8'),
        );
    } catch (error) {
        throw new Error(`Cannot parse locked run manifest: ${(error as Error).message}`, {
            cause: error,
        });
    }
    const manifest = parseLocalRunManifest(serializedManifest);
    verifyArtifactDigest(
        canonicalOutputPath,
        'agent-observations.json',
        manifest.artifacts.agentObservations,
    );
    verifyArtifactDigest(canonicalOutputPath, 'agent-report.md', manifest.artifacts.agentReport);
    verifyArtifactDigest(canonicalOutputPath, 'run-result.json', manifest.artifacts.runResult);
    verifyLockedUsageAccounting(canonicalOutputPath, manifest);
    if (manifest.artifacts.agentDecision) {
        verifyArtifactDigest(
            canonicalOutputPath,
            'agent-decision.json',
            manifest.artifacts.agentDecision,
        );
    } else if (existsSync(join(canonicalOutputPath, 'agent-decision.json'))) {
        throw new Error('Run manifest omits an existing agent-decision.json artifact.');
    }
    if (manifest.artifacts.candidatePatch) {
        verifyArtifactDigest(
            canonicalOutputPath,
            'candidate.patch',
            manifest.artifacts.candidatePatch,
        );
    } else if (existsSync(join(canonicalOutputPath, 'candidate.patch'))) {
        throw new Error('Run manifest omits an existing candidate.patch artifact.');
    }
    const evidence = collectEvidenceDigests(canonicalOutputPath);
    if (JSON.stringify(evidence) !== JSON.stringify(manifest.evidence)) {
        throw new Error('Run evidence digest set does not match the locked manifest.');
    }
    if (manifest.runId !== createRunId(manifest.artifacts, manifest.evidence)) {
        throw new Error('Run manifest identifier does not match its artifact digests.');
    }
    for (const entry of readdirSync(canonicalOutputPath, { withFileTypes: true })) {
        if (!LOCKED_RUN_TOP_LEVEL_PATHS.has(entry.name)) {
            throw new Error(`Locked fix-agent run contains foreign artifact: ${entry.name}.`);
        }
        if (entry.name === 'artifacts' ? !entry.isDirectory() : !entry.isFile()) {
            throw new Error(`Locked fix-agent run contains an invalid path type: ${entry.name}.`);
        }
    }
    return manifest;
}
