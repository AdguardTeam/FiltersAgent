import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { FixRunResult } from '../../../src/types/fix-run-result';
import type { ExtractedHumanFix, HumanFixCandidate } from '../../../lab/e2e/human-commit-oracle';
import { classifyGoldenResult } from '../../../lab/e2e/golden-comparator';

const HUMAN_CANDIDATES: HumanFixCandidate[] = [
    {
        rule: 'nettg.pl##.banner',
        syntaxKind: 'element_hiding',
        filePath: 'BaseFilter/sections/foreign.txt',
        repositoryEdit: 'extend_domains',
        sourceRule: 'nettg.pl,morizon.pl##.banner',
    },
    {
        rule: '||nettg.pl/store-view/api/track-page-view',
        syntaxKind: 'network',
        filePath: 'SpywareFilter/sections/specific.txt',
        repositoryEdit: 'insert',
        sourceRule: '||nettg.pl/store-view/api/track-page-view',
    },
];

const HUMAN_FIX: ExtractedHumanFix = {
    commit: '8e9ba459a4552df35b3edb1a4e4d8dd240095ce8',
    firstParent: '8e73dd6c67cb432e1d93bfb79326fd88b16fdbe5',
    candidates: HUMAN_CANDIDATES,
};

/**
 * Build the post-run fields consumed by the golden comparator.
 *
 * @param overrides - Scenario-specific result fields.
 * @returns Candidate-bearing fix result.
 */
function actualResult(overrides: Record<string, unknown> = {}): FixRunResult {
    return {
        issueNumber: 235988,
        domain: 'nettg.pl',
        runStatus: 'patch_proposed',
        requestedBrowserMode: 'on',
        effectiveMode: 'browser',
        verificationStatus: 'verified',
        reproductionSettingsStatus: 'applied',
        symptomObservation: 'reproduced',
        fallbackReason: null,
        fallbackDetail: null,
        candidatePatch: {
            rule: 'nettg.pl##   .banner',
            ruleType: 'cosmetic',
            syntaxKind: 'element_hiding',
            filePath: 'BaseFilter/sections/foreign.txt',
            repositoryEdit: {
                kind: 'extend_domains',
                line: 42,
                originalRule: 'morizon.pl##.banner',
                replacementRule: 'nettg.pl,morizon.pl##.banner',
            },
        },
        artifactPaths: {
            screenshots: [],
            domSnapshot: null,
            har: null,
            trace: null,
        },
        reasoning: 'Verified.',
        repository: 'AdguardTeam/AdguardFilters',
        baseSha: '0e06526e359cfb83f2883f7005aeee3feb56b653',
        ...overrides,
    } as FixRunResult;
}

function semanticallyVerifiedResult(
    rule: string,
    candidateOverrides: Record<string, unknown> = {},
    resultOverrides: Record<string, unknown> = {},
): FixRunResult {
    const candidateRuleHash = createHash('sha256').update(rule).digest('hex');
    const candidatePatch = {
        rule,
        ruleType: 'cosmetic',
        syntaxKind: 'element_hiding',
        filePath: 'BaseFilter/sections/foreign.txt',
        repositoryEdit: {
            kind: 'insert',
            insertionPoint: 9235,
            anchorRule: 'wpoznaniu.pl##.existing-rule',
        },
        ...candidateOverrides,
    };
    return actualResult({
        issueNumber: 235403,
        domain: 'wpoznaniu.pl',
        candidatePatch,
        candidateVisualReview: {
            verdict: 'verified',
            symptom: 'resolved',
            symptomScope: 'The reporter-visible empty top advertising container.',
            coverageComplete: true,
            beforeInstances: [
                {
                    artifactId: 'before-tile-1',
                    landmark: 'Above the main navigation.',
                    description: 'A large reporter-visible empty advertising gap.',
                },
            ],
            remainingInstances: [],
            pageIntegrity: 'intact',
            validationArtifactId: `validation-${candidateRuleHash.slice(0, 12)}`,
            candidateRuleHash,
            beforeViewportArtifactId: 'before-viewport',
            afterViewportArtifactId: 'after-viewport',
            beforeFullPageArtifactId: 'before-full-page',
            afterFullPageArtifactId: 'after-full-page',
            model: 'vision-test-model',
            rationale: 'The reporter defect is resolved and the page remains intact.',
            observedDamage: [],
        },
        artifactPaths: {
            screenshots: [],
            domSnapshot: null,
            har: null,
            trace: null,
            candidateVisualReview: '/tmp/candidate-visual-review.json',
            verifiedCandidateScreenshots: {
                before: '/tmp/before.png',
                after: '/tmp/after.png',
                beforeFullPage: '/tmp/before-full-page.png',
                afterFullPage: '/tmp/after-full-page.png',
            },
        },
        ...resultOverrides,
    });
}

const WPOZNANIU_HUMAN_FIX: ExtractedHumanFix = {
    commit: '9a9a950e196d746ae2ed8d1f1a61d61a1ffaae8b',
    firstParent: '0b899c514391f66817bbc66efec31a892cea2045',
    candidates: [
        {
            rule: 'wpoznaniu.pl##div[class^="inner-ads-header"]',
            syntaxKind: 'element_hiding',
            filePath: 'BaseFilter/sections/foreign.txt',
            repositoryEdit: 'insert',
            sourceRule: 'wpoznaniu.pl##div[class^="inner-ads-header"]',
        },
    ],
};

describe('classifyGoldenResult', () => {
    it('passes only after browser vision identifies the matching human change as relevant', async () => {
        const probe = vi.fn(async (candidate: HumanFixCandidate) =>
            candidate.syntaxKind === 'element_hiding'
                ? { status: 'verified' as const, detail: 'Reporter defect is removed.' }
                : { status: 'not_verified' as const, detail: 'Unrelated telemetry change.' },
        );

        const result = await classifyGoldenResult(actualResult(), HUMAN_FIX, probe);

        expect(result).toMatchObject({
            status: 'pass',
            exitCode: 0,
            expectedRule: 'nettg.pl##.banner',
            humanFixCommit: HUMAN_FIX.commit,
            humanFixFirstParent: HUMAN_FIX.firstParent,
            humanCandidate: HUMAN_CANDIDATES[0],
        });
        expect(probe).toHaveBeenCalledTimes(1);
        expect(probe).toHaveBeenCalledWith(HUMAN_CANDIDATES[0]);
    });

    it('stops at the first vision-verified human candidate without agent-rule prioritization', async () => {
        const probe = vi.fn(async () => ({
            status: 'verified' as const,
            detail: 'This first human rule independently fixes the reporter symptom.',
        }));

        const result = await classifyGoldenResult(
            actualResult({
                candidatePatch: {
                    ...actualResult().candidatePatch!,
                    rule: HUMAN_CANDIDATES[1].rule,
                    ruleType: 'network',
                    syntaxKind: 'network',
                    filePath: HUMAN_CANDIDATES[1].filePath,
                    repositoryEdit: {
                        kind: 'insert',
                        insertionPoint: 87,
                        anchorRule: '||grizly.*/metrics/',
                    },
                },
            }),
            HUMAN_FIX,
            probe,
        );

        expect(result).toMatchObject({
            status: 'agent_regression',
            humanCandidate: HUMAN_CANDIDATES[0],
            expectedRule: HUMAN_CANDIDATES[0].rule,
        });
        expect(probe).toHaveBeenCalledTimes(1);
        expect(probe).toHaveBeenCalledWith(HUMAN_CANDIDATES[0]);
    });

    it('reports regression when a reporter-relevant human rule works but the agent differs', async () => {
        const result = await classifyGoldenResult(
            actualResult({ candidatePatch: null, runStatus: 'analysis_only' }),
            HUMAN_FIX,
            async (candidate) =>
                candidate.syntaxKind === 'element_hiding'
                    ? { status: 'verified', detail: 'Human rule works.' }
                    : { status: 'not_verified', detail: 'Not reporter-relevant.' },
        );

        expect(result).toMatchObject({
            status: 'agent_regression',
            exitCode: 1,
            expectedRule: 'nettg.pl##.banner',
        });
    });

    it('does not accept an inserted agent rule when the human fix replaced its parent rule', async () => {
        const replacementRule = 'nettg.pl##.banner';
        const humanFix: ExtractedHumanFix = {
            ...HUMAN_FIX,
            candidates: [
                {
                    rule: replacementRule,
                    syntaxKind: 'element_hiding',
                    filePath: 'BaseFilter/sections/foreign.txt',
                    repositoryEdit: 'replace',
                    sourceRule: replacementRule,
                    replacedRule: 'nettg.pl##.banner-slot',
                },
            ],
        };
        const result = await classifyGoldenResult(
            actualResult({
                candidatePatch: {
                    ...actualResult().candidatePatch!,
                    rule: replacementRule,
                    repositoryEdit: {
                        kind: 'insert',
                        insertionPoint: 7383,
                        anchorRule: 'nettg.pl##.article-card',
                    },
                },
            }),
            humanFix,
            async () => ({ status: 'verified', detail: 'The replacement fixes the defect.' }),
        );

        expect(result).toMatchObject({ status: 'agent_regression', exitCode: 1 });
        expect(result.detail).toContain('repository edit: different');
    });

    it('rejects a different rule even when the fix agent reports bound vision verification', async () => {
        const result = await classifyGoldenResult(
            semanticallyVerifiedResult('wpoznaniu.pl##.inner-ads-header'),
            WPOZNANIU_HUMAN_FIX,
            async () => ({
                status: 'verified',
                detail: 'The human rule independently removes the same reporter-visible top gap.',
            }),
        );

        expect(result).toMatchObject({
            status: 'agent_regression',
            exitCode: 1,
            actualRule: 'wpoznaniu.pl##.inner-ads-header',
            expectedRule: 'wpoznaniu.pl##div[class^="inner-ads-header"]',
            humanCandidate: WPOZNANIU_HUMAN_FIX.candidates[0],
        });
        expect(result.detail).toContain('exact rule: different');
        expect(result.detail).toContain('bound vision: verified');
    });

    it('reads bound vision as verified for a third-party network fix on an unclear page', async () => {
        const rule = '||increase-rev.cv3-ecf.workers.dev^$domain=wpoznaniu.pl';
        const base = semanticallyVerifiedResult(rule).candidateVisualReview!;
        const result = await classifyGoldenResult(
            semanticallyVerifiedResult(
                rule,
                {
                    ruleType: 'network',
                    syntaxKind: 'network',
                    repositoryEdit: {
                        kind: 'insert',
                        insertionPoint: 9235,
                        anchorRule: '||other.example^',
                    },
                },
                {
                    candidateVisualReview: {
                        ...base,
                        pageIntegrity: 'unclear',
                        candidateNetworkScope: 'third_party_host_block',
                        integrityBasis: 'third_party_network_clean_before_after',
                    },
                },
            ),
            WPOZNANIU_HUMAN_FIX,
            async () => ({
                status: 'verified',
                detail: 'The human rule independently removes the same reporter-visible top gap.',
            }),
        );

        // The rule is not the human one, so this stays a regression. What matters is the
        // diagnostic beside it: the benchmark must not report the run's own verified decision as
        // unverified vision merely because the page integrity behind it reads unclear.
        expect(result).toMatchObject({ status: 'agent_regression', exitCode: 1 });
        expect(result.detail).toContain('bound vision: verified');
    });

    it('rejects the nettg false green with different rule semantics and edit family', async () => {
        const result = await classifyGoldenResult(
            semanticallyVerifiedResult(
                'nettg.pl##.banner--has-content',
                {
                    repositoryEdit: {
                        kind: 'insert',
                        insertionPoint: 9235,
                        anchorRule: 'nettg.pl##.article-card',
                    },
                },
                {
                    issueNumber: 235988,
                    domain: 'nettg.pl',
                },
            ),
            HUMAN_FIX,
            async () => ({
                status: 'verified',
                detail: 'The human rule independently removes every reporter-visible banner gap.',
            }),
        );

        expect(result).toMatchObject({
            status: 'agent_regression',
            exitCode: 1,
            actualRule: 'nettg.pl##.banner--has-content',
            expectedRule: 'nettg.pl##.banner',
            humanCandidate: HUMAN_CANDIDATES[0],
        });
        expect(result.detail).toContain('exact rule: different');
        expect(result.detail).toContain('repository edit: different');
        expect(result.detail).toContain('bound vision: verified');
    });

    it.each([
        {
            label: 'missing bound visual review',
            result: semanticallyVerifiedResult(
                'wpoznaniu.pl##.inner-ads-header',
                {},
                {
                    candidateVisualReview: undefined,
                },
            ),
        },
        {
            label: 'candidate hash mismatch',
            result: semanticallyVerifiedResult(
                'wpoznaniu.pl##.inner-ads-header',
                {},
                {
                    candidateVisualReview: {
                        ...semanticallyVerifiedResult('wpoznaniu.pl##.inner-ads-header')
                            .candidateVisualReview!,
                        candidateRuleHash: '0'.repeat(64),
                    },
                },
            ),
        },
        {
            label: 'missing verified screenshots',
            result: semanticallyVerifiedResult(
                'wpoznaniu.pl##.inner-ads-header',
                {},
                {
                    artifactPaths: {
                        screenshots: [],
                        domSnapshot: null,
                        har: null,
                        trace: null,
                    },
                },
            ),
        },
        {
            label: 'different domain scope',
            result: semanticallyVerifiedResult('other.example##.inner-ads-header'),
        },
        {
            label: 'different syntax kind',
            result: semanticallyVerifiedResult(
                'wpoznaniu.pl#$#.inner-ads-header { height: 0px !important; }',
                { syntaxKind: 'css_injection' },
            ),
        },
        {
            label: 'different repository file',
            result: semanticallyVerifiedResult('wpoznaniu.pl##.inner-ads-header', {
                filePath: 'AnnoyancesFilter/Popups/sections/popups.txt',
            }),
        },
    ])('keeps a different rule as regression for $label', async ({ result }) => {
        const compared = await classifyGoldenResult(result, WPOZNANIU_HUMAN_FIX, async () => ({
            status: 'verified',
            detail: 'The human rule works.',
        }));

        expect(compared).toMatchObject({ status: 'agent_regression', exitCode: 1 });
        expect(compared.detail).toContain('candidate');
        expect(compared.detail).toContain('exact rule: different');
    });

    it('keeps outcome mismatches as regression despite compatible verified rules', async () => {
        const result = await classifyGoldenResult(
            semanticallyVerifiedResult(
                'wpoznaniu.pl##.inner-ads-header',
                {},
                {
                    symptomObservation: 'indeterminate',
                },
            ),
            WPOZNANIU_HUMAN_FIX,
            async () => ({ status: 'verified', detail: 'The human rule works.' }),
        );

        expect(result).toMatchObject({ status: 'agent_regression', exitCode: 1 });
        expect(result.detail).toContain('symptomObservation');
    });

    it('reports agent regression before probing human rules when reporter environment mismatches', async () => {
        const probe = vi.fn();

        const result = await classifyGoldenResult(actualResult(), HUMAN_FIX, probe, {
            status: 'agent_mismatch',
            detail: 'Enabled filter IDs differ from the reporter import.',
            extension: null,
        });

        expect(result).toMatchObject({
            status: 'agent_regression',
            exitCode: 1,
            detail: expect.stringContaining('Enabled filter IDs differ'),
            expectedRule: null,
            humanFixCommit: HUMAN_FIX.commit,
        });
        expect(probe).not.toHaveBeenCalled();
    });

    it('reports case infrastructure before probing when exact reporter settings cannot be parsed', async () => {
        const probe = vi.fn();

        const result = await classifyGoldenResult(actualResult(), HUMAN_FIX, probe, {
            status: 'infrastructure_failure',
            detail: 'Golden issue has no exact settings import URL.',
            extension: null,
        });

        expect(result).toMatchObject({
            status: 'infrastructure_failure',
            exitCode: 3,
            detail: expect.stringContaining('no exact settings import'),
        });
        expect(probe).not.toHaveBeenCalled();
    });

    it('names why the visual review was unavailable instead of the agent prose', async () => {
        // A vision provider that refused the screenshots is a provider rejection; the benchmark
        // detail has to say so, not echo whatever the agent concluded around it.
        const rule = 'wpoznaniu.pl##.inner-ads-header';
        const rationale =
            'Visual review unavailable: Vision provider rejected the request: 400: ' +
            '{"message":"At least one of the image dimensions exceed max allowed size"}';
        const probe = vi.fn();

        const result = await classifyGoldenResult(
            semanticallyVerifiedResult(
                rule,
                {},
                {
                    reasoning: 'The page looks fixed but vision could not confirm it.',
                    candidateVisualReview: {
                        ...semanticallyVerifiedResult(rule).candidateVisualReview!,
                        verdict: 'inconclusive',
                        rationale,
                    },
                },
            ),
            HUMAN_FIX,
            probe,
        );

        expect(result).toMatchObject({ status: 'infrastructure_failure', exitCode: 3 });
        expect(result.detail).toBe(rationale);
        expect(probe).not.toHaveBeenCalled();
    });

    it('keeps an explicit agent infrastructure failure above missing environment evidence', async () => {
        const probe = vi.fn();

        const result = await classifyGoldenResult(
            actualResult({
                runStatus: 'failed',
                verificationStatus: 'unavailable',
                candidatePatch: null,
                infrastructureFailureReason: 'llm_unavailable',
                reasoning: 'The reasoning provider returned 403.',
            }),
            HUMAN_FIX,
            probe,
            {
                status: 'agent_mismatch',
                detail: 'Locked result has no verified-session extension provenance.',
                extension: null,
            },
        );

        expect(result).toMatchObject({
            status: 'infrastructure_failure',
            exitCode: 3,
            detail: 'The reasoning provider returned 403.',
        });
        expect(probe).not.toHaveBeenCalled();
    });

    it('reports environment drift when no human candidate still fixes the reporter defect', async () => {
        const result = await classifyGoldenResult(actualResult(), HUMAN_FIX, async () => ({
            status: 'not_verified',
            detail: 'Target no longer exists.',
        }));

        expect(result).toMatchObject({ status: 'environment_drift', exitCode: 2 });
    });

    it('reports infrastructure when relevance cannot be established', async () => {
        const result = await classifyGoldenResult(actualResult(), HUMAN_FIX, async () => ({
            status: 'infrastructure_failure',
            detail: 'Pinned browser could not launch.',
        }));

        expect(result).toMatchObject({ status: 'infrastructure_failure', exitCode: 3 });
    });

    it('prefers a verified candidate when another candidate probe has infrastructure trouble', async () => {
        const result = await classifyGoldenResult(actualResult(), HUMAN_FIX, async (candidate) =>
            candidate.syntaxKind === 'element_hiding'
                ? { status: 'verified', detail: 'Human rule works.' }
                : { status: 'infrastructure_failure', detail: 'Secondary probe failed.' },
        );

        expect(result).toMatchObject({ status: 'pass', exitCode: 0 });
    });

    it.each([
        {
            runStatus: 'browser_unavailable',
            verificationStatus: 'unavailable',
            candidatePatch: null,
        },
        {
            runStatus: 'failed',
            verificationStatus: 'unavailable',
            candidatePatch: null,
            infrastructureFailureReason: 'llm_unavailable',
        },
        {
            runStatus: 'analysis_only',
            effectiveMode: 'reasoning',
            verificationStatus: 'partial',
            candidatePatch: null,
            fallbackReason: 'extension_configuration_failed',
        },
    ])(
        'does not consult the human oracle for an agent infrastructure failure',
        async (override) => {
            const probe = vi.fn();

            const result = await classifyGoldenResult(actualResult(override), HUMAN_FIX, probe);

            expect(result).toMatchObject({ status: 'infrastructure_failure', exitCode: 3 });
            expect(probe).not.toHaveBeenCalled();
        },
    );

    it.each([
        'navigation_timeout',
        'target_unreachable',
        'http_blocked',
        'bot_challenge',
        'geo_blocked',
        'empty_dom',
    ] as const)(
        'lets a reachable human-oracle page distinguish target drift after %s',
        async (fallbackReason) => {
            const probe = vi.fn(async () => ({
                status: 'not_verified' as const,
                detail: 'The page loaded, but the reporter-visible symptom no longer existed.',
            }));

            const result = await classifyGoldenResult(
                actualResult({
                    runStatus: 'analysis_only',
                    effectiveMode: 'reasoning',
                    verificationStatus: 'unavailable',
                    symptomObservation: 'indeterminate',
                    candidatePatch: null,
                    fallbackReason,
                }),
                HUMAN_FIX,
                probe,
            );

            expect(result).toMatchObject({ status: 'environment_drift', exitCode: 2 });
            expect(probe).toHaveBeenCalledTimes(HUMAN_CANDIDATES.length);
        },
    );

    it('does not infer browser infrastructure failure from reasoning mode alone', async () => {
        const probe = vi.fn(async () => ({
            status: 'not_verified' as const,
            detail: 'The page loaded independently, but the human rule no longer fixed the defect.',
        }));

        const result = await classifyGoldenResult(
            actualResult({
                runStatus: 'analysis_only',
                effectiveMode: 'reasoning',
                verificationStatus: 'unavailable',
                symptomObservation: 'indeterminate',
                candidatePatch: null,
                fallbackReason: null,
                fallbackDetail: null,
                reasoning: 'Every live navigation timed out before browser evidence was captured.',
            }),
            HUMAN_FIX,
            probe,
        );

        expect(result).toMatchObject({ status: 'environment_drift', exitCode: 2 });
        expect(probe).toHaveBeenCalledTimes(HUMAN_CANDIDATES.length);
    });

    it('reports infrastructure for an empty or malformed human diff candidate set', async () => {
        const probe = vi.fn();

        const result = await classifyGoldenResult(
            actualResult(),
            { ...HUMAN_FIX, candidates: [] },
            probe,
        );

        expect(result).toMatchObject({ status: 'infrastructure_failure', exitCode: 3 });
        expect(probe).not.toHaveBeenCalled();
    });
});
