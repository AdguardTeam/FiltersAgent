import { PROVIDER_CALL_CONCURRENCY } from '../../src/pi/call-limiter';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TraceRecorder } from '../../src/tracer/trace-recorder';
import { reviewCandidateVisually } from '../../src/validator/candidate-visual-verifier';
import type { CandidateVisualVerifierOptions } from '../../src/validator/candidate-visual-evidence';
import { composeReporterSymptomScope } from '../../src/validator/reporter-symptom-scope';
import {
    PRE_EXISTING_BLANK_PANELS,
    PRE_EXISTING_BLANK_SPACE_GROUND,
    PRE_EXISTING_BLANK_SPACE_RUBRIC,
    SymptomKind,
} from '../../src/validator/symptom-rubric';
import { SingleShotResultKind, type SingleShotClient } from '../../src/pi/single-shot-types';
import type { SingleShotMessage } from '../../src/pi/single-shot-input';
import { CandidateInstanceDisposition } from '../../src/types/candidate-visual-review';
import { FullPageOverviewMode } from '../../src/types/full-page-overview-evidence';
import { MAX_EVALUATE_JS_EXPRESSION_CHARS } from '../../src/browser/browser-tools';
import {
    MAX_DOM_CHECKS,
    MAX_DOM_CHECK_CLAIM_CHARS,
    MAX_DOM_CHECK_RESULT_BYTES,
    type DomCheckRecord,
} from '../../src/types/dom-check';
import {
    HermeticScenario,
    type HermeticProvider,
    type ScriptedReply,
    ScriptedReplyKind,
    startHermeticProvider,
} from '../pi/hermetic-provider';
import { VISION_MODEL, createTestVisionClient } from '../pi/test-runtime';
import { encodePng } from '../pi/fixtures/png-image';

const CANDIDATE_RULE = 'example.test##.advert';
const CANDIDATE_HASH = createHash('sha256').update(CANDIDATE_RULE).digest('hex');

/**
 * A sitepoint.com report: the reporter named four locations and the candidate covered three. The
 * review was handed the candidate's three as the symptom, never looked at the header, and verified
 * a rule that leaves its banner on the page.
 */
const SITEPOINT_REPORT = 'Visible ads in header, throughout article, in sidebar, and in footer.';
const SITEPOINT_CANDIDATE_TARGET =
    'In-content ad placeholders, the sticky bottom banner, and the sidebar vertical ad.';
const HEADER_LANDMARK = 'Header, under the site navigation.';

/**
 * The reported page and candidate of a live benchmark run. Images cannot exercise first-party
 * functions, which alone made its review return `pageIntegrity: unclear`.
 */
const REPORTED_PAGE_URL = 'https://www.sarkisozleri.bbs.tr/85';
const THIRD_PARTY_NETWORK_RULE = '||increase-rev.cv3-ecf.workers.dev^$domain=sarkisozleri.bbs.tr';
const THIRD_PARTY_NETWORK_RULE_HASH = createHash('sha256')
    .update(THIRD_PARTY_NETWORK_RULE)
    .digest('hex');

/**
 * After tiles, and observations per tile, of the run whose after state overflows the reconciliation
 * limit: their product is above the limit one state accepts, while each three-tile request stays
 * under the instances one bounded inventory request may report.
 */
const OVERFLOWING_AFTER_TILE_COUNT = 9;
const INSTANCES_PER_OVERFLOWING_TILE = 6;

/**
 * Image-part count carried by one structured call's messages.
 *
 * @param options - The structured call options whose image counts are measured.
 * @returns Number of pi image parts in the call.
 */
function imagePartCount(options: { messages: SingleShotMessage[] }): number {
    let count = 0;
    for (const message of options.messages) {
        if ('images' in message) {
            count += message.images.length;
        }
    }
    return count;
}

/**
 * Review options whose fixture captured both full-page overviews.
 */
type OverviewReviewOptions = CandidateVisualVerifierOptions & {
    evidence: Required<
        Pick<CandidateVisualVerifierOptions['evidence'], 'beforeFullPage' | 'afterFullPage'>
    >;
};

function makeOptions(
    root: string,
    vision: SingleShotClient,
    recorder: TraceRecorder,
): OverviewReviewOptions {
    const evidence = {
        beforeViewport: { id: 'before-viewport', path: join(root, 'before-viewport.png') },
        afterViewport: { id: 'after-viewport', path: join(root, 'after-viewport.png') },
        beforeFullPage: { id: 'before-full-page', path: join(root, 'before-full-page.png') },
        afterFullPage: { id: 'after-full-page', path: join(root, 'after-full-page.png') },
        beforeTiles: [
            {
                id: 'before-tile-1',
                path: join(root, 'before-tile-1.png'),
                index: 0,
                x: 0,
                y: 0,
                width: 1_920,
                height: 1_080,
                landmark: 'Top of page through the first article card.',
            },
        ],
        afterTiles: [
            {
                id: 'after-tile-1',
                path: join(root, 'after-tile-1.png'),
                index: 0,
                x: 0,
                y: 0,
                width: 1_920,
                height: 1_080,
                landmark: 'Top of page through the first article card.',
            },
        ],
        beforeCoverageComplete: true,
        afterCoverageComplete: true,
    };
    for (const item of [
        evidence.beforeViewport,
        evidence.afterViewport,
        evidence.beforeFullPage,
        evidence.afterFullPage,
        ...evidence.beforeTiles,
        ...evidence.afterTiles,
    ]) {
        // A real image: the single-shot client decodes every image to fit it to provider limits.
        writeFileSync(
            item.path,
            encodePng(4, 4, () => [255, 255, 255]),
        );
    }
    return {
        candidateRule: CANDIDATE_RULE,
        validationArtifactId: `validation-${CANDIDATE_HASH.slice(0, 12)}`,
        evidence,
        reporterSymptom: 'An anti-adblock overlay hides the movie list.',
        browserFacts: 'The overlay request completed after the underlying content loaded.',
        artifactsDir: root,
        vision,
        recorder,
    };
}

/**
 * A SingleShotClient stub whose structured call records into the returned mock.
 *
 * @param chat - The structured recorder serving the replies.
 * @returns The stub client around the recorder.
 */
function clientWith(chat: ReturnType<typeof vi.fn>): SingleShotClient {
    return {
        modelId: 'vision-stub',
        structured: chat as never,
        text: async () => {
            throw new Error('not used by this suite');
        },
    };
}

function makeProvider(output: Record<string, unknown> | Error): {
    vision: SingleShotClient;
    chat: ReturnType<typeof vi.fn>;
} {
    const chat = vi.fn(async (options: { messages: SingleShotMessage[] }) => {
        if (output instanceof Error) {
            return {
                kind: SingleShotResultKind.ProviderFailure,
                stopReason: 'error',
                message: output.message,
                usages: [],
                model: 'vision-stub',
            };
        }
        const prompt = JSON.stringify(options.messages);
        const labelledArtifactIds = new Set(
            [...prompt.matchAll(/artifact=([^;\\]+)/gu)].map((match) => match[1]),
        );
        const isBeforeTileBatch = prompt.includes('Page state: BEFORE');
        const isAfterTileBatch = prompt.includes('Page state: AFTER');
        const beforeInstances = Array.isArray(output.beforeInstances)
            ? output.beforeInstances.filter(
                  (instance) =>
                      typeof instance === 'object' &&
                      instance !== null &&
                      String((instance as { artifactId?: unknown }).artifactId).startsWith(
                          'before-',
                      ) &&
                      labelledArtifactIds.has(
                          String((instance as { artifactId?: unknown }).artifactId),
                      ),
              )
            : [];
        const remainingInstances = Array.isArray(output.remainingInstances)
            ? output.remainingInstances.filter(
                  (instance) =>
                      typeof instance === 'object' &&
                      instance !== null &&
                      String((instance as { artifactId?: unknown }).artifactId).startsWith(
                          'after-',
                      ) &&
                      labelledArtifactIds.has(
                          String((instance as { artifactId?: unknown }).artifactId),
                      ),
              )
            : [];
        const value = isBeforeTileBatch
            ? {
                  coverageObserved: !prompt.includes(String(output.unreadableArtifactId)),
                  symptomScope: String(output.symptomScope),
                  instances: beforeInstances,
                  observedDamage: [],
                  rationale: 'The complete before tile batch was inventoried.',
              }
            : isAfterTileBatch
              ? {
                    coverageObserved: !prompt.includes(String(output.unreadableArtifactId)),
                    symptomScope: String(output.symptomScope),
                    instances: remainingInstances,
                    observedDamage: Array.isArray(output.observedDamage)
                        ? output.observedDamage
                        : [],
                    rationale: 'The complete after tile batch was inventoried.',
                }
              : {
                    symptom: output.symptom,
                    symptomScope: output.symptomScope,
                    adLayoutResidue: output.adLayoutResidue ?? 'absent',
                    coverageComplete: output.coverageComplete,
                    beforeInventoryReconciliation:
                        output.beforeInventoryReconciliation ??
                        (Array.isArray(output.beforeInstances) ? output.beforeInstances : []).map(
                            (_, index) => ({
                                observationIndex: index + 1,
                                disposition: 'same_symptom',
                                rationale: 'This batch observation matches the reporter symptom.',
                            }),
                        ),
                    afterInventoryReconciliation:
                        output.afterInventoryReconciliation ??
                        (Array.isArray(output.remainingInstances)
                            ? output.remainingInstances
                            : []
                        ).map((_, index) => ({
                            observationIndex: index + 1,
                            disposition: 'remaining',
                            rationale: 'This batch observation is the reporter symptom remaining.',
                        })),
                    additionalBeforeInstances: output.additionalBeforeInstances ?? [],
                    additionalRemainingInstances: output.additionalRemainingInstances ?? [],
                    pageIntegrity: output.pageIntegrity,
                    rationale: output.rationale,
                    observedDamage: output.observedDamage,
                };
        // The bound client validates the reply against the final-output schema before parsing;
        // the stub mirrors that contract so consumer-side repair behavior stays observable.
        const beforeDispositions =
            (
                value as {
                    beforeInventoryReconciliation?: Array<{ disposition: unknown }>;
                }
            ).beforeInventoryReconciliation ?? [];
        const afterDispositions =
            (
                value as {
                    afterInventoryReconciliation?: Array<{ disposition: unknown }>;
                }
            ).afterInventoryReconciliation ?? [];
        const dispositions = [...beforeDispositions, ...afterDispositions];
        const allowedDispositions = Object.values(CandidateInstanceDisposition) as string[];
        if (dispositions.some((item) => !allowedDispositions.includes(String(item.disposition)))) {
            return {
                kind: SingleShotResultKind.InvalidResult,
                detail: 'The final synthesis contained a disposition that is not allowed.',
                attempts: 1,
                usages: [],
                model: 'vision-stub',
            };
        }
        return {
            kind: SingleShotResultKind.Parsed,
            value,
            usages: [],
            attempts: 1,
            model: 'vision-stub',
        };
    });
    return {
        vision: clientWith(chat),
        chat,
    };
}

function makeSequencedFinalProvider(
    inventoryOutput: Record<string, unknown>,
    finalResponses: Array<Record<string, unknown> | string>,
): {
    vision: SingleShotClient;
    chat: ReturnType<typeof vi.fn>;
} {
    const inventoryChat = makeProvider(inventoryOutput).chat;
    let finalResponseIndex = 0;
    const chat = vi.fn(async (options: { messages: SingleShotMessage[] }) => {
        const prompt = JSON.stringify(options.messages);
        if (prompt.includes('Page state: BEFORE') || prompt.includes('Page state: AFTER')) {
            return inventoryChat(options);
        }
        const response =
            finalResponses[Math.min(finalResponseIndex, finalResponses.length - 1)] ?? 'not JSON';
        finalResponseIndex += 1;
        if (typeof response === 'string') {
            return {
                kind: SingleShotResultKind.InvalidResult,
                detail: 'response did not contain a JSON object',
                attempts: 1,
                usages: [],
                model: 'vision-stub',
            };
        }
        const value = { adLayoutResidue: response.adLayoutResidue ?? 'absent', ...response };
        return {
            kind: SingleShotResultKind.Parsed,
            value,
            usages: [],
            attempts: 1,
            model: 'vision-stub',
        };
    });
    return {
        vision: clientWith(chat),
        chat,
    };
}

function resolvedFinalOutput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        symptom: 'resolved',
        symptomScope: 'All repeated anti-adblock overlays on the movie listing.',
        adLayoutResidue: 'absent',
        coverageComplete: true,
        beforeInventoryReconciliation: [
            {
                observationIndex: 1,
                disposition: 'same_symptom',
                rationale: 'This observation is the reporter-defined anti-adblock overlay.',
            },
        ],
        afterInventoryReconciliation: [],
        additionalBeforeInstances: [],
        additionalRemainingInstances: [],
        pageIntegrity: 'intact',
        rationale: 'The overlay disappeared and the underlying page remains intact.',
        observedDamage: [],
        ...overrides,
    };
}

function sequencedInventoryOutput(): Record<string, unknown> {
    return {
        symptomScope: 'All repeated anti-adblock overlays on the movie listing.',
        beforeInstances: [
            {
                artifactId: 'before-tile-1',
                landmark: 'Top of the movie list.',
                description: 'The anti-adblock overlay covers the movie list.',
            },
        ],
        remainingInstances: [],
        observedDamage: [],
    };
}

/**
 * A final synthesis that resolves an empty panel and dismisses a blank AFTER area as the page's
 * own.
 */
function blankAreaFinalOutput(): Record<string, unknown> {
    return {
        symptom: 'resolved',
        symptomScope: 'The empty panel on the reported page.',
        coverageComplete: true,
        beforeInventoryReconciliation: [
            {
                observationIndex: 1,
                disposition: 'same_symptom',
                rationale: 'The empty panel is the reported symptom.',
            },
        ],
        afterInventoryReconciliation: [
            {
                observationIndex: 1,
                disposition: 'not_same_symptom',
                rationale: 'The blank area looks the same in both states.',
            },
        ],
        additionalBeforeInstances: [],
        additionalRemainingInstances: [],
        pageIntegrity: 'intact',
        rationale: 'The reported panel is resolved.',
        observedDamage: [],
    };
}

let provider: HermeticProvider | undefined;

afterEach(async () => {
    if (!provider) {
        return;
    }
    await provider.close();
    provider = undefined;
});

/**
 * Every text the review sent the vision model, across all of its calls.
 *
 * @param chat - The structured recorder of the review.
 * @returns The text of every text message.
 */
function sentTexts(chat: ReturnType<typeof vi.fn>): string[] {
    return chat.mock.calls.flatMap(([options]) =>
        (options as { messages: SingleShotMessage[] }).messages.flatMap((message) =>
            'text' in message && typeof message.text === 'string' ? [message.text] : [],
        ),
    );
}

/**
 * DOM checks at every bound, their answers full of quotes that JSON escapes again.
 *
 * @returns The records the review would receive.
 */
function checksAtEveryBound(): DomCheckRecord[] {
    return Array.from({ length: MAX_DOM_CHECKS }, (_, index) => {
        const answer = (state: string): string => {
            const tail = `"${state}-${index}"`;
            const quotes = '\\"'.repeat((MAX_DOM_CHECK_RESULT_BYTES - tail.length - 2) / 2);
            return `"${quotes}${tail.slice(1)}`;
        };
        return {
            expression: `'${'"'.repeat(MAX_EVALUATE_JS_EXPRESSION_CHARS - 2)}'`,
            claim: 'c'.repeat(MAX_DOM_CHECK_CLAIM_CHARS),
            before: { status: 'measured', result: answer('BEFORE'), truncated: false },
            after: { status: 'measured', result: answer('AFTER'), truncated: false },
        };
    });
}

describe('reviewCandidateVisually', () => {
    it('hands the reviewer both answers of every check at every bound', async () => {
        // The last check's AFTER answer decides the residue question, and a block cut by length
        // would lose exactly it.
        const root = mkdtempSync(join(tmpdir(), 'candidate-visual-review-dom-checks-'));
        const recorder = new TraceRecorder({ runId: 'visual-review', issueNumber: 3, mode: 'fix' });
        const { vision, chat } = makeProvider({
            symptom: 'resolved',
            symptomScope: 'The sidebar advertising on the reported page.',
            coverageComplete: true,
            beforeInstances: [],
            remainingInstances: [],
            pageIntegrity: 'intact',
            rationale: 'The sidebar advertising is gone.',
            observedDamage: [],
        });
        const domChecks = checksAtEveryBound();
        try {
            await reviewCandidateVisually({ ...makeOptions(root, vision, recorder), domChecks });

            const texts = sentTexts(chat);
            const answers = domChecks
                .flatMap(({ before, after }) => [before, after])
                .map((measurement) =>
                    measurement.status === 'measured' ? measurement.result : measurement.error,
                );
            for (const answer of answers) {
                expect(texts.some((text) => text.includes(answer))).toBe(true);
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('leaves DOM checks out of an incorrect-blocking review', async () => {
        // Checks settle ad residue; a breakage review judges restored content and has no rubric
        // that weighs them.
        const root = mkdtempSync(join(tmpdir(), 'candidate-visual-review-breakage-checks-'));
        const recorder = new TraceRecorder({ runId: 'visual-review', issueNumber: 3, mode: 'fix' });
        const { vision, chat } = makeProvider({
            symptom: 'resolved',
            symptomScope: 'The dealer map region on the reported page.',
            coverageComplete: true,
            beforeInstances: [],
            remainingInstances: [],
            pageIntegrity: 'intact',
            rationale: 'The map renders again and no advertising appeared.',
            observedDamage: [],
        });
        const claim = 'The map container keeps its reserved height.';
        try {
            await reviewCandidateVisually({
                ...makeOptions(root, vision, recorder),
                symptomKind: 'incorrect_blocking',
                domChecks: [
                    {
                        expression: "document.querySelector('.map').offsetHeight",
                        claim,
                        before: { status: 'measured', result: '0', truncated: false },
                        after: { status: 'measured', result: '480', truncated: false },
                    },
                ],
            });

            expect(sentTexts(chat).some((text) => text.includes(claim))).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('keeps the blank-space rules of an ads review out of an incorrect-blocking review', async () => {
        // In an incorrect-blocking review an empty media panel is the defect itself, so the rules
        // that set aside blank space the page already had belong to the ads review alone; there,
        // the dismissal audit states that ground with the same limits as the synthesis rules.
        const sentFor = async (
            symptomKind: SymptomKind,
        ): Promise<{ texts: string[]; audit: string }> => {
            const root = mkdtempSync(join(tmpdir(), 'candidate-visual-review-blank-space-'));
            const recorder = new TraceRecorder({
                runId: 'visual-review',
                issueNumber: 3,
                mode: 'fix',
            });
            const { vision, chat } = makeSequencedFinalProvider(
                {
                    symptomScope: 'The empty panel on the reported page.',
                    beforeInstances: [
                        {
                            artifactId: 'before-tile-1',
                            landmark: 'Main column.',
                            description: 'An empty panel.',
                        },
                    ],
                    remainingInstances: [
                        {
                            artifactId: 'after-tile-1',
                            landmark: 'Lower column.',
                            description: 'A blank area.',
                        },
                    ],
                    observedDamage: [],
                },
                [blankAreaFinalOutput(), blankAreaFinalOutput()],
            );
            try {
                await reviewCandidateVisually({
                    ...makeOptions(root, vision, recorder),
                    symptomKind,
                });
                const lastMessages = (
                    chat.mock.calls.at(-1)![0] as { messages: SingleShotMessage[] }
                ).messages;
                const audit = lastMessages.at(-1)!;
                return {
                    texts: sentTexts(chat),
                    audit: 'text' in audit && typeof audit.text === 'string' ? audit.text : '',
                };
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        };
        const adsOnlyRules = [
            PRE_EXISTING_BLANK_SPACE_RUBRIC.join(' '),
            PRE_EXISTING_BLANK_SPACE_GROUND.join(' '),
            PRE_EXISTING_BLANK_PANELS,
        ];

        const ads = await sentFor(SymptomKind.Ads);
        const breakage = await sentFor(SymptomKind.Breakage);

        for (const rule of adsOnlyRules) {
            expect(ads.texts.some((text) => text.includes(rule))).toBe(true);
            expect(breakage.texts.some((text) => text.includes(rule))).toBe(false);
        }
        expect(ads.audit).toContain(PRE_EXISTING_BLANK_SPACE_GROUND.join(' '));
    });

    it('swaps the ads residue rubric for breakage semantics in incorrect-blocking reviews', async () => {
        const root = mkdtempSync(join(tmpdir(), 'candidate-visual-review-breakage-'));
        const recorder = new TraceRecorder({ runId: 'visual-review', issueNumber: 3, mode: 'fix' });
        const { vision, chat } = makeProvider({
            symptom: 'resolved',
            symptomScope: 'The dealer map region on the reported page.',
            coverageComplete: true,
            beforeInstances: [
                {
                    artifactId: 'before-tile-1',
                    landmark: 'Dealer map region.',
                    description: 'The dealer map area is empty with a loading error.',
                },
            ],
            remainingInstances: [],
            pageIntegrity: 'intact',
            rationale: 'The map renders again and no advertising appeared.',
            observedDamage: [],
        });
        try {
            const result = await reviewCandidateVisually({
                ...makeOptions(root, vision, recorder),
                reporterSymptom: 'The dealer map does not load with filtering enabled.',
                symptomKind: 'incorrect_blocking',
            });

            expect(result.review.verdict).toBe('verified');
            const allCalls = JSON.stringify(chat.mock.calls);
            expect(allCalls).not.toMatch(/REKLAMA/);
            expect(allCalls).toContain('broken or missing page functionality');
            // The inventory prompts must request AD PRESENCE observations in BOTH states so
            // the synthesis has an evidence channel for the filtering-regression guard.
            expect(allCalls).toContain('AD PRESENCE:');
            const finalMessages = JSON.stringify(chat.mock.calls.at(-1)![0].messages);
            expect(finalMessages).toContain('became visible in AFTER');
            expect(finalMessages).toContain('AD PRESENCE');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('observes every image in bounded calls and derives verified from text synthesis', async () => {
        const root = mkdtempSync(join(tmpdir(), 'candidate-visual-review-'));
        const recorder = new TraceRecorder({ runId: 'visual-review', issueNumber: 3, mode: 'fix' });
        const { vision, chat } = makeProvider({
            symptom: 'resolved',
            symptomScope: 'All repeated anti-adblock overlays on the movie listing.',
            coverageComplete: true,
            beforeInstances: [
                {
                    artifactId: 'before-tile-1',
                    landmark: 'Top of the movie list.',
                    description: 'The anti-adblock overlay covers the movie list.',
                },
            ],
            remainingInstances: [],
            pageIntegrity: 'intact',
            rationale: 'The overlay disappeared and the underlying page remains intact.',
            observedDamage: [],
        });
        try {
            const result = await reviewCandidateVisually(makeOptions(root, vision, recorder));

            expect(result.review).toMatchObject({
                verdict: 'verified',
                symptom: 'resolved',
                coverageComplete: true,
                remainingInstances: [],
                pageIntegrity: 'intact',
                candidateRuleHash: CANDIDATE_HASH,
                beforeViewportArtifactId: 'before-viewport',
                afterViewportArtifactId: 'after-viewport',
                beforeFullPageArtifactId: 'before-full-page',
                afterFullPageArtifactId: 'after-full-page',
            });
            expect(chat).toHaveBeenCalledTimes(7);
            const imageCounts = chat.mock.calls.map(([call]) => imagePartCount(call));
            expect(imageCounts).toEqual([1, 1, 1, 1, 1, 1, 0]);
            expect(JSON.stringify(chat.mock.calls[0][0].messages)).toContain(
                'A normal tile with no matching defect still counts as observed coverage',
            );
            expect(JSON.stringify(chat.mock.calls)).toMatch(
                /cookie or consent dialogs.*comparison obstructions/is,
            );
            expect(JSON.stringify(chat.mock.calls)).toMatch(
                /outer ad wrapper.*REKLAMA.*reserved.*(?:blank )?(?:space|height)/is,
            );
            const finalMessages = chat.mock.calls.at(-1)![0].messages;
            expect(JSON.stringify(finalMessages)).toContain('before-full-page');
            expect(JSON.stringify(finalMessages)).toContain('after-full-page');
            expect(JSON.stringify(finalMessages)).toContain('full_page_overview');
            expect(JSON.stringify(finalMessages)).toMatch(
                /set symptom=unclear, pageIntegrity=unclear, and coverageComplete=false/is,
            );
            expect(JSON.stringify(finalMessages)).toMatch(/never report.*candidate as verified/is);
            expect(imagePartCount({ messages: finalMessages })).toBe(0);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('runs the independent inventories of one review side by side, within the bound', async () => {
        // Every inventory is its own vision completion over its own images. Run one after another
        // they cost a live review 70 of its 83 minutes; side by side they cost about the longest.
        const root = mkdtempSync(join(tmpdir(), 'candidate-visual-review-parallel-'));
        const recorder = new TraceRecorder({ runId: 'visual-review', issueNumber: 3, mode: 'fix' });
        const { vision } = makeProvider({
            symptom: 'resolved',
            symptomScope: 'All repeated anti-adblock overlays on the movie listing.',
            coverageComplete: true,
            beforeInstances: [
                {
                    artifactId: 'before-tile-1',
                    landmark: 'Top of the movie list.',
                    description: 'The anti-adblock overlay covers the movie list.',
                },
            ],
            remainingInstances: [],
            pageIntegrity: 'intact',
            rationale: 'The overlay disappeared and the underlying page remains intact.',
            observedDamage: [],
        });
        let inFlight = 0;
        let peak = 0;
        const overlapping: SingleShotClient = {
            ...vision,
            structured: (async (options: never) => {
                inFlight += 1;
                peak = Math.max(peak, inFlight);
                await new Promise((resolve) => setTimeout(resolve, 5));
                try {
                    return await vision.structured(options);
                } finally {
                    inFlight -= 1;
                }
            }) as never,
        };
        try {
            const result = await reviewCandidateVisually(makeOptions(root, overlapping, recorder));

            expect(result.review.verdict).toBe('verified');
            expect(peak).toBeGreaterThan(1);
            expect(peak).toBeLessThanOrEqual(PROVIDER_CALL_CONCURRENCY);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('requires strong image-grounded evidence before dismissing an after observation', async () => {
        const root = mkdtempSync(join(tmpdir(), 'candidate-visual-review-dismissal-prompt-'));
        const recorder = new TraceRecorder({ runId: 'visual-review', issueNumber: 3, mode: 'fix' });
        const { vision, chat } = makeProvider({
            symptom: 'not_resolved',
            symptomScope: 'Every repeated empty advertising gap on the page.',
            coverageComplete: true,
            beforeInstances: [
                {
                    artifactId: 'before-tile-1',
                    landmark: 'Below the stock ticker.',
                    description: 'A large empty advertising gap.',
                },
            ],
            remainingInstances: [
                {
                    artifactId: 'after-tile-1',
                    landmark: 'Between article cards and the latest-news heading.',
                    description: 'A smaller but still conspicuous empty advertising gap.',
                },
            ],
            pageIntegrity: 'intact',
            rationale: 'A repeated instance remains at another page landmark.',
            observedDamage: [],
        });
        try {
            const options = makeOptions(root, vision, recorder);
            options.reporterSymptom = 'A large empty advertising gap interrupts page content.';

            await reviewCandidateVisually(options);

            const finalSystemPrompt = JSON.stringify(chat.mock.calls.at(-1)![0].messages);
            expect(finalSystemPrompt).toMatch(
                /visually repeats.*reporter-defined symptom.*anywhere.*remaining/is,
            );
            expect(finalSystemPrompt).toMatch(
                /not_same_symptom.*only.*strong.*image-grounded.*visually distinct/is,
            );
            expect(finalSystemPrompt).toMatch(
                /size.*severity.*page (?:coordinate|landmark).*prominence.*not.*sufficient/is,
            );
            expect(finalSystemPrompt).toMatch(/browser.*DOM.*geometry.*facts.*cannot.*dismiss/is);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('self-critiques a nettg-like contradictory after dismissal', async () => {
        const root = mkdtempSync(join(tmpdir(), 'candidate-visual-review-dismissal-audit-'));
        const recorder = new TraceRecorder({ runId: 'visual-review', issueNumber: 3, mode: 'fix' });
        const symptomScope = 'Every repeated empty advertising gap interrupting page content.';
        const inventoryOutput = {
            symptomScope,
            beforeInstances: [
                {
                    artifactId: 'before-tile-1',
                    landmark: 'Below the stock ticker.',
                    description: 'A large empty gap left by a blocked banner.',
                },
            ],
            remainingInstances: [
                {
                    artifactId: 'after-tile-1',
                    landmark: 'Between the article cards and the latest-news heading.',
                    description: 'An empty gap likely left by the same blocked banner family.',
                },
            ],
            observedDamage: [],
        };
        const commonFinalOutput = {
            symptomScope,
            coverageComplete: true,
            beforeInventoryReconciliation: [
                {
                    observationIndex: 1,
                    disposition: 'same_symptom',
                    rationale: 'The large empty gap is the reporter-defined symptom.',
                },
            ],
            additionalBeforeInstances: [],
            additionalRemainingInstances: [],
            pageIntegrity: 'intact',
            observedDamage: [],
        };
        const { vision, chat } = makeSequencedFinalProvider(inventoryOutput, [
            {
                ...commonFinalOutput,
                symptom: 'resolved',
                afterInventoryReconciliation: [
                    {
                        observationIndex: 1,
                        disposition: 'not_same_symptom',
                        rationale:
                            'This is a minor gap elsewhere; the primary large gap disappeared.',
                    },
                ],
                rationale: 'The primary banner gap disappeared.',
            },
            {
                ...commonFinalOutput,
                symptom: 'not_resolved',
                afterInventoryReconciliation: [
                    {
                        observationIndex: 1,
                        disposition: 'remaining',
                        rationale:
                            'The gap repeats the visual symptom despite its different landmark.',
                    },
                ],
                rationale: 'A repeated instance of the reporter-defined gap remains.',
            },
        ]);
        try {
            const options = makeOptions(root, vision, recorder);
            options.reporterSymptom = 'A large empty advertising gap interrupts page content.';

            const result = await reviewCandidateVisually(options);

            expect(result.review.verdict).toBe('rejected');
            expect(result.review.remainingInstances).toEqual([
                expect.objectContaining({ artifactId: 'after-tile-1' }),
            ]);
            expect(chat).toHaveBeenCalledTimes(8);
            const auditPrompt = JSON.stringify(chat.mock.calls.at(-1)![0].messages);
            expect(auditPrompt).toMatch(/semantic self-critique.*AFTER.*not_same_symptom/is);
            expect(auditPrompt).toMatch(/strong image-grounded.*visually distinct/is);
            expect(auditPrompt).toMatch(/same symptom.*anywhere.*remaining/is);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('retries only final text synthesis after schema-invalid JSON', async () => {
        const root = mkdtempSync(join(tmpdir(), 'candidate-visual-review-json-retry-'));
        const recorder = new TraceRecorder({ runId: 'visual-review', issueNumber: 3, mode: 'fix' });
        const { vision, chat } = makeSequencedFinalProvider(sequencedInventoryOutput(), [
            'not JSON',
            resolvedFinalOutput(),
        ]);
        try {
            const result = await reviewCandidateVisually(makeOptions(root, vision, recorder));

            expect(result.review.verdict).toBe('verified');
            expect(chat).toHaveBeenCalledTimes(8);
            const imageCounts = chat.mock.calls.map(([call]) => imagePartCount(call));
            expect(imageCounts).toEqual([1, 1, 1, 1, 1, 1, 0, 0]);
            const retryPrompt = JSON.stringify(chat.mock.calls.at(-1)![0].messages);
            expect(retryPrompt).toContain('response did not contain a JSON object');
            expect(retryPrompt).toContain('BEFORE observationIndex range is exactly 1..1');
            expect(retryPrompt).toContain('AFTER reconciliation must be an empty array');
            expect(retryPrompt).not.toContain('"role":"assistant","content":"not JSON"');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('repairs final inventory reconciliation without recomputing image inventories', async () => {
        const root = mkdtempSync(join(tmpdir(), 'candidate-visual-review-index-retry-'));
        const recorder = new TraceRecorder({ runId: 'visual-review', issueNumber: 3, mode: 'fix' });
        const invalidReconciliation = resolvedFinalOutput({
            beforeInventoryReconciliation: [
                {
                    observationIndex: 7,
                    disposition: 'same_symptom',
                    rationale: 'This index does not exist in the supplied inventory.',
                },
            ],
        });
        const { vision, chat } = makeSequencedFinalProvider(sequencedInventoryOutput(), [
            invalidReconciliation,
            resolvedFinalOutput(),
        ]);
        try {
            const result = await reviewCandidateVisually(makeOptions(root, vision, recorder));

            expect(result.review.verdict).toBe('verified');
            expect(chat).toHaveBeenCalledTimes(8);
            const imageCounts = chat.mock.calls.map(([call]) => imagePartCount(call));
            expect(imageCounts).toEqual([1, 1, 1, 1, 1, 1, 0, 0]);
            const retryPrompt = JSON.stringify(chat.mock.calls.at(-1)![0].messages);
            expect(retryPrompt).toContain('unknown=7');
            expect(retryPrompt).toContain('BEFORE observationIndex range is exactly 1..1');
            expect(retryPrompt).toContain('AFTER reconciliation must be an empty array');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('becomes inconclusive only after three invalid final synthesis attempts', async () => {
        const root = mkdtempSync(join(tmpdir(), 'candidate-visual-review-retry-exhausted-'));
        const recorder = new TraceRecorder({ runId: 'visual-review', issueNumber: 3, mode: 'fix' });
        const oversizedUntrustedResponse = `not-json-${'x'.repeat(100_000)}`;
        const { vision, chat } = makeSequencedFinalProvider(sequencedInventoryOutput(), [
            oversizedUntrustedResponse,
        ]);
        try {
            const result = await reviewCandidateVisually(makeOptions(root, vision, recorder));

            expect(result.review.verdict).toBe('inconclusive');
            expect(result.review.rationale).toContain('failed after 3 attempts');
            expect(chat).toHaveBeenCalledTimes(9);
            const finalCalls = chat.mock.calls.filter(([options]) => imagePartCount(options) === 0);
            expect(finalCalls).toHaveLength(3);
            const retryEvents = recorder.toJSON().events.filter((event) => event.type === 'retry');
            expect(retryEvents).toHaveLength(2);
            expect(retryEvents.map((event) => event.payload.attempt)).toEqual([1, 2]);
            const synthesisAttemptEvents = recorder
                .toJSON()
                .events.filter(
                    (event) =>
                        event.type === 'llm_request' && event.payload.phase === 'final_synthesis',
                );
            expect(synthesisAttemptEvents.map((event) => event.payload.attempt)).toEqual([1, 2, 3]);
            const serializedTrace = JSON.stringify(recorder.toJSON());
            expect(serializedTrace.length).toBeLessThan(50_000);
            expect(serializedTrace).not.toContain('x'.repeat(100));
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('does not retry a schema-valid semantic unclear response', async () => {
        const root = mkdtempSync(join(tmpdir(), 'candidate-visual-review-unclear-'));
        const recorder = new TraceRecorder({ runId: 'visual-review', issueNumber: 3, mode: 'fix' });
        const { vision, chat } = makeSequencedFinalProvider(sequencedInventoryOutput(), [
            resolvedFinalOutput({
                symptom: 'unclear',
                coverageComplete: false,
                pageIntegrity: 'unclear',
                rationale: 'The supplied observations are not sufficient for a semantic verdict.',
            }),
            resolvedFinalOutput(),
        ]);
        try {
            const result = await reviewCandidateVisually(makeOptions(root, vision, recorder));

            expect(result.review.verdict).toBe('inconclusive');
            expect(result.review.symptom).toBe('unclear');
            expect(chat).toHaveBeenCalledTimes(7);
            expect(recorder.toJSON().events.filter((event) => event.type === 'retry')).toEqual([]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('persists a typed inconclusive review when the model fails', async () => {
        const root = mkdtempSync(join(tmpdir(), 'candidate-visual-review-failure-'));
        const recorder = new TraceRecorder({ runId: 'visual-review', issueNumber: 3, mode: 'fix' });
        const { vision } = makeProvider(new Error('vision provider unavailable'));
        try {
            const result = await reviewCandidateVisually(makeOptions(root, vision, recorder));
            const persisted = JSON.parse(readFileSync(result.artifactPath, 'utf8'));

            expect(result.review).toMatchObject({
                verdict: 'inconclusive',
                symptom: 'unclear',
                coverageComplete: false,
                beforeInstances: [],
                remainingInstances: [],
                pageIntegrity: 'unclear',
                observedDamage: [],
            });
            expect(result.review.rationale).toContain('vision provider unavailable');
            expect(result.review.rationale).not.toMatch(/rejected/u);
            expect(persisted).toEqual(result.review);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('names a provider rejection of the screenshots as a rejection', async () => {
        // An HTTP 400 for the image itself is refused identically on every retry; the review must
        // say the provider rejected the request rather than read like an outage.
        const root = mkdtempSync(join(tmpdir(), 'candidate-visual-review-rejected-'));
        const recorder = new TraceRecorder({ runId: 'visual-review', issueNumber: 3, mode: 'fix' });
        const { vision } = makeProvider(
            new Error(
                '400: {"message":"messages.0.content.2.image.source.base64.data: At least one ' +
                    'of the image dimensions exceed max allowed size: 8000 pixels"}',
            ),
        );
        try {
            const result = await reviewCandidateVisually(makeOptions(root, vision, recorder));

            expect(result.review.verdict).toBe('inconclusive');
            expect(result.review.rationale).toMatch(/rejected/u);
            expect(result.review.rationale).toContain('8000 pixels');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('never sends more than three original-resolution tiles in one request', async () => {
        const root = mkdtempSync(join(tmpdir(), 'candidate-visual-review-batches-'));
        const recorder = new TraceRecorder({ runId: 'visual-review', issueNumber: 3, mode: 'fix' });
        const { vision, chat } = makeProvider({
            symptom: 'resolved',
            symptomScope: 'All repeated advertising banner leftovers.',
            coverageComplete: true,
            beforeInstances: [
                {
                    artifactId: 'before-tile-1',
                    landmark: 'Below the ticker.',
                    description: 'An empty banner slot.',
                },
            ],
            remainingInstances: [],
            pageIntegrity: 'intact',
            rationale: 'Every tile was inspected and the repeated symptom disappeared.',
            observedDamage: [],
        });
        try {
            const options = makeOptions(root, vision, recorder);
            const makeTile = (state: 'before' | 'after', index: number) => {
                const tile = {
                    id: `${state}-tile-${index + 1}`,
                    path: join(root, `${state}-tile-${index + 1}.png`),
                    index,
                    x: 0,
                    y: index * 920,
                    width: 1_920,
                    height: 1_080,
                    landmark: `${state} landmark ${index + 1}`,
                };
                writeFileSync(tile.path, Buffer.from(`png:${tile.id}`));
                return tile;
            };
            options.evidence.beforeTiles = Array.from({ length: 7 }, (_, index) =>
                makeTile('before', index),
            );
            options.evidence.afterTiles = Array.from({ length: 5 }, (_, index) =>
                makeTile('after', index),
            );

            const result = await reviewCandidateVisually(options);

            expect(result.review.verdict).toBe('verified');
            const imageCounts = chat.mock.calls.map(([call]) => imagePartCount(call));
            expect(imageCounts).toEqual([3, 3, 1, 3, 2, 1, 1, 1, 1, 0]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('never combines multi-megabyte full-page overviews in one provider request', async () => {
        const root = mkdtempSync(join(tmpdir(), 'candidate-visual-review-large-overviews-'));
        const recorder = new TraceRecorder({ runId: 'visual-review', issueNumber: 3, mode: 'fix' });
        const { vision, chat } = makeProvider({
            symptom: 'resolved',
            symptomScope: 'The repeated top-of-page advertising gap.',
            coverageComplete: true,
            beforeInstances: [
                {
                    artifactId: 'before-tile-1',
                    landmark: 'Above the article list.',
                    description: 'A large empty advertising region.',
                },
            ],
            remainingInstances: [],
            pageIntegrity: 'intact',
            rationale: 'The repeated gap disappeared and the page remains intact.',
            observedDamage: [],
        });
        try {
            const options = makeOptions(root, vision, recorder);
            writeFileSync(options.evidence.beforeFullPage.path, Buffer.alloc(5 * 1024 * 1024));
            writeFileSync(options.evidence.afterFullPage.path, Buffer.alloc(5 * 1024 * 1024));

            const result = await reviewCandidateVisually(options);

            expect(result.review.verdict).toBe('verified');
            const callsWithFullPage = chat.mock.calls.filter(([call]) => {
                const prompt = JSON.stringify(call.messages);
                return prompt.includes('FULL PAGE') && imagePartCount(call) > 0;
            });
            expect(callsWithFullPage).toHaveLength(2);
            for (const [call] of callsWithFullPage) {
                expect(imagePartCount(call)).toBe(1);
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('splits tile batches when their encoded request would exceed the byte budget', async () => {
        const root = mkdtempSync(join(tmpdir(), 'candidate-visual-review-byte-batches-'));
        const recorder = new TraceRecorder({ runId: 'visual-review', issueNumber: 3, mode: 'fix' });
        const { vision, chat } = makeProvider({
            symptom: 'resolved',
            symptomScope: 'The repeated advertising gap.',
            coverageComplete: true,
            beforeInstances: [
                {
                    artifactId: 'before-tile-1',
                    landmark: 'Top of page.',
                    description: 'An empty advertising region.',
                },
            ],
            remainingInstances: [],
            pageIntegrity: 'intact',
            rationale: 'The advertising gap disappeared.',
            observedDamage: [],
        });
        try {
            const options = makeOptions(root, vision, recorder);
            options.evidence.beforeTiles = Array.from({ length: 2 }, (_, index) => {
                const tile = {
                    id: `before-tile-${index + 1}`,
                    path: join(root, `before-tile-${index + 1}.png`),
                    index,
                    x: 0,
                    y: index * 920,
                    width: 1_920,
                    height: 1_080,
                    landmark: `Before landmark ${index + 1}`,
                };
                writeFileSync(tile.path, Buffer.alloc(4 * 1024 * 1024));
                return tile;
            });

            const result = await reviewCandidateVisually(options);

            expect(result.review.verdict).toBe('verified');
            const beforeTileCalls = chat.mock.calls.filter(([call]) => {
                const serialized = JSON.stringify(call.messages);
                return (
                    serialized.includes('Page state: BEFORE') &&
                    serialized.includes('Inventory source: TILE_BATCH') &&
                    imagePartCount(call) > 0
                );
            });
            expect(beforeTileCalls).toHaveLength(2);
            expect(beforeTileCalls.map(([call]) => imagePartCount(call))).toEqual([1, 1]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('omits oversized full-page overviews when complete original-resolution tiles exist', async () => {
        const root = mkdtempSync(join(tmpdir(), 'candidate-visual-review-oversized-overview-'));
        const recorder = new TraceRecorder({ runId: 'visual-review', issueNumber: 3, mode: 'fix' });
        const { vision, chat } = makeProvider({
            symptom: 'resolved',
            symptomScope: 'The repeated advertising gap.',
            coverageComplete: true,
            beforeInstances: [
                {
                    artifactId: 'before-tile-1',
                    landmark: 'Above the article list.',
                    description: 'A large empty advertising region.',
                },
            ],
            remainingInstances: [],
            pageIntegrity: 'intact',
            rationale: 'The gap disappeared and every original-resolution tile was inspected.',
            observedDamage: [],
        });
        try {
            const options = makeOptions(root, vision, recorder);
            const originalBytes = 7 * 1024 * 1024;
            writeFileSync(options.evidence.beforeFullPage.path, Buffer.alloc(originalBytes, 1));
            writeFileSync(options.evidence.afterFullPage.path, Buffer.alloc(originalBytes, 2));
            const beforeDigest = createHash('sha256')
                .update(readFileSync(options.evidence.beforeFullPage.path))
                .digest('hex');
            const afterDigest = createHash('sha256')
                .update(readFileSync(options.evidence.afterFullPage.path))
                .digest('hex');

            const result = await reviewCandidateVisually(options);

            expect(result.review.verdict).toBe('verified');
            expect(result.review.beforeFullPageArtifactId).toBe('before-full-page');
            expect(result.review.afterFullPageArtifactId).toBe('after-full-page');
            expect(result.review.fullPageOverviewEvidence).toEqual({
                before: {
                    mode: 'omitted_complete_tiles',
                    originalArtifactId: 'before-full-page',
                    originalBytes,
                    visionArtifactId: null,
                    visionBytes: null,
                    reason: expect.stringContaining('complete original-resolution tiles'),
                },
                after: {
                    mode: 'omitted_complete_tiles',
                    originalArtifactId: 'after-full-page',
                    originalBytes,
                    visionArtifactId: null,
                    visionBytes: null,
                    reason: expect.stringContaining('complete original-resolution tiles'),
                },
            });
            expect(
                createHash('sha256')
                    .update(readFileSync(options.evidence.beforeFullPage.path))
                    .digest('hex'),
            ).toBe(beforeDigest);
            expect(
                createHash('sha256')
                    .update(readFileSync(options.evidence.afterFullPage.path))
                    .digest('hex'),
            ).toBe(afterDigest);
            const calls = JSON.stringify(chat.mock.calls);
            expect(calls).not.toContain('artifact=before-full-page');
            expect(calls).not.toContain('artifact=after-full-page');
            expect(calls).toContain('artifact=before-tile-1');
            expect(calls).toContain('artifact=after-tile-1');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('fails closed before sending an individually oversized original-resolution tile', async () => {
        const root = mkdtempSync(join(tmpdir(), 'candidate-visual-review-oversized-tile-'));
        const recorder = new TraceRecorder({ runId: 'visual-review', issueNumber: 3, mode: 'fix' });
        const { vision, chat } = makeProvider({
            symptom: 'resolved',
            symptomScope: 'The repeated advertising gap.',
            coverageComplete: true,
            beforeInstances: [],
            remainingInstances: [],
            pageIntegrity: 'intact',
            rationale: 'The page appears intact.',
            observedDamage: [],
        });
        try {
            const options = makeOptions(root, vision, recorder);
            writeFileSync(options.evidence.beforeTiles[0]!.path, Buffer.alloc(7 * 1024 * 1024));

            const result = await reviewCandidateVisually(options);

            expect(result.review.verdict).toBe('inconclusive');
            expect(result.review.rationale).toContain('per-image byte budget');
            expect(JSON.stringify(chat.mock.calls)).not.toContain('before-tile-1');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('reviews the tile window when the full-page overview is too tall to read', async () => {
        // A live nottinghampost.com run: the 375x10334 px mobile overview was sent as one image,
        // arrived about 74 px wide, and the model reported ten "remaining blank reserved
        // ad-slot bands" quoted from the symptom text while the viewport and every tile of the same
        // state showed them gone. Withholding that image must not block the review either — it
        // protected nothing, and blocking would make every long page unverifiable.
        const root = mkdtempSync(join(tmpdir(), 'candidate-visual-review-tall-overview-'));
        const recorder = new TraceRecorder({ runId: 'visual-review', issueNumber: 3, mode: 'fix' });
        const { vision, chat } = makeProvider({
            symptom: 'resolved',
            symptomScope: 'The reserved advertising bands above the section header.',
            coverageComplete: true,
            beforeInstances: [
                {
                    artifactId: 'before-tile-1',
                    landmark: 'Above the NEWS / SPORT section header.',
                    description: 'A blank reserved advertising band.',
                },
            ],
            remainingInstances: [],
            pageIntegrity: 'intact',
            rationale: 'Every reserved band is gone across the inspected window.',
            observedDamage: [],
        });
        try {
            const options = makeOptions(root, vision, recorder);
            // The scripted provider answers in call order, so the review must not run its
            // completions side by side.
            options.visionConcurrency = 1;
            options.evidence.beforeDocument = { width: 375, height: 10_334 };
            options.evidence.afterDocument = { width: 375, height: 10_334 };
            // A window-bounded capture proves its own window and never the whole document: this
            // omission must not need the complete-document proof the oversized one does.
            options.evidence.beforeDocumentCoverageComplete = false;
            options.evidence.afterDocumentCoverageComplete = false;
            for (const state of ['before', 'after'] as const) {
                const tiles = Array.from({ length: 5 }, (_, index) => {
                    const tile = {
                        id: `${state}-tile-${index + 1}`,
                        path: join(root, `${state}-tile-${index + 1}.png`),
                        index,
                        x: 0,
                        y: index * 812,
                        width: 375,
                        height: 812,
                        landmark: `Screen ${index + 1} of the reported page.`,
                    };
                    writeFileSync(tile.path, Buffer.from(`png:${tile.id}`));
                    return tile;
                });
                if (state === 'before') {
                    options.evidence.beforeTiles = tiles;
                } else {
                    options.evidence.afterTiles = tiles;
                }
            }

            const result = await reviewCandidateVisually(options);

            expect(result.review.verdict).toBe('verified');
            expect(result.review.fullPageOverviewEvidence?.before.mode).toBe('omitted_illegible');
            expect(result.review.fullPageOverviewEvidence?.after.mode).toBe('omitted_illegible');
            expect(result.review.fullPageOverviewEvidence?.after.reason).toContain('375x10334 px');
            expect(result.review.fullPageOverviewEvidence?.after.reason).toContain(
                'y=0 to y=4060 of 10334 px',
            );
            const calls = JSON.stringify(chat.mock.calls);
            expect(calls).not.toContain('artifact=before-full-page');
            expect(calls).not.toContain('artifact=after-full-page');
            expect(calls).toContain('artifact=after-tile-1');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('fails closed for an oversized full-page overview without complete tiles', async () => {
        const root = mkdtempSync(join(tmpdir(), 'candidate-visual-review-uncovered-overview-'));
        const recorder = new TraceRecorder({ runId: 'visual-review', issueNumber: 3, mode: 'fix' });
        const { vision, chat } = makeProvider({
            symptom: 'resolved',
            symptomScope: 'The repeated advertising gap.',
            coverageComplete: true,
            beforeInstances: [],
            remainingInstances: [],
            pageIntegrity: 'intact',
            rationale: 'The page appears intact.',
            observedDamage: [],
        });
        try {
            const options = makeOptions(root, vision, recorder);
            options.evidence.beforeCoverageComplete = false;
            writeFileSync(options.evidence.beforeFullPage.path, Buffer.alloc(7 * 1024 * 1024));

            const result = await reviewCandidateVisually(options);

            expect(result.review.verdict).toBe('inconclusive');
            expect(result.review.rationale).toContain(
                'complete original-resolution tiles are unavailable',
            );
            expect(result.review.fullPageOverviewEvidence?.before.mode).toBe(
                'blocked_oversized_incomplete_tiles',
            );
            expect(JSON.stringify(chat.mock.calls)).not.toContain('artifact=before-full-page');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('names the page state whose inventory exceeds the reconciliation limit', async () => {
        // Both aligned states are reconciled through the same merge, so a limit diagnostic that
        // does not name the state leaves an operator reading a failed-closed review unable to tell
        // which document produced the observations.
        const root = mkdtempSync(join(tmpdir(), 'candidate-visual-review-overflow-'));
        const recorder = new TraceRecorder({ runId: 'visual-review', issueNumber: 3, mode: 'fix' });
        const afterTileIds = Array.from(
            { length: OVERFLOWING_AFTER_TILE_COUNT },
            (_, index) => `after-tile-${index + 1}`,
        );
        // Every after tile reports the same handful of residual slots. Spread over this many
        // tiles that is more than one state's reconciliation limit accepts, while each bounded
        // batch stays within the per-request instance cap. The before state stays empty, so only
        // the after merge can overflow.
        const remainingInstances = afterTileIds.flatMap((artifactId) =>
            Array.from({ length: INSTANCES_PER_OVERFLOWING_TILE }, (_, index) => ({
                artifactId,
                landmark: `Advertising slot ${index + 1}.`,
                description: `A residual advertising slot ${index + 1} on ${artifactId}.`,
            })),
        );
        const { vision } = makeProvider({
            symptom: 'remaining',
            symptomScope: 'The repeated advertising slots.',
            coverageComplete: true,
            beforeInstances: [],
            remainingInstances,
            pageIntegrity: 'intact',
            rationale: 'The advertising slots are still present.',
            observedDamage: [],
        });
        try {
            const options = makeOptions(root, vision, recorder);
            options.evidence.afterTiles = afterTileIds.map((id, index) => {
                const tile = {
                    id,
                    path: join(root, `${id}.png`),
                    index,
                    x: 0,
                    y: index * 920,
                    width: 1_920,
                    height: 1_080,
                    landmark: `After landmark ${index + 1}`,
                };
                writeFileSync(tile.path, Buffer.from(`png:${tile.id}`));
                return tile;
            });

            const result = await reviewCandidateVisually(options);

            expect(result.review.verdict).toBe('inconclusive');
            expect(result.review.rationale).toContain(
                `Vision after inventory contains ${remainingInstances.length} observations`,
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('binds schema-owned model output to runner fields and registers the trusted artifact', async () => {
        const root = mkdtempSync(join(tmpdir(), 'candidate-visual-review-binding-'));
        const recorder = new TraceRecorder({ runId: 'visual-review', issueNumber: 3, mode: 'fix' });
        const { vision } = makeProvider({
            symptom: 'resolved',
            symptomScope: 'The reported overlay across the movie list.',
            coverageComplete: true,
            beforeInstances: [
                {
                    artifactId: 'before-tile-1',
                    landmark: 'Top of the movie list.',
                    description: 'The overlay obscures the list.',
                },
            ],
            remainingInstances: [],
            pageIntegrity: 'intact',
            rationale: 'The reported defect is gone without visible collateral damage.',
            observedDamage: [],
        });
        try {
            const options = makeOptions(root, vision, recorder);
            const executionSuffix = 'f'.repeat(16);
            options.validationArtifactId += `-execution-${executionSuffix}`;
            options.artifactIdentitySuffix = executionSuffix;
            const result = await reviewCandidateVisually(options);

            expect(result.review.verdict).toBe('verified');
            expect(result.review.validationArtifactId).toBe(options.validationArtifactId);
            expect(result.review.candidateRuleHash).toBe(CANDIDATE_HASH);
            expect(result.review.beforeViewportArtifactId).toBe('before-viewport');
            expect(result.artifactId).toBe(
                `visual-review-${CANDIDATE_HASH.slice(0, 12)}-execution-${executionSuffix}`,
            );
            expect(result.artifactPath).toBe(
                join(
                    root,
                    `candidate-visual-review-${CANDIDATE_HASH.slice(0, 12)}` +
                        `-execution-${executionSuffix}.json`,
                ),
            );
            expect(recorder.getArtifacts()).toContainEqual({
                id: result.artifactId,
                path: result.artifactPath,
                type: 'candidate-visual-review',
                bytes: Buffer.byteLength(readFileSync(result.artifactPath, 'utf8')),
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('rejects a narrow candidate when vision reports a residual instance elsewhere', async () => {
        const root = mkdtempSync(join(tmpdir(), 'candidate-visual-review-residual-'));
        const recorder = new TraceRecorder({ runId: 'visual-review', issueNumber: 3, mode: 'fix' });
        const { vision } = makeProvider({
            symptom: 'resolved',
            symptomScope: 'All repeated advertising banner leftovers.',
            coverageComplete: true,
            beforeInstances: [
                {
                    artifactId: 'before-tile-1',
                    landmark: 'Below the ticker.',
                    description: 'An empty banner slot.',
                },
            ],
            remainingInstances: [
                {
                    artifactId: 'after-tile-1',
                    landmark: 'Before the NAJNOWSZE heading.',
                    description: 'Another empty banner remains visible.',
                },
            ],
            pageIntegrity: 'intact',
            rationale: 'The narrow selector removed one banner but a repeated instance remains.',
            observedDamage: [],
        });
        try {
            const result = await reviewCandidateVisually(makeOptions(root, vision, recorder));

            expect(result.review.verdict).toBe('rejected');
            expect(result.review.remainingInstances).toHaveLength(1);
            expect(result.review.inventoryReconciliation?.after).toEqual([
                expect.objectContaining({
                    observationIndex: 1,
                    disposition: 'remaining',
                    instance: expect.objectContaining({ artifactId: 'after-tile-1' }),
                }),
            ]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('rejects a candidate that misses a reporter-named location it never touched', async () => {
        const root = mkdtempSync(join(tmpdir(), 'candidate-visual-review-reporter-scope-'));
        const recorder = new TraceRecorder({ runId: 'visual-review', issueNumber: 1, mode: 'fix' });
        const { vision, chat } = makeProvider({
            symptom: 'resolved',
            symptomScope: 'The advertising units named in the report.',
            coverageComplete: true,
            beforeInstances: [
                {
                    artifactId: 'before-tile-1',
                    landmark: HEADER_LANDMARK,
                    description: 'A blue SerpApi banner spans the width of the page.',
                },
            ],
            remainingInstances: [
                {
                    artifactId: 'after-tile-1',
                    landmark: HEADER_LANDMARK,
                    description: 'The blue SerpApi banner is still there.',
                },
            ],
            pageIntegrity: 'intact',
            rationale: 'The three units the selector names are gone; the header banner is not.',
            observedDamage: [],
        });
        try {
            const result = await reviewCandidateVisually({
                ...makeOptions(root, vision, recorder),
                reporterSymptom: composeReporterSymptomScope({
                    reportedProblem: SITEPOINT_REPORT,
                    candidateTarget: SITEPOINT_CANDIDATE_TARGET,
                }),
                visionConcurrency: 1,
            });

            // What each request actually carried is the contract: the reporter's four locations,
            // ahead of the three this one candidate covers. Handed the candidate's description
            // alone, no pass looked at the header and the review came back verified.
            for (const call of chat.mock.calls) {
                const messages = JSON.stringify(call[0].messages);
                expect(messages).toContain(SITEPOINT_REPORT);
                expect(messages.indexOf(SITEPOINT_REPORT)).toBeLessThan(
                    messages.indexOf(SITEPOINT_CANDIDATE_TARGET),
                );
            }
            expect(result.review.verdict).toBe('rejected');
            expect(result.review.remainingInstances).toEqual([
                expect.objectContaining({ landmark: HEADER_LANDMARK }),
            ]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('fails closed when final vision cites an after artifact as a before instance', async () => {
        const root = mkdtempSync(join(tmpdir(), 'candidate-visual-review-state-binding-'));
        const recorder = new TraceRecorder({ runId: 'visual-review', issueNumber: 3, mode: 'fix' });
        const { vision } = makeProvider({
            symptom: 'resolved',
            symptomScope: 'All repeated advertising banner leftovers.',
            coverageComplete: true,
            beforeInstances: [
                {
                    artifactId: 'before-tile-1',
                    landmark: 'Below the ticker.',
                    description: 'An empty banner slot.',
                },
            ],
            remainingInstances: [],
            additionalBeforeInstances: [
                {
                    artifactId: 'after-tile-1',
                    landmark: 'Below the ticker.',
                    description: 'An invalid cross-phase additional observation.',
                },
            ],
            pageIntegrity: 'intact',
            rationale: 'The candidate removed the visible defect.',
            observedDamage: [],
        });
        try {
            const result = await reviewCandidateVisually(makeOptions(root, vision, recorder));

            expect(result.review.verdict).toBe('inconclusive');
            expect(result.review.rationale).toContain('non-before evidence artifact');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('does not expose unrelated runner artifact IDs as citable visual evidence', async () => {
        const root = mkdtempSync(join(tmpdir(), 'candidate-visual-review-context-binding-'));
        const recorder = new TraceRecorder({ runId: 'visual-review', issueNumber: 3, mode: 'fix' });
        const unrelatedArtifactId = '15789663-bad1-4a6a-a6e1-90d64dbfa47d';
        const unrelatedArtifactPath = join(root, `${unrelatedArtifactId}.png`);
        writeFileSync(unrelatedArtifactPath, Buffer.from('unrelated pre-candidate tile'));
        recorder.addArtifact({
            id: unrelatedArtifactId,
            path: unrelatedArtifactPath,
            type: 'screenshot-tile',
            bytes: Buffer.byteLength('unrelated pre-candidate tile'),
        });
        const chat = vi.fn(async (options: { messages: SingleShotMessage[] }) => {
            const prompt = JSON.stringify(options.messages);
            const isBeforeInventory = prompt.includes('Page state: BEFORE');
            const isAfterInventory = prompt.includes('Page state: AFTER');
            const isTileBatch = prompt.includes('Inventory source: TILE_BATCH');
            const value = isBeforeInventory
                ? {
                      coverageObserved: true,
                      symptomScope: 'All repeated advertising banner leftovers.',
                      instances: isTileBatch
                          ? [
                                {
                                    artifactId: 'before-tile-1',
                                    landmark: 'Below the ticker.',
                                    description: 'An empty advertising banner slot.',
                                },
                            ]
                          : [],
                      observedDamage: [],
                      rationale: 'The complete before tile batch was inventoried.',
                  }
                : isAfterInventory
                  ? {
                        coverageObserved: true,
                        symptomScope: 'All repeated advertising banner leftovers.',
                        instances: prompt.includes(unrelatedArtifactId)
                            ? [
                                  {
                                      artifactId: unrelatedArtifactId,
                                      landmark: 'Copied from untrusted context.',
                                      description: 'An unrelated artifact reference.',
                                  },
                              ]
                            : [],
                        observedDamage: [],
                        rationale: 'The complete after tile batch was inventoried.',
                    }
                  : {
                        symptom: 'resolved',
                        symptomScope: 'All repeated advertising banner leftovers.',
                        adLayoutResidue: 'absent',
                        coverageComplete: true,
                        beforeInventoryReconciliation: [
                            {
                                observationIndex: 1,
                                disposition: 'same_symptom',
                                rationale: 'This is the reporter-defined banner leftover.',
                            },
                        ],
                        afterInventoryReconciliation: [],
                        additionalBeforeInstances: [],
                        additionalRemainingInstances: [],
                        pageIntegrity: 'intact',
                        rationale: 'The repeated symptom disappeared without page damage.',
                        observedDamage: [],
                    };
            return {
                kind: SingleShotResultKind.Parsed,
                value,
                usages: [],
                attempts: 1,
                model: 'vision-stub',
            };
        });
        const vision = clientWith(chat);
        try {
            const options = makeOptions(root, vision, recorder);
            options.reporterSymptom =
                `Pre-candidate full-page inventory: [${unrelatedArtifactId}] ` +
                'An empty advertising banner slot.';

            const result = await reviewCandidateVisually(options);

            expect(result.review.verdict).toBe('verified');
            expect(chat.mock.calls).toHaveLength(7);
            expect(JSON.stringify(chat.mock.calls)).not.toContain(unrelatedArtifactId);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('accepts final references to any processed tile from the matching page state', async () => {
        const root = mkdtempSync(join(tmpdir(), 'candidate-visual-review-cross-batch-'));
        const recorder = new TraceRecorder({ runId: 'visual-review', issueNumber: 3, mode: 'fix' });
        const { vision } = makeProvider({
            symptom: 'resolved',
            symptomScope: 'All repeated advertising banner leftovers.',
            coverageComplete: true,
            beforeInstances: [
                {
                    artifactId: 'before-tile-4',
                    landmark: 'Below the latest-news heading.',
                    description: 'A repeated advertising banner slot.',
                },
            ],
            remainingInstances: [],
            pageIntegrity: 'intact',
            rationale: 'Every processed tile was reconciled and the symptom disappeared.',
            observedDamage: [],
        });
        try {
            const options = makeOptions(root, vision, recorder);
            for (const state of ['before', 'after'] as const) {
                options.evidence[`${state}Tiles`] = Array.from({ length: 4 }, (_, index) => {
                    const tile = {
                        id: `${state}-tile-${index + 1}`,
                        path: join(root, `${state}-tile-${index + 1}.png`),
                        index,
                        x: 0,
                        y: index * 920,
                        width: 1_920,
                        height: 1_080,
                        landmark: `${state} landmark ${index + 1}`,
                    };
                    writeFileSync(tile.path, Buffer.from(`png:${tile.id}`));
                    return tile;
                });
            }

            const result = await reviewCandidateVisually(options);

            expect(result.review.verdict).toBe('verified');
            expect(result.review.beforeInstances).toContainEqual(
                expect.objectContaining({ artifactId: 'before-tile-4' }),
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('fails closed when a tile batch cites evidence from the opposite page state', async () => {
        const root = mkdtempSync(join(tmpdir(), 'candidate-visual-review-batch-state-'));
        const recorder = new TraceRecorder({ runId: 'visual-review', issueNumber: 3, mode: 'fix' });
        const chat = vi.fn(async (options: { messages: SingleShotMessage[] }) => {
            const prompt = JSON.stringify(options.messages);
            const isBeforeInventory = prompt.includes('Page state: BEFORE');
            const isAfterInventory = prompt.includes('Page state: AFTER');
            const isTileBatch = prompt.includes('Inventory source: TILE_BATCH');
            const value = isBeforeInventory
                ? {
                      coverageObserved: true,
                      symptomScope: 'All repeated advertising banner leftovers.',
                      instances: [],
                      observedDamage: [],
                      rationale: 'The before tile was inventoried.',
                  }
                : isAfterInventory
                  ? {
                        coverageObserved: true,
                        symptomScope: 'All repeated advertising banner leftovers.',
                        instances: isTileBatch
                            ? [
                                  {
                                      artifactId: 'before-tile-1',
                                      landmark: 'Wrong page state.',
                                      description: 'A phase-mismatched reference.',
                                  },
                              ]
                            : [],
                        observedDamage: [],
                        rationale: 'The after tile was inventoried.',
                    }
                  : {
                        symptom: 'resolved',
                        symptomScope: 'All repeated advertising banner leftovers.',
                        coverageComplete: true,
                        beforeInventoryReconciliation: [],
                        afterInventoryReconciliation: [],
                        additionalBeforeInstances: [],
                        additionalRemainingInstances: [],
                        pageIntegrity: 'intact',
                        rationale: 'The symptom disappeared.',
                        observedDamage: [],
                    };
            return {
                kind: SingleShotResultKind.Parsed,
                value,
                usages: [],
                attempts: 1,
                model: 'vision-stub',
            };
        });
        const vision = clientWith(chat);
        try {
            const result = await reviewCandidateVisually(makeOptions(root, vision, recorder));

            expect(result.review.verdict).toBe('inconclusive');
            expect(result.review.rationale).toContain('outside its tile batch');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('is inconclusive when runner capture coverage is incomplete even if vision says complete', async () => {
        const root = mkdtempSync(join(tmpdir(), 'candidate-visual-review-coverage-'));
        const recorder = new TraceRecorder({ runId: 'visual-review', issueNumber: 3, mode: 'fix' });
        const { vision } = makeProvider({
            symptom: 'resolved',
            symptomScope: 'All repeated advertising banner leftovers.',
            coverageComplete: true,
            beforeInstances: [
                {
                    artifactId: 'before-tile-1',
                    landmark: 'Below the ticker.',
                    description: 'An empty banner slot.',
                },
            ],
            remainingInstances: [],
            pageIntegrity: 'intact',
            rationale: 'Every supplied tile is clear.',
            observedDamage: [],
        });
        try {
            const options = makeOptions(root, vision, recorder);
            options.evidence.afterCoverageComplete = false;
            const result = await reviewCandidateVisually(options);

            expect(result.review.verdict).toBe('inconclusive');
            expect(result.review.coverageComplete).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('is inconclusive when one separately observed full-page overview is unreadable', async () => {
        const root = mkdtempSync(join(tmpdir(), 'candidate-visual-review-overview-coverage-'));
        const recorder = new TraceRecorder({ runId: 'visual-review', issueNumber: 3, mode: 'fix' });
        const { vision } = makeProvider({
            symptom: 'resolved',
            symptomScope: 'All repeated advertising banner leftovers.',
            coverageComplete: true,
            beforeInstances: [
                {
                    artifactId: 'before-tile-1',
                    landmark: 'Below the ticker.',
                    description: 'An empty banner slot.',
                },
            ],
            remainingInstances: [],
            pageIntegrity: 'intact',
            rationale: 'Every supplied observation is clear.',
            observedDamage: [],
            unreadableArtifactId: 'after-full-page',
        });
        try {
            const result = await reviewCandidateVisually(makeOptions(root, vision, recorder));

            expect(result.review.verdict).toBe('inconclusive');
            expect(result.review.coverageComplete).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('fails closed when final vision omits an after tile observation', async () => {
        const root = mkdtempSync(join(tmpdir(), 'candidate-visual-review-omitted-after-'));
        const recorder = new TraceRecorder({ runId: 'visual-review', issueNumber: 3, mode: 'fix' });
        const { vision } = makeProvider({
            symptom: 'resolved',
            symptomScope: 'All repeated advertising banner leftovers.',
            coverageComplete: true,
            beforeInstances: [
                {
                    artifactId: 'before-tile-1',
                    landmark: 'Below the ticker.',
                    description: 'An empty advertising banner slot.',
                },
            ],
            remainingInstances: [
                {
                    artifactId: 'after-tile-1',
                    landmark: 'Right sidebar gutter.',
                    description: 'A large blank region needing semantic reconciliation.',
                },
            ],
            afterInventoryReconciliation: [],
            pageIntegrity: 'intact',
            rationale: 'The page overview appears intact.',
            observedDamage: [],
        });
        try {
            const result = await reviewCandidateVisually(makeOptions(root, vision, recorder));

            expect(result.review.verdict).toBe('inconclusive');
            expect(result.review.coverageComplete).toBe(false);
            expect(result.review.rationale).toContain('after tile observation');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('allows vision to explicitly dismiss normal after whitespace with an audit trail', async () => {
        const root = mkdtempSync(join(tmpdir(), 'candidate-visual-review-dismissed-after-'));
        const recorder = new TraceRecorder({ runId: 'visual-review', issueNumber: 3, mode: 'fix' });
        const { vision } = makeProvider({
            symptom: 'resolved',
            symptomScope: 'All repeated advertising banner leftovers.',
            coverageComplete: true,
            beforeInstances: [
                {
                    artifactId: 'before-tile-1',
                    landmark: 'Between article cards.',
                    description: 'A reporter-related empty advertising banner slot.',
                },
            ],
            remainingInstances: [
                {
                    artifactId: 'after-tile-1',
                    landmark: 'Right sidebar gutter.',
                    description: 'A normal empty gutter beside the article column.',
                },
            ],
            afterInventoryReconciliation: [
                {
                    observationIndex: 1,
                    disposition: 'not_same_symptom',
                    rationale: 'This is the normal sidebar gutter, not an advertising slot.',
                },
            ],
            pageIntegrity: 'intact',
            rationale: 'The actual advertising leftovers disappeared and the page remains intact.',
            observedDamage: [],
        });
        try {
            const result = await reviewCandidateVisually(makeOptions(root, vision, recorder));

            expect(result.review.verdict).toBe('verified');
            expect(result.review.remainingInstances).toEqual([]);
            expect(result.review.inventoryReconciliation?.after).toEqual([
                expect.objectContaining({
                    observationIndex: 1,
                    disposition: 'not_same_symptom',
                    rationale: expect.stringContaining('normal sidebar gutter'),
                    instance: expect.objectContaining({ artifactId: 'after-tile-1' }),
                }),
            ]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('rejects a nebule-like candidate when vision reports residual ad layout', async () => {
        const root = mkdtempSync(join(tmpdir(), 'candidate-visual-review-ad-layout-residue-'));
        const recorder = new TraceRecorder({ runId: 'visual-review', issueNumber: 3, mode: 'fix' });
        const { vision } = makeSequencedFinalProvider(sequencedInventoryOutput(), [
            resolvedFinalOutput({
                adLayoutResidue: 'present',
                rationale:
                    'The creatives disappeared, but four empty outer ad wrappers remain visible.',
            }),
        ]);
        try {
            const result = await reviewCandidateVisually(makeOptions(root, vision, recorder));

            expect(result.review).toMatchObject({
                verdict: 'rejected',
                symptom: 'resolved',
                adLayoutResidue: 'present',
                remainingInstances: [],
                pageIntegrity: 'intact',
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('retains every reconciled before tile observation in the final review', async () => {
        const root = mkdtempSync(join(tmpdir(), 'candidate-visual-review-before-retained-'));
        const recorder = new TraceRecorder({ runId: 'visual-review', issueNumber: 3, mode: 'fix' });
        const { vision } = makeProvider({
            symptom: 'resolved',
            symptomScope: 'All repeated advertising banner leftovers.',
            coverageComplete: true,
            beforeInstances: [
                {
                    artifactId: 'before-tile-1',
                    landmark: 'Below the ticker.',
                    description: 'The first empty advertising banner slot.',
                },
                {
                    artifactId: 'before-tile-4',
                    landmark: 'Above the latest-news heading.',
                    description: 'The second empty advertising banner slot.',
                },
            ],
            remainingInstances: [],
            pageIntegrity: 'intact',
            rationale: 'Both repeated before instances disappeared.',
            observedDamage: [],
        });
        try {
            const options = makeOptions(root, vision, recorder);
            options.evidence.beforeTiles = Array.from({ length: 4 }, (_, index) => {
                const tile = {
                    id: `before-tile-${index + 1}`,
                    path: join(root, `before-tile-${index + 1}.png`),
                    index,
                    x: 0,
                    y: index * 920,
                    width: 1_920,
                    height: 1_080,
                    landmark: `Before landmark ${index + 1}`,
                };
                writeFileSync(tile.path, Buffer.from(`png:${tile.id}`));
                return tile;
            });
            const result = await reviewCandidateVisually(options);

            expect(result.review.verdict).toBe('verified');
            expect(result.review.beforeInstances).toHaveLength(2);
            expect(result.review.inventoryReconciliation?.before).toHaveLength(2);
            expect(result.review.beforeInstances.map((instance) => instance.artifactId)).toEqual([
                'before-tile-1',
                'before-tile-4',
            ]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it.each([
        {
            label: 'duplicate',
            dispositions: [
                {
                    observationIndex: 1,
                    disposition: 'remaining',
                    rationale: 'First disposition.',
                },
                {
                    observationIndex: 1,
                    disposition: 'not_same_symptom',
                    rationale: 'Conflicting duplicate disposition.',
                },
            ],
        },
        {
            label: 'unknown',
            dispositions: [
                {
                    observationIndex: 2,
                    disposition: 'remaining',
                    rationale: 'This index does not exist.',
                },
            ],
        },
        {
            label: 'invalid',
            dispositions: [
                {
                    observationIndex: 1,
                    disposition: 'ignore',
                    rationale: 'This disposition is not allowed.',
                },
            ],
        },
    ])('fails closed for $label after-inventory dispositions', async ({ dispositions }) => {
        const root = mkdtempSync(join(tmpdir(), 'candidate-visual-review-invalid-disposition-'));
        const recorder = new TraceRecorder({ runId: 'visual-review', issueNumber: 3, mode: 'fix' });
        const { vision } = makeProvider({
            symptom: 'resolved',
            symptomScope: 'All repeated advertising banner leftovers.',
            coverageComplete: true,
            beforeInstances: [
                {
                    artifactId: 'before-tile-1',
                    landmark: 'Below the ticker.',
                    description: 'An advertising banner slot.',
                },
            ],
            remainingInstances: [
                {
                    artifactId: 'after-tile-1',
                    landmark: 'Right sidebar gutter.',
                    description: 'An observation requiring reconciliation.',
                },
            ],
            afterInventoryReconciliation: dispositions,
            pageIntegrity: 'intact',
            rationale: 'The overview appears intact.',
            observedDamage: [],
        });
        try {
            const result = await reviewCandidateVisually(makeOptions(root, vision, recorder));

            expect(result.review.verdict).toBe('inconclusive');
            expect(result.review.coverageComplete).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('verifies a third-party network block the reviewer could not call intact', async () => {
        const root = mkdtempSync(join(tmpdir(), 'candidate-visual-third-party-'));
        const recorder = new TraceRecorder({ runId: 'visual-review', issueNumber: 3, mode: 'fix' });
        const { vision } = makeProvider({
            symptom: 'resolved',
            symptomScope: 'Every injected advertising banner on the lyrics page.',
            coverageComplete: true,
            beforeInstances: [
                {
                    artifactId: 'before-tile-1',
                    landmark: 'Above the lyrics body.',
                    description: 'An injected advertising banner.',
                },
            ],
            remainingInstances: [],
            // What the reviewer reports for every network candidate whose first-party functions
            // images cannot exercise.
            pageIntegrity: 'unclear',
            rationale: 'The banners are gone; images cannot prove first-party functions work.',
            observedDamage: [],
        });
        try {
            const result = await reviewCandidateVisually({
                ...makeOptions(root, vision, recorder),
                candidateRule: THIRD_PARTY_NETWORK_RULE,
                validationArtifactId: `validation-${THIRD_PARTY_NETWORK_RULE_HASH.slice(0, 12)}`,
                reportedPageUrl: REPORTED_PAGE_URL,
            });

            expect(result.review).toMatchObject({
                verdict: 'verified',
                pageIntegrity: 'unclear',
                candidateNetworkScope: 'third_party_host_block',
                integrityBasis: 'third_party_network_clean_before_after',
            });
            // The persisted artifact carries the same basis a maintainer reads in the report.
            expect(JSON.parse(readFileSync(result.artifactPath, 'utf8'))).toMatchObject({
                verdict: 'verified',
                integrityBasis: 'third_party_network_clean_before_after',
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('leaves an unclear cosmetic candidate inconclusive on the same reported page', async () => {
        const root = mkdtempSync(join(tmpdir(), 'candidate-visual-cosmetic-unclear-'));
        const recorder = new TraceRecorder({ runId: 'visual-review', issueNumber: 3, mode: 'fix' });
        const { vision } = makeProvider({
            symptom: 'resolved',
            symptomScope: 'Every injected advertising banner on the lyrics page.',
            coverageComplete: true,
            beforeInstances: [
                {
                    artifactId: 'before-tile-1',
                    landmark: 'Above the lyrics body.',
                    description: 'An injected advertising banner.',
                },
            ],
            remainingInstances: [],
            pageIntegrity: 'unclear',
            rationale: 'The banners are gone but the page state could not be compared.',
            observedDamage: [],
        });
        try {
            const result = await reviewCandidateVisually({
                ...makeOptions(root, vision, recorder),
                reportedPageUrl: REPORTED_PAGE_URL,
            });

            expect(result.review.verdict).toBe('inconclusive');
            expect(result.review.candidateNetworkScope).toBe('not_applicable');
            expect(result.review.integrityBasis).toBeUndefined();
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

/**
 * Valid scripted inventory reply for a batch without instances.
 *
 * @param rationale - Batch rationale text.
 * @returns The serialized batch reply.
 */
function hermeticInventoryJson(rationale: string): string {
    return JSON.stringify({
        coverageObserved: true,
        symptomScope: 'All repeated anti-adblock overlays on the movie listing.',
        instances: [],
        observedDamage: [],
        rationale,
    });
}

/**
 * Valid scripted before-tile reply carrying one verified instance.
 *
 * @returns The serialized before-tile reply.
 */
function hermeticBeforeTileJson(): string {
    return JSON.stringify({
        coverageObserved: true,
        symptomScope: 'All repeated anti-adblock overlays on the movie listing.',
        instances: [
            {
                artifactId: 'before-tile-1',
                landmark: 'Top of the movie list.',
                description: 'The anti-adblock overlay covers the movie list.',
            },
        ],
        observedDamage: [],
        rationale: 'The before tile batch was inventoried.',
    });
}

/**
 * Valid scripted final-synthesis reply reconciling the before instance.
 *
 * @returns The serialized final reply.
 */
function hermeticFinalJson(): string {
    return JSON.stringify({
        symptom: 'resolved',
        symptomScope: 'All repeated anti-adblock overlays on the movie listing.',
        adLayoutResidue: 'absent',
        coverageComplete: true,
        beforeInventoryReconciliation: [
            {
                observationIndex: 1,
                disposition: 'same_symptom',
                rationale: 'The anti-adblock overlay is the reporter-defined defect.',
            },
        ],
        afterInventoryReconciliation: [],
        additionalBeforeInstances: [],
        additionalRemainingInstances: [],
        pageIntegrity: 'intact',
        rationale: 'The overlay disappeared and the underlying page remains intact.',
        observedDamage: [],
    });
}

describe('reviewCandidateVisually on the single-shot client', () => {
    function validScript(): ScriptedReply[] {
        return [
            { kind: ScriptedReplyKind.Text, text: hermeticBeforeTileJson() },
            {
                kind: ScriptedReplyKind.Text,
                text: hermeticInventoryJson('After tiles inventoried.'),
            },
            {
                kind: ScriptedReplyKind.Text,
                text: hermeticInventoryJson('Before viewport inventoried.'),
            },
            {
                kind: ScriptedReplyKind.Text,
                text: hermeticInventoryJson('Before full page inventoried.'),
            },
            {
                kind: ScriptedReplyKind.Text,
                text: hermeticInventoryJson('After viewport inventoried.'),
            },
            {
                kind: ScriptedReplyKind.Text,
                text: hermeticInventoryJson('After full page inventoried.'),
            },
            { kind: ScriptedReplyKind.Text, text: hermeticFinalJson() },
        ];
    }

    it('reviews a candidate through the bound client with image parts on every inventory request', async () => {
        provider = await startHermeticProvider({
            scenario: HermeticScenario.Scripted,
            script: validScript(),
        });
        const root = mkdtempSync(join(tmpdir(), 'candidate-visual-hermetic-'));
        const recorder = new TraceRecorder({ runId: 'visual-review', issueNumber: 3, mode: 'fix' });
        try {
            const result = await reviewCandidateVisually({
                ...makeOptions(root, await createTestVisionClient(provider.baseUrl), recorder),
                visionConcurrency: 1,
            });

            expect(provider.requests).toHaveLength(7);
            for (const request of provider.requests.slice(0, 6)) {
                expect(request.model).toBe(VISION_MODEL);
                expect(JSON.stringify(request.messages)).toContain('image_url');
                expect(JSON.stringify(request.messages)).toContain('data:image/png;base64,');
            }
            expect(JSON.stringify(provider.requests[6]!.messages)).not.toContain('image_url');
            expect(result.review).toMatchObject({
                verdict: 'verified',
                symptom: 'resolved',
                coverageComplete: true,
            });
            expect(result.artifactId).toContain('visual-review-');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('runs exactly one repair before the first inventory batch parses', async () => {
        provider = await startHermeticProvider({
            scenario: HermeticScenario.Scripted,
            script: [
                { kind: ScriptedReplyKind.Text, text: 'not json at all' },
                { kind: ScriptedReplyKind.Text, text: hermeticBeforeTileJson() },
                {
                    kind: ScriptedReplyKind.Text,
                    text: hermeticInventoryJson('After tiles inventoried.'),
                },
                {
                    kind: ScriptedReplyKind.Text,
                    text: hermeticInventoryJson('Before viewport inventoried.'),
                },
                {
                    kind: ScriptedReplyKind.Text,
                    text: hermeticInventoryJson('Before full page inventoried.'),
                },
                {
                    kind: ScriptedReplyKind.Text,
                    text: hermeticInventoryJson('After viewport inventoried.'),
                },
                {
                    kind: ScriptedReplyKind.Text,
                    text: hermeticInventoryJson('After full page inventoried.'),
                },
                { kind: ScriptedReplyKind.Text, text: hermeticFinalJson() },
            ],
        });
        const root = mkdtempSync(join(tmpdir(), 'candidate-visual-hermetic-repair-'));
        const recorder = new TraceRecorder({ runId: 'visual-review', issueNumber: 3, mode: 'fix' });
        try {
            const result = await reviewCandidateVisually({
                ...makeOptions(root, await createTestVisionClient(provider.baseUrl), recorder),
                visionConcurrency: 1,
            });

            expect(provider.requests).toHaveLength(8);
            const repair = provider.requests[1]!;
            expect(repair.messages.map((message) => message.role)).toEqual([
                'system',
                'user',
                'user',
                'assistant',
                'user',
            ]);
            expect(result.review.verdict).toBe('verified');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('reviewCandidateVisually on a page too tall for one full-page overview', () => {
    // money.pl and pb.pl: Chromium refused the full-page capture of a page about 17,500 px tall,
    // and an overview past the vision byte cap is no more readable. The tile window of the same
    // states carries the proof either way, so the review reaches its verdict on it.
    const DOCUMENT = { width: 1_920, height: 17_811 };

    it.each([
        { overview: 'not captured', mode: FullPageOverviewMode.UnavailableIllegible },
        { overview: 'over the vision byte cap', mode: FullPageOverviewMode.OmittedIllegible },
    ])(
        'verifies from the tile window when the overview is $overview',
        async ({ overview, mode }) => {
            const root = mkdtempSync(join(tmpdir(), 'candidate-visual-review-no-overview-'));
            const recorder = new TraceRecorder({
                runId: 'visual-review',
                issueNumber: 3,
                mode: 'fix',
            });
            const { vision, chat } = makeProvider({
                symptom: 'resolved',
                symptomScope: 'The empty advertising placeholder below the first article row.',
                coverageComplete: true,
                beforeInstances: [
                    {
                        artifactId: 'before-tile-1',
                        landmark: 'Below the first article row.',
                        description: 'An empty advertising placeholder.',
                    },
                ],
                remainingInstances: [],
                pageIntegrity: 'intact',
                rationale: 'The placeholder is gone across the inspected window.',
                observedDamage: [],
            });
            try {
                const options: CandidateVisualVerifierOptions = makeOptions(root, vision, recorder);
                // The scripted provider answers in call order, so the review must not run its
                // completions side by side.
                options.visionConcurrency = 1;
                options.evidence.beforeDocument = DOCUMENT;
                options.evidence.afterDocument = DOCUMENT;
                options.evidence.beforeDocumentCoverageComplete = false;
                options.evidence.afterDocumentCoverageComplete = false;
                if (overview === 'not captured') {
                    delete options.evidence.beforeFullPage;
                    delete options.evidence.afterFullPage;
                } else {
                    writeFileSync(
                        join(root, 'before-full-page.png'),
                        Buffer.alloc(7 * 1024 * 1024),
                    );
                    writeFileSync(join(root, 'after-full-page.png'), Buffer.alloc(7 * 1024 * 1024));
                }

                const result = await reviewCandidateVisually(options);

                expect(result.review.verdict).toBe('verified');
                expect(result.review.fullPageOverviewEvidence?.before.mode).toBe(mode);
                expect(result.review.fullPageOverviewEvidence?.after.mode).toBe(mode);
                const calls = JSON.stringify(chat.mock.calls);
                expect(calls).not.toContain('artifact=before-full-page');
                expect(calls).not.toContain('artifact=after-full-page');
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        },
    );
});
