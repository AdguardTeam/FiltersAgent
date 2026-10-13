import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { IBrowserSession } from '../../src/browser/browser-interfaces';
import type { FirefoxPolicies } from '../../src/browser/firefox-policies';
import type { PolicySessionRelaunchRequest } from '../../src/browser/prepared-extension-launch';
import { BlockerVerificationMethod } from '../../src/environment/environment-proofs';
import {
    ExtensionLaunchFamily,
    type FirefoxExtensionLaunch,
} from '../../src/environment/extension-launch';
import { createLogger } from '../../src/logger/logger';
import { runFileBackedApplication } from '../../src/orchestrator/file-backed-application';
import { Viewport, ConsentStrategy, type ReproProfile } from '../../src/types/repro-profile';
import {
    ApplicationGoalKind,
    PhaseApplicationOutcomeKind,
} from '../../src/validator/phase-application-contract';

/**
 * The extension id uBlock Origin publishes for Firefox.
 */
const UBLOCK_EXTENSION_ID = 'uBlock0@raymondhill.net';

/**
 * The candidate rule one application applies.
 */
const CANDIDATE_RULE = '||ads.example^$third-party';

/**
 * Reproduction profile the relaunched session must carry.
 */
const REPRO_PROFILE: ReproProfile = {
    userAgentProfile: 'Firefox',
    viewport: Viewport.Desktop,
    locale: 'en-US',
    timezone: 'UTC',
    consentStrategy: ConsentStrategy.Untouched,
};

/**
 * One throwaway host-state root the declared user-filters file is maintained in.
 *
 * @returns The absolute declared target path inside a fresh temp host-state root.
 */
function declaredTargetPath(): string {
    const hostStateRoot = mkdtempSync(join(tmpdir(), 'file-backed-application-'));
    return join(hostStateRoot, 'filters-agent', 'ublock', 'user-filters.txt');
}

/**
 * The Firefox launch declaration of the uBlock Origin example.
 *
 * @returns The declaration with an absolute XPI path.
 */
function firefoxLaunch(): FirefoxExtensionLaunch {
    return {
        launchFamily: ExtensionLaunchFamily.Firefox,
        extensionId: UBLOCK_EXTENSION_ID,
        xpiPath: join(tmpdir(), 'ublock-origin.firefox.signed.xpi'),
        managedStorageTemplate: {
            adminSettings: { selectedFilterLists: ['user-filters', 'ublock-filters'] },
        },
        userFiltersKeyPath: ['adminSettings', 'userFilters'],
    };
}

/**
 * The user filters one rebuilt policies payload carries into managed storage.
 *
 * @param policies - The policies the relaunch received.
 * @returns The content at the declared key path.
 */
function managedUserFilters(policies: FirefoxPolicies): unknown {
    const managed = policies.policies['3rdparty']!.Extensions[UBLOCK_EXTENSION_ID] as {
        adminSettings: { userFilters: unknown };
    };
    return managed.adminSettings.userFilters;
}

/**
 * A stub session standing in for a running phase session; the application never drives it, it only
 * hands it to the relaunch seam.
 *
 * @returns The stub session.
 */
function stubSession(): IBrowserSession {
    return { close: vi.fn(async () => {}) } as unknown as IBrowserSession;
}

describe('runFileBackedApplication', () => {
    it('writes the file empty, relaunches with rebuilt policies and credits the baseline', async () => {
        const targetPath = declaredTargetPath();
        mkdirSync(join(targetPath, '..'), { recursive: true });
        writeFileSync(targetPath, `${CANDIDATE_RULE}\n`, 'utf8');
        const previous = stubSession();
        const replacement = stubSession();
        const relaunched: PolicySessionRelaunchRequest[] = [];

        const outcome = await runFileBackedApplication({
            goal: { kind: ApplicationGoalKind.Baseline },
            method: BlockerVerificationMethod.ManagedStorageFile,
            targetPath,
            launch: firefoxLaunch(),
            session: previous,
            reproProfile: REPRO_PROFILE,
            relaunch: async (request) => {
                relaunched.push(request);
                return replacement;
            },
            logger: createLogger(),
        });

        expect(outcome.result.kind).toBe(PhaseApplicationOutcomeKind.Applied);
        expect(outcome.session).toBe(replacement);
        expect(readFileSync(targetPath, 'utf8')).toBe('');
        expect(relaunched).toHaveLength(1);
        expect(relaunched[0]!.previous).toBe(previous);
        expect(relaunched[0]!.reproProfile).toEqual(REPRO_PROFILE);
        expect(managedUserFilters(relaunched[0]!.firefoxPolicies)).toBe('');
        const detail =
            outcome.result.kind === PhaseApplicationOutcomeKind.Applied
                ? outcome.result.detail
                : undefined;
        expect(detail).toContain(targetPath);
        expect(detail).toContain('relaunched');
    });

    it('writes exactly the candidate line, carries it into managed storage and credits the candidate', async () => {
        const targetPath = declaredTargetPath();
        const previous = stubSession();
        const replacement = stubSession();
        const relaunched: PolicySessionRelaunchRequest[] = [];

        const outcome = await runFileBackedApplication({
            goal: { kind: ApplicationGoalKind.Candidate, rule: CANDIDATE_RULE },
            method: BlockerVerificationMethod.ManagedStorageFile,
            targetPath,
            launch: firefoxLaunch(),
            session: previous,
            reproProfile: REPRO_PROFILE,
            relaunch: async (request) => {
                relaunched.push(request);
                return replacement;
            },
            logger: createLogger(),
        });

        expect(outcome.result.kind).toBe(PhaseApplicationOutcomeKind.Applied);
        expect(readFileSync(targetPath, 'utf8')).toBe(`${CANDIDATE_RULE}\n`);
        expect(managedUserFilters(relaunched[0]!.firefoxPolicies)).toBe(`${CANDIDATE_RULE}\n`);
        const readBack =
            outcome.result.kind === PhaseApplicationOutcomeKind.Applied
                ? outcome.result.readBack
                : undefined;
        expect(readBack?.rulesContent).toBe(CANDIDATE_RULE);
    });

    it('leaves the phase unverified when the declared state changed under the relaunch', async () => {
        const targetPath = declaredTargetPath();
        const previous = stubSession();
        const replacement = stubSession();

        const outcome = await runFileBackedApplication({
            goal: { kind: ApplicationGoalKind.Candidate, rule: CANDIDATE_RULE },
            method: BlockerVerificationMethod.ManagedStorageFile,
            targetPath,
            launch: firefoxLaunch(),
            session: previous,
            reproProfile: REPRO_PROFILE,
            relaunch: async () => {
                writeFileSync(targetPath, `${CANDIDATE_RULE}\n||other.example^\n`, 'utf8');
                return replacement;
            },
            logger: createLogger(),
        });

        expect(outcome.result.kind).toBe(PhaseApplicationOutcomeKind.Unverified);
        // The replacement session is handed back even for a failed credit: it is the one that is
        // running, and the caller has to close it.
        expect(outcome.session).toBe(replacement);
        const detail =
            outcome.result.kind === PhaseApplicationOutcomeKind.Unverified
                ? outcome.result.detail
                : '';
        expect(detail).toContain('does not contain exactly the candidate');
    });

    it('leaves the phase unverified, without relaunching, when the declared file cannot be written', async () => {
        const targetPath = declaredTargetPath();
        // A directory where the declared file belongs: the write fails and nothing downstream runs.
        mkdirSync(targetPath, { recursive: true });
        const previous = stubSession();
        const relaunch = vi.fn(async () => previous);

        const outcome = await runFileBackedApplication({
            goal: { kind: ApplicationGoalKind.Baseline },
            method: BlockerVerificationMethod.ManagedStorageFile,
            targetPath,
            launch: firefoxLaunch(),
            session: previous,
            reproProfile: REPRO_PROFILE,
            relaunch,
            logger: createLogger(),
        });

        expect(outcome.result.kind).toBe(PhaseApplicationOutcomeKind.Unverified);
        expect(outcome.session).toBeUndefined();
        expect(relaunch).not.toHaveBeenCalled();
        const detail =
            outcome.result.kind === PhaseApplicationOutcomeKind.Unverified
                ? outcome.result.detail
                : '';
        expect(detail).toContain(targetPath);
        const actionLog =
            outcome.result.kind === PhaseApplicationOutcomeKind.Unverified
                ? outcome.result.actionLog
                : [];
        expect(actionLog.at(-1)?.ok).toBe(false);
    });
});
