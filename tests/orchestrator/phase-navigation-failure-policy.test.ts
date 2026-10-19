import { describe, expect, it } from 'vitest';
import { NavigationFailureLedger } from '../../src/orchestrator/phase-navigation-failure-policy';
import { BrowserFallbackOrigin } from '../../src/types/browser-fallback-origin';
import { AdsEnvironmentExperimentVerdict } from '../../src/validator/ads-environment-experiment-result';
import type { FailedPhaseNavigation } from '../../src/validator/ads-environment-experiment-result';

const RULE = 'rule-key';

/**
 * Record one failed experiment for the rule and answer it.
 *
 * @param ledger - The run's ledger.
 * @param failure - The failure the experiment ended on.
 * @returns The model-facing answer.
 */
function fail(ledger: NavigationFailureLedger, failure: FailedPhaseNavigation) {
    return ledger.answer(
        RULE,
        AdsEnvironmentExperimentVerdict.Inconclusive,
        failure.phase === 'C' ? ['A', 'B', 'C'] : ['A', failure.phase],
        failure,
    );
}

describe('NavigationFailureLedger', () => {
    it.each([
        { origin: BrowserFallbackOrigin.Site, retryable: true },
        { origin: BrowserFallbackOrigin.Indeterminate, retryable: true },
        { origin: BrowserFallbackOrigin.Agent, retryable: false },
    ])('lets the model retry once unless the runner refused the page: $origin', (row) => {
        const answer = fail(new NavigationFailureLedger(), {
            phase: 'B',
            detail: 'Phase B navigation failed',
            origin: row.origin,
        });

        // The same experiment meets our own refusal again; a site refusal may not recur.
        expect(answer).toMatchObject({ failedPhase: 'B', retryable: row.retryable });
        expect('requiredAction' in answer).toBe(!row.retryable);
    });

    it.each([
        { phase: 'B' as const, finish: true },
        { phase: 'C' as const, finish: false },
    ])('closes the rule after one own refusal in phase $phase; asks to finish: $finish', (row) => {
        const ledger = new NavigationFailureLedger();

        const answer = fail(ledger, {
            phase: row.phase,
            detail: 'navigation failed (navigation_off_origin)',
            origin: BrowserFallbackOrigin.Agent,
        });
        const refusal = ledger.refusal(RULE);

        // Only the candidate differs between B and C, so a phase C redirect indicts the rule, not
        // the page: another rule may still verify.
        expect(answer).toMatchObject({ retryable: false });
        expect('requiredAction' in answer).toBe(row.finish);
        expect(refusal).toMatchObject({ retryable: false });
        expect(refusal !== null && 'requiredAction' in refusal).toBe(row.finish);
    });

    it.each(['B' as const, 'C' as const])(
        'asks to finish after two site refusals in phase %s',
        (phase) => {
            const ledger = new NavigationFailureLedger();
            const failure = { phase, detail: 'HTTP 403', origin: BrowserFallbackOrigin.Site };

            fail(ledger, failure);
            expect(ledger.refusal(RULE)).toBeNull();
            fail(ledger, failure);

            expect(ledger.refusal(RULE)).toMatchObject({
                requiredAction: 'finish_fix_analysis_only',
            });
        },
    );
});
