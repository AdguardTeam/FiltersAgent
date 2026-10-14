import { describe, it, expect, vi } from 'vitest';
import type { CommanderError } from 'commander';
import {
    buildProgram,
    type ExportParsedCommand,
    type RepoParsedCommand,
} from '../../../lab/cli/program';

/**
 * Parse an `export issue` invocation through its dedicated callback.
 *
 * @param argv - Raw CLI arguments beginning at the top-level command.
 * @returns The export callback spy and any Commander parsing error.
 */
function runExport(argv: string[]) {
    const onExportCommand = vi.fn();
    const program = buildProgram(
        vi.fn(),
        { exitOverride: true, suppressOutput: true },
        vi.fn(),
        onExportCommand,
    );
    let error: CommanderError | undefined;
    try {
        program.parse(argv, { from: 'user' });
    } catch (caught) {
        error = caught as CommanderError;
    }
    return { onExportCommand, error };
}

describe('export command parsing', () => {
    it('parses an external output and trusted exclusions', () => {
        const { onExportCommand, error } = runExport([
            'export',
            'issue',
            '4',
            '--output-dir',
            '/tmp/agent-case-4',
            '--human-solution-comment',
            'maintainer@2026-01-02T00:00:00.000Z',
            '--additional-bot',
            'triage-automation',
            '--prompt-safe-only',
        ]);

        expect(error).toBeUndefined();
        expect(onExportCommand).toHaveBeenCalledTimes(1);
        const parsed: ExportParsedCommand = onExportCommand.mock.calls[0][0];
        expect(parsed).toEqual({
            issueNumber: 4,
            outputDir: '/tmp/agent-case-4',
            humanSolutionComments: [
                {
                    author: 'maintainer',
                    createdAt: '2026-01-02T00:00:00.000Z',
                },
            ],
            additionalBotAuthors: ['triage-automation'],
            repository: undefined,
            promptSafeOnly: true,
        });
    });

    it('requires an output directory', () => {
        const { onExportCommand, error } = runExport(['export', 'issue', '4']);

        expect(error).toBeDefined();
        expect(onExportCommand).not.toHaveBeenCalled();
    });

    it('rejects an ambiguous human-solution identity', () => {
        const { onExportCommand, error } = runExport([
            'export',
            'issue',
            '4',
            '--output-dir',
            '/tmp/agent-case-4',
            '--human-solution-comment',
            'maintainer',
        ]);

        expect(error?.code).toBe('agent.invalidCommentIdentity');
        expect(onExportCommand).not.toHaveBeenCalled();
    });
});

/**
 * Parse a CLI argument array and return the captured callback and any error.
 *
 * @param argv - Raw CLI argument array (including the node executable prefix).
 * @returns The mock callback spy and, if parsing failed, the thrown `CommanderError`.
 */
function run(argv: string[]) {
    const onCommand = vi.fn();
    const program = buildProgram(onCommand, { exitOverride: true, suppressOutput: true });
    let error: CommanderError | undefined;
    try {
        program.parse(argv, { from: 'user' });
    } catch (err) {
        error = err as CommanderError;
    }
    return { onCommand, error };
}

describe('buildProgram', () => {
    it('parses "fix issue 123"', () => {
        const { onCommand, error } = run(['fix', 'issue', '123']);
        expect(error).toBeUndefined();
        expect(onCommand).toHaveBeenCalledWith({
            command: 'fix',
            issueNumber: 123,
            flags: {
                dryRun: false,
                verbose: false,
                model: undefined,
                browserMode: 'auto',
                routingCheck: false,
                output: undefined,
                issueFile: undefined,
                environment: 'current',
                outputDir: undefined,
                runConfig: undefined,
                repository: undefined,
                keepTemporaryFiles: false,
                blockerModules: [],
                noComment: false,
            },
        });
    });

    it('collects every repeated --blocker-module manifest in the order given', () => {
        const { onCommand, error } = run([
            'fix',
            'issue',
            '4',
            '--blocker-module',
            'adguard-cli/blocker-module.json',
            '--blocker-module',
            '/opt/demo-module/blocker-module.json',
        ]);

        expect(error).toBeUndefined();
        expect(onCommand).toHaveBeenCalledWith(
            expect.objectContaining({
                flags: expect.objectContaining({
                    blockerModules: [
                        'adguard-cli/blocker-module.json',
                        '/opt/demo-module/blocker-module.json',
                    ],
                }),
            }),
        );
    });

    it('parses --repository as a repository identity override', () => {
        const { onCommand, error } = run([
            'fix',
            'issue',
            '4',
            '--issue-file',
            '/tmp/case/issue.json',
            '--repository',
            'fork-owner/list-repo',
        ]);

        expect(error).toBeUndefined();
        expect(onCommand).toHaveBeenCalledWith(
            expect.objectContaining({
                flags: expect.objectContaining({ repository: 'fork-owner/list-repo' }),
            }),
        );
    });

    it('rejects a malformed --repository slug', () => {
        const { error, onCommand } = run(['show', 'issue', '4', '--repository', 'banana']);

        expect(error?.code).toBe('agent.invalidRepositoryIdentity');
        expect(onCommand).not.toHaveBeenCalled();
    });

    it('parses a targeted live fix with a local output directory', () => {
        const { onCommand, error } = run([
            'fix',
            'issue',
            '123',
            '--output-dir',
            '/tmp/targeted-live',
        ]);

        expect(error).toBeUndefined();
        expect(onCommand).toHaveBeenCalledWith(
            expect.objectContaining({
                command: 'fix',
                issueNumber: 123,
                flags: expect.objectContaining({
                    issueFile: undefined,
                    environment: 'current',
                    outputDir: '/tmp/targeted-live',
                }),
            }),
        );
    });

    it('parses browser mode and serialized output path for an issue run', () => {
        const { onCommand } = run([
            'fix',
            'issue',
            '7',
            '--dry-run',
            '--browser',
            'auto',
            '--output',
            '/tmp/result.json',
        ]);

        expect(onCommand).toHaveBeenCalledWith(
            expect.objectContaining({
                command: 'fix',
                flags: expect.objectContaining({
                    browserMode: 'auto',
                    output: '/tmp/result.json',
                }),
            }),
        );
    });

    it('parses a local current fix run', () => {
        const { onCommand, error } = run([
            'fix',
            'issue',
            '4',
            '--issue-file',
            '/tmp/agent-case-4/issue.json',
            '--environment',
            'current',
            '--output-dir',
            '/tmp/adguard-agent-runs/issue-4',
        ]);

        expect(error).toBeUndefined();
        expect(onCommand).toHaveBeenCalledWith(
            expect.objectContaining({
                command: 'fix',
                issueNumber: 4,
                flags: expect.objectContaining({
                    issueFile: '/tmp/agent-case-4/issue.json',
                    environment: 'current',
                    outputDir: '/tmp/adguard-agent-runs/issue-4',
                    keepTemporaryFiles: false,
                }),
            }),
        );
    });

    it('parses historical run provenance without exposing a human reference', () => {
        const { onCommand, error } = run([
            'fix',
            'issue',
            '4',
            '--issue-file',
            '/tmp/agent-case-4/issue.json',
            '--environment',
            'historical',
            '--output-dir',
            '/tmp/adguard-agent-runs/issue-4-historical',
            '--run-config',
            '/tmp/agent-case-4/historical.json',
            '--keep-temporary-files',
        ]);

        expect(error).toBeUndefined();
        expect(onCommand).toHaveBeenCalledWith(
            expect.objectContaining({
                flags: expect.objectContaining({
                    environment: 'historical',
                    outputDir: '/tmp/adguard-agent-runs/issue-4-historical',
                    runConfig: '/tmp/agent-case-4/historical.json',
                    keepTemporaryFiles: true,
                }),
            }),
        );
    });

    it('rejects an invalid local environment', () => {
        const { error, onCommand } = run(['fix', 'issue', '4', '--environment', 'sometimes']);

        expect(error?.code).toBe('agent.invalidEnvironment');
        expect(onCommand).not.toHaveBeenCalled();
    });

    it.each([
        ['--environment', 'historical'],
        ['--run-config', '/tmp/run.json'],
    ])('rejects unsupported live flags without --issue-file: %s', (...localFlags) => {
        const { error, onCommand } = run(['fix', 'issue', '4', ...localFlags]);

        expect(error?.code).toBe('agent.invalidLocalRun');
        expect(onCommand).not.toHaveBeenCalled();
    });

    it('allows the runtime to choose a project-local output directory', () => {
        const { error, onCommand } = run([
            'fix',
            'issue',
            '4',
            '--issue-file',
            '/tmp/case/issue.json',
        ]);

        expect(error).toBeUndefined();
        expect(onCommand).toHaveBeenCalledWith(
            expect.objectContaining({
                flags: expect.objectContaining({
                    outputDir: undefined,
                }),
            }),
        );
    });

    it('requires an exact case config for a historical local run', () => {
        const { error, onCommand } = run([
            'fix',
            'issue',
            '4',
            '--issue-file',
            '/tmp/case/issue.json',
            '--output-dir',
            '/tmp/output',
            '--environment',
            'historical',
        ]);

        expect(error?.code).toBe('agent.invalidLocalRun');
        expect(onCommand).not.toHaveBeenCalled();
    });

    it('rejects local snapshots for commands other than fix', () => {
        const { error, onCommand } = run([
            'show',
            'issue',
            '4',
            '--issue-file',
            '/tmp/case/issue.json',
            '--output-dir',
            '/tmp/output',
        ]);

        expect(error?.code).toBe('agent.invalidLocalRun');
        expect(onCommand).not.toHaveBeenCalled();
    });

    it('rejects an invalid browser mode', () => {
        const { error, onCommand } = run(['fix', 'issue', '7', '--browser', 'sometimes']);
        expect(error?.code).toBe('agent.invalidBrowserMode');
        expect(onCommand).not.toHaveBeenCalled();
    });

    it('rejects reasoning-only mode for the browser-first fix agent', () => {
        const { error, onCommand } = run(['fix', 'issue', '7', '--browser', 'off']);
        expect(error?.code).toBe('agent.invalidBrowserMode');
        expect(onCommand).not.toHaveBeenCalled();
    });

    it('keeps reasoning-only mode available for non-fix compatibility commands', () => {
        const { error, onCommand } = run(['show', 'issue', '7', '--browser', 'off']);
        expect(error).toBeUndefined();
        expect(onCommand).toHaveBeenCalledWith(
            expect.objectContaining({
                command: 'show',
                flags: expect.objectContaining({ browserMode: 'off' }),
            }),
        );
    });

    it('parses flags after the issue number', () => {
        const { onCommand } = run([
            'fix',
            'issue',
            '5',
            '--dry-run',
            '--verbose',
            '--model',
            'gpt-5.5',
        ]);
        expect(onCommand).toHaveBeenCalledWith(
            expect.objectContaining({
                flags: expect.objectContaining({
                    dryRun: true,
                    verbose: true,
                    model: 'gpt-5.5',
                    browserMode: 'auto',
                }),
            }),
        );
    });

    it('errors on an unknown command', () => {
        const { error, onCommand } = run(['frobnicate', 'issue', '1']);
        expect(onCommand).not.toHaveBeenCalled();
        expect(error?.code).toBe('commander.unknownCommand');
    });

    it('errors when the "issue" subcommand is missing', () => {
        const { error, onCommand } = run(['fix']);
        expect(onCommand).not.toHaveBeenCalled();
        expect(error).toBeDefined();
    });

    it('errors on a non-numeric issue number', () => {
        const { error, onCommand } = run(['fix', 'issue', 'abc']);
        expect(onCommand).not.toHaveBeenCalled();
        expect(error?.code).toBe('agent.invalidIssue');
    });

    it('errors on an unknown flag', () => {
        const { error } = run(['fix', 'issue', '1', '--turbo']);
        expect(error?.code).toBe('commander.unknownOption');
    });

    it('handles --help via the exit override', () => {
        const { error } = run(['--help']);
        expect(error?.code).toMatch(/help/);
    });

    it('parses "show issue 123" with the same flags', () => {
        const { onCommand, error } = run(['show', 'issue', '123', '--verbose']);
        expect(error).toBeUndefined();
        expect(onCommand).toHaveBeenCalledWith({
            command: 'show',
            issueNumber: 123,
            flags: {
                dryRun: false,
                verbose: true,
                model: undefined,
                browserMode: 'auto',
                routingCheck: false,
                output: undefined,
                issueFile: undefined,
                environment: 'current',
                outputDir: undefined,
                runConfig: undefined,
                repository: undefined,
                keepTemporaryFiles: false,
                blockerModules: [],
                noComment: false,
            },
        });
    });

    it('parses the shared --repository override for the read-only export command', () => {
        const { onExportCommand, error: exportError } = runExport([
            'export',
            'issue',
            '4',
            '--output-dir',
            '/tmp/agent-case-4',
            '--repository',
            'fork-owner/list-repo',
        ]);
        expect(exportError).toBeUndefined();
        expect(onExportCommand.mock.calls[0][0]).toMatchObject({
            repository: 'fork-owner/list-repo',
        });
    });
});

/**
 * Parse a `repo` CLI argument array against a dedicated repo callback.
 *
 * @param argv - Raw CLI argument array (including the node executable prefix).
 * @returns The mock repo callback spy and, if parsing failed, the thrown `CommanderError`.
 */
function runRepo(argv: string[]) {
    const onRepoCommand = vi.fn();
    const program = buildProgram(
        vi.fn(),
        { exitOverride: true, suppressOutput: true },
        onRepoCommand,
    );
    let error: CommanderError | undefined;
    try {
        program.parse(argv, { from: 'user' });
    } catch (err) {
        error = err as CommanderError;
    }
    return { onRepoCommand, error };
}

describe('repo command parsing', () => {
    it('parses repo search with --domain', () => {
        const { onRepoCommand, error } = runRepo(['repo', 'search', '--domain', 'ads.example.com']);
        expect(error).toBeUndefined();
        const parsed: RepoParsedCommand = onRepoCommand.mock.calls[0][0];
        expect(parsed.subcommand).toBe('search');
        if (parsed.subcommand === 'search') {
            expect(parsed.query.domain).toBe('ads.example.com');
        }
    });

    it('parses repo search with selector + url-pattern', () => {
        const { onRepoCommand } = runRepo([
            'repo',
            'search',
            '--selector',
            '.ad-banner',
            '--url-pattern',
            '||ads.example.com^',
        ]);
        const parsed: RepoParsedCommand = onRepoCommand.mock.calls[0][0];
        if (parsed.subcommand === 'search') {
            expect(parsed.query.selector).toBe('.ad-banner');
            expect(parsed.query.urlPattern).toBe('||ads.example.com^');
        }
    });

    it('parses repo map', () => {
        const { onRepoCommand } = runRepo(['repo', 'map']);
        const parsed: RepoParsedCommand = onRepoCommand.mock.calls[0][0];
        expect(parsed.subcommand).toBe('map');
    });
});
