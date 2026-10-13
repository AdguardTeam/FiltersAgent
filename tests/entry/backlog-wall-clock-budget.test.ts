import { describe, expect, it } from 'vitest';
import { canStartAnotherBacklogIssue } from '../../src/entry/backlog-wall-clock-budget';

describe('canStartAnotherBacklogIssue', () => {
    it('allows starting while enough budget remains for one more full investigation', () => {
        expect(
            canStartAnotherBacklogIssue({
                budgetMs: 100_000,
                perIssueBudgetMs: 30_000,
                elapsedMs: 0,
            }),
        ).toBe(true);
        expect(
            canStartAnotherBacklogIssue({
                budgetMs: 100_000,
                perIssueBudgetMs: 30_000,
                elapsedMs: 70_000,
            }),
        ).toBe(true);
    });

    it('refuses once the remaining budget could not fit one more issue', () => {
        expect(
            canStartAnotherBacklogIssue({
                budgetMs: 100_000,
                perIssueBudgetMs: 30_000,
                elapsedMs: 70_001,
            }),
        ).toBe(false);
        expect(
            canStartAnotherBacklogIssue({
                budgetMs: 100_000,
                perIssueBudgetMs: 30_000,
                elapsedMs: 100_000,
            }),
        ).toBe(false);
    });
});
