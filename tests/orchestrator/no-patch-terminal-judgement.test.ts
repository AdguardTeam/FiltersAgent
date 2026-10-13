import { describe, expect, it } from 'vitest';
import { judgeNoPatchSymptomMatrix } from '../../src/orchestrator/no-patch-terminal-judgement';
import type { FixOutcome } from '../../src/types/fix-outcome';

const NOT_REPRODUCED: FixOutcome = {
    outcome: 'resolve_without_patch',
    runStatus: 'not_reproduced',
    reasoning: 'The reported advertisement was absent in both sessions.',
} as FixOutcome;

const ABSENT = { sessionId: 'session-a', presence: 'absent', access: 'accessible' } as const;

describe('judgeNoPatchSymptomMatrix', () => {
    it('accepts a no-patch claim when both sessions saw the page and the symptom was absent', () => {
        expect(
            judgeNoPatchSymptomMatrix(NOT_REPRODUCED, ABSENT, {
                sessionId: 'session-b',
                presence: 'absent',
                access: 'accessible',
            }),
        ).toBeUndefined();
    });

    it.each([
        ['region_restricted' as const],
        ['authentication_required' as const],
        ['bot_challenge' as const],
    ])('refuses a no-patch claim taken from a %s page', (classification) => {
        // A page that withheld what the reporter described cannot show the symptom either way:
        // one live pass published not_reproduced for a geo-blocked Rutube player (#238615)
        // and a login-walled x.com timeline (#237706) on exactly this evidence.
        const rejection = judgeNoPatchSymptomMatrix(
            NOT_REPRODUCED,
            { ...ABSENT, access: classification },
            { sessionId: 'session-b', presence: 'absent', access: 'accessible' },
        );

        expect(rejection).toMatchObject({
            errorKind: 'no_patch_target_not_observable',
            requiredAction: 'finish_fix_analysis_only',
            retryable: true,
        });
    });

    it('leaves decisions that claim no no-patch status alone', () => {
        const draft = { outcome: 'propose_rule' } as FixOutcome;

        expect(
            judgeNoPatchSymptomMatrix(draft, { ...ABSENT, access: 'region_restricted' }, undefined),
        ).toBeUndefined();
    });
});
