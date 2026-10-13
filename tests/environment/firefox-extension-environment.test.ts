import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as v from 'valibot';
import type { IBrowserSession } from '../../src/browser/browser-interfaces';
import { declaredBaselineListKeys } from '../../src/environment/declared-filter-baseline';
import {
    BlockerVerificationMethod,
    EnvironmentPhaseStateProofSchema,
} from '../../src/environment/environment-proofs';
import {
    ExtensionLaunchFamily,
    type FirefoxExtensionLaunch,
} from '../../src/environment/extension-launch';
import { FirefoxExtensionEnvironmentAdapter } from '../../src/environment/firefox-extension-environment';
import type {
    AdapterPhaseLease,
    EnvironmentPhaseOpenResult,
} from '../../src/environment/filtering-environment';
import { normalizeRulesContent, sha256OfContent } from '../../src/environment/rules-content';
import { createLogger } from '../../src/logger/logger';
import { runFileBackedApplication } from '../../src/orchestrator/file-backed-application';
import { projectApplicationResult } from '../../src/orchestrator/phase-application-file-backed';
import { ConsentStrategy, Viewport, type ReproProfile } from '../../src/types/repro-profile';
import { SettingsProfileKind } from '../../src/types/settings-profile-kind';
import { PhaseLabel } from '../../src/types/validation';
import { ApplicationGoalKind } from '../../src/validator/phase-application-contract';

/**
 * The extension id uBlock Origin publishes for Firefox.
 */
const UBLOCK_EXTENSION_ID = 'uBlock0@raymondhill.net';

/**
 * The candidate rule phase C applies.
 */
const CANDIDATE_RULE = 'example.test##.articleAdSlot';

/**
 * The target page every phase observes.
 */
const TARGET_URL = 'https://example.test/article';

/**
 * Reproduction profile the phases observe the target with.
 */
const REPRO_PROFILE: ReproProfile = {
    userAgentProfile: 'Firefox',
    viewport: Viewport.Desktop,
    locale: 'en-US',
    timezone: 'UTC',
    consentStrategy: ConsentStrategy.Untouched,
};

/**
 * The Firefox launch declaration of the shipped uBlock Origin example, list selection included.
 *
 * @returns The declaration with an absolute XPI path.
 */
function ublockLaunch(): FirefoxExtensionLaunch {
    return {
        launchFamily: ExtensionLaunchFamily.Firefox,
        extensionId: UBLOCK_EXTENSION_ID,
        xpiPath: join(tmpdir(), 'ublock-origin.firefox.signed.xpi'),
        managedStorageTemplate: {
            adminSettings: {
                selectedFilterLists: [
                    'user-filters',
                    'ublock-filters',
                    'ublock-badware',
                    'easylist',
                ],
            },
        },
        userFiltersKeyPath: ['adminSettings', 'userFilters'],
    };
}

/**
 * A stub session standing in for a running Firefox phase session.
 *
 * @param label - Identity carried so a replacement is distinguishable from what it replaced.
 * @returns The stub session.
 */
function stubSession(label: string): IBrowserSession {
    return { label, close: vi.fn(async () => {}) } as unknown as IBrowserSession;
}

/**
 * What one adapter under test recorded while its phases ran.
 */
interface AdapterHarness {
    /**
     * The adapter under test.
     */
    adapter: FirefoxExtensionEnvironmentAdapter;

    /**
     * Absolute path of the declared user-filters file the host maintains.
     */
    targetPath: string;

    /**
     * The extension roots each phase's session request named, in phase order.
     */
    requestedRoots: (string | null)[];

    /**
     * The sessions the relaunch produced, in relaunch order.
     */
    replacements: IBrowserSession[];
}

/**
 * Build one adapter over a real declared file, wired to the production file application.
 *
 * The configuration seam is the run's own composition: the host writes the declared file, rebuilds
 * the enterprise policies, relaunches the session and reads the file back. Only the browser itself
 * is a stub, so the phase credits and proofs this suite asserts are the ones a run produces.
 *
 * @param targetPath - Absolute path of the declared user-filters file.
 * @returns The adapter and the records its seams collected.
 */
function adapterOverDeclaredFile(targetPath: string): AdapterHarness {
    const launch = ublockLaunch();
    const requestedRoots: (string | null)[] = [];
    const replacements: IBrowserSession[] = [];
    let created = 0;
    const adapter = new FirefoxExtensionEnvironmentAdapter({
        extensionId: launch.extensionId,
        xpiPath: launch.xpiPath,
        declaredListKeys: declaredBaselineListKeys(launch),
        profileKind: SettingsProfileKind.DefaultsPlusRequired,
        application: 'read: managed-storage-file filters-agent/ublock/user-filters.txt',
        buildDigest: 'b'.repeat(64),
        createSession: async (request) => {
            requestedRoots.push(request.extensionRoot);
            created += 1;
            return { session: stubSession(`phase-${request.phase}-${created}`) };
        },
        phaseConfiguration: async (session, request) => {
            const outcome = await runFileBackedApplication({
                goal:
                    request.candidateRule === null
                        ? { kind: ApplicationGoalKind.Baseline }
                        : { kind: ApplicationGoalKind.Candidate, rule: request.candidateRule },
                method: BlockerVerificationMethod.ManagedStorageFile,
                targetPath,
                launch,
                session,
                reproProfile: REPRO_PROFILE,
                relaunch: async (relaunch) => {
                    await relaunch.previous.close();
                    const replacement = stubSession(`relaunched-${replacements.length + 1}`);
                    replacements.push(replacement);
                    return replacement;
                },
                logger: createLogger(),
            });
            return projectApplicationResult(
                outcome.result,
                BlockerVerificationMethod.ManagedStorageFile,
                outcome.session,
            );
        },
    });
    return { adapter, targetPath, requestedRoots, replacements };
}

/**
 * Open one phase and fail the suite loudly with the limitation when it does not open.
 *
 * @param opened - The phase open result.
 * @returns The established lease.
 */
function requireLease(opened: EnvironmentPhaseOpenResult): AdapterPhaseLease {
    if (!opened.ready) {
        throw new Error(
            `The phase did not open: [${opened.limitation.code}] ${opened.limitation.detail}`,
        );
    }
    return opened.handle;
}

/**
 * A fresh declared target path inside its own temp host-state root.
 *
 * @returns The absolute path the instruction's state verification declares.
 */
function declaredTargetPath(): string {
    const hostStateRoot = mkdtempSync(join(tmpdir(), 'firefox-environment-'));
    return join(hostStateRoot, 'filters-agent', 'ublock', 'user-filters.txt');
}

describe('FirefoxExtensionEnvironmentAdapter', () => {
    it('reaches phases A, B and C on the declared list selection and the declared file', async () => {
        const harness = adapterOverDeclaredFile(declaredTargetPath());
        const declaredKeys = [
            'declared:easylist',
            'declared:ublock-badware',
            'declared:ublock-filters',
            'declared:user-filters',
        ];

        // Decision 1: the executable baseline is the declaration, so nothing is requested.
        const prepared = await harness.adapter.prepare({ requestedLists: [] });
        expect(prepared.ready).toBe(true);
        expect(harness.adapter.snapshot().baseline).toMatchObject({
            environment: 'browser_extension',
            enabledListKeys: declaredKeys,
            resources: [],
            // No list file is ever opened, so every enabled list is named unattributed rather than
            // claimed byte-proven.
            unattributedListKeys: declaredKeys,
        });

        const phaseA = requireLease(
            await harness.adapter.openPhase({
                experimentId: 'experiment-1',
                phase: PhaseLabel.A,
                targetUrl: TARGET_URL,
                candidate: null,
            }),
        );
        expect(phaseA.adapterProof.filteringState).toBe('disabled');
        expect(phaseA.adapterProof.extension).toBeNull();
        expect(phaseA.adapterProof.baselineDigest).toBeNull();
        expect(() => v.parse(EnvironmentPhaseStateProofSchema, phaseA.adapterProof)).not.toThrow();

        const phaseB = requireLease(
            await harness.adapter.openPhase({
                experimentId: 'experiment-1',
                phase: PhaseLabel.B,
                targetUrl: TARGET_URL,
                candidate: null,
            }),
        );
        // Decision 2: B is the declaration's lists with an empty user-filters file, and the proof
        // reports the declared enabled set rather than "not observed".
        expect(readFileSync(harness.targetPath, 'utf8')).toBe('');
        expect(phaseB.adapterProof.filteringState).toBe('published_baseline');
        expect(phaseB.adapterProof.extension).toMatchObject({
            enabledListKeys: declaredKeys,
            userRulesDigest: null,
            stealthEnabled: null,
            application: { method: 'managed-storage-file', appliedRules: [] },
        });
        expect(phaseB.adapterProof.extension?.application?.detail).toContain(harness.targetPath);
        expect(phaseB.adapterProof.extension?.application?.detail).toContain('relaunched');
        expect(() => v.parse(EnvironmentPhaseStateProofSchema, phaseB.adapterProof)).not.toThrow();
        // The application relaunched the browser so it would read the rebuilt policies; the lease
        // the validators observe is the session that is live now.
        expect(phaseB.session).toBe(harness.replacements.at(-1));

        const phaseC = requireLease(
            await harness.adapter.openPhase({
                experimentId: 'experiment-1',
                phase: PhaseLabel.C,
                targetUrl: TARGET_URL,
                candidate: { operation: 'add', rule: CANDIDATE_RULE },
            }),
        );
        const candidateDigest = sha256OfContent(normalizeRulesContent(CANDIDATE_RULE));
        expect(readFileSync(harness.targetPath, 'utf8')).toBe(`${CANDIDATE_RULE}\n`);
        expect(phaseC.adapterProof.filteringState).toBe('published_baseline_plus_candidate');
        expect(phaseC.adapterProof.candidateDigest).toBe(candidateDigest);
        expect(phaseC.adapterProof.extension).toMatchObject({
            enabledListKeys: declaredKeys,
            userRulesDigest: candidateDigest,
            application: { method: 'managed-storage-file', appliedRules: [CANDIDATE_RULE] },
        });
        expect(() => v.parse(EnvironmentPhaseStateProofSchema, phaseC.adapterProof)).not.toThrow();

        // No phase of this family ever names an unpacked root: A runs with no policies at all and
        // B and C force-install the signed XPI.
        expect(harness.requestedRoots).toEqual([null, null, null]);

        const cleanup = await harness.adapter.cleanup();
        expect(cleanup.completed).toBe(true);
        expect(harness.adapter.snapshot().openLeaseIds).toEqual([]);
    });

    it('does not open a phase whose declared file cannot be written', async () => {
        const hostStateRoot = mkdtempSync(join(tmpdir(), 'firefox-environment-unwritable-'));
        // The declared file's parent is an ordinary file, so creating the directory fails and the
        // host can never write the state the phase would be credited from.
        const blocker = join(hostStateRoot, 'ublock');
        writeFileSync(blocker, 'not a directory', 'utf8');
        const harness = adapterOverDeclaredFile(join(blocker, 'user-filters.txt'));
        await harness.adapter.prepare({ requestedLists: [] });

        const opened = await harness.adapter.openPhase({
            experimentId: 'experiment-1',
            phase: PhaseLabel.B,
            targetUrl: TARGET_URL,
            candidate: null,
        });

        expect(opened.ready).toBe(false);
        if (!opened.ready) {
            expect(opened.limitation.code).toBe('phase_proof_unavailable');
            expect(opened.limitation.detail).toContain('user-filters.txt');
        }
        expect(harness.replacements).toEqual([]);
        await harness.adapter.cleanup();
    });
});
