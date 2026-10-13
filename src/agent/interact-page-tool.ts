import type { IBrowserSession } from '../browser/browser-interfaces';
import {
    persistSafeInteractionRecord,
    runSafeInteractionSequence,
} from '../browser/safe-interaction-runner';
import {
    canonicalInteractionStep,
    normalizeSafeInteractionPlan,
    type SafeInteractionRecord,
} from '../environment/safe-interaction';
import type { TraceRecorder } from '../tracer/trace-recorder';
import { registeredParameters } from './registered-parameters';
import { ToolName } from './tool-names';
import type { ToolRegistry } from './tool-registry';

/**
 * Most third-party hosts named in one rehearsal observation.
 */
const MAX_REPORTED_REQUEST_HOSTS = 10;

/**
 * Everything the rehearsal tool needs to act on the live investigation page.
 */
export interface InteractPageToolOptions {
    /**
     * Live browser session the model is investigating in.
     */
    session: IBrowserSession;

    /**
     * Authoritative trace artifact registry.
     */
    recorder: TraceRecorder;

    /**
     * Run-owned artifacts directory.
     */
    artifactsDir: string;

    /**
     * Canonical origin of the reported site.
     */
    allowedOrigin: string;
}

/**
 * Reduce one URL to the host it addresses.
 *
 * @param url - Absolute request URL from the session log.
 * @returns Lowercase hostname, or the empty string when the URL cannot be parsed.
 */
function requestHost(url: string): string {
    try {
        return new URL(url).hostname.toLowerCase();
    } catch {
        return '';
    }
}

/**
 * Name the distinct off-site hosts the rehearsal's own requests reached.
 *
 * A click that starts an ad engine is recognised by where it sends traffic, so the hosts a step
 * added are the compact form of that evidence: enough for the model to name a network candidate
 * without reading the whole HAR back into the conversation.
 *
 * @param session - Session whose network log is read.
 * @param fromIndex - First log entry the rehearsal is responsible for.
 * @param allowedOrigin - Canonical origin of the reported site.
 * @returns Bounded list of third-party hosts, in first-seen order.
 */
function newRequestHosts(
    session: IBrowserSession,
    fromIndex: number,
    allowedOrigin: string,
): string[] {
    const reportedHost = requestHost(allowedOrigin);
    const hosts: string[] = [];
    for (const entry of session.getNetworkLog().slice(fromIndex)) {
        const host = requestHost(entry.url);
        if (host.length === 0 || host === reportedHost || hosts.includes(host)) {
            continue;
        }
        hosts.push(host);
        if (hosts.length === MAX_REPORTED_REQUEST_HOSTS) {
            break;
        }
    }
    return hosts;
}

/**
 * Project one rehearsal record into the compact observation the model reads.
 *
 * @param record - Complete record of the rehearsed sequence.
 * @param artifactId - Identity of the retained record.
 * @param requestHosts - Third-party hosts the sequence's requests reached.
 * @returns Serializable tool result stating what each step did and what it provoked.
 */
function rehearsalObservation(
    record: SafeInteractionRecord,
    artifactId: string,
    requestHosts: string[],
): Record<string, unknown> {
    return {
        planDigest: record.planDigest,
        status: record.status,
        executedSteps: record.steps.filter((step) => step.outcome === 'performed').length,
        popupsOpened: record.popupsOpened,
        // The host is what a popup rule names, and it is the part of an ad network's URL that
        // carries no page-supplied query values; the retained record keeps the full URL.
        popupHosts: [
            ...new Set(record.popups.map((popup) => requestHost(popup.url)).filter(Boolean)),
        ],
        dialogsDismissed: record.dialogs.length,
        newRequestHosts: requestHosts,
        artifactId,
        steps: record.steps.map((step) => ({
            index: step.index,
            kind: step.step.kind,
            outcome: step.outcome,
            refusalReason: step.refusalReason,
            failureDetail: step.failureDetail,
            targetFound: step.resolvedTarget?.found ?? null,
            urlChanged: step.result !== null && step.result.url !== step.precondition.url,
            obstructionDelta:
                step.result === null
                    ? null
                    : step.result.visibleObstructionCount -
                      step.precondition.visibleObstructionCount,
            networkEntriesAdded: step.observation.networkEntriesAdded,
            popupsOpened: step.observation.popupsOpened,
            dialogsDismissed: step.observation.dialogsDismissed,
        })),
    };
}

/**
 * Register the tool that rehearses an interaction on the live investigation page.
 *
 * Rehearsals are exploratory evidence: what a click provoked — new hosts, popups, dialogs, overlay
 * changes — is recorded and cited. A check session re-performs a sequence only when the model
 * passes it to apply_rule as `revealSteps`.
 *
 * @param registry - Registry receiving the tool.
 * @param options - Live session, artifact sink, and reported origin.
 */
export function registerInteractPageTool(
    registry: ToolRegistry,
    options: InteractPageToolOptions,
): void {
    let rehearsals = 0;

    registry.register({
        definition: {
            type: 'function',
            function: {
                name: ToolName.InteractPage,
                description:
                    'Perform a bounded sequence of actions on the page you are investigating and ' +
                    'observe what it provoked: requests to new hosts, tabs the site opened, ' +
                    'dialogs, and overlays that appeared or disappeared. Use it to find the one ' +
                    'interaction that makes the reported symptom appear, and cite what it ' +
                    'provoked as evidence. Text is ' +
                    'never supplied by you: a type step names one of the host-owned synthetic ' +
                    'values. Unsafe controls (sign-in, payment, upload, publishing) are refused.',
                parameters: registeredParameters(ToolName.InteractPage),
            },
        },
        handler: async (args: Record<string, unknown>) => {
            const requested = args.steps;
            const outcome = normalizeSafeInteractionPlan(
                Array.isArray(requested)
                    ? requested.map((step) => canonicalInteractionStep(step))
                    : requested,
            );
            if (outcome.kind !== 'normalized') {
                return {
                    error: 'The proposed interaction was not accepted.',
                    errorKind: outcome.reason,
                    detail: outcome.detail,
                    retryable: true,
                };
            }
            const networkBefore = options.session.getNetworkLog().length;
            const record = await runSafeInteractionSequence({
                session: options.session,
                plan: outcome.plan,
                allowedOrigin: options.allowedOrigin,
            });
            rehearsals += 1;
            const artifact = persistSafeInteractionRecord({
                record,
                baseline: null,
                // The publication boundary re-sanitizes every artifact against the real Host
                // secret list; the runtime never holds one.
                configuredSecrets: [],
                artifactsDir: options.artifactsDir,
                recorder: options.recorder,
                artifactIdSuffix: `rehearsal-${rehearsals}`,
            });
            return rehearsalObservation(
                record,
                artifact.artifactId,
                newRequestHosts(options.session, networkBefore, options.allowedOrigin),
            );
        },
    });
}
