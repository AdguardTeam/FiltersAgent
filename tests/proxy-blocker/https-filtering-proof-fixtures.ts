import {
    TlsInterceptionOutcome,
    type TlsInterceptionDiagnostic,
} from '../../src/local/tls-interception-diagnostic';

/**
 * What the HTTPS probe saw through the proxy for one URL, shaped the way the real probe reports
 * each outcome.
 *
 * @param url - The probed URL.
 * @param outcome - The probe outcome.
 * @returns A probe result.
 */
export function probed(url: string, outcome: TlsInterceptionOutcome): TlsInterceptionDiagnostic {
    const filtered = outcome === TlsInterceptionOutcome.Filtered;
    return {
        outcome,
        host: new URL(url).hostname,
        chain: [],
        expectedCertificateSha256: 'c'.repeat(64),
        expectedSpkiSha256Base64: 'spki',
        expectedCaPresentInChain: false,
        leafIssuedByExpectedCa: filtered || outcome === TlsInterceptionOutcome.NoResponse,
        statusCode: filtered ? 200 : null,
        failure: filtered ? null : 'socket hang up',
    };
}
