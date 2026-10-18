/**
 * The faked workspace, issue, intake and GitHub seams the single-issue run suites share.
 */

import { vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import * as v from 'valibot';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
    EffectiveMode,
    FixRunStatus,
    VerificationStatus,
    type FixRunResult,
} from '../../src/types/fix-run-result';
import { BrowserMode } from '../../src/types/browser-mode';
import { IssueState } from '../../src/types/issue-state';
import type { RawIssue } from '../../src/github/fetch-issue';
import { IntakeExtractionKind, type IntakeExtraction } from '../../src/intake/extract-report';
import type { ExtractReport } from '../../src/intake/extract-issue-facts';
import { ReportSchema, ReportProblemType, type Report } from '../../src/intake/report';
import type {
    FiltersCommand,
    FiltersPreparationDependencies,
} from '../../src/local/filters-preparer';
import {
    buildExportedIssueRevision,
    loadVerifiedExportedIssueRevision,
    type VerifiedIssueRevision,
} from '../../src/local/issue-revision';
import { buildLocalIssueSnapshot } from '../../src/local/issue-snapshot';
import { DEFAULT_INSTRUCTION_PATH } from '../../src/knowledge/instruction-loader';

/**
 * The detached checkout commit every faked git run resolves to; a full 40-character SHA so the
 * preparer's own verification accepts it.
 */
export const ISSUE_COMMIT_FIXTURE = 'a'.repeat(40);

/**
 * The derived remote URL the entry must hand the preparer for the named repository.
 */
export const REPOSITORY_REMOTE_URL_FIXTURE = 'https://github.com/remote-owner/remote-list.git';

/**
 * Directories created for the running scenario, removed after each test.
 */
const createdDirs: string[] = [];

/**
 * Create one throwaway directory for the running scenario.
 *
 * @param prefix - Directory name prefix.
 * @returns Absolute path to the created directory.
 */
export function scratchDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    createdDirs.push(dir);
    return dir;
}

/**
 * Remove every directory the running scenario created; each suite runs it after each test.
 */
export function removeScratchDirs(): void {
    for (const dir of createdDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
}

/**
 * Build one raw prompt-safe issue fixture for the named number.
 *
 * @param number - Issue number the fixture carries.
 * @returns The validated-shape raw issue.
 */
export function rawIssueFixture(number: number): RawIssue {
    return {
        number,
        reporterAuthor: 'reporter',
        updatedAt: '2026-09-09T10:00:00.000Z',
        url: `https://github.com/source-owner/source-list/issues/${String(number)}`,
        title: 'Ad banner stays visible',
        body: 'Repro steps spell the reported defect.',
        state: IssueState.Open,
        labels: [],
        assignee: null,
        comments: [],
    };
}

/**
 * Build a stable terminal investigation result for the named number.
 *
 * @param issueNumber - Issue the investigation examined.
 * @returns Complete core result in the no-patch half.
 */
export function processedRunResult(issueNumber: number): FixRunResult {
    return {
        issueNumber,
        domain: 'example.com',
        runStatus: FixRunStatus.NotReproduced,
        requestedBrowserMode: BrowserMode.Auto,
        effectiveMode: EffectiveMode.Browser,
        verificationStatus: VerificationStatus.NotAttempted,
        fallbackReason: null,
        fallbackDetail: null,
        candidatePatch: null,
        artifactPaths: { screenshots: [], domSnapshot: null, har: null, trace: null },
        reasoning: 'The reported symptom was absent.',
        repository: null,
        baseSha: null,
    };
}

/**
 * Build the instruction text a fixture checkout carries.
 *
 * @returns Instruction Markdown with a report template section.
 */
export function fixtureInstruction(): string {
    return ['# Guidance', '## Report template', 'Outcome: {{outcome}}', ''].join('\n');
}

/**
 * One faked filters workspace: the git flow runs scripted, the temporary lifecycle is in-memory,
 * and the prepared checkout root optionally carries an AGENTS.md.
 */
export interface PreparedWorkspace {
    /**
     * Local source the request names, existing only when `localSourceAvailable` was set.
     */
    localSourcePath: string;

    /**
     * Checkout root the prepared checkout hands to the run.
     */
    checkoutRoot: string;

    /**
     * Command and filesystem seams wired for the filters preparer.
     */
    dependencies: FiltersPreparationDependencies;

    /**
     * Git commands the preparer issued, in order.
     */
    commands: FiltersCommand[];

    /**
     * Paths the disposable lifecycle removed.
     */
    removedPaths: string[];
}

/**
 * A failing answer of the faked git command.
 */
export interface ScriptedCommandFailure {
    /**
     * Exit code the command answers with.
     */
    exitCode: number;

    /**
     * Standard error the command answers with.
     */
    stderr: string;
}

/**
 * How one faked filters workspace is set up.
 */
export interface PreparedWorkspaceOptions {
    /**
     * Whether the local source the request names exists.
     */
    localSourceAvailable: boolean;

    /**
     * Whether the prepared checkout carries an AGENTS.md.
     */
    withInstruction: boolean;

    /**
     * A failing answer for the remote default-ref resolution, when the scenario needs one.
     */
    lsRemoteFailure?: ScriptedCommandFailure;
}

/**
 * Prepare one faked filters workspace.
 *
 * @param options - Whether the local source exists, whether the checkout carries an AGENTS.md, and
 *   an optional failing answer for the remote default-ref resolution.
 * @returns The wired workspace.
 */
export function preparedWorkspace(options: PreparedWorkspaceOptions): PreparedWorkspace {
    const localSourcePath = scratchDir('single-issue-case-');
    const checkoutRoot = join(localSourcePath, 'source');
    mkdirSync(checkoutRoot, { recursive: true });
    if (options.withInstruction) {
        const instructionPath = join(checkoutRoot, DEFAULT_INSTRUCTION_PATH);
        mkdirSync(dirname(instructionPath), { recursive: true });
        writeFileSync(instructionPath, fixtureInstruction(), 'utf8');
    }
    const commands: FiltersCommand[] = [];
    const removedPaths: string[] = [];
    return {
        localSourcePath,
        checkoutRoot,
        commands,
        removedPaths,
        dependencies: {
            commandRunner: {
                run: async (command) => {
                    commands.push(command);
                    if (command.args[0] === 'ls-remote') {
                        if (options.lsRemoteFailure !== undefined) {
                            return {
                                exitCode: options.lsRemoteFailure.exitCode,
                                stdout: '',
                                stderr: options.lsRemoteFailure.stderr,
                            };
                        }
                        return {
                            exitCode: 0,
                            stdout: `ref: refs/heads/main\tHEAD\n${ISSUE_COMMIT_FIXTURE}\tHEAD\n`,
                            stderr: '',
                        };
                    }
                    if (command.args[0] === 'rev-parse') {
                        return {
                            exitCode: 0,
                            stdout: `${ISSUE_COMMIT_FIXTURE}\n`,
                            stderr: '',
                        };
                    }
                    return { exitCode: 0, stdout: '', stderr: '' };
                },
            },
            fileSystem: {
                createTemporaryDirectory: async () => localSourcePath,
                exists: async (path) => path === localSourcePath && options.localSourceAvailable,
                remove: async (path) => {
                    removedPaths.push(path);
                },
            },
        },
    };
}

/**
 * One exported issue revision bundle on disk.
 */
export interface ExportedIssueFixture {
    /**
     * Portable path of the exported bundle.
     */
    issueFile: string;

    /**
     * The revision the bundle verifies to.
     */
    revision: VerifiedIssueRevision;
}

/**
 * Write one exported issue revision bundle on disk.
 *
 * @param issueNumber - Issue the bundle exports.
 * @returns The portable path and the verified revision.
 */
export function exportedIssueFixture(issueNumber: number): ExportedIssueFixture {
    const dir = scratchDir('single-issue-export-');
    const issueFile = join(dir, 'issue.json');
    const snapshot = buildLocalIssueSnapshot(rawIssueFixture(issueNumber), []);
    const envelope = buildExportedIssueRevision({
        repository: 'example/lab',
        issueNumber,
        sourceUpdatedAt: '2026-09-09T10:02:00.000Z',
        capturedAt: '2026-09-09T10:03:00.000Z',
        snapshot,
    });
    writeFileSync(issueFile, JSON.stringify(envelope), 'utf8');
    return { issueFile, revision: loadVerifiedExportedIssueRevision(issueFile) };
}

/**
 * The faked issue-read API the publication guard drives.
 */
export interface OpenIssueApi {
    /**
     * The `issues.get` and `listEventsForTimeline` fakes.
     */
    issues: Record<string, ReturnType<typeof vi.fn>>;

    /**
     * The `paginate` that drains them.
     */
    paginate: ReturnType<typeof vi.fn>;
}

/**
 * The issue-read API the publication guard drives, answering an open issue with an empty timeline.
 *
 * @returns The `issues.get`/`listEventsForTimeline` fakes and the `paginate` that drains them.
 */
export function openIssueApi(): OpenIssueApi {
    return {
        issues: {
            get: vi.fn().mockResolvedValue({
                data: { state: 'open', assignees: [], labels: [] },
            }),
            listEventsForTimeline: vi.fn(),
        },
        paginate: vi.fn().mockResolvedValue([]),
    };
}

/**
 * Build the fake issue-comment API the real publisher drives.
 *
 * @returns Octokit recording the issue-comment calls.
 */
export function issueCommentOctokit(): Octokit {
    const issueApi = openIssueApi();
    return {
        paginate: issueApi.paginate,
        rest: {
            issues: {
                ...issueApi.issues,
                listComments: vi.fn().mockResolvedValue({ data: [] }),
                createComment: vi.fn().mockResolvedValue({
                    data: {
                        id: 501,
                        html_url:
                            'https://github.com/remote-owner/remote-list/issues/4#issuecomment-501',
                    },
                }),
            },
            users: {
                getAuthenticated: vi.fn().mockResolvedValue({ data: { login: 'agent-bot' } }),
            },
        },
    } as unknown as Octokit;
}

/**
 * The platform's own refusal message the fake comment write rejects with; the failed run must carry
 * it verbatim into `failureDetail` instead of swallowing the publication failure.
 */
export const PLATFORM_WRITE_REFUSAL = 'platform write refused: report comment rejected';

/**
 * Build the issue-comment API whose write is refused by the platform, so the real
 * `publishReportOnce` dedupe runs its full path into a rejecting `createComment`.
 *
 * @returns Octokit whose `createComment` rejects.
 */
export function refusedCommentOctokit(): Octokit {
    const issueApi = openIssueApi();
    return {
        paginate: issueApi.paginate,
        rest: {
            issues: {
                ...issueApi.issues,
                listComments: vi.fn().mockResolvedValue({ data: [] }),
                createComment: vi.fn().mockRejectedValue(new Error(PLATFORM_WRITE_REFUSAL)),
            },
            users: {
                getAuthenticated: vi.fn().mockResolvedValue({ data: { login: 'agent-bot' } }),
            },
        },
    } as unknown as Octokit;
}

/**
 * Build one schema-valid report fixture a scripted intake extraction resolves to.
 *
 * @param version - Optional product version to carry in the environment payload.
 * @returns The validated report.
 */
export function fixtureReport(version?: string): Report {
    return v.parse(ReportSchema, {
        siteUrls: ['https://example.com/watch?v=1'],
        problemType: ReportProblemType.Ads,
        screenshots: [],
        environment: {
            product: 'AdGuard Ad Filter',
            ...(version !== undefined ? { version } : {}),
        },
        enabledLists: [{ name: 'BaseFilter' }],
        userRules: [],
        reproductionSteps: ['Open the page'],
    });
}

/**
 * Script the intake extraction seam so every call resolves to one fixed outcome.
 *
 * @param outcome - The extraction outcome each call returns.
 * @returns The extraction callable wired as a Vitest mock.
 */
export function scriptedExtractReport(outcome: IntakeExtraction): ExtractReport {
    return vi.fn(async () => outcome);
}

/**
 * The dependencies fragment carrying the scripted extraction seam.
 */
export interface ExtractedReportSeam {
    /**
     * The scripted intake extraction.
     */
    extractReport: ExtractReport;
}

/**
 * Build the dependency spread every scenario injects so the run's intake extraction never builds a
 * real provider client.
 *
 * @returns The dependencies fragment carrying the scripted extraction seam.
 */
export function extractedReportSeam(): ExtractedReportSeam {
    return {
        extractReport: scriptedExtractReport({
            kind: IntakeExtractionKind.Report,
            report: fixtureReport(),
        }),
    };
}
