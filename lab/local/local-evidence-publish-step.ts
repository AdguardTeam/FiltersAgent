/**
 * The publication step of a local run: the private raw evidence collection the run writes into, its
 * ownership-proved removal, and the append-only publication that turns a verified result into an
 * immutable consumer-visible generation.
 *
 * Kept apart from the runner because it is plain functions over the run's already-locked record and
 * paths — nothing here reads or advances run state.
 */
import {
    existsSync,
    lstatSync as inspectPrivateCollectionPathWithoutFollowingLinks,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { bindReviewCandidate } from '../../src/repo/repository-edit';
import type { AgentRunArtifacts } from '../../src/types/agent-run-artifacts';
import type { RunUsageSummary } from '../../src/types/usage-summary';
import {
    publishLocalRun,
    writeLocalPublicationSanitizationFailure,
    type LocalPublicationOutcome,
} from '../../src/local/evidence-publication';
import { buildCandidateScreenshotCaptures } from './candidate-screenshot-captures';
import { LocalPublicationTrustError } from '../../src/local/local-publication-trust';
import { verifyLocalPublication } from '../../src/local/local-publication-verifier';
import type { PreparedFiltersCheckout } from '../../src/local/filters-preparer';
import type { VerifiedIssueRevision } from '../../src/local/issue-revision';
import type { LocalRunOutputPaths, LocalRunRecord } from '../../src/local/run-output';

/**
 * One private runner-owned raw collection kept outside consumer-visible generations.
 */
export interface PrivateEvidenceCollection {
    /**
     * Exact ownership root retained on trust failure.
     */
    root: string;

    /**
     * Raw working directory supplied to input and core artifact writers.
     */
    workDir: string;

    /**
     * Exact ownership marker content.
     */
    marker: string;
}

/**
 * Create one exclusive private raw collection beneath the owned output root.
 *
 * @param outputDir - Canonical owned local output root.
 * @param idSource - Host UUID source.
 * @returns Exclusive private collection paths and marker.
 */
export function createPrivateEvidenceCollection(
    outputDir: string,
    idSource: () => string,
): PrivateEvidenceCollection {
    const id = idSource();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(id)) {
        throw new Error('Generated private collection ID must be a lowercase RFC 4122 UUID.');
    }
    const collectionsRoot = join(outputDir, 'collections');
    mkdirSync(collectionsRoot, { recursive: true, mode: 0o700 });
    const root = join(collectionsRoot, id);
    mkdirSync(root, { mode: 0o700 });
    const marker = `adguard-filters-agent private collection ${id}\n`;
    writeFileSync(join(root, '.collection-owner'), marker, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
    });
    const workDir = join(root, 'raw');
    mkdirSync(workDir, { mode: 0o700 });
    return { root, workDir, marker };
}

/**
 * Remove one exact private collection only after proving its ownership marker and shape.
 *
 * @param collection - Exact Host-issued collection paths and marker.
 */
export function removePrivateEvidenceCollection(collection: PrivateEvidenceCollection): void {
    if (!existsSync(collection.root)) {
        return;
    }
    const rootStats = inspectPrivateCollectionPathWithoutFollowingLinks(collection.root);
    const markerPath = join(collection.root, '.collection-owner');
    const markerStats = inspectPrivateCollectionPathWithoutFollowingLinks(markerPath);
    if (
        !rootStats.isDirectory() ||
        rootStats.isSymbolicLink() ||
        !markerStats.isFile() ||
        markerStats.isSymbolicLink() ||
        markerStats.nlink !== 1 ||
        readFileSync(markerPath, 'utf8') !== collection.marker
    ) {
        throw new Error('Private evidence collection ownership proof is invalid.');
    }
    rmSync(collection.root, { recursive: true, force: false });
}

/**
 * Convert an append-only publication result to the established local-cycle path contract.
 *
 * @param publication - Verified durable local publication.
 * @returns Compatibility paths all pointing into the immutable generation.
 */
function publicationOutputPaths(publication: LocalPublicationOutcome): LocalRunOutputPaths {
    const generation = publication.paths.generationPath;
    return {
        agentReportPath: publication.paths.reportPath,
        agentDecisionPath: null,
        agentObservationsPath: join(generation, 'agent-run-artifacts.json'),
        runResultPath: join(generation, 'run-result.json'),
        manifestPath: publication.paths.manifestPath,
        candidatePatchPath: publication.paths.candidatePatchPath,
        llmUsageSummaryPath: join(generation, 'llm-usage.json'),
    };
}

/**
 * Publish one verified-revision result while its exact prepared source remains available.
 *
 * @param revision - Opaque verified issue revision.
 * @param record - Canonical immutable local run record.
 * @param source - Exact prepared AdguardFilters source used by the run.
 * @param collection - Private raw evidence collection owned by this invocation.
 * @param outputDir - Canonical append-only publication root.
 * @param agentRunArtifacts - Captured model decision and observations.
 * @param llmUsage - Complete provider usage summary.
 * @param configuredSecrets - Exact Host-only secrets removed before publication.
 * @param publisher - Injectable append-only publisher.
 * @returns Compatibility paths into the verified immutable generation.
 */
export function publishVerifiedLocalResult(
    revision: VerifiedIssueRevision,
    record: LocalRunRecord,
    source: PreparedFiltersCheckout,
    collection: PrivateEvidenceCollection,
    outputDir: string,
    agentRunArtifacts: AgentRunArtifacts,
    llmUsage: RunUsageSummary,
    configuredSecrets: readonly string[],
    publisher: typeof publishLocalRun,
): LocalRunOutputPaths {
    const candidateBinding = bindReviewCandidate(record.result.candidatePatch, source, record);
    const collectionDir = join(collection.workDir, 'artifacts');
    const trustedCaptures = buildCandidateScreenshotCaptures(
        record.result.artifactPaths.verifiedCandidateScreenshots,
        collectionDir,
    );
    let publication: LocalPublicationOutcome;
    try {
        publication = publisher({
            revision,
            record,
            source,
            candidateBinding,
            collectionDir,
            trustedCaptures,
            outputRoot: outputDir,
            agentRunArtifacts,
            llmUsage,
            configuredSecrets,
        });
    } catch (error) {
        if (
            error instanceof LocalPublicationTrustError &&
            (error.code === 'redaction_failed' || error.code === 'residual_secret')
        ) {
            removePrivateEvidenceCollection(collection);
            writeLocalPublicationSanitizationFailure(outputDir, error.code);
        }
        throw error;
    }
    verifyLocalPublication(publication.paths.generationPath);
    removePrivateEvidenceCollection(collection);
    return publicationOutputPaths(publication);
}
