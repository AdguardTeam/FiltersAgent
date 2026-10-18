import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { chmod, mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { BrowserSession } from '../browser/browser-session';
import { createBlockerAppliedRulesLog } from '../blocker-contract/blocker-applied-rules';
import type {
    BlockerApplyRequest,
    BlockerDescription,
    BlockerFilterList,
    BlockerRoute,
} from '../blocker-contract/blocker-contract';
import {
    followBlockedRequests,
    type BlockedRequestsFollower,
} from '../blocker-contract/blocked-requests';
import { watchPageEvidence } from '../blocker-contract/page-evidence';
import type { AppliedRulesLog } from '../environment/applied-rules';
import { BaselineLineRefusal } from '../environment/filtering-environment';
import type { Logger } from '../logger/logger';
import { createPreparedStrictBrowserRoute } from '../browser/strict-browser-route';
import type {
    BaselineEditOutcome,
    EvidenceRoutePorts,
    EvidenceRouteSnapshot,
    EvidenceSessionRequest,
} from '../local/evidence-route-contract';
import {
    EvidenceRouteError,
    EvidenceRouteFailureCode,
    EvidenceRouteState,
} from '../local/evidence-route-contract';
import { probePlainHttp } from '../local/plain-http-probe';
import { probeTlsInterception } from '../local/tls-interception-diagnostic';
import { proveBlockerHttpsFiltering, type HttpsFilteringProof } from './https-filtering-proof';
import type {
    CreateProxyBlockerEvidenceRouteInput,
    ProxyBlockerEvidenceRoute,
} from './proxy-evidence-route-contract';
import {
    createProxyBlockerBaselineHost,
    type ProxyBlockerBaselineHost,
} from './baseline-catalog-host';
import {
    downloadOfficialFilters,
    type DownloadedOfficialFilter,
} from '../local/official-filter-downloader';

/**
 * Milliseconds a minted evidence route stays consumable before the strict route rejects it.
 */
const EVIDENCE_ROUTE_LIFETIME_MS = 10 * 60_000;

/**
 * What the proxy executes while the route proves it decrypts HTTPS: no list and no rule. The proof
 * asks whether the proxy reads the target's traffic, not what the lists decide about it: a list
 * that blocks the target host would end the request before it proved anything.
 */
const PROOF_CONFIGURATION: BlockerApplyRequest = {
    enabledListIds: [],
    userRules: [],
    listReplacement: null,
};

/**
 * The text of one list as the blocker and the baseline host both write it: ending in a newline, so
 * the digest of this text is the digest the baseline locked.
 *
 * @param content - Downloaded list text.
 * @returns Executed list text.
 */
function executedFilterText(content: string): string {
    return content.endsWith('\n') ? content : `${content}\n`;
}

/**
 * Drop the carriage return a CRLF list leaves at the end of each line, so a published line is
 * compared the way a reader sees it.
 *
 * @param line - One line split on the line feed.
 * @returns The line without a trailing carriage return.
 */
function stripCarriageReturn(line: string): string {
    return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/**
 * AdGuard Base filter, which every evidence route runs: an unfiltered baseline would make every
 * phase meaningless.
 */
const ADGUARD_BASE_FILTER_ID = 2;

/**
 * The official filters an evidence route runs: AdGuard Base, with the reporter's own selection
 * layered on top. The runtime prepares apply_rule's baseline from the same set, so a report without
 * a settings link verifies against what the browser saw instead of an empty set.
 *
 * @param reporterFilterIds - Official filters the reporter had enabled, possibly empty.
 * @returns The route's filter identifiers, ascending and without repeats.
 */
export function evidenceRouteFilterIds(reporterFilterIds: readonly number[]): number[] {
    return [...new Set([ADGUARD_BASE_FILTER_ID, ...reporterFilterIds])].sort(
        (left, right) => left - right,
    );
}

/**
 * Create the evidence route over one blocker module's proxy.
 *
 * The route executes exactly the filter files the run supplied — which is what makes its baseline
 * attributable and its phases comparable — and launches sessions only once it proved the proxy
 * filters HTTPS for the run's target.
 *
 * @param input - The blocker, the cycle identity, the workspace and filter cache directories, the
 *   reporter's filters, and optional seams.
 * @returns The route, with the HTTPS filtering proof the executor runs on it first.
 */
export function createProxyBlockerEvidenceRoute(
    input: CreateProxyBlockerEvidenceRouteInput,
): ProxyBlockerEvidenceRoute {
    const now = input.now ?? (() => new Date().toISOString());
    const downloadFilters = input.dependencies?.downloadFilters ?? downloadOfficialFilters;
    const createSession = input.dependencies?.createBrowserSession ?? BrowserSession.create;

    let state: EvidenceRouteState = EvidenceRouteState.New;
    let failureCode: EvidenceRouteFailureCode | null = null;
    let description: BlockerDescription | null = null;
    let filters: readonly DownloadedOfficialFilter[] = [];
    let unavailableFilterIds: readonly number[] = [];
    // Set once an HTTPS request to the target went through the proxy's filter.
    let httpsFilteringProven = false;
    // How the browser reaches the running proxy, and the revision it runs at; null until started.
    let route: BlockerRoute | null = null;
    let revision = 0;
    let port: number | null = null;
    let userRules: readonly string[] = [];
    // The text one list executes instead of its downloaded text while a candidate edits or removes
    // one of its lines, and the locked digest of that list to restore.
    let listReplacement: BlockerFilterList | null = null;
    let lockedReplacedSha256: string | null = null;
    let baselineHost: ProxyBlockerBaselineHost | null = null;
    // Every session's blocked-request follower, stopped before the blocker.
    const followers: BlockedRequestsFollower[] = [];

    // The baseline host owns this directory alone: it is the agent's own record of the catalog
    // phases enable lists from, and it must not mix with anything the blocker writes.
    const baselineDataRoot = join(input.workspaceDir, 'baseline');

    const fail = (code: EvidenceRouteFailureCode, cause?: unknown): EvidenceRouteError => {
        state = EvidenceRouteState.Failed;
        failureCode ??= code;
        return new EvidenceRouteError(code, cause === undefined ? undefined : { cause });
    };

    // The lists the proxy executes now: every downloaded list until the baseline host exists,
    // then exactly the subset the current phase enabled through it.
    const executedFilterIds = (): readonly number[] | null =>
        baselineHost === null ? null : baselineHost.enabledFilterIds();

    /**
     * The lists and rules the current phase executes.
     *
     * @returns The configuration to ask the blocker for.
     */
    const currentConfiguration = (): BlockerApplyRequest => {
        return {
            enabledListIds: executedFilterIds(),
            userRules,
            listReplacement,
        };
    };

    /**
     * Ask the blocker to execute a configuration, starting it on first use, and record where it
     * runs now.
     *
     * @param configuration - What to execute; the current phase's lists and rules by default.
     * @returns Whether the proxy restarted.
     */
    const reconcile = async (
        configuration: BlockerApplyRequest = currentConfiguration(),
    ): Promise<boolean> => {
        if (route === null) {
            const started = await input.blocker.start({
                lists: filters.map((filter) => ({ id: filter.filterId, content: filter.content })),
                ...configuration,
            });
            route = started.route;
            revision = started.revision;
            port = (await input.blocker.state()).port;
            state = EvidenceRouteState.ForegroundRunning;
            return false;
        }
        const applied = await input.blocker.apply(configuration);
        route = applied.route;
        revision = applied.revision;
        port = (await input.blocker.state()).port;
        return applied.restarted;
    };

    /**
     * The digest of one list as the blocker executes it now, read back from the blocker.
     *
     * @param filterId - The list.
     * @returns Its SHA-256, or null when the blocker does not execute it.
     */
    const executedListSha256 = async (filterId: number): Promise<string | null> =>
        (await input.blocker.state()).lists.find((list) => list.id === filterId)?.sha256 ?? null;

    /**
     * Rewrite one exact published line in the list the blocker executes, and run the blocker on it.
     *
     * The line is looked up across the lists the current phase executes. A line that occurs nowhere
     * or more than once is refused before anything changes: the mutation must be attributable to
     * one source line. The receipt's after-digest is the blocker's own read-back, not the text the
     * route asked for.
     *
     * @param originalRule - Exact published line to replace or delete.
     * @param replacementRule - Complete replacement line, or null to delete the line.
     * @returns Receipt naming the list and its bytes before and after, or the refusal.
     */
    const mutateBaselineLine = async (
        originalRule: string,
        replacementRule: string | null,
    ): Promise<BaselineEditOutcome> => {
        const executed = executedFilterIds();
        const occurrences = filters
            .filter((filter) => executed === null || executed.includes(filter.filterId))
            .flatMap((filter) => {
                const lines = executedFilterText(filter.content).split('\n');
                return lines.flatMap((line, index) =>
                    stripCarriageReturn(line) === originalRule
                        ? [{ filterId: filter.filterId, lines, index }]
                        : [],
                );
            });
        if (occurrences.length !== 1) {
            return {
                applied: false,
                refusal:
                    occurrences.length === 0
                        ? BaselineLineRefusal.NotFound
                        : BaselineLineRefusal.NotUnique,
            };
        }
        const { filterId, lines, index } = occurrences[0]!;
        const before = lines.join('\n');
        const lineEnding = lines[index]!.endsWith('\r') ? '\r' : '';
        const mutated = [...lines];
        if (replacementRule === null) {
            mutated.splice(index, 1);
        } else {
            mutated[index] = `${replacementRule}${lineEnding}`;
        }
        // Recorded before the blocker runs it: an apply that fails after the list was rewritten must
        // still leave the revoke knowing there is something to restore.
        lockedReplacedSha256 = createHash('sha256').update(before).digest('hex');
        listReplacement = { id: filterId, content: mutated.join('\n') };
        await reconcile();
        const afterSha256 = await executedListSha256(filterId);
        if (afterSha256 === null) {
            throw new Error('The blocker does not execute the list the candidate changed.');
        }
        return {
            applied: true,
            receipt: {
                filterId,
                beforeSha256: lockedReplacedSha256,
                afterSha256,
                replacedLineCount: 1,
                extraSourceCount: (await input.blocker.state()).userRules.length === 0 ? 0 : 1,
            },
        };
    };

    const reserveBrowserRoot =
        input.dependencies?.reserveBrowserRoot ??
        (async (): Promise<string> => {
            const root = await mkdtemp(join(input.workspaceDir, 'evidence-browser-'));
            await chmod(root, 0o700);
            return root;
        });

    return {
        async prepareConfiguration(): Promise<void> {
            if (description) {
                return;
            }
            try {
                await mkdir(input.workspaceDir, { recursive: true, mode: 0o700 });
                await mkdir(baselineDataRoot, { recursive: true, mode: 0o700 });
                description = await input.blocker.describe();
                const requested = evidenceRouteFilterIds(input.reporterFilterIds ?? []);
                const downloaded = await downloadFilters(requested, input.filterCacheDir);
                filters = downloaded.filters;
                unavailableFilterIds = downloaded.unavailableFilterIds;
                if (filters.length === 0) {
                    throw fail(EvidenceRouteFailureCode.ConfigurationFailed);
                }
                state = EvidenceRouteState.Configured;
            } catch (error) {
                if (error instanceof EvidenceRouteError) {
                    throw error;
                }
                throw fail(EvidenceRouteFailureCode.ConfigurationFailed, error);
            }
        },

        async proveHttpsFiltering(targetUrl: string): Promise<HttpsFilteringProof> {
            if (!description) {
                throw fail(EvidenceRouteFailureCode.RouteUnavailable);
            }
            try {
                await reconcile(PROOF_CONFIGURATION);
            } catch (error) {
                // The public code is finite; the blocker's own failure is only diagnosable here.
                console.error('blocker evidence route foreground start failed', error);
                throw fail(EvidenceRouteFailureCode.ForegroundFailed, error);
            }
            const proof = await proveBlockerHttpsFiltering({
                blocker: input.blocker,
                route: route!,
                targetUrl,
                probe: input.dependencies?.probeInterception ?? probeTlsInterception,
                probePlain: input.dependencies?.probePlainHttp ?? probePlainHttp,
            });
            httpsFilteringProven = proof.proven;
            return proof;
        },

        async launchEvidenceSession(request: EvidenceSessionRequest) {
            if (!description) {
                throw fail(EvidenceRouteFailureCode.RouteUnavailable);
            }
            if (!httpsFilteringProven) {
                throw new Error(
                    'An evidence session launched before HTTPS filtering was proven for the route.',
                );
            }
            try {
                // The session must ride a proxy executing exactly the filters the current phase
                // enabled through the baseline host — bookkeeping alone would leave a control
                // phase filtered by the whole baseline. Before any baseline exists, every
                // downloaded list runs.
                const restarted = await reconcile();
                request.logger.info(
                    {
                        proxyPort: port,
                        revision,
                        restarted,
                        filterIds: executedFilterIds() ?? filters.map((filter) => filter.filterId),
                        unavailableFilterIds,
                    },
                    'blocker evidence route ready',
                );
            } catch (error) {
                // The public code is finite, but the blocker's own failure detail is the only thing
                // that makes a foreground start diagnosable — log it before collapsing.
                request.logger.info(
                    {
                        error: error instanceof Error ? error.message : String(error),
                        stack: error instanceof Error ? error.stack : undefined,
                    },
                    'blocker evidence route foreground start failed',
                );
                throw fail(EvidenceRouteFailureCode.ForegroundFailed, error);
            }
            const certificate = route!;
            try {
                const browserRoot = await reserveBrowserRoot();
                const certificateDer = Buffer.from(certificate.certificateDerBase64, 'base64');
                const authority = new X509Certificate(certificateDer);
                const strictRoute = createPreparedStrictBrowserRoute({
                    routeId: randomUUID(),
                    cycleId: input.cycleId,
                    targetUrl: request.targetUrl,
                    proxyUrl: certificate.proxyUrl,
                    spkiSha256Base64: createHash('sha256')
                        .update(authority.publicKey.export({ type: 'spki', format: 'der' }))
                        .digest('base64'),
                    certificateDerBase64: certificate.certificateDerBase64,
                    certificateSha256: createHash('sha256').update(certificateDer).digest('hex'),
                    browserRoot,
                    expiresAt: new Date(
                        Date.parse(now()) + EVIDENCE_ROUTE_LIFETIME_MS,
                    ).toISOString(),
                });
                const { CloakBrowserEngine } = await import('../browser/cloakbrowser-engine');
                const sessionLog = await input.blocker.log(null);
                const follower = followBlockedRequests(
                    input.blocker,
                    sessionLog.cursor,
                    revision,
                    request.logger,
                );
                followers.push(follower);
                return await createSession({
                    engine: new CloakBrowserEngine(),
                    logger: request.logger,
                    reproProfile: request.reproProfile,
                    artifactsDir: request.artifactsDir,
                    headless: request.headless,
                    noSandbox: request.noSandbox,
                    strictRoute,
                    strictRouteTargetUrl: request.targetUrl,
                    // The proxy presents its leaf alone, so the browser accepts it only by
                    // accepting the proxy's authority; proveHttpsFiltering showed that authority
                    // decrypting a request to the target.
                    strictRouteAcceptProxyAuthority: true,
                    engineBlockedRequests: follower.read,
                });
            } catch (error) {
                if (error instanceof EvidenceRouteError) {
                    throw error;
                }
                // The public code is finite; the underlying browser or route-construction error
                // is only diagnosable from the run log, so it is recorded before collapsing.
                // The wrapper message is fixed prose; everything diagnosable — the engine's own
                // failure and its stack — lives in `cause`, so unwrap the whole chain.
                const chain: string[] = [];
                for (let current: unknown = error; current; ) {
                    chain.push(
                        current instanceof Error
                            ? `${current.name}: ${current.message}`
                            : String(current),
                    );
                    current = current instanceof Error ? current.cause : null;
                }
                request.logger.info(
                    {
                        error: chain.join(' <- '),
                        stack: error instanceof Error ? error.stack : undefined,
                    },
                    'blocker evidence session launch failed',
                );
                throw fail(EvidenceRouteFailureCode.BrowserLaunchFailed, error);
            }
        },

        environmentPorts(): EvidenceRoutePorts {
            const blockerDescription = description;
            if (!blockerDescription) {
                throw fail(EvidenceRouteFailureCode.RouteUnavailable);
            }
            baselineHost ??= createProxyBlockerBaselineHost({
                dataRoot: baselineDataRoot,
                filters,
                acquiredAt: now(),
            });
            return {
                cliVersion: blockerDescription.version,
                product: blockerDescription.product,
                installationDigest: blockerDescription.binarySha256,
                baselineHost,
                applyCandidate: async (rule) => {
                    userRules = [rule];
                    await reconcile();
                    // The receipt is the blocker's own account of what it executes, not the
                    // request: a rule it dropped or rewrote fails the candidate phase.
                    const executed = (await input.blocker.state()).userRules;
                    return {
                        contentDigest: createHash('sha256')
                            .update(executed.join('\n'))
                            .digest('hex'),
                        ruleCount: executed.length,
                        extraSourceCount: executed.length === 0 ? 0 : 1,
                    };
                },
                revokeCandidate: async () => {
                    userRules = [];
                    await reconcile();
                },
                applyBaselineEdit: async (originalRule, replacementRule) =>
                    await mutateBaselineLine(originalRule, replacementRule),
                applyBaselineRemoval: async (originalRule) =>
                    await mutateBaselineLine(originalRule, null),
                revokeBaselineEdit: async () => {
                    if (lockedReplacedSha256 === null || listReplacement === null) {
                        return null;
                    }
                    const replaced = { listReplacement, lockedReplacedSha256 };
                    const filterId = listReplacement.id;
                    listReplacement = null;
                    lockedReplacedSha256 = null;
                    try {
                        await reconcile();
                    } catch (error) {
                        // The blocker may still run the edited list: keep the edit in effect so
                        // the adapter's cleanup retry restores it instead of finding nothing to do.
                        ({ listReplacement, lockedReplacedSha256 } = replaced);
                        throw error;
                    }
                    // The restored digest is the blocker's own read-back; the adapter compares it
                    // with the digest locked at preparation.
                    return await executedListSha256(filterId);
                },
            };
        },

        async openAppliedRulesLog(
            session: BrowserSession,
            logger: Logger,
        ): Promise<AppliedRulesLog> {
            if (route === null || description === null) {
                throw new Error(
                    'The applied-rules log opened with no proxy running, yet a session launches ' +
                        'on this route only after it starts the proxy.',
                );
            }
            const executed = executedFilterIds();
            const sessionLog = await input.blocker.log(null);
            return createBlockerAppliedRulesLog({
                blocker: input.blocker,
                description,
                cursor: sessionLog.cursor,
                revision,
                lists: filters
                    .filter((filter) => executed === null || executed.includes(filter.filterId))
                    .map((filter) => ({ id: filter.filterId, content: filter.content })),
                page:
                    description.pageEvidence === null
                        ? null
                        : watchPageEvidence(session.getPage(), description.pageEvidence, logger),
            });
        },

        async stop(): Promise<void> {
            // The followers stop first: once the blocker is gone their reads could only fail.
            for (const follower of followers.splice(0)) {
                follower.stop();
            }
            await input.blocker.stop();
            route = null;
            port = null;
            if (state !== EvidenceRouteState.Failed) {
                state = EvidenceRouteState.Stopped;
            }
        },

        snapshot(): EvidenceRouteSnapshot {
            return {
                state,
                port,
                baseFilterEnabled: filters.some(
                    (filter) => filter.filterId === ADGUARD_BASE_FILTER_ID,
                ),
                reproducedFilterIds: filters
                    .map((filter) => filter.filterId)
                    .filter((filterId) => filterId !== ADGUARD_BASE_FILTER_ID),
                unavailableFilterIds: [...unavailableFilterIds],
                failureCode,
            };
        },
    };
}
