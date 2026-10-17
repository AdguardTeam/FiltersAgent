import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LlmConfig } from '../../src/config/config';
import type { LlmApi } from '../../src/config/llm-api';
import { writeAtomicJson } from '../atomic-json';
import { effectiveVisionModel } from '../effective-vision-model';
import type { ExtensionBuildPin } from '../local/run-config';
import type { GoldenReporterEnvironment } from './golden-agent-environment';
import type { HumanFixVerdict } from './golden-judge';
import type { HumanFixCandidate } from './human-commit-oracle';

export const JUDGE_CACHE_SCHEMA_VERSION = 1;

/**
 * Weekly rechecks limit live-site drift while keeping repeated model comparisons on one verdict.
 */
export const HUMAN_FIX_VERDICT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Identity of the independent browser and vision evaluation of a human fix.
 */
export interface JudgeVerdictKey {
    /**
     * Stable benchmark case directory name.
     */
    caseName: string;
    /**
     * Commit from which human candidates are extracted.
     */
    humanFixCommit: string;
    /**
     * Historical extension identity used for validation.
     */
    extensionBuild: ExtensionBuildPin;
    /**
     * Judge provider protocol.
     */
    judgeApi: LlmApi;
    /**
     * Text judge model used to interpret the report.
     */
    judgeModel: string;
    /**
     * Effective vision model used to confirm the human fix.
     */
    judgeVisionModel: string;
    /**
     * Judge loop effort, including whether reasoning is disabled.
     */
    judgeReasoningEffort: LlmConfig['reasoningEffort'];
    /**
     * Judge effort used for independent extraction and vision calls.
     */
    judgeSingleShotReasoningEffort: LlmConfig['singleShotReasoningEffort'];
    /**
     * Snapshot digest covering the URL, screenshots and reporter facts used by the probe.
     */
    issueSha256: string;
}

/**
 * Text extraction identity, including the exact issue snapshot bytes.
 */
export type JudgeEnvironmentKey = Omit<JudgeVerdictKey, 'judgeVisionModel'>;

/**
 * Conclusive human-fix judgement that may be reused across model runs.
 */
export type CachedHumanFixVerdict =
    | {
          /**
           * The candidate was independently confirmed.
           */
          status: typeof HumanFixVerdict.Verified;
          /**
           * First browser-confirmed human change.
           */
          candidate: HumanFixCandidate;
          /**
           * Independent confirmation evidence.
           */
          detail: string;
      }
    | {
          /**
           * No human candidate fixes the reported defect.
           */
          status: typeof HumanFixVerdict.NotVerified;
          /**
           * Independent rejection evidence.
           */
          detail: string;
      };

/**
 * Trusted local cache containing independent environment and human-fix records.
 */
export interface JudgeCacheDocument {
    /**
     * Cache format revision written by this benchmark.
     */
    schemaVersion: typeof JUDGE_CACHE_SCHEMA_VERSION;
    /**
     * Indefinitely reusable report extraction and its identity.
     */
    environment: {
        /**
         * Snapshot and text-judge identity.
         */
        key: JudgeEnvironmentKey;
        /**
         * Exact reporter settings extracted from the issue.
         */
        value: GoldenReporterEnvironment;
    } | null;
    /**
     * Conclusive human-fix judgement, expiring from its check time.
     */
    verdict: {
        /**
         * Browser and vision evaluation identity.
         */
        key: JudgeVerdictKey;
        /**
         * ISO timestamp when the independent probe completed.
         */
        checkedAt: string;
        /**
         * First confirmed candidate or conclusive drift.
         */
        value: CachedHumanFixVerdict;
    } | null;
}

/**
 * Construct a stable-order verdict key without provider credentials or endpoint details.
 *
 * @param caseName - Stable benchmark case identity.
 * @param humanFixCommit - Human fix commit.
 * @param extensionBuild - Pinned historical extension build.
 * @param judge - Judge provider settings.
 * @param issueSha256 - Exact issue snapshot digest.
 * @returns Canonical verdict key.
 */
export function judgeVerdictKey(
    caseName: string,
    humanFixCommit: string,
    extensionBuild: ExtensionBuildPin,
    judge: LlmConfig,
    issueSha256: string,
): JudgeVerdictKey {
    return {
        caseName,
        humanFixCommit,
        extensionBuild: {
            version: extensionBuild.version,
            releaseTag: extensionBuild.releaseTag,
            autobuildCommit: extensionBuild.autobuildCommit,
        },
        judgeApi: judge.api,
        judgeModel: judge.model,
        judgeVisionModel: effectiveVisionModel(judge),
        judgeReasoningEffort: judge.reasoningEffort,
        judgeSingleShotReasoningEffort: judge.singleShotReasoningEffort,
        issueSha256,
    };
}

/**
 * Construct the stable-order identity of text-only reporter extraction.
 *
 * @param caseName - Stable benchmark case identity.
 * @param humanFixCommit - Human fix commit.
 * @param extensionBuild - Pinned historical extension build.
 * @param judge - Judge provider settings.
 * @param issueSha256 - Exact snapshot digest.
 * @returns Canonical extraction key, independent of the vision model.
 */
export function judgeEnvironmentKey(
    caseName: string,
    humanFixCommit: string,
    extensionBuild: ExtensionBuildPin,
    judge: LlmConfig,
    issueSha256: string,
): JudgeEnvironmentKey {
    const { judgeVisionModel: _vision, ...key } = judgeVerdictKey(
        caseName,
        humanFixCommit,
        extensionBuild,
        judge,
        issueSha256,
    );
    return key;
}

/**
 * Read trusted benchmark-generated cache data, or initialize an empty document.
 *
 * @param cacheRoot - Shared cache directory outside agent-visible roots.
 * @param caseName - Stable case directory name.
 * @returns Parsed cache or an empty document when absent.
 */
export function readJudgeCache(cacheRoot: string, caseName: string): JudgeCacheDocument {
    const path = join(cacheRoot, `${caseName}.json`);
    return existsSync(path)
        ? (JSON.parse(readFileSync(path, 'utf8')) as JudgeCacheDocument)
        : { schemaVersion: JUDGE_CACHE_SCHEMA_VERSION, environment: null, verdict: null };
}

/**
 * Atomically replace one shared case cache, preserving readers' complete-document view.
 *
 * @param cacheRoot - Shared cache directory outside agent-visible roots.
 * @param caseName - Stable case directory name.
 * @param document - Complete trusted cache document to save.
 * @returns Nothing after the atomic replacement completes.
 */
export function writeJudgeCache(
    cacheRoot: string,
    caseName: string,
    document: JudgeCacheDocument,
): void {
    writeAtomicJson(join(cacheRoot, `${caseName}.json`), document);
}

/**
 * Reuse extraction only for the same canonical snapshot and judge identity.
 *
 * @param document - Trusted cache document.
 * @param key - Requested extraction identity.
 * @returns Cached reporter settings or null on a miss.
 */
export function cachedReporterEnvironment(
    document: JudgeCacheDocument,
    key: JudgeEnvironmentKey,
): GoldenReporterEnvironment | null {
    return document.environment && JSON.stringify(document.environment.key) === JSON.stringify(key)
        ? document.environment.value
        : null;
}

/**
 * Reuse a conclusive human verdict only while its weekly lifetime remains.
 *
 * @param document - Trusted cache document.
 * @param key - Requested evaluation identity.
 * @param nowMs - Current wall-clock timestamp in milliseconds.
 * @returns Fresh matching verdict or null.
 */
export function freshHumanFixVerdict(
    document: JudgeCacheDocument,
    key: JudgeVerdictKey,
    nowMs: number,
): CachedHumanFixVerdict | null {
    const verdict = document.verdict;
    return verdict &&
        JSON.stringify(verdict.key) === JSON.stringify(key) &&
        nowMs - Date.parse(verdict.checkedAt) < HUMAN_FIX_VERDICT_TTL_MS
        ? verdict.value
        : null;
}
