import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
    ApplicationGoalKind,
    PhaseApplicationOutcomeKind,
    type PhaseApplicationRunner,
    type PhaseApplicationRunnerResult,
    type PhaseApplicationSession,
} from '../../src/validator/phase-application-contract';
import { runPhaseApplication } from '../../src/validator/phase-application-procedure';
import {
    fileBlockerStateReader,
    type BlockerStateRead,
} from '../../src/validator/blocker-state-readers';
import { ApplicationInstructionGap } from '../../src/environment/application-instruction-gap';
import { BlockerVerificationMethod } from '../../src/environment/environment-proofs';
import { SettingsLimitation } from '../../src/environment/settings-limitation';
import type { ActionLogEntry } from '../../src/environment/environment-proofs';

const TARGET_URL = 'https://example.org/article';

const FIXTURE_INSTRUCTION = [
    '# The blocker',
    '',
    '## Rule application',
    '',
    'Open the options page and add the rule from the goal as one exact line, then save.',
    '',
    '## State verification',
    '',
    'read: extension-state user-rules',
    '',
].join('\n');

function sha256(content: string): string {
    return createHash('sha256').update(content, 'utf8').digest('hex');
}

function entry(tool: string, ok: boolean, summary: string): ActionLogEntry {
    return { tool, ok, summary };
}

function fakeRunner(
    result: Partial<PhaseApplicationRunnerResult> = {},
): PhaseApplicationRunner & { calls: { prompt: string }[] } {
    const calls: { prompt: string }[] = [];
    return {
        calls,
        run: vi.fn(async (request: { prompt: string }) => {
            calls.push({ prompt: request.prompt });
            return {
                completed: result.completed ?? true,
                ...(result.detail === undefined ? {} : { detail: result.detail }),
                actionLog: result.actionLog ?? [entry('get_dom', true, 'read the page')],
            };
        }),
    };
}

function session(overrides: Partial<PhaseApplicationSession> = {}): PhaseApplicationSession {
    return {
        targetUrl: TARGET_URL,
        blockerSurfaceUrl: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/pages/options.html',
        notes: '',
        ...overrides,
    };
}

describe('runPhaseApplication refusals', () => {
    it('refuses an instruction without a state-verification section before any model turn', async () => {
        const runner = fakeRunner();
        const withoutVerification = [
            '# The blocker',
            '',
            '## Rule application',
            '',
            'Add the rule.',
            '',
        ].join('\n');

        const outcome = await runPhaseApplication({
            application: withoutVerification,
            goal: { kind: ApplicationGoalKind.Candidate, rule: 'example.com##.ad-slot' },
            session: session(),
            runner,
            readBack: {},
        });

        expect(outcome).toEqual({
            kind: 'refused',
            gap: ApplicationInstructionGap.NoVerificationMethod,
            detail: expect.stringMatching(/state-verification/),
        });
        expect(runner.run).not.toHaveBeenCalled();
    });

    it('refuses an instruction without a rule-application section before any model turn', async () => {
        const runner = fakeRunner();

        const outcome = await runPhaseApplication({
            application: '# The blocker\n\nSome prose.\n',
            goal: { kind: ApplicationGoalKind.Baseline },
            session: session(),
            runner,
            readBack: {},
        });

        expect(outcome).toMatchObject({
            kind: 'refused',
            gap: ApplicationInstructionGap.NoApplicationMethod,
        });
        expect(runner.run).not.toHaveBeenCalled();
    });

    it('refuses a file-declared method the executor supplies no reader for', async () => {
        const runner = fakeRunner();
        const instruction = FIXTURE_INSTRUCTION.replace(
            'read: extension-state user-rules',
            'read: user-rules-file /etc/ublock/user-rules.txt',
        );

        const outcome = await runPhaseApplication({
            application: instruction,
            goal: { kind: ApplicationGoalKind.Candidate, rule: 'example.com##.ad-slot' },
            session: session(),
            runner,
            readBack: { [BlockerVerificationMethod.ExtensionState]: async () => ({}) },
        });

        expect(outcome).toEqual({
            kind: 'refused',
            gap: ApplicationInstructionGap.VerificationMethodUnsupported,
            detail: expect.stringContaining('user-rules-file'),
        });
        expect(runner.run).not.toHaveBeenCalled();
    });
});

describe('runPhaseApplication applied and unverified paths', () => {
    it('renders the bounded session once and reports applied with host read-back and action log', async () => {
        const rule = 'example.com##.ad-slot';
        const settingsPayload = '{"filters":{"enabled-filters":[2]}}';
        const runner = fakeRunner();
        const readBack: BlockerStateRead = {
            rulesContentSha256: sha256(rule),
            enabledFilterIds: ['adguard:2'],
        };

        const outcome = await runPhaseApplication({
            application: FIXTURE_INSTRUCTION,
            goal: { kind: ApplicationGoalKind.Candidate, rule },
            session: session({ baselineEnabledFilterIds: ['adguard:2'], settingsPayload }),
            runner,
            readBack: {
                [BlockerVerificationMethod.ExtensionState]: async () => readBack,
            },
        });

        expect(runner.run).toHaveBeenCalledTimes(1);
        expect(runner.calls[0]!.prompt).toContain('Open the options page');
        // The task hands the host-built settings payload over as a fill, unchanged.
        expect(runner.calls[0]!.prompt).toContain(settingsPayload);
        // Only the exact prepared extension surface is admitted as the blocker surface.
        expect(runner.calls[0]!.prompt).toContain(
            'chrome-extension://abcdefghijklmnopabcdefghijklmnop/pages/options.html',
        );
        expect(runner.calls[0]!.prompt).toContain(rule);
        expect(outcome).toEqual({
            kind: 'applied',
            actionLog: [entry('get_dom', true, 'read the page')],
            readBack,
        });
    });

    it('reads the state back itself and reports applied even when the runner ended without a payload', async () => {
        const rule = 'example.org##.banner';
        const runner = fakeRunner({
            completed: false,
            detail: 'the session ended without a terminal payload (no-terminal)',
        });

        const outcome = await runPhaseApplication({
            application: FIXTURE_INSTRUCTION,
            goal: { kind: ApplicationGoalKind.Candidate, rule },
            session: session(),
            runner,
            readBack: {
                [BlockerVerificationMethod.ExtensionState]: async () => ({
                    rulesContentSha256: sha256(rule),
                }),
            },
        });

        expect(outcome).toMatchObject({ kind: 'applied' });
    });

    it('reports unverified when the read-back differs after the steps ran', async () => {
        const runner = fakeRunner();

        const outcome = await runPhaseApplication({
            application: FIXTURE_INSTRUCTION,
            goal: { kind: ApplicationGoalKind.Candidate, rule: 'example.com##.ad-slot' },
            session: session(),
            runner,
            readBack: {
                [BlockerVerificationMethod.ExtensionState]: async () => ({
                    rulesContentSha256: sha256('example.com##.different'),
                }),
            },
        });

        expect(runner.run).toHaveBeenCalledTimes(1);
        expect(outcome).toMatchObject({
            kind: 'unverified',
            detail: expect.stringContaining(sha256('example.com##.different')),
        });
        expect((outcome as { actionLog: ActionLogEntry[] }).actionLog).toHaveLength(1);
    });

    it('reports unverified when the candidate is exact but the enabled set left the prepared one', async () => {
        // The candidate is applied on top of the prepared baseline; a blocker that also switched a
        // list on or off would test a different state than the one the experiment names.
        const rule = 'example.com##.ad-slot';

        const outcome = await runPhaseApplication({
            application: FIXTURE_INSTRUCTION,
            goal: { kind: ApplicationGoalKind.Candidate, rule },
            session: session({ baselineEnabledFilterIds: ['adguard:2'] }),
            runner: fakeRunner(),
            readBack: {
                [BlockerVerificationMethod.ExtensionState]: async () => ({
                    rulesContentSha256: sha256(rule),
                    enabledFilterIds: ['adguard:2', 'adguard:17'],
                }),
            },
        });

        expect(outcome).toMatchObject({
            kind: 'unverified',
            detail: expect.stringContaining('adguard:17'),
        });
    });

    it('verifies the baseline goal by enabled-list set equality', async () => {
        const runner = fakeRunner();
        const enabled = ['adguard:2', 'adguard:17', 'adguard:3'];

        const outcome = await runPhaseApplication({
            application: FIXTURE_INSTRUCTION,
            goal: { kind: ApplicationGoalKind.Baseline },
            session: session({
                baselineEnabledFilterIds: ['adguard:17', 'adguard:2', 'adguard:3'],
            }),
            runner,
            readBack: {
                [BlockerVerificationMethod.ExtensionState]: async () => ({
                    rulesContent: '',
                    enabledFilterIds: enabled,
                }),
            },
        });

        expect(outcome).toMatchObject({ kind: 'applied' });
    });

    it('reports unverified when the baseline read-back list differs from the prepared one', async () => {
        const runner = fakeRunner();

        const outcome = await runPhaseApplication({
            application: FIXTURE_INSTRUCTION,
            goal: { kind: ApplicationGoalKind.Baseline },
            session: session({ baselineEnabledFilterIds: ['adguard:2', 'adguard:17'] }),
            runner,
            readBack: {
                [BlockerVerificationMethod.ExtensionState]: async () => ({
                    rulesContent: '',
                    enabledFilterIds: ['adguard:2', 'adguard:3'],
                }),
            },
        });

        expect(outcome).toMatchObject({
            kind: 'unverified',
            detail: expect.stringContaining('baseline'),
        });
    });

    it('reports unverified when the requested filters are not all active in the MV3 rulesets', async () => {
        // Requested/options [2, 3] both credit against the prepared set, but only [2] actually
        // compiled and activated: the options-metadata credit alone would call this Applied.
        const outcome = await runPhaseApplication({
            application: FIXTURE_INSTRUCTION,
            goal: { kind: ApplicationGoalKind.Baseline },
            session: session({ baselineEnabledFilterIds: ['adguard:2', 'adguard:3'] }),
            runner: fakeRunner(),
            readBack: {
                [BlockerVerificationMethod.ExtensionState]: async () => ({
                    rulesContent: '',
                    enabledFilterIds: ['adguard:2', 'adguard:3'],
                    activeRulesetFilterIds: ['adguard:2'],
                }),
            },
        });

        expect(outcome).toMatchObject({
            kind: 'unverified',
            detail: expect.stringContaining('adguard:3'),
        });
    });

    it('reports unverified when the read-back reports MV3 filter or rule limits exceeded', async () => {
        const outcome = await runPhaseApplication({
            application: FIXTURE_INSTRUCTION,
            goal: { kind: ApplicationGoalKind.Baseline },
            session: session({ baselineEnabledFilterIds: ['adguard:2'] }),
            runner: fakeRunner(),
            readBack: {
                [BlockerVerificationMethod.ExtensionState]: async () => ({
                    rulesContent: '',
                    enabledFilterIds: ['adguard:2'],
                    activeRulesetFilterIds: ['adguard:2'],
                    limitsExceeded: true,
                }),
            },
        });

        expect(outcome).toMatchObject({
            kind: 'unverified',
            detail: expect.stringContaining('limit'),
        });
    });

    // AdguardFilters#242720: the reporter's 52-filter set exceeds Chrome's MV3 static ruleset
    // limit, so the extension keeps only what Chrome enabled and the read-back set never equals
    // the prepared one. The model must learn that the cause is the MV3 limits — with the
    // numbers — not merely that the sets differ.
    it('names the MV3 limits and their counters when the mismatching read-back reports them exceeded', async () => {
        const prepared = ['adguard:2', 'adguard:3', 'adguard:10'] as const;
        const outcomeFor = (limits: Partial<BlockerStateRead>) =>
            runPhaseApplication({
                application: FIXTURE_INSTRUCTION,
                goal: { kind: ApplicationGoalKind.Baseline },
                session: session({ baselineEnabledFilterIds: [...prepared] }),
                runner: fakeRunner(),
                readBack: {
                    [BlockerVerificationMethod.ExtensionState]: async () => ({
                        rulesContent: '',
                        enabledFilterIds: ['adguard:2', 'adguard:10'],
                        activeRulesetFilterIds: ['adguard:2', 'adguard:10'],
                        ...limits,
                    }),
                },
            });

        const exceeded = await outcomeFor({
            limitsExceeded: true,
            rulesLimits: {
                staticFiltersEnabledCount: 2,
                staticFiltersMaximumCount: 50,
                staticRulesEnabledCount: 120_000,
                staticRulesMaximumCount: 330_000,
            },
        });
        expect(exceeded).toMatchObject({
            kind: 'unverified',
            settingsLimitation: SettingsLimitation.Mv3LimitsExceeded,
        });
        const detail =
            exceeded.kind === PhaseApplicationOutcomeKind.Unverified ? exceeded.detail : '';
        for (const fragment of [
            'MV3',
            '3 filter',
            'adguard:2',
            'adguard:10',
            '2/50',
            '120000/330000',
        ]) {
            expect(detail).toContain(fragment);
        }

        // A plain mismatch keeps today's detail and carries no limitation marker.
        const plain = await outcomeFor({});
        expect(plain).toMatchObject({
            kind: 'unverified',
            detail: expect.stringContaining('does not equal the prepared baseline set'),
        });
        expect(plain).not.toHaveProperty('settingsLimitation');
    });

    it('reports unverified when the read-back Tracking-protection state differs from the prepared one', async () => {
        const outcome = await runPhaseApplication({
            application: FIXTURE_INSTRUCTION,
            goal: { kind: ApplicationGoalKind.Baseline },
            session: session({
                baselineEnabledFilterIds: ['adguard:2'],
                expectStealthEnabled: true,
            }),
            runner: fakeRunner(),
            readBack: {
                [BlockerVerificationMethod.ExtensionState]: async () => ({
                    rulesContent: '',
                    enabledFilterIds: ['adguard:2'],
                    stealthEnabled: false,
                }),
            },
        });

        expect(outcome).toMatchObject({
            kind: 'unverified',
            detail: expect.stringContaining('Tracking-protection'),
        });
    });

    it('credits a read-back that cannot observe Tracking protection', async () => {
        const outcome = await runPhaseApplication({
            application: FIXTURE_INSTRUCTION,
            goal: { kind: ApplicationGoalKind.Baseline },
            session: session({
                baselineEnabledFilterIds: ['adguard:2'],
                expectStealthEnabled: true,
            }),
            runner: fakeRunner(),
            readBack: {
                [BlockerVerificationMethod.ExtensionState]: async () => ({
                    rulesContent: '',
                    enabledFilterIds: ['adguard:2'],
                }),
            },
        });

        expect(outcome).toMatchObject({ kind: 'applied' });
    });

    it('reports unverified when the baseline read-back still carries a user rule', async () => {
        const runner = fakeRunner();

        const outcome = await runPhaseApplication({
            application: FIXTURE_INSTRUCTION,
            goal: { kind: ApplicationGoalKind.Baseline },
            session: session({ baselineEnabledFilterIds: ['adguard:2'] }),
            runner,
            readBack: {
                [BlockerVerificationMethod.ExtensionState]: async () => ({
                    rulesContent: '||leftover.example^',
                    enabledFilterIds: ['adguard:2'],
                }),
            },
        });

        expect(outcome).toMatchObject({
            kind: 'unverified',
            detail: expect.stringContaining('||leftover.example^'),
        });
    });

    it('refuses a baseline whose read-back carries a digest but no rules content', async () => {
        const runner = fakeRunner();

        const outcome = await runPhaseApplication({
            application: FIXTURE_INSTRUCTION,
            goal: { kind: ApplicationGoalKind.Baseline },
            session: session({ baselineEnabledFilterIds: ['adguard:2'] }),
            runner,
            readBack: {
                [BlockerVerificationMethod.ExtensionState]: async () => ({
                    rulesContentSha256: 'a'.repeat(64),
                    enabledFilterIds: ['adguard:2'],
                }),
            },
        });

        expect(outcome).toMatchObject({
            kind: 'unverified',
            detail: expect.stringContaining('no rules content'),
        });
    });
});

describe('runPhaseApplication file-backed verification end to end', () => {
    it('verifies a managed-storage declaration from parse through reader to digest compare', async () => {
        const rule = 'example.net##.promo';
        const dir = mkdtempSync(join(tmpdir(), 'managed-storage-'));
        const storagePath = join(dir, 'managed-storage.json');
        writeFileSync(storagePath, `${rule}\n`, 'utf8');
        const runner = fakeRunner();
        const instruction = FIXTURE_INSTRUCTION.replace(
            'read: extension-state user-rules',
            `read: managed-storage-file ${storagePath}`,
        );

        const outcome = await runPhaseApplication({
            application: instruction,
            goal: { kind: ApplicationGoalKind.Candidate, rule },
            session: session(),
            runner,
            readBack: {
                [BlockerVerificationMethod.ManagedStorageFile]: fileBlockerStateReader(),
            },
        });

        expect(runner.run).toHaveBeenCalledTimes(1);
        // A file cannot report the enabled filter set, so the candidate is credited on the exact
        // rules content alone, and the outcome says so for the phase proof.
        expect(outcome).toEqual({
            kind: 'applied',
            actionLog: [entry('get_dom', true, 'read the page')],
            readBack: { rulesContent: rule, rulesContentSha256: sha256(rule) },
            detail: expect.stringContaining('does not expose the enabled filter set'),
        });
    });

    it('credits a candidate whose goal rule carries a trailing newline', async () => {
        const rule = 'example.net##.promo';
        const dir = mkdtempSync(join(tmpdir(), 'managed-storage-candidate-newline-'));
        const storagePath = join(dir, 'managed-storage.json');
        writeFileSync(storagePath, `${rule}\n`, 'utf8');
        const runner = fakeRunner();
        const instruction = FIXTURE_INSTRUCTION.replace(
            'read: extension-state user-rules',
            `read: managed-storage-file ${storagePath}`,
        );

        const outcome = await runPhaseApplication({
            application: instruction,
            goal: { kind: ApplicationGoalKind.Candidate, rule: `${rule}\n` },
            session: session(),
            runner,
            readBack: {
                [BlockerVerificationMethod.ManagedStorageFile]: fileBlockerStateReader(),
            },
        });

        expect(outcome).toMatchObject({ kind: 'applied' });
    });

    it('credits a file-backed baseline over an empty file and records the unobservable filter set', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'managed-storage-baseline-empty-'));
        const storagePath = join(dir, 'managed-storage.json');
        writeFileSync(storagePath, '', 'utf8');
        const runner = fakeRunner();
        const instruction = FIXTURE_INSTRUCTION.replace(
            'read: extension-state user-rules',
            `read: managed-storage-file ${storagePath}`,
        );

        const outcome = await runPhaseApplication({
            application: instruction,
            goal: { kind: ApplicationGoalKind.Baseline },
            session: session({ baselineEnabledFilterIds: ['adguard:2'] }),
            runner,
            readBack: {
                [BlockerVerificationMethod.ManagedStorageFile]: fileBlockerStateReader(),
            },
        });

        expect(outcome).toMatchObject({ kind: 'applied' });
        if (outcome.kind !== PhaseApplicationOutcomeKind.Applied) {
            throw new Error(`expected an applied baseline, got ${outcome.kind}`);
        }
        expect(outcome.detail).toContain('enabled filter set');
        expect(outcome.detail).toContain(BlockerVerificationMethod.ManagedStorageFile);
    });

    it('reports unverified when a file-backed baseline still holds a rule', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'managed-storage-baseline-leftover-'));
        const storagePath = join(dir, 'managed-storage.json');
        writeFileSync(storagePath, '||leftover.example^\n', 'utf8');
        const runner = fakeRunner();
        const instruction = FIXTURE_INSTRUCTION.replace(
            'read: extension-state user-rules',
            `read: managed-storage-file ${storagePath}`,
        );

        const outcome = await runPhaseApplication({
            application: instruction,
            goal: { kind: ApplicationGoalKind.Baseline },
            session: session({ baselineEnabledFilterIds: ['adguard:2'] }),
            runner,
            readBack: {
                [BlockerVerificationMethod.ManagedStorageFile]: fileBlockerStateReader(),
            },
        });

        expect(outcome).toMatchObject({
            kind: 'unverified',
            detail: expect.stringContaining('||leftover.example^'),
        });
    });
});
