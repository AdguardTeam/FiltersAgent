import * as v from 'valibot';
import { createOctokit, type GithubReadConfig } from '../../src/github/fetch-issue';
import { FULL_COMMIT_SHA_PATTERN } from '../../src/environment/environment-proofs';
import { normalizeRule } from '../../src/repo/rule-normalizer';
import {
    parseHumanCommitDiff,
    parseHumanCommitRuleLines,
    type HumanCommitRuleLines,
} from './human-commit-oracle';

const HumanCommitFilesSchema = v.array(
    v.object({
        filename: v.string(),
        patch: v.optional(v.string()),
    }),
);

/**
 * Trusted upstream repository containing the human filter history.
 */
export const FILTERS_REPOSITORY = { owner: 'AdguardTeam', repo: 'AdguardFilters' } as const;

/**
 * Trusted upstream repository containing historical browser-extension tags.
 */
export const EXTENSION_REPOSITORY = {
    owner: 'AdguardTeam',
    repo: 'AdguardBrowserExtension',
} as const;

/**
 * Read-only historical metadata validated before a case becomes visible in the corpus.
 */
export interface HistoricalCaseMetadata {
    /**
     * Original GitHub issue creation timestamp used to measure human turnaround.
     */
    issueCreatedAt: string;

    /**
     * Human fix committer timestamp, independent of the commit author date.
     */
    fixCommittedAt: string;

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

    /**
     * Original added and removed rules checked against the reporter build.
     */
    humanRuleLines: HumanCommitRuleLines;
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
 * Injectable GitHub client factory for history-inspection unit tests.
 */
export interface HistoricalCaseInspectionDependencies {
    /**
     * Build the read-only Octokit client used by the inspector.
     */
    createClient?: typeof createOctokit;
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
 * @param diff - Complete GitHub commit patches for changed text files.
 * @returns Deduplicated human-rule fingerprints in diff order.
 */
function extractHumanRuleCandidates(diff: string): HumanRuleIsolationCandidate[] {
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
 * Assemble complete text-file patches, refusing incomplete external GitHub responses.
 *
 * @param files - Validated external commit files.
 * @returns Unified text diff shared by answer isolation and build guards.
 */
function humanCommitDiff(files: readonly HumanCommitFile[]): string {
    const textFiles = files.filter((file) => file.filename.endsWith('.txt'));
    const missingPatch = textFiles.find((file) => typeof file.patch !== 'string');
    if (missingPatch) {
        throw new Error(`GitHub omitted the human diff patch for ${missingPatch.filename}.`);
    }
    return textFiles
        .map(
            (file) =>
                `diff --git a/${file.filename} b/${file.filename}\n+++ b/${file.filename}\n${file.patch!}`,
        )
        .join('\n');
}

/**
 * Resolve an official lightweight autobuild tag to a complete commit id.
 *
 * @param octokit - Authenticated read-only GitHub client.
 * @param tag - Exact autobuild tag of the reporter version.
 * @returns Full lowercase commit pinned by the tag.
 */
export async function resolveAutobuildTagCommit(
    octokit: ReturnType<typeof createOctokit>,
    tag: string,
): Promise<string> {
    const response = await octokit.rest.git.getRef({
        ...EXTENSION_REPOSITORY,
        ref: `tags/${tag}`,
    });
    if (response.data.object.type !== 'commit') {
        throw new Error(`Extension tag ${tag} does not point directly to a commit.`);
    }
    const commit = response.data.object.sha.toLowerCase();
    if (!FULL_COMMIT_SHA_PATTERN.test(commit)) {
        throw new Error(`Extension tag ${tag} returned an invalid commit.`);
    }
    return commit;
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
        const [baseResponse, humanResponse, extensionTagCommit] = await Promise.all([
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
            resolveAutobuildTagCommit(octokit, input.extensionTag),
        ]);
        const filtersBaseSha = baseResponse.data[0]?.sha?.toLowerCase();
        if (!filtersBaseSha || !FULL_COMMIT_SHA_PATTERN.test(filtersBaseSha)) {
            throw new Error(`No AdguardFilters master commit exists before ${createdAt}.`);
        }
        const resolvedHumanCommit = humanResponse.data.sha.toLowerCase();
        if (resolvedHumanCommit !== input.humanFixCommit.toLowerCase()) {
            throw new Error('GitHub resolved the human fix to an unexpected commit.');
        }
        const fixCommittedAt = humanResponse.data.commit.committer?.date;
        if (!fixCommittedAt) {
            throw new Error('Human fix commit has no committer date.');
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
        const humanFiles = v.parse(HumanCommitFilesSchema, humanResponse.data.files ?? []);
        const humanChangedFiles = humanFiles.map((file) => file.filename);
        if (!humanChangedFiles.some((file) => file.endsWith('.txt'))) {
            throw new Error('Human fix commit does not change an AdguardFilters text file.');
        }
        const diff = humanCommitDiff(humanFiles);
        const humanRuleCandidates = extractHumanRuleCandidates(diff);
        const humanRuleLines = parseHumanCommitRuleLines(diff);
        return {
            issueCreatedAt: createdAt,
            fixCommittedAt,
            filtersBaseSha,
            extensionTagCommit,
            humanChangedFiles,
            humanRuleCandidates,
            humanRuleLines,
        };
    } catch (error) {
        throw githubReadError(`Unable to validate historical case #${input.issueNumber}`, error);
    }
}
