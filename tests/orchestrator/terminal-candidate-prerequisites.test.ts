import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    validateCandidatePlacement,
    validateCandidateScope,
} from '../../src/orchestrator/terminal-candidate-prerequisites';
import type { TerminalValidationView } from '../../src/orchestrator/terminal-validation-view';
import type { ProposeRuleOutcome } from '../../src/orchestrator/agent-runtime-candidate-context';
import type { PlacementPosition } from '../../src/types/rule-proposal';

const checkouts: string[] = [];

/**
 * The one list file the placement check owns in these fixtures.
 */
const FILE_PATH = 'BaseFilter/sections/specific.txt';

/**
 * Build a draft that proposes one rule.
 *
 * @param rule - The proposed rule.
 * @param position - The position the draft names inside its file, when it names one.
 * @returns The draft outcome.
 */
function draftFor(rule: string, position?: PlacementPosition): ProposeRuleOutcome {
    return {
        outcome: 'propose_rule',
        ruleProposal: {
            rule,
            ruleType: 'cosmetic',
            risk: { level: 'low', reasons: [] },
            placement: {
                filter: 'BaseFilter',
                filePath: FILE_PATH,
                confidence: 0.9,
                alternatives: [],
                ...(position === undefined ? {} : { position }),
            },
            duplicateCheck: { classification: 'none', matches: [] },
            productCompatibility: { extension: true },
        },
        policyDecision: { decision: 'allow_rule_generation', reasons: [] },
        reasoning: 'Candidate proposed.',
        evidenceSummary: 'Browser evidence.',
    };
}

/**
 * Write the fixture list file and return the checkout that holds it.
 *
 * @param lines - Exact lines of the list file.
 * @returns The checkout root.
 */
function checkoutWith(lines: readonly string[]): string {
    const root = mkdtempSync(join(tmpdir(), 'placement-prerequisite-'));
    checkouts.push(root);
    mkdirSync(join(root, 'BaseFilter/sections'), { recursive: true });
    writeFileSync(join(root, FILE_PATH), `${lines.join('\n')}\n`, 'utf8');
    return root;
}

/**
 * The placement view a run over that checkout hands the prerequisite check.
 *
 * @param checkout - The checkout root holding the list file.
 * @returns The read-only view.
 */
function placementView(checkout: string): TerminalValidationView {
    return {
        placementContext: {
            checkoutPath: checkout,
            ownedListPaths: new Set([FILE_PATH]),
        },
    } as unknown as TerminalValidationView;
}

afterEach(() => {
    for (const root of checkouts.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

describe('validateCandidateScope', () => {
    // The judgement reads only the target URLs from the view.
    const view = {
        allowedTargetUrls: ['https://short.link/abc', 'https://article-site.com/news/1'],
    } as unknown as TerminalValidationView;

    it('accepts a rule scoped to the page a reported URL redirected to', () => {
        expect(validateCandidateScope(view, draftFor('article-site.com##.ad'))).toBeUndefined();
    });

    it('still refuses a rule scoped to neither target', () => {
        expect(validateCandidateScope(view, draftFor('other-site.com##.ad'))).toMatchObject({
            errorKind: 'candidate_scope_invalid',
            expectedTargetDomain: 'short.link',
        });
    });
});

describe('validateCandidatePlacement', () => {
    it('carries the refused position beside the file, so a retry into another place differs', () => {
        const checkout = checkoutWith(['first.example##.a', 'second.example##.z']);
        const view = placementView(checkout);
        const position = { kind: 'before_line', line: 9 } as const;

        expect(validateCandidatePlacement(view, draftFor('site.example##.ad', position))).toEqual(
            expect.objectContaining({
                errorKind: 'candidate_placement_not_insertable',
                retryable: true,
                requiredTool: 'finish_fix',
                filePath: FILE_PATH,
                position,
            }),
        );
    });

    it('records no position as null rather than dropping it', () => {
        const checkout = checkoutWith(['first.example##.a', 'second.example##.z']);

        expect(
            validateCandidatePlacement(placementView(checkout), draftFor('site.example##.ad')),
        ).toMatchObject({
            errorKind: 'candidate_placement_not_insertable',
            filePath: FILE_PATH,
            position: null,
        });
    });

    it('accepts a position the file can take', () => {
        const checkout = checkoutWith(['first.example##.a', 'second.example##.z']);

        expect(
            validateCandidatePlacement(
                placementView(checkout),
                draftFor('site.example##.ad', { kind: 'before_line', line: 1 }),
            ),
        ).toBeUndefined();
    });

    it('returns a sorted position the named region cannot take to the model', () => {
        const checkout = checkoutWith(['first.example##.a', 'second.example##.z']);

        expect(
            validateCandidatePlacement(
                placementView(checkout),
                draftFor('site.example##.ad', { kind: 'sorted' }),
            ),
        ).toMatchObject({
            errorKind: 'candidate_placement_not_insertable',
            position: { kind: 'sorted' },
            error: expect.stringContaining('sorted'),
        });
    });
});
