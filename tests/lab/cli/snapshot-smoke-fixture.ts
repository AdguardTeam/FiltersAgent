import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLocalIssueSnapshot } from '../../../src/local/issue-snapshot';
import { buildExportedIssueRevision } from '../../../src/local/issue-revision';
import type { RawIssue } from '../../../src/github/fetch-issue';
import { BrowserMode } from '../../../src/types/browser-mode';
import { ExtensionEnvironmentKind } from '../../../src/types/extension-environment-kind';
import type { ExportedSnapshotCycleOptions } from '../../../lab/local/local-cycle';

const fixtureRoots: string[] = [];

/**
 * Remove every disposable smoke fixture root. Tests call this from their `afterEach`, after the
 * hermetic providers were stopped.
 */
export async function disposeSnapshotSmokeFixtures(): Promise<void> {
    for (const root of fixtureRoots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
}

/**
 * The smoke fixture's issue document: one ordinary website-filtering report whose body names the
 * reported URL, bounded enough for the deterministic extraction seam.
 */
const smokeIssue: RawIssue = {
    number: 4,
    url: 'https://github.com/example/lab/issues/4',
    title: 'Ad remains visible',
    body: [
        '### Issue URL (Ads)',
        'https://example.com/article',
        '',
        '### System configuration',
        'AdGuard product: | AdGuard Browser Extension v5.4.3',
        'Filters: | AdGuard Base filter',
    ].join('\n'),
    state: 'open',
    labels: ['T: Ads'],
    assignee: null,
    comments: [],
};

/**
 * The disposable paths one smoke fixture owns.
 */
export interface SnapshotSmokeFixture {
    /**
     * Workspace root the CLI face runs against.
     */
    workspaceRoot: string;

    /**
     * Filters checkout the fixture preparer hands every run.
     */
    checkoutPath: string;

    /**
     * Exported issue snapshot the run reads.
     */
    issueFile: string;

    /**
     * Cycle output root driven by the entry face.
     */
    entryOutputDir: string;

    /**
     * Cycle output root driven by the directly invoked oracle cycle.
     */
    oracleOutputDir: string;
}

/**
 * Create one disposable smoke fixture: an exported issue snapshot whose publication identity
 * matches its issue URL, a filters checkout fixture, a workspace root, and the two dedicated cycle
 * output roots (one per smoke leg).
 *
 * @returns The fixture paths.
 */
export function createSnapshotSmokeFixture(): SnapshotSmokeFixture {
    const root = mkdtempSync(join(tmpdir(), 'agent-cli-snapshot-smoke-'));
    fixtureRoots.push(root);
    const workspaceRoot = join(root, 'workspace');
    const checkoutPath = join(root, 'filters-checkout');
    mkdirSync(workspaceRoot, { recursive: true });
    mkdirSync(join(checkoutPath, 'BaseFilter', 'sections'), { recursive: true });
    writeFileSync(join(checkoutPath, 'BaseFilter/sections/foreign.txt'), '', 'utf8');
    const issueFile = join(root, 'issue.json');
    writeFileSync(
        issueFile,
        JSON.stringify(
            buildExportedIssueRevision({
                repository: 'example/lab',
                issueNumber: 4,
                sourceUpdatedAt: '2026-09-01T10:00:00.000Z',
                capturedAt: '2026-09-01T10:01:00.000Z',
                snapshot: buildLocalIssueSnapshot(smokeIssue, []),
            }),
        ),
    );
    return {
        workspaceRoot,
        checkoutPath,
        issueFile,
        entryOutputDir: join(root, 'entry-run'),
        oracleOutputDir: join(root, 'oracle-run'),
    };
}

/**
 * The oracle cycle options for one fixture, mirroring exactly what the parsed `fix --issue-file`
 * command adapter derives: dedicated output root, current environment, kept artifact defaults, and
 * the empty pricing table the adapter falls back to when the workspace carries no pin.
 *
 * @param fixture - The snapshot smoke fixture paths.
 * @param fixture.issueFile - The exported issue snapshot the cycle reads.
 * @param fixture.oracleOutputDir - The dedicated oracle output root.
 * @returns The exported-snapshot cycle options.
 */
export function oracleCycleOptions(fixture: {
    /**
     * The exported issue snapshot the cycle reads.
     */
    issueFile: string;

    /**
     * The dedicated oracle output root.
     */
    oracleOutputDir: string;
}): ExportedSnapshotCycleOptions {
    return {
        issueNumber: 4,
        issueFile: fixture.issueFile,
        outputDir: fixture.oracleOutputDir,
        environment: ExtensionEnvironmentKind.Current,
        keepTemporaryFiles: false,
        browserMode: BrowserMode.Auto,
        verbose: false,
        pricingSnapshot: {},
    };
}

/**
 * List every regular file under one root, relative to it, recursively, sorted.
 *
 * @param root - Directory to walk.
 * @param prefix - Accumulated relative prefix.
 * @returns Sorted relative file paths.
 */
export function relativeFileSet(root: string, prefix = ''): string[] {
    return readdirSync(root, { withFileTypes: true })
        .flatMap((entry) => {
            const path = join(root, entry.name);
            const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
            return entry.isDirectory() ? relativeFileSet(path, relativePath) : [relativePath];
        })
        .sort((left, right) => left.localeCompare(right));
}

/**
 * Resolve the single published generation directory under one runs root.
 *
 * @param runsRoot - The investigation's runs root.
 * @returns The absolute generation path.
 */
export function publishedGenerationPath(runsRoot: string): string {
    const directories = readdirSync(runsRoot, { withFileTypes: true }).filter((entry) =>
        entry.isDirectory(),
    );
    if (directories.length !== 1) {
        throw new Error(`Expected exactly one published generation under ${runsRoot}.`);
    }
    return join(runsRoot, directories[0]!.name);
}

/**
 * The agent-facing report document one published generation actually carries, derived from the
 * published tree itself: the report is the single top-level Markdown document the publication
 * writer produced. Consumers of the real layout — including the printed-line expectations — derive
 * the name from this seam instead of restating a fabricated file name.
 *
 * @param generationPath - The published generation directory.
 * @returns The report document's file name.
 * @throws When the generation does not carry exactly one top-level Markdown document.
 */
export function publishedReportDocument(generationPath: string): string {
    const documents = relativeFileSet(generationPath).filter(
        (name) => !name.includes('/') && name.endsWith('.md'),
    );
    if (documents.length !== 1) {
        throw new Error(
            `Expected exactly one top-level Markdown report document under ${generationPath}.`,
        );
    }
    return documents[0]!;
}

/**
 * A run-owned UUID: the session correlation ids the investigation mints per run (trace file names
 * and their bound record paths). Structure is compared with these normalized away — the record
 * itself pseudonymizes the same ids — so the two legs compare as the same artifact set.
 */
const RUN_OWNED_UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu;

/**
 * Normalize one relative file-name set the same way the session ids are pseudonymized in the
 * record: the exported trace file name carries the run's own session id.
 *
 * @param paths - Relative file paths.
 * @returns The normalized sorted list.
 */
export function normalizeFileNameSet(paths: string[]): string[] {
    return paths
        .map((path) => path.replace(RUN_OWNED_UUID_PATTERN, '<run-id>'))
        .sort((left, right) => left.localeCompare(right));
}

/**
 * Normalize one run's published invariant values so the two legs compare equal despite living in
 * different output roots: absolute paths are only comparable up to the run's own root, and the
 * run's own correlation ids are placeholders.
 *
 * @param value - The JSON-bound values or paths to normalize.
 * @param runRoot - The output root whose prefix must be normalized away.
 * @returns The normalized value.
 */
export function normalizeRunOwnedValues(value: unknown, runRoot: string): unknown {
    if (typeof value === 'string') {
        return value.split(runRoot).join('<run-root>').replace(RUN_OWNED_UUID_PATTERN, '<run-id>');
    }
    if (Array.isArray(value)) {
        return value.map((entry) => normalizeRunOwnedValues(entry, runRoot));
    }
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([key, entry]) => [
                key,
                normalizeRunOwnedValues(entry, runRoot),
            ]),
        );
    }
    return value;
}
