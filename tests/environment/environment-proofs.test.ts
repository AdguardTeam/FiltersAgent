import { createHash } from 'node:crypto';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import {
    BlockerVerificationMethod,
    EnvironmentPhaseStateProofSchema,
    PROOF_ACTION_LOG_MAX_ENTRIES,
    PROOF_ACTION_LOG_SUMMARY_MAX,
    PreparedExtensionProvenanceSchema,
} from '../../src/environment/environment-proofs';
import {
    ExtensionManifestVersion,
    PreparedExtensionSource,
} from '../../src/environment/extension-preparation';
import type { PhaseApplicationProof } from '../../src/environment/environment-proofs';

const actualContext = {
    kind: 'browser_extension' as const,
    product: 'AdGuard Browser Extension',
    browser: 'CloakBrowser Chromium',
    productVersion: '5.0.0',
};

const cliActualContext = {
    kind: 'adguard_cli' as const,
    product: 'AdGuard CLI',
    browser: 'CloakBrowser Chromium',
    productVersion: '1.4.13',
};

/**
 * Build one CLI-authored published-baseline proof with the requested enabled set.
 *
 * @param enabledListKeys - Requested list keys the phase claims are enabled.
 * @returns Proof input shaped exactly as the recorder receives it.
 */
function cliBaselineProof(enabledListKeys: string[]): unknown {
    return {
        leaseId: 'lease-b',
        adapterStateDigest: 'd'.repeat(64),
        phase: 'B',
        filteringState: 'published_baseline',
        sessionId: 'session-b',
        actualContext: cliActualContext,
        baselineDigest: 'e'.repeat(64),
        candidateDigest: null,
        extension: null,
        cli: {
            cliVersion: '1.4.13',
            enabledListKeys,
            coenabledListKeys: ['adguard:1'],
            userFilterEnabled: true,
        },
    };
}

/**
 * Build one CLI-authored candidate-phase proof over the same baseline the B proof describes.
 *
 * @param candidateDigest - Digest of the exact candidate the phase claims to execute.
 * @returns Proof input shaped exactly as the recorder receives it.
 */
function cliCandidateProof(candidateDigest: string | null): unknown {
    return {
        ...(cliBaselineProof(['adguard:2', 'adguard:14']) as Record<string, unknown>),
        leaseId: 'lease-c',
        phase: 'C',
        filteringState: 'published_baseline_plus_candidate',
        sessionId: 'session-c',
        candidateDigest,
    };
}

describe('EnvironmentPhaseStateProofSchema', () => {
    it('accepts a CLI published-baseline phase that proves the requested lists enabled', () => {
        const proof = v.parse(
            EnvironmentPhaseStateProofSchema,
            cliBaselineProof(['adguard:2', 'adguard:14']),
        );

        expect(proof).toMatchObject({
            phase: 'B',
            extension: null,
            cli: { enabledListKeys: ['adguard:2', 'adguard:14'], coenabledListKeys: ['adguard:1'] },
        });
    });

    it('refuses a CLI published-baseline phase with no requested list enabled', () => {
        expect(v.safeParse(EnvironmentPhaseStateProofSchema, cliBaselineProof([])).success).toBe(
            false,
        );
    });

    it('accepts a CLI candidate phase that names the candidate beside the locked baseline', () => {
        const proof = v.parse(EnvironmentPhaseStateProofSchema, cliCandidateProof('f'.repeat(64)));

        expect(proof).toMatchObject({
            phase: 'C',
            filteringState: 'published_baseline_plus_candidate',
            candidateDigest: 'f'.repeat(64),
            extension: null,
            cli: { enabledListKeys: ['adguard:2', 'adguard:14'] },
        });
    });

    it('refuses a CLI candidate phase that names no candidate', () => {
        expect(v.safeParse(EnvironmentPhaseStateProofSchema, cliCandidateProof(null)).success).toBe(
            false,
        );
    });

    it('refuses a phase-A proof whose CLI proof claims lists enabled', () => {
        const phaseA = {
            ...(cliBaselineProof(['adguard:2']) as Record<string, unknown>),
            phase: 'A',
            filteringState: 'disabled',
            sessionId: 'session-a',
            baselineDigest: null,
            candidateDigest: null,
            leaseId: 'lease-a',
        };
        expect(v.safeParse(EnvironmentPhaseStateProofSchema, phaseA).success).toBe(false);
    });

    it('keeps an Extension published-baseline proof parsing without the CLI member', () => {
        const proof = v.parse(EnvironmentPhaseStateProofSchema, {
            leaseId: 'lease-b',
            adapterStateDigest: 'd'.repeat(64),
            phase: 'B',
            filteringState: 'published_baseline',
            sessionId: 'session-b',
            actualContext,
            baselineDigest: 'e'.repeat(64),
            candidateDigest: null,
            extension: {
                packageVersion: '5.0.0',
                manifestVersion: '5.0.0',
                profileKind: 'agent_selected',
                enabledListKeys: ['adguard:2'],
                activeRulesetListKeys: ['adguard:2'],
                stealthEnabled: false,
                userRulesDigest: null,
                application: {
                    method: BlockerVerificationMethod.ExtensionState,
                    appliedRules: [],
                    actionLog: [],
                },
            },
        });

        expect(proof).not.toHaveProperty('cli');
    });
});

/**
 * SHA-256 of the exact newline-joined user-rule content a proof claims was applied.
 *
 * @param appliedRules - Rules the application claims to have applied, one per line.
 * @returns The lowercase hex digest of the newline-joined content.
 */
function appliedRulesDigest(appliedRules: string[]): string {
    return createHash('sha256').update(appliedRules.join('\n'), 'utf8').digest('hex');
}

/**
 * Build an extension-authored candidate-phase proof body around the requested application record.
 *
 * @param options - Optional application record (omitted to prove the required-on-C rule).
 * @returns A proof input carrying a candidate digest plus matching user rules digest.
 */
function extensionCandidateProof(options: { application?: PhaseApplicationProof } = {}): unknown {
    const appliedRules = ['example.test##.ad'];
    return {
        leaseId: 'lease-c',
        adapterStateDigest: 'd'.repeat(64),
        phase: 'C',
        filteringState: 'published_baseline_plus_candidate',
        sessionId: 'session-c',
        actualContext,
        baselineDigest: 'e'.repeat(64),
        candidateDigest: appliedRulesDigest(appliedRules),
        extension: {
            packageVersion: '5.0.0',
            manifestVersion: '5.0.0',
            profileKind: 'agent_selected',
            enabledListKeys: ['adguard:2'],
            activeRulesetListKeys: ['adguard:2'],
            stealthEnabled: false,
            userRulesDigest: appliedRulesDigest(appliedRules),
            ...(options.application === undefined ? {} : { application: options.application }),
        },
    };
}

/**
 * Build an extension-authored baseline-phase proof body around the requested application record.
 *
 * @param options - Optional application record override for the baseline phase.
 * @returns A proof input shaped exactly as the recorder receives phase B.
 */
function extensionBaselineProof(options: { application?: PhaseApplicationProof } = {}): unknown {
    return {
        leaseId: 'lease-b',
        adapterStateDigest: 'd'.repeat(64),
        phase: 'B',
        filteringState: 'published_baseline',
        sessionId: 'session-b',
        actualContext,
        baselineDigest: 'e'.repeat(64),
        candidateDigest: null,
        extension: {
            packageVersion: '5.0.0',
            manifestVersion: '5.0.0',
            profileKind: 'agent_selected',
            enabledListKeys: ['adguard:2'],
            activeRulesetListKeys: ['adguard:2'],
            stealthEnabled: false,
            userRulesDigest: null,
            ...(options.application === undefined ? {} : { application: options.application }),
        },
    };
}

describe('EnvironmentPhaseStateProofSchema application contract', () => {
    it('accepts a phase-C proof whose applied rules digest proves the candidate user rules', () => {
        const proof = v.parse(
            EnvironmentPhaseStateProofSchema,
            extensionCandidateProof({
                application: {
                    method: BlockerVerificationMethod.ExtensionState,
                    appliedRules: ['example.test##.ad'],
                    actionLog: [
                        {
                            tool: 'browser_navigate',
                            ok: true,
                            summary: 'Opened the options page.',
                        },
                    ],
                },
            }),
        );

        expect(proof.extension?.application).toMatchObject({
            method: BlockerVerificationMethod.ExtensionState,
            appliedRules: ['example.test##.ad'],
        });
    });

    it('refuses a phase-C proof without an application record', () => {
        expect(
            v.safeParse(EnvironmentPhaseStateProofSchema, extensionCandidateProof()).success,
        ).toBe(false);
    });

    it('refuses a phase-C proof whose applied rules digest does not prove the user rules', () => {
        const proof = extensionCandidateProof({
            application: {
                method: BlockerVerificationMethod.ExtensionState,
                appliedRules: ['other.test##.banner'],
                actionLog: [],
            },
        });
        expect(v.safeParse(EnvironmentPhaseStateProofSchema, proof).success).toBe(false);
    });

    it('refuses a phase-C proof whose proven user-rules digest differs from the candidate digest', () => {
        const proof = extensionCandidateProof({
            application: {
                method: BlockerVerificationMethod.ExtensionState,
                appliedRules: ['example.test##.ad'],
                actionLog: [],
            },
        }) as { candidateDigest: string };
        const mismatched = {
            ...proof,
            candidateDigest: 'f'.repeat(64),
        };
        expect(v.safeParse(EnvironmentPhaseStateProofSchema, mismatched).success).toBe(false);
    });

    it('refuses a phase-B proof without an application record', () => {
        expect(
            v.safeParse(EnvironmentPhaseStateProofSchema, extensionBaselineProof()).success,
        ).toBe(false);
    });

    it('refuses a phase-B proof whose application claims applied rules', () => {
        expect(
            v.safeParse(
                EnvironmentPhaseStateProofSchema,
                extensionBaselineProof({
                    application: {
                        method: BlockerVerificationMethod.ExtensionState,
                        appliedRules: ['example.test##.ad'],
                        actionLog: [],
                    },
                }),
            ).success,
        ).toBe(false);
    });

    it('accepts a phase-B proof whose application records an empty applied set', () => {
        const proof = v.parse(
            EnvironmentPhaseStateProofSchema,
            extensionBaselineProof({
                application: {
                    method: BlockerVerificationMethod.ExtensionState,
                    appliedRules: [],
                    actionLog: [],
                },
            }),
        );

        expect(proof.extension?.application?.appliedRules).toEqual([]);
    });

    it('keeps a CLI candidate proof counting without an application record', () => {
        const cliCandidate = {
            ...(cliBaselineProof(['adguard:2']) as Record<string, unknown>),
            leaseId: 'lease-c',
            phase: 'C',
            filteringState: 'published_baseline_plus_candidate',
            sessionId: 'session-c',
            candidateDigest: 'f'.repeat(64),
        };

        expect(v.parse(EnvironmentPhaseStateProofSchema, cliCandidate).extension).toBeNull();
    });

    it('refuses an action log beyond the bounded entry count', () => {
        const proof = extensionCandidateProof({
            application: {
                method: BlockerVerificationMethod.ExtensionState,
                appliedRules: ['example.test##.ad'],
                actionLog: Array.from({ length: PROOF_ACTION_LOG_MAX_ENTRIES + 1 }, () => ({
                    tool: 'browser_snapshot',
                    ok: true,
                    summary: 'Snapshot taken.',
                })),
            },
        });

        expect(v.safeParse(EnvironmentPhaseStateProofSchema, proof).success).toBe(false);
    });

    it('refuses an action log entry whose summary exceeds the bounded length', () => {
        const proof = extensionCandidateProof({
            application: {
                method: BlockerVerificationMethod.ExtensionState,
                appliedRules: ['example.test##.ad'],
                actionLog: [
                    {
                        tool: 'browser_snapshot',
                        ok: true,
                        summary: 'x'.repeat(PROOF_ACTION_LOG_SUMMARY_MAX + 1),
                    },
                ],
            },
        });

        expect(v.safeParse(EnvironmentPhaseStateProofSchema, proof).success).toBe(false);
    });

    it('refuses an action log entry without a named tool', () => {
        const proof = extensionCandidateProof({
            application: {
                method: BlockerVerificationMethod.ExtensionState,
                appliedRules: ['example.test##.ad'],
                actionLog: [{ tool: '', ok: true, summary: 'No tool name.' }],
            },
        });

        expect(v.safeParse(EnvironmentPhaseStateProofSchema, proof).success).toBe(false);
    });
});

const historicalBuild = {
    version: '5.4.3.99',
    releaseTag: 'v5.4.3.1',
    releaseSha256: 'a'.repeat(64),
    autobuildTag: 'autobuild-v5.4.3.99',
    autobuildCommit: 'b'.repeat(40),
};

const pinnedProvenance = {
    source: PreparedExtensionSource.PinnedRelease,
    extensionPath: '/tmp/extension',
    manifestVersion: ExtensionManifestVersion.Mv3,
    extensionSourceSha256: 'c'.repeat(64),
    extensionSourceTag: 'v5.5.2.3',
};

describe('PreparedExtensionProvenanceSchema', () => {
    it('parses a historical-build provenance with its release and autobuild identity', () => {
        const provenance = {
            ...pinnedProvenance,
            source: PreparedExtensionSource.HistoricalBuild,
            extensionSourceTag: historicalBuild.autobuildTag,
            historicalBuild,
        };

        expect(v.parse(PreparedExtensionProvenanceSchema, provenance)).toEqual(provenance);
    });

    it('refuses a historical-build provenance without its build identity and a build identity on another source', () => {
        expect(
            v.safeParse(PreparedExtensionProvenanceSchema, {
                ...pinnedProvenance,
                source: PreparedExtensionSource.HistoricalBuild,
            }).success,
        ).toBe(false);
        expect(
            v.safeParse(PreparedExtensionProvenanceSchema, {
                ...pinnedProvenance,
                historicalBuild,
            }).success,
        ).toBe(false);
    });

    it('keeps parsing a pinned-release provenance written before historical builds', () => {
        expect(v.parse(PreparedExtensionProvenanceSchema, pinnedProvenance)).toEqual(
            pinnedProvenance,
        );
    });
});
