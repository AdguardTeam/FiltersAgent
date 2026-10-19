/**
 * The per-session browser tool registry of a production fix run, and the applied-rules log it
 * binds: which filtering engine can report the rules it applied in this session, and how that
 * report is opened as soon as the session launches.
 *
 * Split from `agent-runtime.ts`, which builds one of these for every launched session and needs
 * nothing from it but the finished registry.
 */
import type { RedirectOriginPolicy } from '../browser/redirect-origin-policy';
import type { SiteAnalyzer } from '../analyzer/site-analyzer';
import { createToolRegistry } from '../agent/tool-factory';
import type { ToolRegistry } from '../agent/tool-registry';
import { openAdGuardFilteringLog } from '../browser/adguard-filtering-log';
import type { BrowserSession } from '../browser/browser-session';
import type { AppliedRulesLog } from '../environment/applied-rules';
import { ExtensionLaunchFamily } from '../environment/extension-launch';
import type { RawIssue } from '../github/fetch-issue';
import type { EvidenceRouteHost } from '../local/evidence-route-contract';
import type { PreparedExtension } from '../local/prepared-extension';
import type { Logger } from '../logger/logger';
import type { SingleShotClient } from '../pi/single-shot-types';
import type { TraceRecorder } from '../tracer/trace-recorder';
import type { PlacementMap } from '../types/repo-context';
import type { ReproProfile } from '../types/repro-profile';

/**
 * Runtime-owned browser context supplied to an injectable browser registry factory.
 */
export interface AgentRuntimeBrowserContext {
    /**
     * Policy deciding whether a redirect landing remains admitted after its current load.
     */
    redirectOriginPolicy: RedirectOriginPolicy;

    /**
     * Newly launched isolated browser session.
     */
    session: BrowserSession;

    /**
     * Runtime recorder that owns every browser artifact identity and local path.
     */
    recorder: TraceRecorder;

    /**
     * Reporter symptom accumulated from issue screenshot vision calls.
     */
    reporterSymptom: () => string | undefined;

    /**
     * Physical navigation attempts allowed for one model-visible open_page call.
     */
    openPageRetries: number;

    /**
     * Bounded consent setup selected by the model for this isolated session.
     */
    consentStrategy: ReproProfile['consentStrategy'];
}

/**
 * What decides a session's applied-rules log.
 */
export interface SessionAppliedRulesLogInput {
    /**
     * The launched session.
     */
    session: BrowserSession;

    /**
     * The run's activated evidence route, when the session browses through it.
     */
    evidenceRoute: EvidenceRouteHost | null;

    /**
     * The prepared build the session loaded; absent for a session launched without one.
     */
    extension: PreparedExtension | undefined;

    /**
     * Whether the run applies through the built-in AdGuard route, whose blocker is the AdGuard
     * Browser Extension and whose filtering log this run knows how to read.
     */
    builtInAdGuardRoute: boolean;

    /**
     * Run logger receiving a log that failed to open, with its error.
     */
    logger: Logger;
}

/**
 * Open the applied-rules log of one launched session, before the Baseline application configures
 * its blocker and before it loads any page: the extension reports the declarative rules Chrome
 * fires only when its log is open while its engine is configured.
 *
 * A session whose engine cannot report gets no log, so it never offers `get_applied_rules` and the
 * agent sees that in the launch answer instead of learning it from a refusal: a control session, a
 * blocker the run's own instruction prepares, a Firefox build, or a log that failed to open. Never
 * throws for any of those; the run log says which one it was.
 *
 * @param input - The session and what it runs.
 * @returns The session's applied-rules log, or nothing when its engine cannot report.
 */
export async function openSessionAppliedRulesLog(
    input: SessionAppliedRulesLogInput,
): Promise<AppliedRulesLog | undefined> {
    const startedAt = Date.now();
    if (input.evidenceRoute !== null) {
        const log = await input.evidenceRoute.openAppliedRulesLog(input.session, input.logger);
        input.logger.info(
            { openMs: Date.now() - startedAt },
            "the session's applied-rules log opened on the evidence route",
        );
        return log;
    }
    const { extension } = input;
    if (extension === undefined) {
        input.logger.info({}, 'a session without a blocker has no applied-rules log');
        return undefined;
    }
    if (extension.launchFamily === ExtensionLaunchFamily.Firefox || !input.builtInAdGuardRoute) {
        input.logger.info(
            {
                launchFamily: extension.launchFamily,
                builtInAdGuardRoute: input.builtInAdGuardRoute,
            },
            "the session's blocker exposes no applied-rules log to this run",
        );
        return undefined;
    }
    try {
        const context = input.session.extensionContext;
        if (context === undefined) {
            throw new Error('The prepared session carries no extension context.');
        }
        const log = await openAdGuardFilteringLog({
            context,
            manifestVersion: extension.manifestVersion,
        });
        input.logger.info(
            { openMs: Date.now() - startedAt },
            "the extension's filtering log opened for the session",
        );
        return log;
    } catch (error) {
        input.logger.error(
            { err: error },
            "the extension's filtering log could not be opened for the session; the session " +
                'offers no get_applied_rules',
        );
        return undefined;
    }
}

/**
 * Everything one production session registry is built from.
 */
export interface ProductionBrowserRegistryInput extends AgentRuntimeBrowserContext {
    /**
     * Exact prompt-safe URL selected for the session.
     */
    targetUrl: string;

    /**
     * Run logger receiving the browser tools' navigation and capture failures.
     */
    logger: Logger;

    /**
     * The run's issue snapshot, answering fetch_issue.
     */
    issue: RawIssue;

    /**
     * The AdguardFilters checkout backing search_rules.
     */
    filtersPath: string;

    /**
     * The placement map the run already walked, so the checkout is never walked twice.
     */
    placementMap: PlacementMap | undefined;

    /**
     * The run's artifacts directory.
     */
    artifactsDir: string;

    /**
     * The run's vision client.
     */
    vision: SingleShotClient;

    /**
     * The session's applied-rules log; absent when its engine cannot report.
     */
    appliedRules: AppliedRulesLog | undefined;
}

/**
 * Create the browser-bound tools of one production session.
 *
 * @param input - The session, its log, and the run's bound inputs.
 * @returns Registry containing the browser and candidate validation tools.
 */
export async function createProductionBrowserRegistry(
    input: ProductionBrowserRegistryInput,
): Promise<ToolRegistry> {
    const { SiteAnalyzer: SiteAnalyzerClass } = await import('../analyzer/site-analyzer');
    const analyzer: SiteAnalyzer = new SiteAnalyzerClass();
    return await createToolRegistry({
        allowedIssueNumber: input.issue.number,
        checkoutPath: input.filtersPath,
        placementMap: input.placementMap,
        browserTools: {
            session: input.session,
            analyzer,
            artifactsDir: input.artifactsDir,
            recorder: input.recorder,
            allowedOrigin: input.targetUrl,
            logger: input.logger,
            vision: input.vision,
            reporterSymptom: input.reporterSymptom,
            openPageRetries: input.openPageRetries,
            consentStrategy: input.consentStrategy,
            redirectOriginPolicy: input.redirectOriginPolicy,
            appliedRules: input.appliedRules,
        },
        visionTools: {
            artifactsDir: input.artifactsDir,
            recorder: input.recorder,
            vision: input.vision,
            reporterSymptom: input.reporterSymptom,
        },
        localIssueTools: { localIssue: input.issue },
    });
}
