import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { RawIssue } from '../../src/github/fetch-issue';
import type { Report } from '../../src/intake/report';
import type { ExtensionBuildPin } from '../local/run-config';
import {
    extractGoldenReporterEnvironment,
    type GoldenReporterEnvironment,
} from './golden-agent-environment';
import { GoldenOracleProbeStatus, type GoldenOracleProbe } from './golden-comparator';
import type { GoldenJudgeSeries } from './golden-runner';
import type { ExtractedHumanFix, HumanFixCandidate } from './human-commit-oracle';
import {
    cachedReporterEnvironment,
    freshHumanFixVerdict,
    judgeEnvironmentKey,
    judgeVerdictKey,
    readJudgeCache,
    writeJudgeCache,
    type CachedHumanFixVerdict,
} from './judge-cache';

/**
 * Explain that none of the historical human candidates resolves the current defect.
 */
const HUMAN_FIX_DRIFT_DETAIL = 'No human commit candidate still fixes the reporter-visible defect';

/**
 * Keep individual probe rationales distinguishable in the complete judgement detail.
 */
const PROBE_DETAIL_SEPARATOR = ' | ';

export const HumanFixVerdict = {
    Verified: 'verified',
    NotVerified: 'not_verified',
    InfrastructureFailure: 'infrastructure_failure',
    NotChecked: 'not_checked',
} as const;

/**
 * Independent human-fix evaluation state, including cases requiring no probe.
 */
export type HumanFixVerdict = (typeof HumanFixVerdict)[keyof typeof HumanFixVerdict];

/**
 * Independent evaluation of the complete ordered human candidate set.
 */
export type HumanFixJudgement =
    | CachedHumanFixVerdict
    | {
          /**
           * A failed probe prevents a conclusive judgement.
           */
          status: typeof HumanFixVerdict.InfrastructureFailure;
          /**
           * Complete independent probe failure details.
           */
          detail: string;
      };

/**
 * Post-lock inputs needed by the independent judge and shared cache.
 */
export interface GoldenJudgeCaseContext {
    /**
     * Shared judge configuration and cache policy.
     */
    series: GoldenJudgeSeries;
    /**
     * Stable case directory identity.
     */
    caseName: string;
    /**
     * Human commit loaded after the agent run seals.
     */
    humanFixCommit: string;
    /**
     * Historical build pinned by run.json.
     */
    extensionBuild: ExtensionBuildPin;
    /**
     * Portable issue snapshot the judge independently interprets.
     */
    issueFile: string;
    /**
     * Wall-clock timestamp source for verdict lifetime and check timestamps.
     */
    now: () => number;
}

/**
 * Read or independently extract exact reporter settings without a lifetime limit.
 *
 * @param context - Case identity and cache policy.
 * @param extractReport - Judge-bound report extraction seam.
 * @returns Reporter environment and whether it came from the shared cache.
 */
export async function judgeReporterEnvironment(
    context: GoldenJudgeCaseContext,
    extractReport: (raw: RawIssue) => Promise<Report | null>,
): Promise<{
    /**
     * Independently extracted exact reporter settings.
     */
    environment: GoldenReporterEnvironment;
    /**
     * Whether shared persisted extraction was reused.
     */
    fromCache: boolean;
}> {
    const { series, caseName, humanFixCommit, extensionBuild, issueFile } = context;
    const issueSha256 = issueSnapshotSha256(issueFile);
    const key = judgeEnvironmentKey(
        caseName,
        humanFixCommit,
        extensionBuild,
        series.judgeConfig.llm,
        issueSha256,
    );
    if (series.judgeCacheRoot && !series.refreshJudgeCache) {
        const cached = cachedReporterEnvironment(
            readJudgeCache(series.judgeCacheRoot, caseName),
            key,
        );
        if (cached) {
            return { environment: cached, fromCache: true };
        }
    }
    const environment = await extractGoldenReporterEnvironment(issueFile, extractReport);
    if (series.judgeCacheRoot) {
        const document = readJudgeCache(series.judgeCacheRoot, caseName);
        document.environment = { key, value: environment };
        writeJudgeCache(series.judgeCacheRoot, caseName, document);
    }
    return { environment, fromCache: false };
}

/**
 * Read a matching fresh verdict unless refresh or cache disabling requires a live probe.
 *
 * @param context - Case identity, wall clock, and cache policy.
 * @returns Fresh judgement or null on a miss.
 */
export function cachedHumanFixJudgement(context: GoldenJudgeCaseContext): HumanFixJudgement | null {
    const { series, caseName, humanFixCommit, extensionBuild } = context;
    if (!series.judgeCacheRoot || series.refreshJudgeCache) {
        return null;
    }
    return freshHumanFixVerdict(
        readJudgeCache(series.judgeCacheRoot, caseName),
        judgeVerdictKey(
            caseName,
            humanFixCommit,
            extensionBuild,
            series.judgeConfig.llm,
            issueSnapshotSha256(context.issueFile),
        ),
        context.now(),
    );
}

/**
 * Select the first independently verified human candidate, caching only conclusive outcomes.
 *
 * @param context - Case identity, wall clock, and cache policy.
 * @param humanFix - Ordered human candidates from the closed commit.
 * @param probe - Independent judge-bound browser and vision validation.
 * @returns Complete human judgement and whether it came from the shared cache.
 */
export async function judgeHumanFix(
    context: GoldenJudgeCaseContext,
    humanFix: ExtractedHumanFix,
    probe: GoldenOracleProbe,
): Promise<{
    /**
     * Complete independent human-fix evaluation.
     */
    judgement: HumanFixJudgement;
    /**
     * Whether a fresh shared verdict was reused.
     */
    fromCache: boolean;
}> {
    const cached = cachedHumanFixJudgement(context);
    if (
        cached &&
        (cached.status !== HumanFixVerdict.Verified ||
            humanFix.candidates.some((candidate) =>
                sameHumanFixCandidate(candidate, cached.candidate),
            ))
    ) {
        return { judgement: cached, fromCache: true };
    }
    const infrastructureDetails: string[] = [];
    const driftDetails: string[] = [];
    let judgement: HumanFixJudgement | null = null;
    if (humanFix.candidates.length === 0) {
        infrastructureDetails.push('Human fix diff contains no actionable filter candidates.');
    }
    for (const candidate of humanFix.candidates) {
        const result = await probe(candidate);
        if (result.status === GoldenOracleProbeStatus.Verified) {
            judgement = { status: HumanFixVerdict.Verified, candidate, detail: result.detail };
            break;
        }
        if (result.status === GoldenOracleProbeStatus.NotVerified) {
            driftDetails.push(result.detail);
        }
        if (result.status === GoldenOracleProbeStatus.InfrastructureFailure) {
            infrastructureDetails.push(result.detail);
        }
    }
    judgement ??=
        infrastructureDetails.length > 0
            ? {
                  status: HumanFixVerdict.InfrastructureFailure,
                  detail: infrastructureDetails.join(PROBE_DETAIL_SEPARATOR),
              }
            : {
                  status: HumanFixVerdict.NotVerified,
                  detail: `${HUMAN_FIX_DRIFT_DETAIL}: ${driftDetails.join(PROBE_DETAIL_SEPARATOR)}`,
              };
    const { series, caseName, humanFixCommit, extensionBuild } = context;
    if (series.judgeCacheRoot && judgement.status !== HumanFixVerdict.InfrastructureFailure) {
        const document = readJudgeCache(series.judgeCacheRoot, caseName);
        document.verdict = {
            key: judgeVerdictKey(
                caseName,
                humanFixCommit,
                extensionBuild,
                series.judgeConfig.llm,
                issueSnapshotSha256(context.issueFile),
            ),
            checkedAt: new Date(context.now()).toISOString(),
            value: judgement,
        };
        writeJudgeCache(series.judgeCacheRoot, caseName, document);
    }
    return { judgement, fromCache: false };
}

/**
 * Adapt a complete live or cached judgement to the comparator's per-candidate probe contract.
 *
 * @param judgement - Complete independent human-fix evaluation.
 * @returns Probe replaying the selected candidate or the complete failure exactly once.
 */
export function replayHumanFixJudgement(judgement: HumanFixJudgement): GoldenOracleProbe {
    let infrastructureReplayed = false;
    return async (candidate) => {
        if (
            judgement.status === HumanFixVerdict.Verified &&
            sameHumanFixCandidate(candidate, judgement.candidate)
        ) {
            return { status: GoldenOracleProbeStatus.Verified, detail: judgement.detail };
        }
        if (judgement.status === HumanFixVerdict.InfrastructureFailure && !infrastructureReplayed) {
            infrastructureReplayed = true;
            return {
                status: GoldenOracleProbeStatus.InfrastructureFailure,
                detail: judgement.detail,
            };
        }
        return { status: GoldenOracleProbeStatus.NotVerified, detail: judgement.detail };
    };
}

/**
 * Match the candidate fields required to replay an independently verified human change.
 *
 * @param candidate - Newly extracted human candidate.
 * @param verified - Candidate selected by the independent judge.
 * @returns Whether the candidate can reuse the verification evidence.
 */
function sameHumanFixCandidate(candidate: HumanFixCandidate, verified: HumanFixCandidate): boolean {
    return (
        candidate.filePath === verified.filePath &&
        candidate.rule === verified.rule &&
        candidate.repositoryEdit === verified.repositoryEdit &&
        candidate.replacedRule === verified.replacedRule
    );
}

/**
 * Read a fresh cached judgement for cases classified without a human-rule probe.
 *
 * @param context - Independent judge cache identity.
 * @returns Benchmark verdict and cache provenance.
 */
export function benchmarkCachedJudgement(context: GoldenJudgeCaseContext): {
    /**
     * Complete independent human-fix verdict, or an explicit unprobed state.
     */
    verdict: HumanFixVerdict;
    /**
     * Whether the verdict was reused from a fresh matching cache entry.
     */
    fromCache: boolean;
} {
    const cached = cachedHumanFixJudgement(context);
    return { verdict: cached?.status ?? HumanFixVerdict.NotChecked, fromCache: cached !== null };
}

/**
 * Hash exact snapshot bytes so recaptured reports invalidate both independent cache records.
 *
 * @param issueFile - Portable issue snapshot path.
 * @returns SHA-256 identity of the reporter input.
 */
function issueSnapshotSha256(issueFile: string): string {
    return createHash('sha256').update(readFileSync(issueFile)).digest('hex');
}
