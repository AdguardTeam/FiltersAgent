import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
    runMainSecretBoundary,
    type MainRuntimeContext,
} from '../../../lab/cli/main-secret-boundary';

describe('runMainSecretBoundary', () => {
    it('freezes the environment, keeps prior signal listeners, and reports the signal exit code', async () => {
        const env = { LLM_MODEL: 'exported-model' };
        const stdout: string[] = [];
        const stderr: string[] = [];
        const exitCodes: number[] = [];
        const signals = new EventEmitter();
        const existing = vi.fn();
        signals.on('SIGINT', existing);
        const beforeInt = signals.listeners('SIGINT');

        await runMainSecretBoundary({
            env,
            argv: ['node', 'agent', 'fix', 'issue', '4'],
            workspaceRoot: process.cwd(),
            processTarget: signals,
            stdout: { write: (value) => stdout.push(String(value)) },
            stderr: { write: (value) => stderr.push(String(value)) },
            setExitCode: (code) => exitCodes.push(code),
            loadRuntime: async () => ({
                runMainRuntime: async (context) => {
                    expect(Object.isFrozen(context.env)).toBe(true);
                    expect(context.env.LLM_MODEL).toBe('exported-model');
                    expect(context.signal.aborted).toBe(false);
                    context.stdout.write('terminal\n');
                    signals.emit('SIGTERM');
                    expect(context.signal.aborted).toBe(true);
                },
            }),
        });

        expect(stdout.join('')).toContain('terminal');
        expect(stderr).toEqual([]);
        expect(exitCodes).toEqual([143]);
        expect(signals.listeners('SIGINT')).toEqual(beforeInt);
        expect(signals.listenerCount('SIGTERM')).toBe(0);
    });

    it('sanitizes a top-level runtime rejection and fails with a non-zero exit code', async () => {
        const stderr: string[] = [];
        const exitCodes: number[] = [];

        await runMainSecretBoundary({
            env: {},
            argv: ['node', 'agent', 'fix', 'issue', '4'],
            workspaceRoot: process.cwd(),
            stdout: { write: () => undefined },
            stderr: { write: (value) => stderr.push(String(value)) },
            setExitCode: (code) => exitCodes.push(code),
            loadRuntime: async () => ({
                runMainRuntime: async () => {
                    throw new Error('native argv failure Bearer sk-live-secret-value');
                },
            }),
        });

        expect(stderr.join('')).toContain('Runtime failed:');
        expect(stderr.join('')).not.toContain('sk-live-secret-value');
        expect(stderr.join('')).toContain('[redacted]');
        expect(exitCodes).toEqual([1]);
    });

    it('reads the workspace dotenv only through explicit loaders when the environment is injected', async () => {
        const workspaceRoot = mkdtempSync(join(tmpdir(), 'ordinary-main-no-dotenv-'));
        const dotenvPath = join(workspaceRoot, '.env');
        const env: NodeJS.ProcessEnv = {};
        const dotenvContents = ['LLM_API_KEY=synthetic-workspace-provider-key', ''].join('\n');
        writeFileSync(dotenvPath, dotenvContents, 'utf8');
        let capturedContext: MainRuntimeContext | undefined;
        const loadRuntime = vi.fn(async () => ({
            runMainRuntime: async (context: MainRuntimeContext) => {
                capturedContext = context;
            },
        }));

        try {
            await runMainSecretBoundary({
                env,
                argv: ['node', 'agent', '--help'],
                workspaceRoot,
                loadRuntime,
                stdout: { write: () => undefined },
                stderr: { write: () => undefined },
                setExitCode: () => undefined,
            });

            expect(env).not.toHaveProperty('LLM_API_KEY');
            expect(loadRuntime).toHaveBeenCalledOnce();
            expect(capturedContext?.env).not.toHaveProperty('LLM_API_KEY');
            expect(readFileSync(dotenvPath, 'utf8')).toBe(dotenvContents);
        } finally {
            rmSync(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('applies workspace generic keys with exported-environment precedence', async () => {
        const env: NodeJS.ProcessEnv = { LLM_MODEL: 'exported-model' };
        let capturedContext: MainRuntimeContext | undefined;
        const loadWorkspaceEnv = vi.fn(() => ({
            LLM_MODEL: 'dotenv-model',
            LLM_API_KEY: 'dotenv-provider-key',
        }));

        await runMainSecretBoundary({
            env,
            argv: ['node', 'agent', '--help'],
            workspaceRoot: process.cwd(),
            loadWorkspaceEnv,
            loadRuntime: async () => ({
                runMainRuntime: async (context: MainRuntimeContext) => {
                    capturedContext = context;
                },
            }),
            stdout: { write: () => undefined },
            stderr: { write: () => undefined },
            setExitCode: () => undefined,
        });

        expect(loadWorkspaceEnv).toHaveBeenCalledOnce();
        expect(capturedContext?.env.LLM_MODEL).toBe('exported-model');
        expect(capturedContext?.env.LLM_API_KEY).toBe('dotenv-provider-key');
    });
});
