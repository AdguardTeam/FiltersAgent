import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { BlockerVerificationMethod } from '../../src/environment/environment-proofs';
import {
    chmodSync,
    existsSync,
    linkSync,
    mkdtempSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { publishLocalRun } from '../../src/local/evidence-publication';
import { publishVerifiedLocalResult } from '../../lab/local/local-evidence-publish-step';
import { LocalPublicationManifestSchema } from '../../src/local/local-publication-manifest';
import { LocalPublicationTrustError } from '../../src/local/local-publication-trust';
import {
    copySanitizedEvidenceArtifact,
    sanitizeEvidenceCollection,
} from '../../src/local/evidence-sanitizer';
import { normalizeTrustedPngCapture } from '../../src/local/png-normalizer';
import {
    cleanupLocalPublication,
    listVerifiedLocalPublications,
    parseVerifiedJsonArtifact,
    verifyLocalPublication,
} from '../../src/local/local-publication-verifier';
import { readLocalRunOutput } from '../../src/local/run-output';
import { createRunUsageCollector } from '../../src/pi/usage-collector';
import { RunUsageSummarySchema, UsageModelRatesSchema } from '../../src/types/usage-summary';
import { EnvironmentSelectionHost } from '../../src/environment/environment-selection';
import { extensionExecutorDescriptor } from '../environment/test-filtering-environment-fixtures';
import { projectEnvironmentResult } from '../../src/environment/environment-result-projection';
import type { FilteringEnvironmentExecution } from '../../src/environment/filtering-environment';
import { bindReviewCandidate } from '../../src/repo/repository-edit';
import type { CandidatePatch } from '../../src/types/fix-run-result';
import { buildLocalIssueSnapshot } from '../../src/local/issue-snapshot';
import { verifyCapturedIssueRevision } from '../../src/local/issue-revision';
import type { PreparedFiltersCheckout } from '../../src/local/filters-preparer';
import type { LocalRunRecord } from '../../src/local/run-output';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/**
 * Compute a PNG CRC-32.
 *
 * @param bytes - Chunk type and data.
 * @returns Unsigned CRC-32.
 */
/**
 * Remove every empty directory below a root, the way an Actions artifact zip round-trip does.
 *
 * @param directory - Current directory to sweep.
 * @returns Whether the directory still holds any file after the sweep.
 */
function dropEmptyDirectories(directory: string): boolean {
    let occupied = false;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
            occupied = true;
            continue;
        }
        const child = join(directory, entry.name);
        if (dropEmptyDirectories(child)) {
            occupied = true;
        } else {
            rmSync(child, { recursive: true });
        }
    }
    return occupied;
}

function crc32(bytes: Buffer): number {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) {
            crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Encode one PNG chunk.
 *
 * @param type - Four-byte chunk type.
 * @param data - Chunk payload.
 * @returns Encoded chunk.
 */
function pngChunk(type: string, data: Buffer): Buffer {
    const typeBytes = Buffer.from(type, 'ascii');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.byteLength);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
    return Buffer.concat([length, typeBytes, data, checksum]);
}

/**
 * Create a one-pixel RGBA PNG carrying one untrusted text metadata chunk.
 *
 * @param metadata - Secret metadata text.
 * @returns Valid PNG bytes.
 */
function pngWithMetadata(metadata: string): Buffer {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(1, 0);
    header.writeUInt32BE(1, 4);
    header[8] = 8;
    header[9] = 6;
    return Buffer.concat([
        PNG_SIGNATURE,
        pngChunk('IHDR', header),
        pngChunk('tEXt', Buffer.from(`Comment\0${metadata}`, 'utf8')),
        pngChunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

describe('sanitizeEvidenceCollection', () => {
    it('structurally redacts text evidence and omits raw image bytes before hashing', () => {
        const collectionDir = mkdtempSync(join(tmpdir(), 'evidence-sanitize-'));
        mkdirSync(join(collectionDir, 'nested'));
        writeFileSync(
            join(collectionDir, 'network.har'),
            JSON.stringify({
                request: {
                    headers: {
                        AuThOrIzAtIoN: 'Bearer configured-secret',
                        COOKIE: 'session=configured-secret',
                    },
                    url: 'https://user:pass@example.test/path?ToKeN=configured-secret&ok=1',
                },
                response: { headers: { 'SeT-CoOkIe': 'sid=configured-secret' } },
            }),
        );
        writeFileSync(
            join(collectionDir, 'nested', 'storage.jsonl'),
            `${JSON.stringify({ state: { auth: { token: 'configured-secret' } } })}\n`,
        );
        writeFileSync(
            join(collectionDir, 'trace.txt'),
            'Authorization: Bearer configured-secret\nordinary=configured-secret\n',
        );
        writeFileSync(
            join(collectionDir, 'page.html'),
            '<meta name="token" content="configured-secret">',
        );
        writeFileSync(join(collectionDir, 'raw.png'), pngWithMetadata('configured-secret'));
        writeFileSync(join(collectionDir, 'raw.jpg'), 'configured-secret');

        const pack = sanitizeEvidenceCollection({
            collectionDir,
            configuredSecrets: ['configured-secret'],
        });
        const allText = pack.artifacts
            .map((artifact) => copySanitizedEvidenceArtifact(pack, artifact.path).toString('utf8'))
            .join('\n');

        expect(allText).not.toContain('configured-secret');
        expect(allText).not.toContain('user:pass');
        expect(allText).toContain('[redacted]');
        expect(pack.images).toEqual(
            ['raw.jpg', 'raw.png'].map((path) => ({
                kind: 'omitted',
                path,
                role: 'browser_evidence',
                reason: 'untrusted_image_without_pixel_redaction_proof',
            })),
        );
        expect(pack.artifacts.some((artifact) => artifact.path === 'raw.png')).toBe(false);
    });

    it('publishes only metadata-free pixels from an opaque trusted redaction proof', () => {
        const collectionDir = mkdtempSync(join(tmpdir(), 'evidence-trusted-png-'));
        const raw = pngWithMetadata('visible-secret');
        writeFileSync(join(collectionDir, 'capture.png'), raw);
        const capture = normalizeTrustedPngCapture({
            relativePath: 'capture.png',
            pngBytes: raw,
            role: 'phase_c_after',
            proofId: 'proof-2026-07-24-capture',
            regions: [{ x: 0, y: 0, width: 1, height: 1 }],
        });

        const pack = sanitizeEvidenceCollection({
            collectionDir,
            configuredSecrets: ['visible-secret'],
            trustedCaptures: [capture],
        });
        const published = copySanitizedEvidenceArtifact(pack, 'capture.png');

        expect(published.includes(Buffer.from('visible-secret'))).toBe(false);
        expect(pack.images).toEqual([
            expect.objectContaining({
                kind: 'capture',
                path: 'capture.png',
                role: 'phase_c_after',
                proofId: 'proof-2026-07-24-capture',
                sha256: createHash('sha256').update(published).digest('hex'),
            }),
        ]);
    });

    it('rejects a hardlinked text artifact before publishing any bytes', () => {
        const root = mkdtempSync(join(tmpdir(), 'evidence-hardlink-'));
        const collectionDir = join(root, 'collection');
        mkdirSync(collectionDir);
        const outside = join(root, 'outside.json');
        writeFileSync(outside, '{"token":"must-not-read"}\n');
        linkSync(outside, join(collectionDir, 'linked.json'));

        expect(() => sanitizeEvidenceCollection({ collectionDir, configuredSecrets: [] })).toThrow(
            LocalPublicationTrustError,
        );
    });

    it('treats a structurally forged trusted capture as an omission', () => {
        const collectionDir = mkdtempSync(join(tmpdir(), 'evidence-forged-png-'));
        writeFileSync(join(collectionDir, 'capture.png'), pngWithMetadata('untrusted'));

        const pack = sanitizeEvidenceCollection({
            collectionDir,
            configuredSecrets: [],
            trustedCaptures: [{} as never],
        });

        expect(pack.artifacts).toEqual([]);
        expect(pack.images[0]).toMatchObject({
            kind: 'omitted',
            reason: 'untrusted_image_without_pixel_redaction_proof',
        });
    });
});

/**
 * Create all source and evidence inputs for a local publication in test-owned storage.
 *
 * @param candidate - Optional exact candidate.
 * @returns Complete publication fixture.
 */
function createPublicationFixture(candidate: CandidatePatch | null) {
    const root = mkdtempSync(join(tmpdir(), 'local-publication-'));
    const sourcePath = join(root, 'source');
    const collectionRoot = join(root, 'collection');
    const collectionWorkDir = join(collectionRoot, 'raw');
    const collectionDir = join(collectionWorkDir, 'artifacts');
    const outputRoot = join(root, 'output');
    const filePath = 'BaseFilter/sections/foreign.txt';
    mkdirSync(join(sourcePath, 'BaseFilter/sections'), { recursive: true });
    mkdirSync(collectionDir, { recursive: true });
    mkdirSync(outputRoot);
    const collectionMarker = 'private collection fixture\n';
    writeFileSync(join(collectionRoot, '.collection-owner'), collectionMarker);
    writeFileSync(
        join(sourcePath, filePath),
        '! header\nexample.com##.old\nlast.example##.last\nshared-one.example,shared-two.example##.shared\n',
    );
    // The real filters repository tracks executable hook files; artifact transport between the
    // analyze and publish jobs strips their mode bits, which the verification must tolerate.
    writeFileSync(join(sourcePath, 'hook.sh'), '#!/bin/sh\n', { mode: 0o755 });
    execFileSync('git', ['init', '-q'], { cwd: sourcePath });
    execFileSync('git', ['add', '.'], { cwd: sourcePath });
    execFileSync(
        'git',
        [
            '-c',
            'user.name=Test',
            '-c',
            'user.email=test@example.invalid',
            'commit',
            '-qm',
            'fixture',
        ],
        { cwd: sourcePath },
    );
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: sourcePath,
        encoding: 'utf8',
    }).trim();
    const source: PreparedFiltersCheckout = {
        checkoutPath: sourcePath,
        filtersPath: sourcePath,
        provenance: {
            environment: 'current',
            source: 'local-shared-clone',
            sourceLocation: sourcePath,
            requestedRevision: commit,
            commit,
        },
    };
    const issue = {
        number: 42,
        reporterAuthor: 'reporter',
        url: 'https://github.com/AdguardTeam/AdguardFilters/issues/42',
        title: 'Ad remains visible',
        body: [
            'AdGuard Browser Extension; T: Ads',
            '',
            '### System configuration',
            'Filters: | AdGuard Base filter',
        ].join('\n'),
        state: 'open' as const,
        labels: ['T: Ads'],
        assignee: null,
        comments: [
            {
                author: 'reporter',
                body: 'The banner is still there after a reload.',
                createdAt: '2026-07-23T12:00:00.000Z',
            },
        ],
    };
    const snapshot = buildLocalIssueSnapshot(issue, [], { reporterAuthorOnly: 'reporter' });
    const revision = verifyCapturedIssueRevision({
        repository: 'AdguardTeam/AdguardFilters',
        issueNumber: 42,
        sourceUpdatedAt: '2026-07-24T00:00:00.000Z',
        capturedAt: '2026-07-24T00:01:00.000Z',
        snapshot,
        attachmentBytes: [],
        inputOrigin: 'exported',
    });
    const environment = new EnvironmentSelectionHost(
        {
            issueNumber: 42,
            issueUrl: 'https://github.com/AdguardTeam/AdguardFilters/issues/42',
            reportedSiteUrls: [],
            labels: ['T: Ads'],
            problemType: 'ads',
            product: 'AdGuard Browser Extension',
            enabledFilters: [{ name: 'AdGuard Base filter', officialFilterId: 2 }],
            screenshots: [],
        },
        [extensionExecutorDescriptor()],
    );
    environment.select({
        kind: 'browser_extension',
        requiredCapabilities: ['browser_navigation'],
        intent: {
            issueType: 'ads',
            rationale: 'The report identifies an advertisement.',
            confidence: 0.95,
            evidence: [{ source: 'issue_body', observation: 'An ad remains visible.' }],
            conflicts: [],
        },
        rationale: 'Use the browser extension environment.',
        confidence: 0.95,
    });
    environment.bindActualContext('browser_extension', {
        product: 'AdGuard Browser Extension',
        productVersion: '5.5.2.3',
        browser: 'CloakBrowser Chromium',
    });
    const extensionProvenance = {
        source: 'pinned_release' as const,
        extensionPath: '/tmp/cache/extensions/prebuilt/v5.5.2.3/unpacked',
        manifestVersion: 3 as const,
        extensionSourceSha256: 'e'.repeat(64),
        extensionSourceTag: 'v5.5.2.3',
    };
    const settingsEvidence = {
        profileKind: 'agent_selected' as const,
        enabledListKeys: ['adguard:2'],
        activeRulesetListKeys: ['adguard:2'],
        stealthEnabled: false,
        limitsExceeded: false,
    };
    const candidateRuleHash = candidate
        ? createHash('sha256').update(candidate.rule).digest('hex')
        : null;
    const candidateShortHash = candidateRuleHash?.slice(0, 12) ?? null;
    const validationArtifactId = candidateShortHash ? `validation-${candidateShortHash}` : null;
    const verifiedScreenshots = (() => {
        if (!candidate) {
            return null;
        }
        return {
            before: join(collectionDir, 'before.png'),
            after: join(collectionDir, 'after.png'),
            beforeFullPage: join(collectionDir, 'before-full.png'),
            afterFullPage: join(collectionDir, 'after-full.png'),
        };
    })();
    const candidateEvidence = (() => {
        if (!candidate || !verifiedScreenshots || !validationArtifactId || !candidateRuleHash) {
            return {};
        }
        return {
            extensionProvenance,
            settingsEvidence,
            browserSessions: [
                {
                    sessionId: 'prepared-session',
                    targetUrl: 'https://example.com/',
                    extensionMode: 'prepared' as const,
                    profile: {
                        viewport: 'desktop' as const,
                        locale: 'en-US',
                        timezone: 'UTC',
                        userAgentProfile: 'Chromium',
                        consentStrategy: 'untouched' as const,
                    },
                    selectedSettingsProfileKind: 'agent_selected' as const,
                    extensionProvenance,
                    settingsEvidence,
                    navigationVerified: true,
                    fullVisionVerified: false,
                    captures: [],
                },
            ],
            candidateValidationEvidence: {
                validationArtifactId,
                sessionId: 'prepared-session',
                extensionProvenance,
                settingsEvidence,
                validationArtifact: {
                    artifactId: validationArtifactId,
                    path: join(collectionDir, `factual-validation-${candidateShortHash}.json`),
                },
                visualReviewArtifact: {
                    artifactId: `visual-review-${candidateShortHash}`,
                    path: join(collectionDir, `candidate-visual-review-${candidateShortHash}.json`),
                },
                beforeViewport: {
                    artifactId: 'before-viewport',
                    path: verifiedScreenshots.before,
                },
                afterViewport: {
                    artifactId: 'after-viewport',
                    path: verifiedScreenshots.after,
                },
                beforeFullPage: {
                    artifactId: 'before-full-page',
                    path: verifiedScreenshots.beforeFullPage,
                },
                afterFullPage: {
                    artifactId: 'after-full-page',
                    path: verifiedScreenshots.afterFullPage,
                },
            },
            candidateVisualReview: {
                verdict: 'verified' as const,
                symptom: 'resolved' as const,
                symptomScope: 'The complete reported advertisement.',
                adLayoutResidue: 'absent' as const,
                coverageComplete: true,
                beforeInstances: [
                    {
                        artifactId: 'before-viewport',
                        landmark: 'Reported target area.',
                        description: 'The advertisement is visible before the rule.',
                    },
                ],
                remainingInstances: [],
                pageIntegrity: 'intact' as const,
                validationArtifactId,
                candidateRuleHash,
                beforeViewportArtifactId: 'before-viewport',
                afterViewportArtifactId: 'after-viewport',
                beforeFullPageArtifactId: 'before-full-page',
                afterFullPageArtifactId: 'after-full-page',
                model: 'vision-test',
                rationale: 'The candidate removes the ad without visible damage.',
                observedDamage: [],
            },
        };
    })();
    const candidateArtifacts = (() => {
        if (!verifiedScreenshots || !candidateShortHash) {
            return {};
        }
        return {
            candidateVisualReview: join(
                collectionDir,
                `candidate-visual-review-${candidateShortHash}.json`,
            ),
            verifiedCandidateScreenshots: verifiedScreenshots,
        };
    })();
    const record: LocalRunRecord = {
        result: {
            issueNumber: 42,
            domain: 'example.com',
            runStatus: candidate ? 'patch_proposed' : 'not_reproduced',
            requestedBrowserMode: 'auto',
            effectiveMode: 'browser',
            verificationStatus: 'verified',
            reproductionSettingsStatus: 'applied',
            reproductionSettingsDetail: 'Controlled settings were applied.',
            fallbackReason: null,
            fallbackDetail: null,
            environmentSelection: environment.snapshot()!,
            ...candidateEvidence,
            candidatePatch: candidate,
            artifactPaths: {
                screenshots: verifiedScreenshots ? Object.values(verifiedScreenshots) : [],
                domSnapshot: null,
                har: null,
                trace: null,
                settingsProof: null,
                ...candidateArtifacts,
            },
            reasoning: candidate ? 'The verified candidate fixes the issue.' : 'No issue found.',
            repository: null,
            baseSha: null,
            filtersRepository: 'AdguardTeam/AdguardFilters',
            filtersBaseSha: commit,
        },
        provenance: {
            environment: 'current',
            headless: true,
            extension: null,
            settingsProfiles: [],
        },
        evidence: {
            summary: candidate ? 'The verified candidate fixes the issue.' : 'No issue found.',
            userScreenshots: [],
            unfilteredScreenshots: [],
            profileScreenshots: [],
            beforeScreenshots: verifiedScreenshots ? [verifiedScreenshots.before] : [],
            afterScreenshots: verifiedScreenshots ? [verifiedScreenshots.after] : [],
            beforeFullPageScreenshots: verifiedScreenshots
                ? [verifiedScreenshots.beforeFullPage]
                : [],
            afterFullPageScreenshots: verifiedScreenshots
                ? [verifiedScreenshots.afterFullPage]
                : [],
            rejectedScreenshots: [],
            rejectedPairs: [],
        },
        artifacts: [],
    };
    if (verifiedScreenshots && candidateShortHash) {
        for (const path of Object.values(verifiedScreenshots)) {
            writeFileSync(path, pngWithMetadata('raw reporter metadata'));
        }
        writeFileSync(
            join(collectionDir, `factual-validation-${candidateShortHash}.json`),
            '{"validated":true}\n',
        );
        writeFileSync(
            join(collectionDir, `candidate-visual-review-${candidateShortHash}.json`),
            '{"verdict":"verified"}\n',
        );
    }
    writeFileSync(
        join(collectionDir, 'trace.json'),
        `${JSON.stringify({ authorization: 'Bearer publication-secret', safe: true })}\n`,
    );
    const candidateBinding = bindReviewCandidate(candidate, source, record);
    return {
        root,
        source,
        collectionDir,
        collection: {
            root: collectionRoot,
            workDir: collectionWorkDir,
            marker: collectionMarker,
        },
        outputRoot,
        revision,
        record,
        candidateBinding,
        input: {
            revision,
            record,
            source,
            candidateBinding,
            collectionDir,
            outputRoot,
            agentRunArtifacts: { decision: null, observations: [] },
            llmUsage: createRunUsageCollector({}).summary(),
            configuredSecrets: ['publication-secret'],
        },
    };
}

/**
 * Rewrite a locked run record into a complete pending-publication claim.
 *
 * The status only becomes persistable together with the A/B/C reproduction and the published
 * checksums that justify it, so the round trip has to carry a real canonical execution.
 *
 * @param record - Run record whose environment selection the execution must agree with.
 */
function attachPendingPublicationExecution(record: LocalRunRecord): void {
    const actualContext = record.result.environmentSelection!.actual!;
    const baselineDigest = '7'.repeat(64);
    /**
     * Exact single-line candidate rule the C phase applies, and its verified digest.
     */
    const candidateRule = 'example.test##.ad';
    const candidateDigest = createHash('sha256').update(candidateRule, 'utf8').digest('hex');
    const provenance = {
        source: 'pinned_release' as const,
        extensionPath: '/tmp/cache/extensions/prebuilt/v5.5.2.3/unpacked',
        manifestVersion: 3 as const,
        extensionSourceSha256: 'e'.repeat(64),
        extensionSourceTag: 'v5.5.2.3',
    };
    const execution: FilteringEnvironmentExecution = {
        recorderVersion: 1,
        runId: 'run-42',
        kind: 'browser_extension',
        actualContext,
        capabilities: ['browser_navigation', 'filtering_control', 'phase_proof'],
        preparation: null,
        baseline: {
            environment: 'browser_extension',
            acquiredAt: '2026-07-24T00:00:00.000Z',
            enabledListKeys: ['adguard:2'],
            resources: [
                {
                    listKey: 'adguard:2',
                    rulesetId: 'ruleset_2',
                    path: 'filters/declarative/ruleset_2/ruleset_2.json',
                    version: '1.0.1.2',
                    byteCount: 4096,
                    sha256: 'e'.repeat(64),
                },
            ],
            aggregateDigest: baselineDigest,
        },
        phases: (['A', 'B', 'C'] as const).map((phase) => {
            let filteringState:
                | 'disabled'
                | 'published_baseline'
                | 'published_baseline_plus_candidate' = 'disabled';
            if (phase === 'B') {
                filteringState = 'published_baseline';
            }
            if (phase === 'C') {
                filteringState = 'published_baseline_plus_candidate';
            }
            const viewport = `/tmp/run/lag-viewport-${phase}.png`;
            const fullPage = `/tmp/run/lag-full-page-${phase}.png`;
            const tile = `/tmp/run/lag-tile-${phase}.png`;
            return {
                runId: 'run-42',
                experimentId: 'experiment-1',
                phase,
                proof: {
                    leaseId: `lease-${phase}`,
                    adapterStateDigest: '5'.repeat(64),
                    phase,
                    filteringState,
                    sessionId: `lag-session-${phase}`,
                    actualContext,
                    baselineDigest: phase === 'A' ? null : baselineDigest,
                    candidateDigest: phase === 'C' ? candidateDigest : null,
                    extension:
                        phase === 'A'
                            ? null
                            : {
                                  packageVersion: '5.5.2.3',
                                  manifestVersion: '5.5.2.3',
                                  profileKind: 'agent_selected' as const,
                                  enabledListKeys: ['adguard:2'],
                                  activeRulesetListKeys: ['adguard:2'],
                                  stealthEnabled: false,
                                  userRulesDigest: phase === 'C' ? candidateDigest : null,
                                  application: {
                                      method: BlockerVerificationMethod.ExtensionState,
                                      appliedRules: phase === 'C' ? [candidateRule] : [],
                                      actionLog: [],
                                  },
                                  provenance,
                              },
                },
                completion: {
                    kind: 'observed',
                    sessionId: `lag-session-${phase}`,
                    targetUrl: 'https://example.com/',
                    targetObservation: { symptomPresent: phase !== 'C', pageUsable: true },
                    navigationVerified: true,
                    artifacts: [
                        { artifactId: `lag-viewport-${phase}`, kind: 'screenshot', path: viewport },
                        {
                            artifactId: `lag-full-page-${phase}`,
                            kind: 'screenshot',
                            path: fullPage,
                        },
                        { artifactId: `lag-tile-${phase}`, kind: 'screenshot', path: tile },
                    ],
                    vision: null,
                    candidateValidation: null,
                    rejectedCandidates: [],
                    profile: {
                        viewport: 'desktop',
                        locale: 'en-US',
                        timezone: 'UTC',
                        userAgentProfile: 'Chromium',
                        consentStrategy: 'untouched',
                    },
                    captures: [
                        {
                            visionVerified: true,
                            viewportArtifactId: `lag-viewport-${phase}`,
                            viewport,
                            fullPageOverviewArtifactId: `lag-full-page-${phase}`,
                            fullPageOverview: fullPage,
                            tileArtifactIds: [`lag-tile-${phase}`],
                            tiles: [tile],
                            coverageComplete: true,
                            reporterSymptomPresence: phase === 'C' ? 'absent' : 'present',
                        },
                    ],
                },
            };
        }),
        rejectedCandidates: [],
        drain: { attempted: 0, closed: 0, failed: 0, failures: [] },
        cleanup: {
            attempted: true,
            completed: true,
            finalizerAttempts: 0,
            finalizerCompleted: 0,
            finalizerFailed: 0,
            failures: [],
        },
        investigationDisposition: { status: 'inconclusive', candidateDigest: null, failure: null },
        secondaryFailures: [],
        disposition: { status: 'inconclusive', candidateDigest: null, failure: null },
    };
    const projected = projectEnvironmentResult(execution)!;
    Object.assign(record.result, {
        runStatus: 'fixed_in_source_pending_publication',
        verificationStatus: 'partial',
        environmentExecution: execution,
        browserSessions: projected.browserSessions,
        extensionProvenance: projected.extensionProvenance,
        settingsEvidence: projected.settingsEvidence,
        ...(projected.candidateApplicationEvidence
            ? { candidateApplicationEvidence: projected.candidateApplicationEvidence }
            : {}),
        artifactPaths: projected.artifactPaths,
    });
}

/**
 * Rewrite one visible manifest and its marker as a marker-consistent tamper replay.
 *
 * @param generationPath - Exact published generation under test.
 * @param mutate - Mutation applied to the parsed manifest.
 */
function rewritePublishedManifest(
    generationPath: string,
    mutate: (manifest: Record<string, unknown>) => void,
): void {
    const manifestPath = join(generationPath, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    mutate(manifest);
    writeRehashedManifest(generationPath, manifest);
}

/**
 * Persist one mutated manifest together with its recomputed visibility marker.
 *
 * @param generationPath - Exact published generation under test.
 * @param manifest - Mutated manifest value.
 */
function writeRehashedManifest(generationPath: string, manifest: Record<string, unknown>): void {
    const manifestPath = join(generationPath, 'manifest.json');
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    writeFileSync(manifestPath, bytes);
    writeFileSync(
        join(generationPath, 'PUBLISHED'),
        `${createHash('sha256').update(bytes).digest('hex')}\n`,
    );
}

/**
 * Require an untrusted JSON value to be an object for a tamper mutation.
 *
 * @param value - Parsed JSON value.
 * @returns Mutable object value.
 */
function jsonObject(value: unknown): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('Expected a JSON object in the publication fixture.');
    }
    return value as Record<string, unknown>;
}

/**
 * Rewrite every persisted copy of a bound publication's run and review receipts.
 *
 * @param generationPath - Exact published generation under test.
 * @param mutate - Mutation applied to the manifest, locked run, and review receipt.
 */
interface BoundPublicationReplayValues {
    manifest: Record<string, unknown>;
    runRecord: Record<string, unknown>;
    reviewReceipt: Record<string, unknown>;
}

function rewriteBoundPublication(
    generationPath: string,
    mutate: (values: BoundPublicationReplayValues) => void,
): void {
    const manifest = JSON.parse(
        readFileSync(join(generationPath, 'manifest.json'), 'utf8'),
    ) as Record<string, unknown>;
    const runRecord = JSON.parse(
        readFileSync(join(generationPath, 'run-result.json'), 'utf8'),
    ) as Record<string, unknown>;
    const reviewReceipt = JSON.parse(
        readFileSync(join(generationPath, 'review-receipt.json'), 'utf8'),
    ) as Record<string, unknown>;
    mutate({ manifest, runRecord, reviewReceipt });

    const artifacts = manifest.artifacts;
    if (!Array.isArray(artifacts)) {
        throw new Error('Expected manifest artifacts.');
    }
    for (const [path, value, binding] of [
        ['run-result.json', runRecord, 'runRecordSha256'],
        ['review-receipt.json', reviewReceipt, null],
    ] as const) {
        const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
        writeFileSync(join(generationPath, path), bytes);
        const digest = artifacts.map(jsonObject).find((entry) => entry.path === path);
        if (!digest) {
            throw new Error(`Expected ${path} digest.`);
        }
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        digest.sha256 = sha256;
        digest.bytes = bytes.byteLength;
        if (binding) {
            jsonObject(manifest.bindings)[binding] = sha256;
        }
    }
    manifest.review = reviewReceipt;
    writeRehashedManifest(generationPath, manifest);
}

/**
 * Build one valid candidate for a publication operation.
 *
 * @param operation - Candidate operation to create.
 * @returns Candidate accepted by the public publication boundary.
 */
function publicationCandidate(
    operation: 'add' | 'edit' | 'remove' | 'extend_domains',
): CandidatePatch {
    if (operation === 'add') {
        return {
            rule: 'middle.example##.new',
            ruleType: 'cosmetic',
            filePath: 'BaseFilter/sections/foreign.txt',
            repositoryEdit: {
                kind: 'insert',
                insertionPoint: 2,
                anchorRule: 'last.example##.last',
            },
        };
    }
    if (operation === 'extend_domains') {
        // The candidate rule is the single-domain rule the reported site executes, not the extended
        // line the patch writes: those are the same filtering state for that site.
        return {
            rule: 'nettg.example##.shared',
            ruleType: 'cosmetic',
            filePath: 'BaseFilter/sections/foreign.txt',
            repositoryEdit: {
                kind: 'extend_domains',
                line: 4,
                originalRule: 'shared-one.example,shared-two.example##.shared',
                replacementRule: 'nettg.example,shared-one.example,shared-two.example##.shared',
            },
        };
    }
    if (operation === 'remove') {
        return {
            rule: 'example.com##.old',
            ruleType: 'cosmetic',
            filePath: 'BaseFilter/sections/foreign.txt',
            repositoryEdit: {
                kind: 'remove',
                line: 2,
                originalRule: 'example.com##.old',
            },
        };
    }
    return {
        rule: 'example.com##.new',
        ruleType: 'cosmetic',
        filePath: 'BaseFilter/sections/foreign.txt',
        repositoryEdit: {
            kind: 'replace',
            line: 2,
            originalRule: 'example.com##.old',
            replacementRule: 'example.com##.new',
        },
    };
}

/**
 * Build a valid append-at-EOF candidate whose locked insert intentionally has no anchor.
 *
 * @returns Candidate accepted as an exact EOF insertion.
 */
function eofPublicationCandidate(): CandidatePatch {
    return {
        rule: 'tail.example##.new',
        ruleType: 'cosmetic',
        filePath: 'BaseFilter/sections/foreign.txt',
        repositoryEdit: {
            kind: 'insert',
        },
    };
}

/**
 * Rewrite a locked JSON artifact and all matching digest declarations.
 *
 * @param generationPath - Exact published generation under test.
 * @param artifactPath - Generation-relative locked JSON artifact.
 * @param bindingName - Manifest binding that duplicates the artifact digest.
 * @param mutate - Mutation applied to the parsed artifact.
 */
function rewriteLockedJsonArtifact(
    generationPath: string,
    artifactPath: 'issue-input.json' | 'run-result.json',
    bindingName: 'issueInputSha256' | 'runRecordSha256',
    mutate: (artifact: Record<string, unknown>) => void,
): void {
    const persistedPath = join(generationPath, artifactPath);
    const artifact = JSON.parse(readFileSync(persistedPath, 'utf8')) as Record<string, unknown>;
    mutate(artifact);
    const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    writeFileSync(persistedPath, bytes);
    rewritePublishedManifest(generationPath, (manifest) => {
        const artifacts = manifest.artifacts;
        if (!Array.isArray(artifacts)) {
            throw new Error('Expected manifest artifacts.');
        }
        const digest = artifacts.map(jsonObject).find((entry) => entry.path === artifactPath);
        if (!digest) {
            throw new Error(`Expected ${artifactPath} digest.`);
        }
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        digest.sha256 = sha256;
        digest.bytes = bytes.byteLength;
        jsonObject(manifest.bindings)[bindingName] = sha256;
    });
}

describe('publishLocalRun', () => {
    it('publishes an exact candidate patch and identical isolated unstaged review diff', () => {
        const candidate: CandidatePatch = {
            rule: 'example.com##.new',
            ruleType: 'cosmetic',
            filePath: 'BaseFilter/sections/foreign.txt',
            repositoryEdit: {
                kind: 'replace',
                line: 2,
                originalRule: 'example.com##.old',
                replacementRule: 'example.com##.new',
            },
        };
        const fixture = createPublicationFixture(candidate);
        expect(fixture.candidateBinding.kind).toBe('bound');

        const result = publishLocalRun(fixture.input, {
            idSource: () => '00000000-0000-4000-8000-000000000010',
            now: () => '2026-07-24T00:02:00.000Z',
        });

        expect(result.kind).toBe('published');
        expect(result.paths.candidatePatchPath).not.toBeNull();
        expect(result.paths.reviewCheckoutPath).not.toBeNull();
        const patch = readFileSync(result.paths.candidatePatchPath!);
        const diff = execFileSync('git', ['diff', '--binary', '--no-ext-diff', '--no-textconv'], {
            cwd: result.paths.reviewCheckoutPath!,
        });
        expect(diff.equals(patch)).toBe(true);
        expect(verifyLocalPublication(result.paths.generationPath)).toEqual(result.manifest);
        expect(
            readFileSync(join(result.paths.generationPath, 'evidence/trace.json'), 'utf8'),
        ).not.toContain('publication-secret');

        // The published record must round-trip through the strict reader: generic key redaction
        // must not replace the schema-required browserSessions array with a string.
        const reread = readLocalRunOutput(join(result.paths.generationPath, 'run-result.json'));
        expect(Array.isArray(reread.result.browserSessions)).toBe(true);
        expect(reread.result.browserSessions).toHaveLength(1);
        expect(reread.result.browserSessions![0].extensionMode).toBe('prepared');

        // Session identifiers are hidden as stable pseudonyms rather than one shared placeholder:
        // the record's invariants bind candidate evidence to exactly one session, which a shared
        // placeholder makes impossible to satisfy on any multi-session run.
        const publishedSessionId = reread.result.browserSessions![0].sessionId;
        expect(publishedSessionId).not.toBe('[redacted]');
        expect(publishedSessionId).toMatch(/^\[redacted-\d+]$/);

        // Numeric token counters are usage metrics, not credentials; the published usage report
        // must keep them as numbers instead of "[redacted]" strings.
        const publishedUsage = JSON.parse(
            readFileSync(join(result.paths.generationPath, 'llm-usage.json'), 'utf8'),
        ) as { tokens: Record<string, unknown>; costUsd: unknown };
        expect(typeof publishedUsage.tokens.input).toBe('number');
        expect(typeof publishedUsage.tokens.output).toBe('number');
        expect(typeof publishedUsage.tokens.cacheRead).toBe('number');
        expect(publishedUsage.costUsd).toBeNull();
    });

    it('publishes and re-verifies an unobserved enabled-filter profile without refusing it', () => {
        const fixture = createPublicationFixture(null);
        // A proof-less profile is a legal run-record value: the read-back never observed the
        // enabled set, so the record — and the manifest that duplicates it verbatim — carry null
        // rather than an empty filter list.
        fixture.record.provenance.settingsProfiles = [
            {
                name: 'agent_selected',
                status: 'partial',
                detail: 'The requested profile did not produce complete metadata and runtime proof.',
                activationProof: 'unavailable',
                enabledFilters: null,
            },
        ];

        const result = publishLocalRun(fixture.input, {
            idSource: () => '00000000-0000-4000-8000-000000000042',
            now: () => '2026-07-24T00:02:00.000Z',
        });

        expect(result.kind).toBe('published');
        const persistedManifest = v.parse(
            LocalPublicationManifestSchema,
            JSON.parse(
                readFileSync(join(result.paths.generationPath, 'manifest.json'), 'utf8'),
            ) as unknown,
        );
        expect(persistedManifest.bindings.filters.settingsProfiles).toEqual([
            expect.objectContaining({ enabledFilters: null }),
        ]);
        const publishedRecord = JSON.parse(
            readFileSync(join(result.paths.generationPath, 'run-result.json'), 'utf8'),
        ) as LocalRunRecord;
        expect(publishedRecord.provenance.settingsProfiles[0].enabledFilters).toBeNull();
        // The verifier re-parses the record and re-derives the bindings: the null is compared as
        // the persisted value, so a matching null must not read as an unsafe artifact.
        expect(verifyLocalPublication(result.paths.generationPath)).toEqual(result.manifest);

        // Null is not a wildcard: a manifest claiming an observed empty list while its locked
        // record says the set was never observed must keep failing the semantic comparison.
        rewritePublishedManifest(result.paths.generationPath, (manifest) => {
            const profiles = jsonObject(jsonObject(manifest.bindings).filters).settingsProfiles;
            if (!Array.isArray(profiles)) {
                throw new Error('Expected persisted settings profiles.');
            }
            jsonObject(profiles[0]).enabledFilters = [];
        });
        expect(() => verifyLocalPublication(result.paths.generationPath)).toThrow(
            LocalPublicationTrustError,
        );
    });

    it('publishes zeroed token counters from an unreported completion unredacted', () => {
        const fixture = createPublicationFixture(null);
        const collector = createRunUsageCollector({ rates: {} });
        collector.addSession({
            completions: [
                {
                    model: 'quiet-model',
                    reported: false,
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    reasoningTokens: 0,
                },
            ],
            durationMs: 120_000,
        });

        const result = publishLocalRun(
            { ...fixture.input, llmUsage: collector.summary() },
            {
                idSource: () => '00000000-0000-4000-8000-000000000041',
                now: () => '2026-07-24T00:02:00.000Z',
            },
        );

        expect(result.kind).toBe('published');
        // The publish workflow re-parses this artifact with the usage schema; a placeholder
        // string in a token counter kills the whole finished result at exactly that boundary.
        const published = v.parse(
            RunUsageSummarySchema,
            JSON.parse(
                readFileSync(join(result.paths.generationPath, 'llm-usage.json'), 'utf8'),
            ) as unknown,
        );
        expect(published.tokens).toEqual({
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            reasoningTokens: 0,
        });
        expect(published.costUsd).toBeNull();
        expect(published.usageCompleteness).toBe('unreported');
    });

    it('publishes the audited per-model price table unredacted', () => {
        const fixture = createPublicationFixture(null);
        const rates = {
            'priced-model': {
                inputUsdPerMillionTokens: 3,
                outputUsdPerMillionTokens: 15,
                cachedInputUsdPerMillionTokens: 0.3,
                cacheWriteUsdPerMillionTokens: 3.75,
                reasoningUsdPerMillionTokens: 15,
            },
        };
        // The fixture must carry every rate the schema can: a rate the redactor does not know is
        // scrubbed to a string, the re-parse fails and the finished run is thrown away — which is
        // how one live pass lost all eight analyses the day the cache-write rate landed.
        expect(Object.keys(rates['priced-model']).sort()).toEqual(
            Object.keys(UsageModelRatesSchema.entries).sort(),
        );
        const collector = createRunUsageCollector({ rates });
        collector.addSession({
            completions: [
                {
                    model: 'priced-model',
                    reported: true,
                    input: 1_000,
                    output: 500,
                    cacheRead: 200,
                    cacheWrite: 100,
                    reasoningTokens: 50,
                },
            ],
            durationMs: 120_000,
        });

        const result = publishLocalRun(
            { ...fixture.input, llmUsage: collector.summary() },
            {
                idSource: () => '00000000-0000-4000-8000-000000000043',
                now: () => '2026-07-24T00:02:00.000Z',
            },
        );

        expect(result.kind).toBe('published');
        // Every real campaign run seeds a rates table, and its keys end in "Tokens": the generic
        // key heuristic scrubbed the prices, the artifact stopped satisfying the schema the
        // publish workflow re-parses, and the whole finished run was thrown away at that point.
        const published = v.parse(
            RunUsageSummarySchema,
            JSON.parse(
                readFileSync(join(result.paths.generationPath, 'llm-usage.json'), 'utf8'),
            ) as unknown,
        );
        expect(published.rates).toEqual(rates);
        expect(published.costUsd).toBeGreaterThan(0);
    });

    it('publishes no reporter identity and no PII-shaped evidence field', () => {
        // Publication is the boundary where evidence leaves the machine, so it answers a stricter
        // question than the generic credential rules do: a reporter's GitHub login and a person's
        // address or account id are not needed to reproduce a fix, and every generation before the
        // two redaction passes were merged blanked them.
        const fixture = createPublicationFixture(null);

        const result = publishLocalRun(
            {
                ...fixture.input,
                agentRunArtifacts: {
                    decision: null,
                    observations: [
                        {
                            sequence: 0,
                            toolCallId: 'call-1',
                            tool: 'get_dom',
                            // A tool result is an arbitrary record of whatever the page returned.
                            result: {
                                id: 'user-9182',
                                email: 'reporter@example.invalid',
                                user: 'alice',
                                key: 'kc-7',
                                sessionKey: 'sk-page',
                                csrfValue: 'c-1',
                                selector: '.ad-banner',
                            },
                        },
                    ],
                },
            },
            {
                idSource: () => '00000000-0000-4000-8000-000000000044',
                now: () => '2026-07-24T00:02:00.000Z',
            },
        );

        expect(result.kind).toBe('published');
        const issueInput = JSON.parse(
            readFileSync(join(result.paths.generationPath, 'issue-input.json'), 'utf8'),
        ) as { comments: { author: unknown; body: unknown }[] };
        expect(issueInput.comments[0]!.author).toBe('[redacted]');
        // ...and the comment itself survives: the report is the evidence, the login is not.
        expect(issueInput.comments[0]!.body).toContain('still there');

        const observations = JSON.parse(
            readFileSync(join(result.paths.generationPath, 'agent-run-artifacts.json'), 'utf8'),
        ) as { observations: { result: Record<string, unknown> }[] };
        const observed = observations.observations[0]!.result;
        expect(observed['id']).toBe('[redacted]');
        expect(observed['email']).toBe('[redacted]');
        // The whole historical key table, not the four generic shapes: a bare `user` or `key`, and
        // the substring forms (`sessionKey`, `csrfValue`) the exact-name credential list misses,
        // were all blanked by the browser-evidence pass this publication absorbed.
        expect(observed['user']).toBe('[redacted]');
        expect(observed['key']).toBe('[redacted]');
        expect(observed['sessionKey']).toBe('[redacted]');
        expect(observed['csrfValue']).toBe('[redacted]');
        // ...and the evidence around them survives: this is redaction, not deletion.
        expect(observed['selector']).toBe('.ad-banner');
    });

    it('fails closed at the source when redaction breaks a schema-required usage field', () => {
        const fixture = createPublicationFixture(null);
        const collector = createRunUsageCollector({ rates: {} });
        collector.addSession({
            completions: [
                {
                    model: 'quiet-model',
                    reported: false,
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    reasoningTokens: 0,
                },
            ],
            durationMs: 120_000,
        });

        expect(() =>
            publishLocalRun(
                {
                    ...fixture.input,
                    llmUsage: collector.summary(),
                    // A configured secret colliding with schema-enum text turns the coverage
                    // literal into the placeholder, which the usage schema must reject here
                    // rather than in the downstream publish workflow.
                    configuredSecrets: [...fixture.input.configuredSecrets, 'none'],
                },
                {
                    idSource: () => '00000000-0000-4000-8000-000000000042',
                    now: () => '2026-07-24T00:02:00.000Z',
                },
            ),
        ).toThrow('llm-usage.json diverged from its schema after redaction at costCoverage');
    });

    it('publishes a legitimate no-candidate result without a false review workspace', () => {
        const fixture = createPublicationFixture(null);

        const result = publishLocalRun(fixture.input, {
            idSource: () => '00000000-0000-4000-8000-000000000011',
            now: () => '2026-07-24T00:02:00.000Z',
        });

        expect(result).toMatchObject({
            kind: 'published',
            paths: { candidatePatchPath: null, reviewCheckoutPath: null },
            manifest: { candidate: { kind: 'not_applicable' }, failure: null },
        });
        expect(verifyLocalPublication(result.paths.generationPath)).toEqual(result.manifest);
    });

    it('publishes a pending-publication run as a legitimate no-candidate outcome', () => {
        const fixture = createPublicationFixture(null);
        attachPendingPublicationExecution(fixture.record);

        const result = publishLocalRun(
            {
                ...fixture.input,
                candidateBinding: bindReviewCandidate(null, fixture.source, fixture.record),
            },
            {
                idSource: () => '00000000-0000-4000-8000-000000000031',
                now: () => '2026-07-24T00:02:00.000Z',
            },
        );

        expect(result.kind).toBe('published');
        expect(result.manifest.candidate).toEqual({
            kind: 'not_applicable',
            disposition: 'no_candidate',
        });
        expect(verifyLocalPublication(result.paths.generationPath)).toEqual(result.manifest);
    });

    it.each(['add', 'edit', 'remove', 'extend_domains'] as const)(
        'keeps a valid %s publication verifiable through the public read boundary',
        (operation) => {
            const fixture = createPublicationFixture(publicationCandidate(operation));
            const result = publishLocalRun(fixture.input, {
                idSource: () => '00000000-0000-4000-8000-000000000021',
                now: () => '2026-07-24T00:02:00.000Z',
            });

            expect(result.kind).toBe('published');
            expect(verifyLocalPublication(result.paths.generationPath)).toEqual(result.manifest);
        },
    );

    it.each([
        {
            name: 'an unknown candidate discriminator',
            mutate: (manifest: Record<string, unknown>) => {
                manifest.candidate = { kind: 'invalid_contract_value' };
            },
        },
        {
            name: 'a missing nested issue field',
            mutate: (manifest: Record<string, unknown>) => {
                delete jsonObject(manifest.issue).revisionDigest;
            },
        },
        {
            name: 'an invalid artifact digest',
            mutate: (manifest: Record<string, unknown>) => {
                const artifacts = manifest.artifacts;
                if (!Array.isArray(artifacts)) {
                    throw new Error('Expected manifest artifacts.');
                }
                jsonObject(artifacts[0]).sha256 = 'not-a-digest';
            },
        },
        {
            name: 'an invalid artifact size',
            mutate: (manifest: Record<string, unknown>) => {
                const artifacts = manifest.artifacts;
                if (!Array.isArray(artifacts)) {
                    throw new Error('Expected manifest artifacts.');
                }
                jsonObject(artifacts[0]).bytes = 0.5;
            },
        },
        {
            name: 'an unknown image discriminator',
            mutate: (manifest: Record<string, unknown>) => {
                manifest.images = [
                    {
                        kind: 'invalid_contract_value',
                        path: 'omitted.png',
                        role: 'browser_evidence',
                        reason: 'untrusted_image_without_pixel_redaction_proof',
                    },
                ];
            },
        },
        {
            name: 'a source commit inconsistent with the locked run',
            mutate: (manifest: Record<string, unknown>) => {
                jsonObject(manifest.source).commit = 'f'.repeat(40);
            },
        },
        {
            name: 'a repository inconsistent with the locked GitHub issue URL',
            mutate: (manifest: Record<string, unknown>) => {
                jsonObject(manifest.issue).repository = 'other/repository';
            },
        },
        {
            name: 'semantic bindings inconsistent with the locked run',
            mutate: (manifest: Record<string, unknown>) => {
                jsonObject(manifest.bindings).environmentChoice = null;
            },
        },
        {
            name: 'an evidence-only outcome with a no-candidate disposition',
            mutate: (manifest: Record<string, unknown>) => {
                manifest.outcome = 'evidence_only';
                manifest.failure = {
                    code: 'review_precondition_failed',
                    stage: 'review_checkout',
                    detail: 'The review checkout could not be created.',
                };
            },
        },
    ])('rejects marker-consistent manifest tampering with $name', ({ mutate }) => {
        const fixture = createPublicationFixture(null);
        const result = publishLocalRun(fixture.input, {
            idSource: () => '00000000-0000-4000-8000-000000000018',
            now: () => '2026-07-24T00:02:00.000Z',
        });
        rewritePublishedManifest(result.paths.generationPath, mutate);

        expect(() => verifyLocalPublication(result.paths.generationPath)).toThrow(
            LocalPublicationTrustError,
        );
    });

    it.each([
        {
            name: 'target byte count',
            mutate: ({ manifest }: BoundPublicationReplayValues) => {
                const operation = jsonObject(jsonObject(manifest.candidate).operation);
                operation.targetBytes = Number(operation.targetBytes) + 1;
            },
        },
        {
            name: 'target blob identity',
            mutate: ({ manifest }: BoundPublicationReplayValues) => {
                const operation = jsonObject(jsonObject(manifest.candidate).operation);
                operation.targetBlobOid = 'f'.repeat(40);
            },
        },
        {
            name: 'target file preimage digest',
            mutate: ({ manifest, reviewReceipt }: BoundPublicationReplayValues) => {
                const forgedDigest = 'f'.repeat(64);
                const operation = jsonObject(jsonObject(manifest.candidate).operation);
                operation.targetFileSha256 = forgedDigest;
                reviewReceipt.candidatePreimageDigest = forgedDigest;
            },
        },
        {
            name: 'target line count',
            mutate: ({ manifest }: BoundPublicationReplayValues) => {
                const operation = jsonObject(jsonObject(manifest.candidate).operation);
                operation.targetLines = Number(operation.targetLines) + 1;
            },
        },
        {
            name: 'exact edit line preimage',
            mutate: ({ manifest, runRecord }: BoundPublicationReplayValues) => {
                const operation = jsonObject(jsonObject(manifest.candidate).operation);
                operation.line = 1;
                operation.originalRule = '! header';
                const candidate = jsonObject(jsonObject(runRecord.result).candidatePatch);
                const edit = jsonObject(candidate.repositoryEdit);
                edit.line = 1;
                edit.originalRule = '! header';
            },
        },
    ])('rejects a fully rehashed bound publication with forged $name', ({ mutate }) => {
        const fixture = createPublicationFixture(publicationCandidate('edit'));
        const result = publishLocalRun(fixture.input, {
            idSource: () => '00000000-0000-4000-8000-000000000022',
            now: () => '2026-07-24T00:02:00.000Z',
        });
        rewriteBoundPublication(result.paths.generationPath, mutate);

        expect(() => verifyLocalPublication(result.paths.generationPath)).toThrow(
            LocalPublicationTrustError,
        );
    });

    it('keeps a bound publication verifiable after transport strips executable modes', () => {
        // actions artifact transport does not preserve file permissions: the .husky hooks in
        // the filters checkout come back mode-stripped, and a filemode-sensitive status called
        // them modified (2026-08-11 publish failures for 237616 and 237760).
        const fixture = createPublicationFixture(publicationCandidate('edit'));
        const result = publishLocalRun(fixture.input, {
            idSource: () => '00000000-0000-4000-8000-000000000033',
            now: () => '2026-07-24T00:02:00.000Z',
        });
        chmodSync(join(result.paths.reviewCheckoutPath!, 'hook.sh'), 0o644);

        expect(verifyLocalPublication(result.paths.generationPath)).toEqual(result.manifest);
    });

    it('keeps a bound publication verifiable after transport drops empty directories', () => {
        // The Actions artifact zip between the analyze and publish jobs preserves file bytes
        // but not empty directories. A shallow detached-HEAD review checkout keeps nothing
        // under .git/refs, so the transported checkout used to fail git's repository check
        // and the whole verified publication died as an anonymous "unsafe artifact".
        const fixture = createPublicationFixture(publicationCandidate('edit'));
        const result = publishLocalRun(fixture.input, {
            idSource: () => '00000000-0000-4000-8000-000000000031',
            now: () => '2026-07-24T00:02:00.000Z',
        });
        dropEmptyDirectories(result.paths.generationPath);
        expect(existsSync(join(result.paths.reviewCheckoutPath!, '.git', 'refs'))).toBe(false);

        expect(verifyLocalPublication(result.paths.generationPath)).toEqual(result.manifest);
    });

    it('publishes a run with more raw images than any single capture produces', () => {
        // A live run on issue 243262 collected 270 raw images across its control,
        // prepared and validation sessions; the manifest then refused its own image list and a
        // verified rule died as an anonymous "unsafe artifact".
        const rawImages = 300;
        const fixture = createPublicationFixture(publicationCandidate('edit'));
        for (let index = 0; index < rawImages; index += 1) {
            writeFileSync(
                join(fixture.collectionDir, `tile-${index}.png`),
                pngWithMetadata(`tile-${index}`),
            );
        }

        const result = publishLocalRun(fixture.input, {
            idSource: () => '00000000-0000-4000-8000-000000000040',
            now: () => '2026-07-24T00:02:00.000Z',
        });

        expect(result.kind).toBe('published');
        expect(
            result.manifest.images.filter((image) => image.path.startsWith('tile-')),
        ).toHaveLength(rawImages);
        expect(verifyLocalPublication(result.paths.generationPath)).toEqual(result.manifest);
    });

    it('names the schema check a persisted JSON artifact failed', () => {
        const schema = v.strictObject({ images: v.pipe(v.array(v.string()), v.maxLength(1)) });
        const bytes = Buffer.from(JSON.stringify({ images: ['secret-one', 'secret-two'] }));

        expect(() => parseVerifiedJsonArtifact(bytes, schema)).toThrow(
            /\[schema: images max_length\]/u,
        );
        expect(() => parseVerifiedJsonArtifact(bytes, schema)).not.toThrow(/secret/u);
    });

    it('names the failing stage and artifact instead of an anonymous trust failure', () => {
        const fixture = createPublicationFixture(publicationCandidate('edit'));
        const result = publishLocalRun(fixture.input, {
            idSource: () => '00000000-0000-4000-8000-000000000032',
            now: () => '2026-07-24T00:02:00.000Z',
        });
        rmSync(join(result.paths.reviewCheckoutPath!, '.git', 'index'));

        expect(() => verifyLocalPublication(result.paths.generationPath)).toThrow(
            /review_checkout:git_failed.*git (status|diff)/,
        );
    });

    it('rejects a rehashed domain extension whose candidate names a scope it never adds', () => {
        const fixture = createPublicationFixture(publicationCandidate('extend_domains'));
        const result = publishLocalRun(fixture.input, {
            idSource: () => '00000000-0000-4000-8000-000000000029',
            now: () => '2026-07-24T00:02:00.000Z',
        });
        rewriteBoundPublication(result.paths.generationPath, ({ runRecord }) => {
            const candidate = jsonObject(jsonObject(runRecord.result).candidatePatch);
            candidate.rule = 'other.example##.shared';
        });

        expect(() => verifyLocalPublication(result.paths.generationPath)).toThrow(
            LocalPublicationTrustError,
        );
    });

    it('rejects a fully rehashed add operation with a forged insertion boundary', () => {
        const fixture = createPublicationFixture(publicationCandidate('add'));
        const result = publishLocalRun(fixture.input, {
            idSource: () => '00000000-0000-4000-8000-000000000023',
            now: () => '2026-07-24T00:02:00.000Z',
        });
        rewriteBoundPublication(result.paths.generationPath, ({ manifest }) => {
            const operation = jsonObject(jsonObject(manifest.candidate).operation);
            operation.beforeLine = '! forged boundary';
            operation.insertionBoundarySha256 = createHash('sha256')
                .update(
                    JSON.stringify({
                        filePath: operation.filePath,
                        targetBlobOid: operation.targetBlobOid,
                        targetFileSha256: operation.targetFileSha256,
                        line: operation.line,
                        beforeLine: operation.beforeLine,
                        afterLine: operation.afterLine,
                    }),
                )
                .digest('hex');
        });

        expect(() => verifyLocalPublication(result.paths.generationPath)).toThrow(
            LocalPublicationTrustError,
        );
    });

    it('keeps a locked EOF add without an anchor verifiable', () => {
        const fixture = createPublicationFixture(eofPublicationCandidate());
        const result = publishLocalRun(fixture.input, {
            idSource: () => '00000000-0000-4000-8000-000000000024',
            now: () => '2026-07-24T00:02:00.000Z',
        });

        expect(verifyLocalPublication(result.paths.generationPath)).toEqual(result.manifest);
    });

    it.each([
        {
            name: 'a mismatched non-EOF anchor',
            candidate: publicationCandidate('add'),
            mutate: (edit: Record<string, unknown>) => {
                edit.anchorRule = '! forged anchor';
            },
        },
        {
            name: 'a missing non-EOF anchor',
            candidate: publicationCandidate('add'),
            mutate: (edit: Record<string, unknown>) => {
                delete edit.anchorRule;
            },
        },
        {
            name: 'an unexpected EOF anchor',
            candidate: eofPublicationCandidate(),
            mutate: (edit: Record<string, unknown>) => {
                edit.anchorRule = '! forged EOF anchor';
            },
        },
    ])('rejects a fully rehashed locked add with $name', ({ candidate, mutate }) => {
        const fixture = createPublicationFixture(candidate);
        const result = publishLocalRun(fixture.input, {
            idSource: () => '00000000-0000-4000-8000-000000000025',
            now: () => '2026-07-24T00:02:00.000Z',
        });
        rewriteBoundPublication(result.paths.generationPath, ({ runRecord }) => {
            const lockedCandidate = jsonObject(jsonObject(runRecord.result).candidatePatch);
            mutate(jsonObject(lockedCandidate.repositoryEdit));
        });

        expect(() => verifyLocalPublication(result.paths.generationPath)).toThrow(
            LocalPublicationTrustError,
        );
    });

    it.each([
        {
            name: 'candidate operation',
            mutate: (manifest: Record<string, unknown>) => {
                const operation = jsonObject(jsonObject(manifest.candidate).operation);
                operation.replacementRule = 'example.com##.other';
            },
        },
        {
            name: 'review receipt',
            mutate: (manifest: Record<string, unknown>) => {
                jsonObject(manifest.review).createdAt = '2026-07-24T00:03:00.000Z';
            },
        },
    ])('rejects a marker-consistent $name that disagrees with locked files', ({ mutate }) => {
        const candidate: CandidatePatch = {
            rule: 'example.com##.new',
            ruleType: 'cosmetic',
            filePath: 'BaseFilter/sections/foreign.txt',
            repositoryEdit: {
                kind: 'replace',
                line: 2,
                originalRule: 'example.com##.old',
                replacementRule: 'example.com##.new',
            },
        };
        const fixture = createPublicationFixture(candidate);
        const result = publishLocalRun(fixture.input, {
            idSource: () => '00000000-0000-4000-8000-000000000019',
            now: () => '2026-07-24T00:02:00.000Z',
        });
        rewritePublishedManifest(result.paths.generationPath, mutate);

        expect(() => verifyLocalPublication(result.paths.generationPath)).toThrow(
            LocalPublicationTrustError,
        );
    });

    it.each([
        {
            name: 'issue input',
            artifactPath: 'issue-input.json' as const,
            bindingName: 'issueInputSha256' as const,
            mutate: (artifact: Record<string, unknown>) => {
                artifact.number = 43;
            },
        },
        {
            name: 'run result',
            artifactPath: 'run-result.json' as const,
            bindingName: 'runRecordSha256' as const,
            mutate: (artifact: Record<string, unknown>) => {
                jsonObject(artifact.result).issueNumber = 43;
            },
        },
    ])('rejects a fully re-digested mismatched locked $name', (tamper) => {
        const fixture = createPublicationFixture(null);
        const result = publishLocalRun(fixture.input, {
            idSource: () => '00000000-0000-4000-8000-000000000020',
            now: () => '2026-07-24T00:02:00.000Z',
        });
        rewriteLockedJsonArtifact(
            result.paths.generationPath,
            tamper.artifactPath,
            tamper.bindingName,
            tamper.mutate,
        );

        expect(() => verifyLocalPublication(result.paths.generationPath)).toThrow(
            LocalPublicationTrustError,
        );
    });

    it('converts a post-sanitization checkout precondition failure to evidence-only output', () => {
        const candidate: CandidatePatch = {
            rule: 'example.com##.new',
            ruleType: 'cosmetic',
            filePath: 'BaseFilter/sections/foreign.txt',
            repositoryEdit: {
                kind: 'replace',
                line: 2,
                originalRule: 'example.com##.old',
                replacementRule: 'example.com##.new',
            },
        };
        const fixture = createPublicationFixture(candidate);
        writeFileSync(
            join(fixture.source.checkoutPath, candidate.filePath),
            '! changed after binding\n',
        );

        const result = publishLocalRun(fixture.input, {
            idSource: () => '00000000-0000-4000-8000-000000000012',
            now: () => '2026-07-24T00:02:00.000Z',
        });

        expect(result).toMatchObject({
            kind: 'evidence_only',
            paths: { candidatePatchPath: null, reviewCheckoutPath: null },
            manifest: {
                outcome: 'evidence_only',
                failure: { code: 'review_precondition_failed', stage: 'review_checkout' },
                review: null,
            },
        });
        expect(existsSync(join(result.paths.generationPath, 'candidate.patch'))).toBe(false);
        expect(existsSync(join(result.paths.generationPath, 'review'))).toBe(false);
        expect(verifyLocalPublication(result.paths.generationPath)).toEqual(result.manifest);
    });

    it('leaves a redaction trust failure unmarked and invisible to consumers', () => {
        const fixture = createPublicationFixture(null);
        writeFileSync(join(fixture.collectionDir, 'unknown.bin'), 'unsafe');

        expect(() =>
            publishLocalRun(fixture.input, {
                idSource: () => '00000000-0000-4000-8000-000000000013',
                now: () => '2026-07-24T00:02:00.000Z',
            }),
        ).toThrow(LocalPublicationTrustError);
        expect(listVerifiedLocalPublications(fixture.outputRoot)).toEqual([]);
        const generations = readdirSync(join(fixture.outputRoot, 'runs'));
        expect(generations).toEqual(['00000000-0000-4000-8000-000000000013']);
        expect(existsSync(join(fixture.outputRoot, 'runs', generations[0], 'PUBLISHED'))).toBe(
            false,
        );
    });

    it('retains an earlier visible generation when a later run publishes', () => {
        const first = createPublicationFixture(null);
        publishLocalRun(first.input, {
            idSource: () => '00000000-0000-4000-8000-000000000014',
            now: () => '2026-07-24T00:02:00.000Z',
        });
        publishLocalRun(first.input, {
            idSource: () => '00000000-0000-4000-8000-000000000015',
            now: () => '2026-07-24T00:03:00.000Z',
        });

        expect(
            listVerifiedLocalPublications(first.outputRoot).map(
                (manifest) => manifest.publicationId,
            ),
        ).toEqual(['00000000-0000-4000-8000-000000000014', '00000000-0000-4000-8000-000000000015']);
    });

    it('verifies without the source, detects review edits, and cleans one exact generation', () => {
        const candidate: CandidatePatch = {
            rule: 'example.com##.new',
            ruleType: 'cosmetic',
            filePath: 'BaseFilter/sections/foreign.txt',
            repositoryEdit: {
                kind: 'replace',
                line: 2,
                originalRule: 'example.com##.old',
                replacementRule: 'example.com##.new',
            },
        };
        const fixture = createPublicationFixture(candidate);
        const first = publishLocalRun(fixture.input, {
            idSource: () => '00000000-0000-4000-8000-000000000016',
            now: () => '2026-07-24T00:02:00.000Z',
        });
        const second = publishLocalRun(fixture.input, {
            idSource: () => '00000000-0000-4000-8000-000000000017',
            now: () => '2026-07-24T00:03:00.000Z',
        });
        rmSync(fixture.source.checkoutPath, { recursive: true, force: true });

        expect(verifyLocalPublication(first.paths.generationPath)).toEqual(first.manifest);
        const reviewTarget = join(
            first.paths.reviewCheckoutPath!,
            'BaseFilter/sections/foreign.txt',
        );
        const expectedReviewBytes = readFileSync(reviewTarget);
        writeFileSync(reviewTarget, 'human edit\n');
        expect(() => verifyLocalPublication(first.paths.generationPath)).toThrow(
            LocalPublicationTrustError,
        );
        writeFileSync(reviewTarget, expectedReviewBytes);

        cleanupLocalPublication(first.paths.generationPath);
        expect(existsSync(first.paths.generationPath)).toBe(false);
        expect(verifyLocalPublication(second.paths.generationPath)).toEqual(second.manifest);
    });
});

/**
 * Publish a fixture's record through the step that owns the private collection.
 *
 * @param fixture - Publication fixture whose collection already holds its evidence files.
 * @returns Compatibility paths into the published generation.
 */
function publishThroughStep(fixture: ReturnType<typeof createPublicationFixture>) {
    return publishVerifiedLocalResult(
        fixture.revision,
        fixture.record,
        fixture.source,
        fixture.collection,
        fixture.outputRoot,
        fixture.input.agentRunArtifacts,
        fixture.input.llmUsage,
        fixture.input.configuredSecrets,
        publishLocalRun,
    );
}

describe('publishVerifiedLocalResult candidate screenshots', () => {
    it('publishes exactly the verified candidate before and after viewport images', () => {
        const candidate: CandidatePatch = {
            rule: 'example.com##.new',
            ruleType: 'cosmetic',
            filePath: 'BaseFilter/sections/foreign.txt',
            repositoryEdit: {
                kind: 'replace',
                line: 2,
                originalRule: 'example.com##.old',
                replacementRule: 'example.com##.new',
            },
        };
        const fixture = createPublicationFixture(candidate);
        writeFileSync(join(fixture.collectionDir, 'unrelated.png'), pngWithMetadata('unrelated'));

        const paths = publishThroughStep(fixture);

        const generation = dirname(paths.runResultPath);
        const manifest = verifyLocalPublication(generation);
        const captures = manifest.images.filter((image) => image.kind === 'capture');
        expect(captures.map((image) => [image.path, image.role]).sort()).toEqual([
            ['after.png', 'candidate-after'],
            ['before.png', 'candidate-before'],
        ]);
        for (const capture of captures) {
            const published = readFileSync(join(generation, 'evidence', capture.path));
            expect(createHash('sha256').update(published).digest('hex')).toBe(capture.sha256);
            expect(published.includes('raw reporter metadata')).toBe(false);
        }
        const omitted = manifest.images.filter((image) => image.kind === 'omitted');
        expect(omitted.map((image) => image.path).sort()).toEqual([
            'after-full.png',
            'before-full.png',
            'unrelated.png',
        ]);
        expect(existsSync(join(generation, 'evidence/unrelated.png'))).toBe(false);
        expect(existsSync(join(generation, 'evidence/before-full.png'))).toBe(false);
    });

    it('fails loudly, naming the path, when a verified candidate screenshot is missing', () => {
        const fixture = createPublicationFixture(publicationCandidate('edit'));
        rmSync(join(fixture.collectionDir, 'after.png'));

        expect(() => publishThroughStep(fixture)).toThrow(/after\.png/u);
    });

    it('publishes no images when the record has no verified candidate screenshots', () => {
        const fixture = createPublicationFixture(null);
        writeFileSync(join(fixture.collectionDir, 'before.png'), pngWithMetadata('before'));

        const paths = publishThroughStep(fixture);

        const manifest = verifyLocalPublication(dirname(paths.runResultPath));
        expect(manifest.images.filter((image) => image.kind === 'capture')).toEqual([]);
    });
});
