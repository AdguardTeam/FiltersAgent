import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    candidateForReviewOf,
    enforceCandidateSafety,
} from '../../src/orchestrator/candidate-safety';
import {
    candidatePatchFromOutcome,
    deriveFixRunStatus,
} from '../../src/orchestrator/candidate-verdict';
import { declaredPlacementForRun } from '../../src/knowledge/instruction-placement';
import type { ProposeRuleOutcome } from '../../src/orchestrator/agent-runtime-candidate-context';
import type { FixOutcome } from '../../src/types/fix-outcome';
import { FixRunStatus } from '../../src/types/fix-run-result';

let checkoutPath: string;

function draftOutcome(overrides: Partial<ProposeRuleOutcome> = {}): ProposeRuleOutcome {
    const base: ProposeRuleOutcome = {
        outcome: 'propose_rule',
        ruleProposal: {
            rule: 'example.com##.ad-slot',
            ruleType: 'cosmetic',
            risk: {
                level: 'low',
                reasons: ['untrusted model claim'],
            },
            placement: {
                filter: 'BaseFilter',
                filePath: 'BaseFilter/sections/specific.txt',
                confidence: 0.9,
                alternatives: [],
            },
            duplicateCheck: { classification: 'none', matches: [] },
            productCompatibility: { extension: true },
        },
        policyDecision: { decision: 'allow_rule_generation', reasons: [] },
        reasoning: 'Candidate proposed.',
        evidenceSummary: 'Browser evidence.',
    };
    return { ...base, ...overrides };
}

beforeEach(() => {
    checkoutPath = mkdtempSync(join(tmpdir(), 'candidate-safety-'));
    mkdirSync(join(checkoutPath, 'BaseFilter/sections'), { recursive: true });
    writeFileSync(
        join(checkoutPath, 'BaseFilter/sections/specific.txt'),
        'example.com##.existing\n',
    );
});

afterEach(() => {
    rmSync(checkoutPath, { recursive: true, force: true });
});

describe('enforceCandidateSafety', () => {
    it("accepts a safe candidate and keeps the agent's own risk assessment", () => {
        const result = enforceCandidateSafety(draftOutcome(), {
            reportedDomain: 'example.com',
            checkoutPath,
        });

        expect(result.rejectionReason).toBeNull();
        expect(result.outcome.outcome).toBe('propose_rule');
        if (result.outcome.outcome === 'propose_rule') {
            expect(result.outcome.ruleProposal.risk).toEqual({
                level: 'low',
                reasons: ['untrusted model claim'],
            });
        }
    });

    it('does not refuse a scoped rule for the words its selector contains', () => {
        // The removed keyword scorer rated any rule mentioning login, player or video as high risk
        // and refused it after the run, however well the experiment had verified it.
        const base = draftOutcome();
        const result = enforceCandidateSafety(
            {
                ...base,
                ruleProposal: { ...base.ruleProposal, rule: 'example.com##.video-player-ad' },
            },
            { reportedDomain: 'example.com', checkoutPath },
        );

        expect(result.rejectionReason).toBeNull();
        expect(result.outcome.outcome).toBe('propose_rule');
    });

    it('publishes a verified CSS injection whatever properties it sets', () => {
        // The blocker applies a `#$#` rule in phase C and the visual review judges it, so a
        // verified padding fix reaches the maintainer as a patch, not as an unverified candidate.
        const base = draftOutcome();
        const rule = 'example.com#$#body > main { padding-right: unset !important; }';
        const result = enforceCandidateSafety(
            { ...base, ruleProposal: { ...base.ruleProposal, rule } },
            { reportedDomain: 'example.com', checkoutPath },
        );

        expect(result.rejectionReason).toBeNull();
        const candidatePatch = candidatePatchFromOutcome(result.outcome, checkoutPath);
        expect(candidatePatch).toMatchObject({ rule });
        expect(deriveFixRunStatus(result.outcome, candidatePatch, true)).toBe(
            FixRunStatus.PatchProposed,
        );
    });

    it('accepts a scriptlet declared as cosmetic and preserves its concrete syntax kind', () => {
        const base = draftOutcome();
        const result = enforceCandidateSafety(
            {
                ...base,
                ruleProposal: {
                    ...base.ruleProposal,
                    rule: "example.com#%#//scriptlet('abort-on-property-read', 'ads')",
                    ruleType: 'cosmetic',
                },
            },
            { reportedDomain: 'example.com', checkoutPath },
        );

        expect(result.rejectionReason).toBeNull();
        expect(result.outcome.outcome).toBe('propose_rule');
        const candidatePatch = candidatePatchFromOutcome(result.outcome);
        expect(candidatePatch).toMatchObject({
            ruleType: 'cosmetic',
            syntaxKind: 'scriptlet',
        });
    });

    it('accepts an exact anchored first-party network path using trusted issue scope', () => {
        const base = draftOutcome();
        const result = enforceCandidateSafety(
            {
                ...base,
                ruleProposal: {
                    ...base.ruleProposal,
                    rule: '||sochi.camera/adblock-detector.js',
                    ruleType: 'network',
                },
            },
            { reportedDomain: 'sochi.camera', checkoutPath },
        );

        expect(result.rejectionReason).toBeNull();
        expect(result.outcome.outcome).toBe('propose_rule');
    });

    it('accepts one trailing separator anchor on an exact first-party network path', () => {
        const base = draftOutcome();
        const result = enforceCandidateSafety(
            {
                ...base,
                ruleProposal: {
                    ...base.ruleProposal,
                    rule: '||sochi.camera/adblock-detector.js^',
                    ruleType: 'network',
                },
            },
            { reportedDomain: 'sochi.camera', checkoutPath },
        );

        expect(result.rejectionReason).toBeNull();
        expect(result.outcome.outcome).toBe('propose_rule');
    });

    it('accepts the narrowing script modifier on an exact first-party network path', () => {
        const base = draftOutcome();
        const result = enforceCandidateSafety(
            {
                ...base,
                ruleProposal: {
                    ...base.ruleProposal,
                    rule: '||sochi.camera/adblock-detector.js^$script',
                    ruleType: 'network',
                },
            },
            { reportedDomain: 'sochi.camera', checkoutPath },
        );

        expect(result.rejectionReason).toBeNull();
        expect(result.outcome.outcome).toBe('propose_rule');
    });

    it.each([
        '||cdn.example.net/adblock-detector.js',
        '||*.sochi.camera/adblock-detector.js',
        '||sochi.camera/adblock-*.js',
        '||sochi.camera/adblock^detector.js',
        '||sochi.camera/adblock-detector.js^^',
        '||sochi.camera/adblock-detector.js$redirect=noopjs',
        '||sochi.camera/adblock-detector.js$removeparam=source',
        '||sochi.camera/adblock-detector.js$script,important',
    ])('rejects an unscoped third-party or wildcard network candidate: %s', (rule) => {
        const base = draftOutcome();
        const result = enforceCandidateSafety(
            {
                ...base,
                ruleProposal: {
                    ...base.ruleProposal,
                    rule,
                    ruleType: 'network',
                },
            },
            { reportedDomain: 'sochi.camera', checkoutPath },
        );

        expect(result.outcome.outcome).toBe('analysis_only');
        expect(result.rejectionReason).toMatch(/scope/iu);
    });

    it('accepts semantic examples when the duplicate classification is none', () => {
        const base = draftOutcome();
        const result = enforceCandidateSafety(
            {
                ...base,
                ruleProposal: {
                    ...base.ruleProposal,
                    duplicateCheck: {
                        classification: 'none',
                        matches: [
                            {
                                rule: 'other.example##.ad-slot',
                                filePath: 'BaseFilter/sections/specific.txt',
                            },
                        ],
                    },
                },
            },
            { reportedDomain: 'example.com', checkoutPath },
        );

        expect(result.rejectionReason).toBeNull();
        expect(result.outcome.outcome).toBe('propose_rule');
    });

    it('ignores unrelated-filter selector matches for a selected target file', () => {
        mkdirSync(join(checkoutPath, 'AnnoyancesFilter/sections'), { recursive: true });
        writeFileSync(
            join(checkoutPath, 'BaseFilter/sections/specific.txt'),
            'one.pl,two.pl##.banner\n',
        );
        writeFileSync(
            join(checkoutPath, 'AnnoyancesFilter/sections/ads.txt'),
            'three.de,four.com##.banner\n',
        );
        const base = draftOutcome();

        const result = enforceCandidateSafety(
            {
                ...base,
                ruleProposal: {
                    ...base.ruleProposal,
                    rule: 'nettg.pl##.banner',
                    duplicateCheck: { classification: 'none', matches: [] },
                },
            },
            { reportedDomain: 'nettg.pl', checkoutPath },
        );

        expect(result.outcome.outcome).toBe('propose_rule');
        expect(result.rejectionReason).toBeNull();
    });

    it('accepts equivalent shared selector groups inside the selected target file', () => {
        writeFileSync(
            join(checkoutPath, 'BaseFilter/sections/specific.txt'),
            ['one.pl,two.pl##.banner', 'three.de,four.com##.banner', ''].join('\n'),
        );
        const base = draftOutcome();

        const result = enforceCandidateSafety(
            {
                ...base,
                ruleProposal: {
                    ...base.ruleProposal,
                    rule: 'nettg.pl##.banner',
                    duplicateCheck: { classification: 'none', matches: [] },
                },
            },
            { reportedDomain: 'nettg.pl', checkoutPath },
        );

        expect(result.outcome.outcome).toBe('propose_rule');
        expect(result.rejectionReason).toBeNull();
    });

    it('accepts a semantic selector match only when it yields a safe domain extension', () => {
        writeFileSync(
            join(checkoutPath, 'BaseFilter/sections/specific.txt'),
            'morizon.pl,prawo.pl,wyniki.pl##.banner\n',
        );
        const base = draftOutcome();
        const outcome: FixOutcome = {
            ...base,
            ruleProposal: {
                ...base.ruleProposal,
                rule: 'nettg.pl##.banner',
                placement: {
                    ...base.ruleProposal.placement,
                    filePath: 'BaseFilter/sections/specific.txt',
                },
                duplicateCheck: {
                    classification: 'semantic',
                    matches: [
                        {
                            rule: 'morizon.pl,prawo.pl,wyniki.pl##.banner',
                            filePath: 'BaseFilter/sections/specific.txt',
                        },
                    ],
                },
            },
        };

        const result = enforceCandidateSafety(outcome, {
            reportedDomain: 'nettg.pl',
            checkoutPath,
        });

        expect(result.rejectionReason).toBeNull();
        expect(result.outcome.outcome).toBe('propose_rule');
    });

    it.each(['semantic', 'subsumed', 'cross-filter'] as const)(
        'keeps a candidate the model marked %s when no rule shares its body',
        (classification) => {
            // The note says related rules exist; with no same-body rule to extend the planner
            // inserts, and the note must not cost the run its fix.
            const base = draftOutcome();
            const result = enforceCandidateSafety(
                {
                    ...base,
                    ruleProposal: {
                        ...base.ruleProposal,
                        duplicateCheck: { classification, matches: [] },
                    },
                },
                { reportedDomain: 'example.com', checkoutPath },
            );

            expect(result.rejectionReason).toBeNull();
            expect(result.outcome.outcome).toBe('propose_rule');
        },
    );

    it.each(['exact', 'conflict'] as const)(
        'leaves the duplicate reading to the agent: a %s note refuses nothing',
        (classification) => {
            const base = draftOutcome();
            const result = enforceCandidateSafety(
                {
                    ...base,
                    ruleProposal: {
                        ...base.ruleProposal,
                        duplicateCheck: { classification, matches: [] },
                    },
                },
                { reportedDomain: 'example.com', checkoutPath },
            );

            // The only duplicate code refuses is an exact copy in the checkout, which this
            // checkout does not hold.
            expect(result.rejectionReason).toBeNull();
            expect(result.outcome.outcome).toBe('propose_rule');
        },
    );

    it.each([
        ['multiline rule', { rule: 'example.com##.ad\nexample.com##.other' }],
        ['wrong domain', { rule: 'other.example##.ad-slot' }],
    ])('downgrades a candidate with %s', (_label, proposalOverride) => {
        const base = draftOutcome();
        const result = enforceCandidateSafety(
            {
                ...base,
                ruleProposal: { ...base.ruleProposal, ...proposalOverride },
            },
            { reportedDomain: 'example.com', checkoutPath },
        );

        expect(result.outcome.outcome).toBe('analysis_only');
        expect(result.rejectionReason).not.toBeNull();
        expect(result.outcome.reasoning).toContain('Candidate rejected');
    });

    it('keeps a verified rule the model labelled with the wrong rule type, typed as it parses', () => {
        // A polytranslator.com run: a verified set-constant scriptlet labelled
        // `network` was downgraded to analysis-only and the report showed no rule at all.
        const base = draftOutcome();
        const rule = "example.com#%#//scriptlet('set-constant', 'nitroAds.abp', 'true')";
        const result = enforceCandidateSafety(
            { ...base, ruleProposal: { ...base.ruleProposal, rule, ruleType: 'network' } },
            { reportedDomain: 'example.com', checkoutPath },
        );

        expect(result.rejectionReason).toBeNull();
        expect(result.ruleTypeCorrection).toEqual({ from: 'network', to: 'cosmetic' });
        const candidatePatch = candidatePatchFromOutcome(result.outcome, checkoutPath);
        expect(candidatePatch).toMatchObject({
            rule,
            ruleType: 'cosmetic',
            syntaxKind: 'scriptlet',
            filePath: 'BaseFilter/sections/specific.txt',
        });
        expect(deriveFixRunStatus(result.outcome, candidatePatch, true)).toBe(
            FixRunStatus.PatchProposed,
        );
    });

    it('carries a downgraded rule as the candidate for review with the rejection reason', () => {
        const base = draftOutcome();
        const rule = 'other.example##.ad-slot';
        const result = enforceCandidateSafety(
            { ...base, ruleProposal: { ...base.ruleProposal, rule } },
            { reportedDomain: 'example.com', checkoutPath },
        );

        expect(result.outcome).toMatchObject({
            outcome: 'analysis_only',
            candidateForReview: {
                rule,
                placement: { filePath: 'BaseFilter/sections/specific.txt' },
                unverifiedReason: result.rejectionReason,
            },
        });
        expect(result.rejectionReason).not.toBeNull();
    });

    it('carries no candidate for review when the downgraded rule is more than one line', () => {
        const base = draftOutcome();
        const result = enforceCandidateSafety(
            {
                ...base,
                ruleProposal: { ...base.ruleProposal, rule: 'example.com##.ad\nexample.com##.x' },
            },
            { reportedDomain: 'example.com', checkoutPath },
        );

        expect(result.outcome.outcome).toBe('analysis_only');
        expect(result.outcome).not.toHaveProperty('candidateForReview');
    });

    it.each([
        ['blocked policy', { policyDecision: { decision: 'propose_close', reasons: [] } }],
        ['incompatible product', { productCompatibility: { extension: false } }],
    ])('downgrades a candidate with %s', (_label, override) => {
        const base = draftOutcome();
        const outcome =
            'policyDecision' in override
                ? { ...base, policyDecision: override.policyDecision }
                : { ...base, ruleProposal: { ...base.ruleProposal, ...override } };

        const result = enforceCandidateSafety(outcome as FixOutcome, {
            reportedDomain: 'example.com',
            checkoutPath,
        });

        expect(result.outcome.outcome).toBe('analysis_only');
        expect(result.rejectionReason).not.toBeNull();
    });

    it.each([
        '../outside.txt',
        '.github/workflows/unsafe.txt',
        'BaseFilter/sections/missing.txt',
        'BaseFilter/sections/specific.md',
    ])('downgrades an unsafe or missing target path: %s', (filePath) => {
        const base = draftOutcome();
        const result = enforceCandidateSafety(
            {
                ...base,
                ruleProposal: {
                    ...base.ruleProposal,
                    placement: { ...base.ruleProposal.placement, filePath },
                },
            },
            { reportedDomain: 'example.com', checkoutPath },
        );

        expect(result.outcome.outcome).toBe('analysis_only');
        expect(result.rejectionReason).toContain('target');
    });

    it('downgrades a rule already present in the target file', () => {
        writeFileSync(
            join(checkoutPath, 'BaseFilter/sections/specific.txt'),
            'example.com##.ad-slot\n',
        );

        const result = enforceCandidateSafety(draftOutcome(), {
            reportedDomain: 'example.com',
            checkoutPath,
        });

        expect(result.outcome.outcome).toBe('analysis_only');
        expect(result.rejectionReason).toContain('already exists');
    });

    it('downgrades an exact rule already present in another filter file', () => {
        mkdirSync(join(checkoutPath, 'AnnoyancesFilter/sections'), { recursive: true });
        writeFileSync(
            join(checkoutPath, 'AnnoyancesFilter/sections/ads.txt'),
            'example.com##.ad-slot\n',
        );

        const result = enforceCandidateSafety(draftOutcome(), {
            reportedDomain: 'example.com',
            checkoutPath,
        });

        expect(result.outcome.outcome).toBe('analysis_only');
        expect(result.rejectionReason).toContain('already exists');
    });

    it('leaves non-draft outcomes unchanged', () => {
        const outcome: FixOutcome = { outcome: 'analysis_only', reasoning: 'No candidate.' };
        const result = enforceCandidateSafety(outcome, {
            reportedDomain: 'example.com',
            checkoutPath,
        });

        expect(result).toEqual({ outcome, rejectionReason: null });
    });
});

describe('the run instruction’s declared placement', () => {
    /**
     * The shared-rule owner a routed plan retargets a same-selector candidate to. It sits in a
     * filter directory the extension search walks, so the declared arm proves the declaration wins
     * over a real alternative rather than over an empty checkout.
     */
    const SHARED_OWNER_RULE = 'one.test,two.test##.ad-slot';

    /**
     * The uAssets-style list the instruction declares, as its declaration renders for this run.
     */
    const DECLARED_LIST_PATH = 'filters/filters-2026.txt';

    /**
     * The comment the declaration renders from the issue under investigation.
     */
    const DECLARED_COMMENT = '! https://github.com/uBlockOrigin/uAssets/issues/29471';

    beforeEach(() => {
        mkdirSync(join(checkoutPath, 'filters'), { recursive: true });
        writeFileSync(
            join(checkoutPath, DECLARED_LIST_PATH),
            ['! Title: uBlock filters 2026', 'other.test##.leftover', ''].join('\n'),
        );
        writeFileSync(
            join(checkoutPath, 'BaseFilter/sections/specific.txt'),
            `${SHARED_OWNER_RULE}\n`,
        );
    });

    it('keeps the declared file in the published patch and writes the declared comment above the rule', () => {
        // Rendered the way the run renders it: one call, from the instruction's declaration and
        // the issue URL.
        const declaredPlacement = declaredPlacementForRun(
            {
                byRuleType: {},
                unqualified: {
                    pathTemplate: 'filters/filters-{{year}}.txt',
                    commentTemplate: '! {{issueUrl}}',
                },
            },
            'https://github.com/uBlockOrigin/uAssets/issues/29471',
        );
        const outcome = draftOutcome();
        const declaredOutcome: FixOutcome = {
            ...outcome,
            ruleProposal: {
                ...outcome.ruleProposal,
                placement: {
                    filter: 'uBlock filters 2026',
                    filePath: DECLARED_LIST_PATH,
                    confidence: 1,
                    alternatives: [],
                },
            },
        };

        const safety = enforceCandidateSafety(declaredOutcome, {
            reportedDomain: 'example.com',
            checkoutPath,
            declaredPlacement,
        });
        const patch = candidatePatchFromOutcome(safety.outcome, checkoutPath, declaredPlacement);

        expect(safety.rejectionReason).toBeNull();
        expect(patch).toMatchObject({
            rule: 'example.com##.ad-slot',
            filePath: DECLARED_LIST_PATH,
            repositoryEdit: {
                kind: 'insert',
                basis: 'append_eof',
                precedingComment: DECLARED_COMMENT,
            },
        });
        // Nothing retargeted the patch to the shared-rule owner the routed planner prefers.
        expect(patch?.filePath).not.toContain('BaseFilter');
    });

    it('keeps the declared append when the model reports a related rule in another list', () => {
        // The declared list takes every new filter at its end; there is no shared-rule owner to
        // extend, so a model-reported neighbour — EasyList's own vendor rule, in the
        // sarkisozleri.bbs.tr run — must not veto a verified candidate.
        const declaredPlacement = declaredPlacementForRun(
            {
                byRuleType: {},
                unqualified: {
                    pathTemplate: 'filters/filters-{{year}}.txt',
                    commentTemplate: '! {{issueUrl}}',
                },
            },
            'https://github.com/uBlockOrigin/uAssets/issues/29471',
        );
        const outcome = draftOutcome();
        const declaredOutcome: FixOutcome = {
            ...outcome,
            ruleProposal: {
                ...outcome.ruleProposal,
                placement: {
                    filter: 'uBlock filters 2026',
                    filePath: DECLARED_LIST_PATH,
                    confidence: 1,
                    alternatives: [],
                },
                duplicateCheck: {
                    classification: 'cross-filter',
                    matches: [
                        {
                            rule: '||increaserev.com^$third-party',
                            filePath: 'thirdparties/easylist/easylist.txt',
                        },
                    ],
                },
            },
        };

        const safety = enforceCandidateSafety(declaredOutcome, {
            reportedDomain: 'example.com',
            checkoutPath,
            declaredPlacement,
        });

        expect(safety.rejectionReason).toBeNull();
        expect(safety.outcome.outcome).toBe('propose_rule');
    });

    it('still lets the routed planner extend the shared-rule owner when no placement is declared', () => {
        const outcome = draftOutcome();

        const safety = enforceCandidateSafety(outcome, {
            reportedDomain: 'example.com',
            checkoutPath,
        });
        const patch = candidatePatchFromOutcome(safety.outcome, checkoutPath);

        expect(safety.rejectionReason).toBeNull();
        expect(patch).toMatchObject({
            filePath: 'BaseFilter/sections/specific.txt',
            repositoryEdit: {
                kind: 'extend_domains',
                originalRule: SHARED_OWNER_RULE,
                replacementRule: 'example.com,one.test,two.test##.ad-slot',
            },
        });
        expect(patch?.repositoryEdit).not.toHaveProperty('precedingComment');
    });
});

describe('candidateForReviewOf', () => {
    it('carries a draft the run will not publish as a rule with its reason', () => {
        const draft = draftOutcome();

        expect(candidateForReviewOf(draft.ruleProposal, 'the review does not back it')).toEqual({
            rule: 'example.com##.ad-slot',
            placement: { filePath: 'BaseFilter/sections/specific.txt' },
            unverifiedReason: 'the review does not back it',
        });
    });

    it('keeps a multi-line rule out of the candidate for review', () => {
        const draft = draftOutcome();
        const proposal = { ...draft.ruleProposal, rule: 'example.com##.ad\nexample.com##.x' };

        expect(candidateForReviewOf(proposal, 'reason')).toBeUndefined();
    });
});
