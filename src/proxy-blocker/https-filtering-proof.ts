/**
 * The capability gate of a proxy blocker: one real HTTPS request to the run's target through the
 * running proxy, trusted only through the proxy's own authority.
 *
 * A proxy that runs is not a proxy that filters. A filtering proxy may pass a host through raw,
 * refuse it, or present an authority the browser will not accept, and then everything the run
 * observes is unfiltered traffic. Only a request the proxy answered under its own authority proves
 * the browser's traffic goes through the filter.
 */
import {
    BlockerEventKind,
    type BlockerContract,
    type BlockerRoute,
} from '../blocker-contract/blocker-contract';
import type { PlainHttpAnswer, probePlainHttp } from '../local/plain-http-probe';
import {
    TlsInterceptionOutcome,
    type probeTlsInterception,
    type TlsInterceptionDiagnostic,
} from '../local/tls-interception-diagnostic';

/**
 * Requests sent before the gate gives up. A refusing proxy fails every one; a second request keeps
 * one dropped connection to a slow site from ending the run's environment.
 */
const PROOF_ATTEMPTS = 2;

/**
 * Status codes of a redirect answer.
 */
const REDIRECT_STATUS = { min: 300, max: 399 } as const;

/**
 * What proving HTTPS filtering for the run's target found.
 */
export type HttpsFilteringProof =
    | {
          /**
           * An HTTPS request to the target went through the filter.
           */
          proven: true;

          /**
           * The target host.
           */
          host: string;
      }
    | {
          /**
           * No HTTPS request to the target went through the filter.
           */
          proven: false;

          /**
           * The target host.
           */
          host: string;

          /**
           * How far the last request got.
           */
          outcome: TlsInterceptionOutcome;
      };

/**
 * What the gate needs from the route.
 */
export interface ProveBlockerHttpsFilteringInput {
    /**
     * The running blocker, read for its own account of a host it left unfiltered.
     */
    blocker: BlockerContract;

    /**
     * How the browser reaches the running proxy, and the authority it signs with.
     */
    route: BlockerRoute;

    /**
     * The run's target.
     */
    targetUrl: string;

    /**
     * The HTTPS probe.
     */
    probe: typeof probeTlsInterception;

    /**
     * The plain HTTP probe, for an `http:` target whose host serves no HTTPS at all; never used
     * once an HTTPS attempt showed the proxy passing the host through.
     */
    probePlain: typeof probePlainHttp;
}

/**
 * Project one probe result into the fields the run log keeps. The expected authority and every
 * presented certificate are named by their digests, so a request the proxy passed through shows
 * whose leaf came back instead of the run's authority.
 *
 * @param diagnostic - One probe result.
 * @returns Path-free log fields.
 */
function probeFields(diagnostic: TlsInterceptionDiagnostic): Record<string, unknown> {
    return {
        outcome: diagnostic.outcome,
        statusCode: diagnostic.statusCode,
        failure: diagnostic.failure,
        leafIssuedByExpectedCa: diagnostic.leafIssuedByExpectedCa,
        expectedCaPresentInChain: diagnostic.expectedCaPresentInChain,
        expectedAuthority: {
            sha256: diagnostic.expectedCertificateSha256,
            spkiSha256Base64: diagnostic.expectedSpkiSha256Base64,
        },
        chain: diagnostic.chain.map((certificate) => ({
            subject: certificate.subjectCommonName,
            issuer: certificate.issuerCommonName,
            sha256: certificate.sha256,
            spkiSha256Base64: certificate.spkiSha256Base64,
        })),
    };
}

/**
 * Read why the blocker left a host unfiltered, in its own words, since a cursor.
 *
 * @param blocker - The running blocker.
 * @param cursor - Log cursor taken before the first request.
 * @param host - The target host.
 * @returns The blocker's reasons for that host, oldest first.
 */
async function blockerReasons(
    blocker: BlockerContract,
    cursor: string,
    host: string,
): Promise<string[]> {
    try {
        const read = await blocker.log(cursor);
        return read.events.flatMap((event) =>
            event.kind === BlockerEventKind.UnfilteredHost && event.host === host
                ? [event.reason]
                : [],
        );
    } catch (error) {
        console.error('blocker log unreadable after the HTTPS filtering proof', error);
        return [];
    }
}

/**
 * Whether a plain HTTP answer keeps the browser on plain HTTP, which the proxy reads without
 * decrypting anything; a redirect to HTTPS sends it to traffic the HTTPS proof did not cover.
 *
 * @param answer - The proxy's answer to a plain request.
 * @param targetUrl - The requested `http:` target.
 * @returns Whether the site's traffic stays on plain HTTP.
 */
function staysOnPlainHttp(answer: PlainHttpAnswer, targetUrl: string): boolean {
    if (answer.statusCode === null) {
        return false;
    }
    if (
        answer.statusCode < REDIRECT_STATUS.min ||
        answer.statusCode > REDIRECT_STATUS.max ||
        answer.location === null
    ) {
        return true;
    }
    return URL.parse(answer.location, targetUrl)?.protocol !== 'https:';
}

/**
 * Send HTTPS requests to the run's target through the running proxy until one goes through the
 * filter, and log every result. An `http:` target is requested over HTTPS on the same host first,
 * since most such sites redirect there; one whose host serves no HTTPS at all is proven by a plain
 * HTTP answer that keeps the browser on plain HTTP. A host whose HTTPS the proxy passed through is
 * never proven that way: the browser would trust the proxy for HTTPS it does not read.
 *
 * @param input - The running blocker, its route, the target, and the probes.
 * @returns Whether filtering is proven for the target, and how the last HTTPS request failed.
 */
export async function proveBlockerHttpsFiltering(
    input: ProveBlockerHttpsFilteringInput,
): Promise<HttpsFilteringProof> {
    const target = new URL(input.targetUrl);
    const host = target.hostname;
    const plainTarget = target.protocol === 'http:';
    const httpsUrl = plainTarget
        ? `https://${target.hostname}${target.pathname}${target.search}`
        : input.targetUrl;
    // Taken before the first request: a proxy that refuses the host says why while it refuses.
    const { cursor } = await input.blocker.log(null);
    const attempts: TlsInterceptionDiagnostic[] = [];
    for (let attempt = 1; attempt <= PROOF_ATTEMPTS; attempt += 1) {
        const diagnostic = await input.probe(
            input.route.proxyUrl,
            httpsUrl,
            input.route.certificateDerBase64,
        );
        attempts.push(diagnostic);
        if (diagnostic.outcome === TlsInterceptionOutcome.Filtered) {
            console.info(
                `HTTPS filtering proven for ${host}`,
                JSON.stringify({ attempt, ...probeFields(diagnostic) }),
            );
            return { proven: true, host };
        }
    }
    const passedThrough = attempts.some(
        (attempt) => attempt.outcome === TlsInterceptionOutcome.NotIntercepted,
    );
    const plain =
        plainTarget && !passedThrough
            ? await input.probePlain(input.route.proxyUrl, input.targetUrl)
            : null;
    if (plain !== null && staysOnPlainHttp(plain, input.targetUrl)) {
        console.info(
            `Plain HTTP filtering proven for ${host}`,
            JSON.stringify({ attempts: attempts.map(probeFields), plain }),
        );
        return { proven: true, host };
    }
    console.error(
        `HTTPS filtering not proven for ${host}`,
        JSON.stringify({
            attempts: attempts.map(probeFields),
            plain,
            blockerReasons: await blockerReasons(input.blocker, cursor, host),
        }),
    );
    return {
        proven: false,
        host,
        outcome: passedThrough ? TlsInterceptionOutcome.NotIntercepted : attempts.at(-1)!.outcome,
    };
}
