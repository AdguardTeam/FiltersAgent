import { randomUUID } from 'node:crypto';
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    renameSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createOctokit, type GithubReadConfig, type RawIssue } from '../../src/github/fetch-issue';
import { IssueState } from '../../src/types/issue-state';
import { exportGithubIssue } from '../local/github-issue-exporter';
import {
    loadLocalIssueSnapshot,
    toAgentIssueInput,
    type ExportedLocalIssueSnapshot,
    type LocalIssueComment,
    type LocalIssueSnapshot,
} from '../../src/local/issue-snapshot';
import { normalizeRule } from '../../src/repo/rule-normalizer';
import type { IssueFacts } from '../../src/types/issue-facts';
import { reportToIssueFacts } from '../../src/intake/report-facts';
import type { Report } from '../../src/intake/report';
import { loadGoldenHumanOracle, loadGoldenRunCase } from './golden-case';
import { GOLDEN_CASE_NAME_PATTERN } from './golden-case-name';
import { parseHumanCommitDiff } from './human-commit-oracle';

/**
 * Trusted upstream repository containing the human filter history.
 */
const FILTERS_REPOSITORY = { owner: 'AdguardTeam', repo: 'AdguardFilters' } as const;

/**
 * Trusted upstream repository containing historical browser-extension tags.
 */
const EXTENSION_REPOSITORY = {
    owner: 'AdguardTeam',
    repo: 'AdguardBrowserExtension',
} as const;

/**
 * Inputs needed to prepare one tracked historical golden case.
 */
export interface PrepareGoldenCaseOptions {
    /**
     * Upstream issue number.
     */
    issueNumber: number;

    /**
     * Full human fix commit stored only in oracle.json.
     */
    humanFixCommit: string;

    /**
     * Absolute repository root whose tracked case directory receives the bundle.
     */
    workspaceRoot: string;

    /**
     * Optional absolute golden case root used by tests or alternate corpora.
     */
    casesRoot?: string;

    /**
     * Optional explicit safe case directory name.
     */
    caseName?: string;
}

/**
 * Read-only historical metadata validated before a case becomes visible in the corpus.
 */
export interface HistoricalCaseMetadata {
    /**
     * Last AdguardFilters master commit at or before issue creation.
     */
    filtersBaseSha: string;

    /**
     * Commit targeted by the exact extension autobuild tag from the selected report.
     */
    extensionTagCommit: string;

    /**
     * Files changed by the trusted human fix commit.
     */
    humanChangedFiles: string[];

    /**
     * Transient human-answer fingerprints used only to reject contaminated agent input.
     */
    humanRuleCandidates: HumanRuleIsolationCandidate[];
}

/**
 * Minimal transient human-answer fingerprint retained only while a case is prepared.
 */
export interface HumanRuleIsolationCandidate {
    /**
     * Canonical form of the reporter-relevant domain delta or inserted human rule.
     */
    canonicalRule: string;

    /**
     * Exact added repository line from the human commit.
     */
    sourceRule: string;
}

/**
 * GitHub commit file fields required to extract human filter-rule fingerprints.
 */
interface HumanCommitFile {
    /**
     * Repository-relative path changed by the human commit.
     */
    filename: string;

    /**
     * GitHub-provided unified patch for the changed file.
     */
    patch?: string;
}

/**
 * Arguments passed to the read-only GitHub history inspector.
 */
export interface HistoricalCaseInspectionInput {
    /**
     * Upstream issue number.
     */
    issueNumber: number;

    /**
     * Full proposed human fix commit.
     */
    humanFixCommit: string;

    /**
     * Exact extension autobuild tag derived from prompt-visible issue evidence.
     */
    extensionTag: string;
}

/**
 * Injectable effects for deterministic case-preparation tests.
 */
export interface GoldenCasePreparationDependencies {
    /**
     * Existing read-only issue and attachment exporter.
     */
    exportIssue?: typeof exportGithubIssue;

    /**
     * Read-only inspection of issue time, filters history, extension tag, and human commit.
     */
    inspectHistoricalMetadata?: (
        config: GithubReadConfig,
        input: HistoricalCaseInspectionInput,
    ) => Promise<HistoricalCaseMetadata>;

    /**
     * The intake extraction seam: one raw issue, one model-filled and schema-validated report, or
     * null when the extraction skipped the issue ("not a filter report"). The facts mapping runs
     * through {@link reportToIssueFacts} inside this module. Production binds the run's LLM
     * configuration; tests script the verdict. There is no deterministic fallback — the model owns
     * the read.
     */
    extractReport?: (raw: RawIssue) => Promise<Report | null>;
}

/**
 * Injectable GitHub client factory for history-inspection unit tests.
 */
export interface HistoricalCaseInspectionDependencies {
    /**
     * Build the read-only Octokit client used by the inspector.
     */
    createClient?: typeof createOctokit;
}

/**
 * Materialized and independently reloadable golden case.
 */
export interface PreparedGoldenCase {
    /**
     * Stable directory name derived from the reported domain and issue number.
     */
    caseName: string;

    /**
     * Absolute final tracked case directory.
     */
    caseDirectory: string;

    /**
     * Computed pre-issue AdguardFilters base commit.
     */
    filtersBaseSha: string;

    /**
     * Historical extension tag proven to exist upstream.
     */
    extensionTag: string;

    /**
     * Commit targeted by the validated extension tag.
     */
    extensionTagCommit: string;

    /**
     * Number of prompt-visible reporter screenshots retained in the portable bundle.
     */
    promptVisibleScreenshotCount: number;
}

/**
 * One prompt-visible structured issue report and its parsed facts.
 */
interface CompatibleIssueReport {
    /**
     * Parsed deterministic issue facts.
     */
    facts: IssueFacts;

    /**
     * Exact four-component extension version.
     */
    extensionVersion: string;
}

/**
 * Normalize a GitHub API failure into a bounded preparation diagnostic.
 *
 * @param operation - Read operation that failed.
 * @param error - Unknown transport or API error.
 * @returns Error containing no credential-bearing URL.
 */
function githubReadError(operation: string, error: unknown): Error {
    return new Error(`${operation}: ${(error as Error).message}`, { cause: error });
}

/**
 * Extract transient canonical and source-rule fingerprints from GitHub commit patches.
 *
 * Missing patches fail closed: without the complete text diff the preparer cannot prove that the
 * prompt is independent of the answer. The returned rules are used in memory and are never written
 * into the case bundle.
 *
 * @param files - GitHub commit files containing repository paths and unified patches.
 * @returns Deduplicated human-rule fingerprints in diff order.
 */
function extractHumanRuleCandidates(
    files: readonly HumanCommitFile[],
): HumanRuleIsolationCandidate[] {
    const textFiles = files.filter((file) => file.filename.endsWith('.txt'));
    const missingPatch = textFiles.find((file) => typeof file.patch !== 'string');
    if (missingPatch) {
        throw new Error(`GitHub omitted the human diff patch for ${missingPatch.filename}.`);
    }
    const diff = textFiles.map((file) => `+++ b/${file.filename}\n${file.patch!}`).join('\n');
    const candidates = parseHumanCommitDiff(diff).map((candidate) => ({
        canonicalRule: normalizeRule(candidate.rule).canonical,
        sourceRule: candidate.sourceRule,
    }));
    if (candidates.length === 0) {
        throw new Error('Human fix commit contains no extractable filter-rule candidates.');
    }
    return [
        ...new Map(
            candidates.map((candidate) => [
                `${candidate.canonicalRule}\0${candidate.sourceRule}`,
                candidate,
            ]),
        ).values(),
    ];
}

/**
 * Encode one exact text value as it appears inside a JSON-stringified agent input.
 *
 * @param value - Unescaped title, body, comment, label, or attachment field value.
 * @returns Lower-cased escaped JSON fragment without surrounding quotes.
 */
function agentInputTextFragment(value: string): string {
    return JSON.stringify(value).slice(1, -1).toLowerCase();
}

/**
 * Inspect the immutable history needed to prove a historical case is reproducible.
 *
 * @param config - GitHub read credential; repository coordinates are ignored in favor of trusted
 *   upstream repositories.
 * @param input - Issue, human commit, and extension tag to validate.
 * @param dependencies - Optional deterministic GitHub client seam.
 * @returns Validated pre-issue base, extension tag commit, and human changed files.
 */
export async function inspectHistoricalCaseMetadata(
    config: GithubReadConfig,
    input: HistoricalCaseInspectionInput,
    dependencies: HistoricalCaseInspectionDependencies = {},
): Promise<HistoricalCaseMetadata> {
    const octokit = (dependencies.createClient ?? createOctokit)(config);
    try {
        const issueResponse = await octokit.rest.issues.get({
            ...FILTERS_REPOSITORY,
            issue_number: input.issueNumber,
        });
        if ('pull_request' in issueResponse.data) {
            throw new Error(`Issue #${input.issueNumber} is a pull request.`);
        }
        const createdAt = issueResponse.data.created_at;
        const [baseResponse, humanResponse, extensionResponse] = await Promise.all([
            octokit.rest.repos.listCommits({
                ...FILTERS_REPOSITORY,
                sha: 'master',
                until: createdAt,
                per_page: 1,
            }),
            octokit.rest.repos.getCommit({
                ...FILTERS_REPOSITORY,
                ref: input.humanFixCommit,
            }),
            octokit.rest.git.getRef({
                ...EXTENSION_REPOSITORY,
                ref: `tags/${input.extensionTag}`,
            }),
        ]);
        const filtersBaseSha = baseResponse.data[0]?.sha?.toLowerCase();
        if (!filtersBaseSha || !/^[0-9a-f]{40}$/u.test(filtersBaseSha)) {
            throw new Error(`No AdguardFilters master commit exists before ${createdAt}.`);
        }
        const resolvedHumanCommit = humanResponse.data.sha.toLowerCase();
        if (resolvedHumanCommit !== input.humanFixCommit.toLowerCase()) {
            throw new Error('GitHub resolved the human fix to an unexpected commit.');
        }
        const humanMessage = humanResponse.data.commit.message;
        if (!new RegExp(`#${input.issueNumber}(?:\\D|$)`, 'u').test(humanMessage)) {
            throw new Error(`Human fix commit does not reference issue #${input.issueNumber}.`);
        }
        if (humanResponse.data.parents.length !== 1) {
            throw new Error(
                'Human fix commit must have exactly one parent for deterministic diffing.',
            );
        }
        const humanFiles = humanResponse.data.files ?? [];
        const humanChangedFiles = humanFiles.map((file) => file.filename);
        if (!humanChangedFiles.some((file) => file.endsWith('.txt'))) {
            throw new Error('Human fix commit does not change an AdguardFilters text file.');
        }
        const humanRuleCandidates = extractHumanRuleCandidates(humanFiles);
        if (extensionResponse.data.object.type !== 'commit') {
            throw new Error(
                `Extension tag ${input.extensionTag} does not point directly to a commit.`,
            );
        }
        const extensionTagCommit = extensionResponse.data.object.sha.toLowerCase();
        if (!/^[0-9a-f]{40}$/u.test(extensionTagCommit)) {
            throw new Error(`Extension tag ${input.extensionTag} returned an invalid commit.`);
        }
        return {
            filtersBaseSha,
            extensionTagCommit,
            humanChangedFiles,
            humanRuleCandidates,
        };
    } catch (error) {
        throw githubReadError(`Unable to validate historical case #${input.issueNumber}`, error);
    }
}

/**
 * Select the latest prompt-visible report that fully describes a Chrome MV3 environment.
 *
 * Compatibility reads only the extraction's mapped facts: the model decides whether a body is a
 * filter report at all, so the preparer has no deterministic issue-format reader of its own.
 *
 * @param snapshot - Exported raw and reporter-safe issue bundle.
 * @param extractReport - Bound intake extraction seam.
 * @returns Latest compatible report and exact extension version.
 */
async function selectCompatibleReport(
    snapshot: LocalIssueSnapshot,
    extractReport: (raw: RawIssue) => Promise<Report | null>,
): Promise<CompatibleIssueReport> {
    const bodies = [
        snapshot.rawIssue.body ?? '',
        ...snapshot.reporterComments.map((comment: LocalIssueComment) => comment.body),
    ];
    const reports: CompatibleIssueReport[] = [];
    for (const body of bodies) {
        const rawIssue: RawIssue = {
            number: snapshot.rawIssue.number,
            url: snapshot.rawIssue.url,
            title: snapshot.rawIssue.title,
            body,
            state: snapshot.rawIssue.state,
            labels: snapshot.rawIssue.labels,
            assignee: snapshot.rawIssue.assignee,
            comments: [],
        };
        const report = await extractReport(rawIssue);
        if (report === null) {
            continue;
        }
        const facts = reportToIssueFacts(
            {
                number: snapshot.rawIssue.number,
                url: snapshot.rawIssue.url,
                labels: snapshot.rawIssue.labels,
            },
            report,
        );
        const extensionVersion = extensionVersionFromProduct(facts.product);
        if (
            extensionVersion !== null &&
            /chrome/iu.test(facts.browser ?? '') &&
            hasExactExtensionImport(facts, extensionVersion)
        ) {
            reports.push({ facts, extensionVersion });
        }
    }
    const selected = reports.at(-1);
    if (!selected) {
        throw new Error(
            'Issue has no prompt-visible Chrome MV3 Browser Extension report with exact import settings.',
        );
    }
    if (selected.facts.screenshots.length === 0) {
        throw new Error('Compatible issue report has no reporter screenshot.');
    }
    const visibleAttachmentUrls = new Set(
        snapshot.attachments
            .filter((attachment) => attachment.promptVisible)
            .map((attachment) => attachment.sourceUrl),
    );
    const missingScreenshots = selected.facts.screenshots.filter(
        (screenshot) => !visibleAttachmentUrls.has(screenshot.url),
    );
    if (missingScreenshots.length > 0) {
        throw new Error(
            'Compatible issue report screenshots were not downloaded as prompt evidence.',
        );
    }
    return selected;
}

/**
 * Read the exact Browser Extension version from a supported product description.
 *
 * @param product - Product row parsed from the issue report.
 * @returns Four-component extension version, or null when the report is not Chrome MV3.
 */
function extensionVersionFromProduct(product: string): string | null {
    return product.match(/\bAdGuard Browser Extension v(\d+(?:\.\d+){3})\s+MV3\b/iu)?.[1] ?? null;
}

/**
 * Verify that one settings import matches the selected Chrome MV3 extension report.
 *
 * @param facts - Parsed report facts.
 * @param extensionVersion - Expected exact product version.
 * @returns Whether the import URL carries the required extension settings identity.
 */
function hasExactExtensionImport(facts: IssueFacts, extensionVersion: string): boolean {
    if (!facts.settingsImportUrl) {
        return false;
    }
    const importUrl = new URL(facts.settingsImportUrl);
    return (
        importUrl.searchParams.get('product_type') === 'ext' &&
        importUrl.searchParams.get('product_version') === extensionVersion &&
        importUrl.searchParams.get('ext.manifest_version') === '3' &&
        importUrl.searchParams.get('browser')?.toLowerCase() === 'chrome'
    );
}

/**
 * Derive a portable case identifier from the selected reported hostname.
 *
 * @param reportedUrl - Target URL selected from the compatible issue report.
 * @param issueNumber - Upstream issue number appended for uniqueness.
 * @returns Safe case directory name.
 */
function deriveCaseName(reportedUrl: string, issueNumber: number): string {
    const hostname = new URL(reportedUrl).hostname.toLowerCase().replace(/^www\./u, '');
    const domainSlug = hostname
        .replace(/[^a-z0-9]+/gu, '-')
        .replace(/^-+|-+$/gu, '')
        .slice(0, 80);
    if (!domainSlug) {
        throw new Error('Reported URL cannot be converted to a portable case name.');
    }
    return `${domainSlug}-${issueNumber}`;
}

/**
 * Assert that the closed human answer cannot cross the model-input boundary.
 *
 * The raw issue history deliberately remains complete for audit. Only the narrowed
 * {@link toAgentIssueInput} representation is subject to this boundary.
 *
 * @param snapshot - Complete raw issue snapshot used to derive agent-visible input.
 * @param humanFixCommit - Full closed human commit.
 * @param humanRuleCandidates - Transient answer fingerprints extracted from the human diff.
 */
function assertOracleIsolation(
    snapshot: LocalIssueSnapshot,
    humanFixCommit: string,
    humanRuleCandidates: readonly HumanRuleIsolationCandidate[] = [],
): void {
    const agentInput = JSON.stringify(toAgentIssueInput(snapshot));
    const normalizedAgentInput = agentInput.toLowerCase();
    const shortHumanCommit = humanFixCommit.slice(0, 7).toLowerCase();
    if (normalizedAgentInput.includes(shortHumanCommit)) {
        throw new Error('Full or abbreviated human fix commit leaked into agent-visible input.');
    }
    if (
        /github\.com[\\/]adguardteam[\\/]adguardfilters[\\/](?:pull|pulls)[\\/]\d+/iu.test(
            agentInput,
        ) ||
        /\b(?:pr|pull request)\s*:?[ \t]*#?\d+\b/iu.test(agentInput)
    ) {
        throw new Error('Human pull request reference leaked into agent-visible input.');
    }
    for (const candidate of humanRuleCandidates) {
        const canonicalRule = candidate.canonicalRule.trim().toLowerCase();
        const sourceRule = candidate.sourceRule.trim().toLowerCase();
        if (!canonicalRule || !sourceRule) {
            throw new Error('Human rule isolation candidate is incomplete.');
        }
        if (
            normalizedAgentInput.includes(agentInputTextFragment(canonicalRule)) ||
            normalizedAgentInput.includes(agentInputTextFragment(sourceRule))
        ) {
            throw new Error('Human filter rule leaked into agent-visible input.');
        }
    }
}

/**
 * Write one JSON document with stable formatting.
 *
 * @param path - Destination JSON path.
 * @param value - JSON-compatible document.
 */
function writeJson(path: string, value: unknown): void {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * Prepare one historical golden case using GitHub reads, the intake extraction, and local atomic
 * materialization only.
 *
 * @param config - GitHub read credential.
 * @param options - Issue, oracle, and local destination configuration.
 * @param dependencies - Deterministic transport seams and the bound intake extraction.
 * @returns Validated final case identity and provenance.
 */
export async function prepareGoldenCase(
    config: GithubReadConfig,
    options: PrepareGoldenCaseOptions,
    dependencies: GoldenCasePreparationDependencies = {},
): Promise<PreparedGoldenCase> {
    if (!/^[0-9a-f]{40}$/iu.test(options.humanFixCommit)) {
        throw new Error('Human fix commit must be a full commit SHA.');
    }
    const workspaceRoot = resolve(options.workspaceRoot);
    const casesRoot = resolve(
        options.casesRoot ?? join(workspaceRoot, 'lab', 'benchmark', 'e2e', 'cases'),
    );
    const stagingDirectory = mkdtempSync(join(tmpdir(), 'adguard-golden-case-'));
    const exportIssue = dependencies.exportIssue ?? exportGithubIssue;
    const inspectMetadata = dependencies.inspectHistoricalMetadata ?? inspectHistoricalCaseMetadata;
    if (!dependencies.extractReport) {
        throw new Error(
            'Golden case preparation requires an extractReport dependency bound to the run LLM ' +
                'configuration; compatibility facts come from the intake extraction.',
        );
    }
    const { extractReport } = dependencies;

    try {
        const exported: ExportedLocalIssueSnapshot = await exportIssue(
            { ...config, ...FILTERS_REPOSITORY },
            options.issueNumber,
            {
                outputDir: join(stagingDirectory, 'issue'),
                workspaceRoot,
                reporterOnlyPrompt: true,
                includeStructuredIssueReports: true,
            },
        );
        if (exported.snapshot.rawIssue.number !== options.issueNumber) {
            throw new Error('Exported issue number does not match the requested case.');
        }
        if (exported.snapshot.rawIssue.state !== IssueState.Closed) {
            throw new Error('Historical golden cases require a closed issue.');
        }
        assertOracleIsolation(exported.snapshot, options.humanFixCommit);
        const compatibleReport = await selectCompatibleReport(exported.snapshot, extractReport);
        const derivedCaseName = deriveCaseName(
            compatibleReport.facts.reportedSiteUrls[0]!,
            options.issueNumber,
        );
        const caseName = options.caseName ?? derivedCaseName;
        if (!GOLDEN_CASE_NAME_PATTERN.test(caseName)) {
            throw new Error(`Invalid golden E2E case name: ${caseName}`);
        }
        const extensionTag = `autobuild-v${compatibleReport.extensionVersion}`;
        const metadata = await inspectMetadata(config, {
            issueNumber: options.issueNumber,
            humanFixCommit: options.humanFixCommit.toLowerCase(),
            extensionTag,
        });
        if (!metadata.humanChangedFiles.some((file) => file.endsWith('.txt'))) {
            throw new Error('Human fix does not contain a filter text-file change.');
        }
        if (metadata.humanRuleCandidates.length === 0) {
            throw new Error('Human fix contains no rule candidates for oracle isolation.');
        }
        assertOracleIsolation(
            exported.snapshot,
            options.humanFixCommit,
            metadata.humanRuleCandidates,
        );
        writeJson(join(stagingDirectory, 'run.json'), {
            schemaVersion: 2,
            issueNumber: options.issueNumber,
            issueFile: 'issue/issue.json',
            filtersBaseSha: metadata.filtersBaseSha.toLowerCase(),
        });
        writeJson(join(stagingDirectory, 'oracle.json'), {
            humanFixCommit: options.humanFixCommit.toLowerCase(),
        });

        loadGoldenRunCase(stagingDirectory);
        loadGoldenHumanOracle(stagingDirectory);
        loadLocalIssueSnapshot(exported.snapshotPath);
        const destination = join(casesRoot, caseName);
        if (existsSync(destination)) {
            throw new Error(`Golden case already exists: ${destination}`);
        }
        mkdirSync(casesRoot, { recursive: true });
        const temporaryDestination = join(casesRoot, `.${basename(caseName)}-${randomUUID()}`);
        try {
            cpSync(stagingDirectory, temporaryDestination, { recursive: true, errorOnExist: true });
            loadGoldenRunCase(temporaryDestination);
            loadGoldenHumanOracle(temporaryDestination);
            renameSync(temporaryDestination, destination);
        } catch (error) {
            rmSync(temporaryDestination, { recursive: true, force: true });
            throw error;
        }
        const finalRun = loadGoldenRunCase(destination);
        const finalSnapshot = loadLocalIssueSnapshot(finalRun.issueFile);
        assertOracleIsolation(finalSnapshot, options.humanFixCommit, metadata.humanRuleCandidates);
        return {
            caseName,
            caseDirectory: destination,
            filtersBaseSha: metadata.filtersBaseSha.toLowerCase(),
            extensionTag,
            extensionTagCommit: metadata.extensionTagCommit.toLowerCase(),
            promptVisibleScreenshotCount: finalSnapshot.attachments.filter(
                (attachment) => attachment.promptVisible,
            ).length,
        };
    } finally {
        rmSync(stagingDirectory, { recursive: true, force: true });
    }
}
