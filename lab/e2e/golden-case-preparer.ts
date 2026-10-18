import { assertOracleIsolation } from './golden-oracle-isolation';
import type { withPreparedFiltersCheckout } from '../../src/local/filters-preparer';
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
import { type GithubReadConfig, type RawIssue } from '../../src/github/fetch-issue';
import { IssueState } from '../../src/types/issue-state';
import { exportGithubIssue } from '../local/github-issue-exporter';
import {
    loadLocalIssueSnapshot,
    type ExportedLocalIssueSnapshot,
    type LocalIssueComment,
    type LocalIssueSnapshot,
} from '../../src/local/issue-snapshot';
import { parseReporterSettingsImportUrl } from '../../src/browser/adguard-settings-import-url';
import type { IssueFacts } from '../../src/types/issue-facts';
import { reportToIssueFacts } from '../../src/intake/report-facts';
import type { Report } from '../../src/intake/report';
import {
    GoldenRunSchemaVersion,
    loadGoldenHumanOracle,
    loadGoldenRunCase,
    writeGoldenRunDocument,
} from './golden-case';
import { GOLDEN_CASE_NAME_PATTERN } from './golden-case-name';
import type { Logger } from '../../src/logger/logger';
import { prepareHistoricalExtensionBuild } from '../local/historical-extension-build';
import {
    autobuildTagFor,
    extensionCodeLine,
    findHistoricalReleaseForVersion,
} from '../local/historical-extension-releases';
import type { ExtensionBuildPin } from '../local/run-config';
import {
    FILTERS_REPOSITORY,
    inspectHistoricalCaseMetadata,
    type HistoricalCaseInspectionInput,
    type HistoricalCaseMetadata,
} from './historical-case-metadata';
import { checkHistoricalHumanFixAbsent, HumanFixPresentError } from './human-fix-build-guard';
import { isPinnableImportLink } from './pinned-report';

/**
 * Inputs needed to prepare one tracked historical golden case.
 */
export interface PrepareGoldenCaseOptions {
    /**
     * Print one removed rule absent from the build as an advisory warning.
     */
    onWarning?: (rule: string) => void;

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
     * Host-only cache for verified historical reporter builds.
     */
    cacheRoot: string;

    /**
     * Receives build preparation diagnostics.
     */
    logger: Logger;

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
 * Injectable effects for deterministic case-preparation tests.
 */
export interface GoldenCasePreparationDependencies {
    /**
     * Existing historical filters checkout lifecycle, injectable for offline tests.
     */
    withPreparedFiltersCheckout?: typeof withPreparedFiltersCheckout;

    /**
     * Reporter build assembler, injectable for offline case-preparation tests.
     */
    prepareHistoricalExtensionBuild?: typeof prepareHistoricalExtensionBuild;

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
     * Exact reporter build verified to exclude the human fix.
     */
    extensionBuild: ExtensionBuildPin;

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
    return isPinnableImportLink(
        parseReporterSettingsImportUrl(facts.settingsImportUrl),
        extensionVersion,
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
        const extensionTag = autobuildTagFor(compatibleReport.extensionVersion);
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
        const version = compatibleReport.extensionVersion;
        const release = findHistoricalReleaseForVersion(version);
        if (!release) {
            throw new Error(
                `No listed release for code line ${extensionCodeLine(version)} (reporter version ${version}).`,
            );
        }
        const extensionBuild: ExtensionBuildPin = {
            version,
            releaseTag: release.tag,
            autobuildCommit: metadata.extensionTagCommit.toLowerCase(),
        };
        const build = await (
            dependencies.prepareHistoricalExtensionBuild ?? prepareHistoricalExtensionBuild
        )({
            build: extensionBuild,
            cacheRoot: options.cacheRoot,
            logger: options.logger,
        });
        const { violations, warnings } = await checkHistoricalHumanFixAbsent(
            build.extensionDir,
            metadata.humanRuleLines,
            metadata.filtersBaseSha,
            dependencies.withPreparedFiltersCheckout,
        );
        for (const warning of warnings) {
            options.onWarning?.(warning);
        }
        if (violations.length > 0) {
            throw new HumanFixPresentError(violations);
        }
        writeGoldenRunDocument(stagingDirectory, {
            schemaVersion: GoldenRunSchemaVersion.Current,
            issueNumber: options.issueNumber,
            issueFile: 'issue/issue.json',
            filtersBaseSha: metadata.filtersBaseSha.toLowerCase(),
            extensionBuild,
        });
        writeJson(join(stagingDirectory, 'oracle.json'), {
            humanFixCommit: options.humanFixCommit.toLowerCase(),
            issueCreatedAt: metadata.issueCreatedAt,
            fixCommittedAt: metadata.fixCommittedAt,
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
            extensionBuild,
            promptVisibleScreenshotCount: finalSnapshot.attachments.filter(
                (attachment) => attachment.promptVisible,
            ).length,
        };
    } finally {
        rmSync(stagingDirectory, { recursive: true, force: true });
    }
}
