import { describe, expect, it } from 'vitest';
import {
    buildPreparationSubprocessEnvironment,
    runPreparationSubprocess,
} from '../../src/local/preparation-subprocess';

describe('buildPreparationSubprocessEnvironment', () => {
    it('keeps only execution essentials and never inherits API or GitHub secrets', () => {
        const environment = buildPreparationSubprocessEnvironment({
            PATH: '/opt/homebrew/bin:/usr/bin',
            HOME: '/home/tester',
            TMPDIR: '/tmp/tester/',
            LANG: 'en_US.UTF-8',
            CI: 'true',
            LLM_API_KEY: 'llm-secret',
            OPENROUTER_API_KEY: 'openrouter-secret',
            GITHUB_TOKEN: 'github-secret',
            GH_TOKEN: 'gh-secret',
            NPM_TOKEN: 'npm-secret',
            CUSTOM_API_KEY: 'custom-secret',
            CUSTOM_SECRET: 'custom-secret',
        });

        expect(environment).toMatchObject({
            PATH: '/opt/homebrew/bin:/usr/bin',
            HOME: '/home/tester',
            TMPDIR: '/tmp/tester/',
            LANG: 'en_US.UTF-8',
            CI: 'true',
            GIT_TERMINAL_PROMPT: '0',
        });
        expect(environment).not.toHaveProperty('LLM_API_KEY');
        expect(environment).not.toHaveProperty('OPENROUTER_API_KEY');
        expect(environment).not.toHaveProperty('GITHUB_TOKEN');
        expect(environment).not.toHaveProperty('GH_TOKEN');
        expect(environment).not.toHaveProperty('NPM_TOKEN');
        expect(environment).not.toHaveProperty('CUSTOM_API_KEY');
        expect(environment).not.toHaveProperty('CUSTOM_SECRET');
    });

    it('gives git, and only git, a github.com credential derived from GITHUB_TOKEN', () => {
        const parent = { PATH: '/usr/bin', GITHUB_TOKEN: 'github-secret' };
        const expectedCredential = Buffer.from('x-access-token:github-secret').toString('base64');

        const gitEnvironment = buildPreparationSubprocessEnvironment(parent, {}, 'git');
        expect(gitEnvironment).toMatchObject({
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
            GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${expectedCredential}`,
        });
        // The raw token still never reaches the child, only the host-scoped derived form.
        expect(gitEnvironment).not.toHaveProperty('GITHUB_TOKEN');

        const packageManagerEnvironment = buildPreparationSubprocessEnvironment(parent, {}, 'pnpm');
        expect(packageManagerEnvironment).not.toHaveProperty('GIT_CONFIG_COUNT');
        expect(packageManagerEnvironment).not.toHaveProperty('GITHUB_TOKEN');

        // No token in the parent: git gets no credential and no dangling config counter.
        expect(
            buildPreparationSubprocessEnvironment({ PATH: '/usr/bin' }, {}, 'git'),
        ).not.toHaveProperty('GIT_CONFIG_COUNT');
    });

    it('applies the sanitized environment to the actual spawned process and overrides', async () => {
        const result = await runPreparationSubprocess(
            {
                executable: process.execPath,
                args: ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
                environment: {
                    HOME: '/safe-home',
                    LLM_API_KEY: 'override-secret',
                    GITHUB_TOKEN: 'override-github-secret',
                },
            },
            {
                PATH: process.env.PATH,
                HOME: '/parent-home',
                OPENROUTER_API_KEY: 'parent-secret',
                GH_TOKEN: 'parent-github-secret',
            },
        );
        const childEnvironment = JSON.parse(result.stdout);

        expect(result.exitCode).toBe(0);
        expect(childEnvironment).toMatchObject({
            HOME: '/safe-home',
            GIT_TERMINAL_PROMPT: '0',
        });
        expect(childEnvironment).not.toHaveProperty('LLM_API_KEY');
        expect(childEnvironment).not.toHaveProperty('OPENROUTER_API_KEY');
        expect(childEnvironment).not.toHaveProperty('GITHUB_TOKEN');
        expect(childEnvironment).not.toHaveProperty('GH_TOKEN');
    });
});

const CHILD_ENV_ARGV = ['-e', 'process.stdout.write(JSON.stringify(process.env))'];

const SLEEP_THIRTY_SECONDS_AFTER_OUTPUT_ARGV = [
    '-e',
    'console.log(`pid:${process.pid}`); process.stdout.write("step-output"); ' +
        'setTimeout(() => {}, 30000)',
];

describe('opt-in timeoutMs kill path', () => {
    it('resolves with exitCode -1, timedOut true, the output captured before the kill, and a gone child', async () => {
        const result = await runPreparationSubprocess(
            {
                executable: process.execPath,
                args: SLEEP_THIRTY_SECONDS_AFTER_OUTPUT_ARGV,
                timeoutMs: 200,
            },
            { PATH: process.env.PATH },
        );

        expect(result.timedOut).toBe(true);
        expect(result.exitCode).toBe(-1);
        expect(result.stdout).toContain('step-output');
        const childPid = Number(/pid:(\d+)/.exec(result.stdout)?.[1]);
        expect(Number.isFinite(childPid)).toBe(true);
        expect(() => process.kill(childPid, 0)).toThrow();
    });

    it('leaves an unbounded command unbounded: a fast command without timeoutMs resolves timedOut false', async () => {
        const result = await runPreparationSubprocess(
            {
                executable: process.execPath,
                args: CHILD_ENV_ARGV,
            },
            { PATH: process.env.PATH },
        );

        expect(result.exitCode).toBe(0);
        expect(result.timedOut).toBe(false);
        expect(result.stdout.length).toBeGreaterThan(0);
    });
});

describe('explicit gitCredentialToken', () => {
    it('gives git the caller-supplied host-scoped credential when the source environment holds no GITHUB_TOKEN', async () => {
        const result = await runPreparationSubprocess(
            {
                executable: 'git',
                args: ['config', '--get', 'http.https://github.com/.extraheader'],
                gitCredentialToken: 'explicit-token',
            },
            { PATH: process.env.PATH },
        );
        const expectedCredential = Buffer.from('x-access-token:explicit-token').toString('base64');

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(`AUTHORIZATION: basic ${expectedCredential}`);
    });
});

describe('allowGitCredential credential-free model path', () => {
    it('keeps LLM key, GitHub token, run budget, and GIT_CONFIG_* out of the env', async () => {
        const result = await runPreparationSubprocess(
            {
                executable: process.execPath,
                args: CHILD_ENV_ARGV,
                allowGitCredential: false,
            },
            {
                PATH: process.env.PATH,
                LLM_API_KEY: 'llm-secret',
                GITHUB_TOKEN: 'github-secret',
                AGENT_INVESTIGATION_BUDGET_MS: '3600000',
            },
        );
        const childEnvironment = JSON.parse(result.stdout);

        expect(result.exitCode).toBe(0);
        expect(childEnvironment).not.toHaveProperty('LLM_API_KEY');
        expect(childEnvironment).not.toHaveProperty('GITHUB_TOKEN');
        expect(childEnvironment).not.toHaveProperty('AGENT_INVESTIGATION_BUDGET_MS');
        expect(childEnvironment).not.toHaveProperty('GIT_CONFIG_COUNT');
        expect(childEnvironment).not.toHaveProperty('GIT_CONFIG_KEY_0');
        expect(childEnvironment).not.toHaveProperty('GIT_CONFIG_VALUE_0');
    });

    it('withholds even the derived git credential from git when false, while the default true path keeps it', () => {
        const parent = { PATH: '/usr/bin', GITHUB_TOKEN: 'github-secret' };
        const expectedCredential = Buffer.from('x-access-token:github-secret').toString('base64');

        const credentialFreeGitEnvironment = buildPreparationSubprocessEnvironment(
            parent,
            {},
            'git',
            false,
        );
        expect(credentialFreeGitEnvironment).not.toHaveProperty('GIT_CONFIG_COUNT');
        expect(credentialFreeGitEnvironment).not.toHaveProperty('GITHUB_TOKEN');

        // Default (allowGitCredential absent): today's derived-credential behavior is unchanged.
        const defaultGitEnvironment = buildPreparationSubprocessEnvironment(
            parent,
            {},
            'git',
            true,
        );
        expect(defaultGitEnvironment).toMatchObject({
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
            GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${expectedCredential}`,
        });
        expect(defaultGitEnvironment).not.toHaveProperty('GITHUB_TOKEN');
    });
});

describe.skipIf(process.getuid === undefined || process.getgid === undefined)(
    'unprivileged identity spawn options',
    () => {
        it('spawns the real child under the requested uid and gid', async () => {
            const uid = process.getuid!();
            const gid = process.getgid!();

            const result = await runPreparationSubprocess(
                {
                    executable: process.execPath,
                    args: ['-e', 'process.stdout.write(String(process.getuid()))'],
                    uid,
                    gid,
                },
                { PATH: process.env.PATH },
            );

            expect(result.exitCode).toBe(0);
            expect(Number(result.stdout)).toBe(uid);
        });
    },
);
