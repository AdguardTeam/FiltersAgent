import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ToolName } from '../../src/agent/tool-names';
import type { Logger } from '../../src/logger/logger';
import type {
    PreparationSubprocessCommand,
    PreparationSubprocessResult,
    runPreparationSubprocess,
} from '../../src/local/preparation-subprocess';
import {
    buildPreparationStepFailureGate,
    buildPreparationTools,
    UNPRIVILEGED_PREPARATION_GID,
    UNPRIVILEGED_PREPARATION_UID,
} from '../../src/orchestrator/preparation-tools';

/**
 * The absolute preparation workdir the tools run in; the hook spy only observes it.
 */
const WORK_DIR = '/run/filters-agent-artifacts/artifacts/preparation';

/**
 * Build the logger fake the preparation tools write their full-text invocation records to.
 *
 * @returns The fake logger.
 */
function fakeLogger(): Logger {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

/**
 * Build a recording subprocess seam that always succeeds.
 *
 * @param recorded - Commands the seam receives, in call order.
 * @returns The seam, typed as the real runner.
 */
function recordingRunSubprocess(
    recorded: PreparationSubprocessCommand[],
): typeof runPreparationSubprocess {
    return async (command): Promise<PreparationSubprocessResult> => {
        recorded.push(command);
        return { exitCode: 0, timedOut: false, stdout: '', stderr: '' };
    };
}

describe('buildPreparationTools unprivileged commands', () => {
    it('drops root to nobody with HOME in the workdir when the host runs as root', async () => {
        const executed: PreparationSubprocessCommand[] = [];
        const prepareWorkdir = vi.fn();
        const tools = buildPreparationTools({
            workDir: WORK_DIR,
            gate: buildPreparationStepFailureGate(),
            sourceEnvironment: { PATH: '/usr/bin' },
            logger: fakeLogger(),
            currentUid: 0,
            runSubprocess: recordingRunSubprocess(executed),
            prepareWorkdirForUnprivilegedCommands: prepareWorkdir,
        });
        const runCommand = tools.find((tool) => tool.name === ToolName.RunCommand);
        if (runCommand === undefined) {
            throw new Error('run_command tool missing from the preparation surface');
        }

        await runCommand.execute({ command: ['echo', 'prepared'] }, undefined);

        expect(executed).toHaveLength(1);
        expect(executed[0]).toMatchObject({
            executable: 'echo',
            args: ['prepared'],
            cwd: WORK_DIR,
            timeoutMs: expect.any(Number),
            allowGitCredential: false,
            uid: UNPRIVILEGED_PREPARATION_UID,
            gid: UNPRIVILEGED_PREPARATION_GID,
            environment: { HOME: WORK_DIR },
        });
        expect(prepareWorkdir).toHaveBeenCalledWith(WORK_DIR, {
            uid: UNPRIVILEGED_PREPARATION_UID,
            gid: UNPRIVILEGED_PREPARATION_GID,
        });
    });

    it('keeps the current identity without a HOME override when the host is not root', async () => {
        const executed: PreparationSubprocessCommand[] = [];
        const prepareWorkdir = vi.fn();
        const tools = buildPreparationTools({
            workDir: WORK_DIR,
            gate: buildPreparationStepFailureGate(),
            sourceEnvironment: { PATH: '/usr/bin' },
            logger: fakeLogger(),
            currentUid: 1_000,
            runSubprocess: recordingRunSubprocess(executed),
            prepareWorkdirForUnprivilegedCommands: prepareWorkdir,
        });
        const runCommand = tools.find((tool) => tool.name === ToolName.RunCommand);
        if (runCommand === undefined) {
            throw new Error('run_command tool missing from the preparation surface');
        }

        await runCommand.execute({ command: ['echo', 'prepared'] }, undefined);

        expect(executed).toHaveLength(1);
        expect(executed[0]).not.toHaveProperty('uid');
        expect(executed[0]).not.toHaveProperty('gid');
        expect(executed[0]).not.toHaveProperty('environment');
        expect(executed[0]).toMatchObject({
            executable: 'echo',
            args: ['prepared'],
            cwd: WORK_DIR,
            allowGitCredential: false,
        });
        expect(prepareWorkdir).not.toHaveBeenCalled();
    });
});

describe('buildPreparationTools write_file unprivileged write', () => {
    it('writes through the unprivileged identity (mkdir -p, then tee) when the host runs as root', async () => {
        const executed: PreparationSubprocessCommand[] = [];
        const tools = buildPreparationTools({
            workDir: WORK_DIR,
            gate: buildPreparationStepFailureGate(),
            sourceEnvironment: { PATH: '/usr/bin' },
            logger: fakeLogger(),
            currentUid: 0,
            runSubprocess: recordingRunSubprocess(executed),
            prepareWorkdirForUnprivilegedCommands: vi.fn(),
        });
        const writeFile = tools.find((tool) => tool.name === ToolName.WriteFile);
        if (writeFile === undefined) {
            throw new Error('write_file tool missing from the preparation surface');
        }

        const result = await writeFile.execute({ path: 'inside.txt', content: 'hello' }, undefined);

        expect(result.error).toBeUndefined();
        expect(executed).toHaveLength(2);
        const identityFields = {
            allowGitCredential: false,
            cwd: WORK_DIR,
            uid: UNPRIVILEGED_PREPARATION_UID,
            gid: UNPRIVILEGED_PREPARATION_GID,
            environment: { HOME: WORK_DIR },
        };
        expect(executed[0]).toMatchObject({
            ...identityFields,
            executable: 'mkdir',
            args: ['-p', WORK_DIR],
        });
        expect(executed[1]).toMatchObject({
            ...identityFields,
            executable: 'tee',
            args: [join(WORK_DIR, 'inside.txt')],
            stdin: 'hello',
        });
    });

    it('never routes through the unprivileged writer when the host is not root', async () => {
        const root = mkdtempSync(join(tmpdir(), 'preparation-tools-write-'));
        try {
            const executed: PreparationSubprocessCommand[] = [];
            const tools = buildPreparationTools({
                workDir: root,
                gate: buildPreparationStepFailureGate(),
                sourceEnvironment: { PATH: '/usr/bin' },
                logger: fakeLogger(),
                currentUid: 1_000,
                runSubprocess: recordingRunSubprocess(executed),
            });
            const writeFile = tools.find((tool) => tool.name === ToolName.WriteFile);
            if (writeFile === undefined) {
                throw new Error('write_file tool missing from the preparation surface');
            }

            const result = await writeFile.execute(
                { path: 'inside.txt', content: 'hello' },
                undefined,
            );

            expect(result.error).toBeUndefined();
            expect(executed).toHaveLength(0);
            expect(statSync(join(root, 'inside.txt')).isFile()).toBe(true);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('buildPreparationTools write_file symlink containment', () => {
    it('refuses a write whose path walks through a workdir symlink to outside it', async () => {
        const root = mkdtempSync(join(tmpdir(), 'preparation-tools-symlink-'));
        try {
            const workDir = join(root, 'workdir');
            const outside = join(root, 'outside');
            mkdirSync(workDir, { recursive: true });
            mkdirSync(outside, { recursive: true });
            // A preparation command run earlier in the same session could create exactly this
            // symlink; the model then asks write_file for a lexically-inside path that actually
            // resolves outside the workdir through it.
            symlinkSync(outside, join(workDir, 'escape'));
            const tools = buildPreparationTools({
                workDir,
                gate: buildPreparationStepFailureGate(),
                sourceEnvironment: { PATH: '/usr/bin' },
                logger: fakeLogger(),
                currentUid: 1_000,
            });
            const writeFile = tools.find((tool) => tool.name === ToolName.WriteFile);
            if (writeFile === undefined) {
                throw new Error('write_file tool missing from the preparation surface');
            }

            const result = await writeFile.execute(
                { path: 'escape/malicious.txt', content: 'x' },
                undefined,
            );

            expect(result.error).toContain('symlink');
            expect(
                statSync(join(outside, 'malicious.txt'), { throwIfNoEntry: false }),
            ).toBeUndefined();
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
