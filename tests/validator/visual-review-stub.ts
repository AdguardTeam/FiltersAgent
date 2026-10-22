/**
 * A stubbed vision model and a two-state fixture for reviews that exercise the settlement of the
 * AFTER inventory: the stub inventories what a script lists and synthesizes like the model the
 * benchmark caught.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TraceRecorder } from '../../src/tracer/trace-recorder';
import { reviewCandidateVisually } from '../../src/validator/candidate-visual-verifier';
import type { CandidateVisualReview } from '../../src/types/candidate-visual-review';
import type { TraceEvent } from '../../src/types/trace';
import { CaptureState } from '../../src/types/validation';
import type {
    CandidateVisualEvidenceImage,
    CandidateVisualVerifierOptions,
} from '../../src/validator/candidate-visual-evidence';
import { SingleShotResultKind, type SingleShotClient } from '../../src/pi/single-shot-types';
import type { SingleShotImage, SingleShotMessage } from '../../src/pi/single-shot-input';
import type { DomCheckRecord } from '../../src/types/dom-check';
import { encodePng } from '../pi/fixtures/png-image';
import type { CandidateVisualInstanceFootprint } from '../../src/types/candidate-visual-instance';
import type { DomCheckFinding } from '../../src/validator/candidate-visual-dom-adjudication';

/**
 * Tile height of the fixture: two tiles per state stack without overlap, so the content of an AFTER
 * tile can sit only in the BEFORE tile at the same height.
 */
export const TILE_HEIGHT = 1_080;

const CANDIDATE_RULE = 'example.org##.ad-slot';

/**
 * Size of an image that one request may carry, but never beside another of the same size: under the
 * per-image cap, over half the bytes one request may carry.
 */
const LARGE_IMAGE_BYTES = 3_500_000;

/**
 * One observation an inventory stub reports.
 */
export interface StubInstance {
    /**
     * Image the observation cites, and whose request reports it.
     */
    artifactId: string;

    /**
     * Where on the page the observation is.
     */
    landmark: string;

    /**
     * What the observation shows.
     */
    description: string;

    /**
     * Whether it is only blank space.
     */
    footprint: CandidateVisualInstanceFootprint;

    /**
     * Image whose request reports the observation, when it is not the one the observation cites.
     */
    reportedOn?: string;
}

/**
 * One flaw an inventory stub reports.
 */
export interface StubDamage {
    /**
     * Image the flaw cites.
     */
    artifactId: string;

    /**
     * The flaw and its landmark.
     */
    description: string;

    /**
     * Image whose request reports the flaw, when it is not the one the flaw cites.
     */
    reportedOn?: string;
}

/**
 * What an attribution stub answers for one item, or nothing to leave it open.
 */
interface StubAttribution {
    /**
     * BEFORE image the answer cites as showing the item unchanged.
     */
    comparisonArtifactId: string;

    /**
     * BEFORE observation of the symptom the answer places the item at, if any.
     */
    comparisonObservationIndex?: number;
}

/**
 * What an adjudication stub answers for every observation it is asked about.
 */
interface StubAdjudication {
    /**
     * What the cited check says about the space.
     */
    finding: DomCheckFinding;

    /**
     * The cited check, one-based.
     */
    domCheckIndex: number | null;

    /**
     * The holder the answer names.
     */
    holder: string | null;
}

/**
 * How the stubbed vision model behaves in one review.
 */
export interface StubScript {
    /**
     * Observations the inventory passes report, each on the image it cites.
     */
    instances: StubInstance[];

    /**
     * Flaws the inventory passes report.
     */
    damage: StubDamage[];

    /**
     * The attribution answer for one item, given its text and the whole request.
     */
    attribute?: (itemText: string, requestText: string) => StubAttribution | undefined;

    /**
     * The adjudication answer for every observation.
     */
    adjudicate?: StubAdjudication;

    /**
     * Whether the synthesis reports the page regressed whatever it is shown.
     */
    alwaysRegressed?: boolean;

    /**
     * Whether the synthesis reports residue whatever it is shown.
     */
    alwaysResidue?: boolean;

    /**
     * Content the synthesis names as gone after the candidate.
     */
    missingContent?: string[];
}

/**
 * Parsed shape of the inventory line of a synthesis request, as far as the stub reads it.
 */
interface SynthesisInventory {
    /**
     * The BEFORE state.
     */
    before: SynthesisState;

    /**
     * The AFTER state.
     */
    after: SynthesisState;
}

/**
 * One state of the synthesis inventory line.
 */
interface SynthesisState {
    /**
     * Its numbered observations.
     */
    instances: unknown[];

    /**
     * Its inventory requests.
     */
    observations: SynthesisRequestRecord[];
}

/**
 * One inventory request of a state, as far as the stub reads it.
 */
interface SynthesisRequestRecord {
    /**
     * The flaws the request still lists.
     */
    observedDamage: unknown[];
}

/**
 * One structured call the review makes, as far as the stub reads it.
 */
interface StubRequest {
    /**
     * The call's messages.
     */
    messages: SingleShotMessage[];
}

/**
 * A value for each page state.
 */
interface StatePair<T> {
    /**
     * The value for the page before the candidate.
     */
    before: T;

    /**
     * The value for the page after the candidate.
     */
    after: T;
}

/**
 * What one review left behind.
 */
interface ReviewOutcome {
    /**
     * The persisted review.
     */
    review: CandidateVisualReview;

    /**
     * The trace events the review recorded.
     */
    events: TraceEvent[];

    /**
     * Messages of every structured call the review made, in call order.
     */
    requests: SingleShotMessage[][];
}

/**
 * One image a request carried, with the text of the message that carried it.
 */
export interface SentImage {
    /**
     * Text of the message the image was sent in.
     */
    text: string;

    /**
     * The image as sent: a file path, or bytes from memory.
     */
    image: SingleShotImage;
}

/**
 * Every image one request carried, in order.
 *
 * @param messages - The request.
 * @returns Each image with the text of its message.
 */
export function sentImages(messages: readonly SingleShotMessage[]): SentImage[] {
    return messages.flatMap((message) =>
        'images' in message
            ? message.images.map((image) => ({ text: message.text ?? '', image }))
            : [],
    );
}

/**
 * The joined text of every message of one request.
 *
 * @param messages - The request messages.
 * @returns Their text.
 */
function requestText(messages: SingleShotMessage[]): string {
    return messages.map((message) => message.text).join('\n');
}

/**
 * A parsed reply.
 *
 * @param value - The reply value.
 * @returns The single-shot result.
 */
function parsed(value: unknown): unknown {
    return { kind: SingleShotResultKind.Parsed, value, usages: [], attempts: 1, model: 'stub' };
}

/**
 * A vision model that inventories what the script lists and synthesizes like the model the
 * benchmark caught: every AFTER observation it is shown stays remaining and counts as residue, and
 * every AFTER flaw it is shown regresses the page.
 *
 * @param script - What the stub reports and answers.
 * @param requests - Collects the messages of every structured call.
 * @returns The client.
 */
function stubVision(script: StubScript, requests: SingleShotMessage[][]): SingleShotClient {
    const structured = async (options: StubRequest): Promise<unknown> => {
        requests.push(options.messages);
        const text = requestText(options.messages);
        const hasImages = options.messages.some((message) => 'images' in message);
        if (text.includes('ITEM artifact=')) {
            const items = [...text.matchAll(/^Item (\d+) \([a-z_]+\): (.*)$/gmu)];
            return parsed({
                items: items.flatMap(([, index, itemText]) => {
                    const answer = script.attribute?.(itemText ?? '', text);
                    return answer === undefined
                        ? []
                        : [
                              {
                                  itemIndex: Number(index),
                                  visibleInComparison: true,
                                  comparisonArtifactId: answer.comparisonArtifactId,
                                  comparisonObservationIndex:
                                      answer.comparisonObservationIndex ?? null,
                                  rationale: 'The comparison image shows it the same.',
                              },
                          ];
                }),
            });
        }
        if (hasImages) {
            const labelled = new Set(
                [...text.matchAll(/artifact=([^;.\s]+)/gu)].map((match) => match[1]),
            );
            return parsed({
                coverageObserved: true,
                symptomScope: 'Empty advertising slots between sections.',
                instances: script.instances
                    .filter((item) => labelled.has(item.reportedOn ?? item.artifactId))
                    .map(({ reportedOn: _reportedOn, ...instance }) => instance),
                observedDamage: script.damage
                    .filter((item) => labelled.has(item.reportedOn ?? item.artifactId))
                    .map(({ artifactId, description }) => ({ artifactId, description })),
                rationale: 'Every supplied image was inventoried.',
            });
        }
        if (text.includes('Agent DOM checks were measured')) {
            const observations = [...text.matchAll(/^Observation (\d+): /gmu)];
            return parsed({
                observations: observations.map(([, index]) => ({
                    observationIndex: Number(index),
                    ...(script.adjudicate ?? {
                        finding: 'unbound',
                        domCheckIndex: null,
                        holder: null,
                    }),
                    rationale: 'Read from the supplied checks.',
                })),
            });
        }
        const inventoryLine = text.split('\n').find((line) => line.startsWith('{"before"'));
        const inventory = JSON.parse(inventoryLine ?? '{}') as SynthesisInventory;
        const after = inventory.after.instances.length;
        const afterDamage = inventory.after.observations.reduce(
            (count, observation) => count + observation.observedDamage.length,
            0,
        );
        return parsed({
            symptom: after > 0 ? 'not_resolved' : 'resolved',
            symptomScope: 'Empty advertising slots between sections.',
            adLayoutResidue: script.alwaysResidue || after > 0 ? 'present' : 'absent',
            coverageComplete: true,
            beforeInventoryReconciliation: inventory.before.instances.map((_, index) => ({
                observationIndex: index + 1,
                disposition: 'same_symptom',
                rationale: 'The reporter-defined advertising slot.',
            })),
            afterInventoryReconciliation: inventory.after.instances.map((_, index) => ({
                observationIndex: index + 1,
                disposition: 'remaining',
                rationale: 'Blank space consistent with a reserved ad slot.',
            })),
            additionalBeforeInstances: [],
            additionalRemainingInstances: [],
            pageIntegrity: script.alwaysRegressed || afterDamage > 0 ? 'regressed' : 'intact',
            rationale: 'Reconciled the supplied inventory.',
            observedDamage: afterDamage > 0 ? ['A flaw the AFTER inventory lists.'] : [],
            ...(script.missingContent === undefined
                ? {}
                : { missingContent: script.missingContent }),
        });
    };
    return {
        modelId: 'vision-stub',
        structured: structured as never,
        text: async () => {
            throw new Error('not used by this suite');
        },
    };
}

/**
 * What one review's fixture carries beyond the default: two stacked tiles per state.
 */
interface ReviewFixture {
    /**
     * DOM checks the agent attached.
     */
    domChecks?: DomCheckRecord[];

    /**
     * Images written at {@link LARGE_IMAGE_BYTES}.
     */
    largeImages?: readonly string[];

    /**
     * Top of every tile of each state, when the tiles do not stack at {@link TILE_HEIGHT}.
     */
    tileTops?: StatePair<number[]>;

    /**
     * Document height of each state, when the capture measured one.
     */
    documentHeights?: StatePair<number>;

    /**
     * Whether the browser captured a full-page overview of each state.
     */
    overviews?: boolean;

    /**
     * Whether each state carries a tile window map, as a page too tall for its overview does.
     */
    tileWindowMaps?: boolean;

    /**
     * Height the tile window maps were cut to, when shorter than the two stacked tiles.
     */
    tileWindowMapHeight?: number;
}

/**
 * Review options over the fixture's tiles, the BEFORE page carrying one advertising slot.
 *
 * @param root - Directory the fixture images are written to.
 * @param vision - The stubbed vision model.
 * @param fixture - What the fixture carries beyond the default.
 * @returns The options.
 */
function makeOptions(
    root: string,
    vision: SingleShotClient,
    fixture: ReviewFixture,
): CandidateVisualVerifierOptions {
    const largeImages = fixture.largeImages ?? [];
    const image = (id: string): CandidateVisualEvidenceImage => {
        const path = join(root, `${id}.png`);
        const png = encodePng(4, 4, () => [255, 255, 255]);
        writeFileSync(
            path,
            largeImages.includes(id)
                ? Buffer.concat([png, Buffer.alloc(LARGE_IMAGE_BYTES - png.length)])
                : png,
        );
        return { id, path };
    };
    const tiles = (
        state: CaptureState,
    ): CandidateVisualVerifierOptions['evidence']['beforeTiles'] =>
        (fixture.tileTops?.[state] ?? [0, TILE_HEIGHT]).map((y, index) => ({
            ...image(`${state}-tile-${index + 1}`),
            index,
            x: 0,
            y,
            width: 1_920,
            height: TILE_HEIGHT,
            landmark: `${state} tile ${index + 1}`,
        }));
    const heights = fixture.documentHeights;
    const tileWindowMap = (state: CaptureState) => ({
        ...image(`${state}-tile-window-map`),
        y: 0,
        height: fixture.tileWindowMapHeight ?? TILE_HEIGHT * 2,
    });
    return {
        candidateRule: CANDIDATE_RULE,
        validationArtifactId: 'validation-0123456789ab',
        evidence: {
            beforeViewport: image('before-viewport'),
            afterViewport: image('after-viewport'),
            beforeTiles: tiles(CaptureState.Before),
            afterTiles: tiles(CaptureState.After),
            beforeCoverageComplete: true,
            afterCoverageComplete: true,
            beforeDocumentCoverageComplete: true,
            afterDocumentCoverageComplete: true,
            beforeWindowTrimmed: false,
            afterWindowTrimmed: false,
            ...(heights === undefined
                ? {}
                : {
                      beforeDocument: { width: 1_920, height: heights.before },
                      afterDocument: { width: 1_920, height: heights.after },
                  }),
            ...(fixture.overviews === true
                ? {
                      beforeFullPage: image('before-full-page'),
                      afterFullPage: image('after-full-page'),
                  }
                : {}),
            ...(fixture.tileWindowMaps === true
                ? {
                      beforeTileWindowMap: tileWindowMap(CaptureState.Before),
                      afterTileWindowMap: tileWindowMap(CaptureState.After),
                  }
                : {}),
        },
        reporterSymptom: 'Empty advertising slots between the sections of the home page.',
        artifactsDir: root,
        vision,
        recorder: new TraceRecorder({ runId: 'settlement', issueNumber: 1, mode: 'fix' }),
        ...(fixture.domChecks === undefined ? {} : { domChecks: fixture.domChecks }),
    };
}

/**
 * Run one review over a fresh fixture with the stubbed vision model.
 *
 * @param script - How the stubbed vision model behaves.
 * @param fixture - What the fixture carries beyond the default.
 * @returns The persisted review and the trace events the review recorded.
 */
export async function reviewWith(
    script: StubScript,
    fixture: ReviewFixture = {},
): Promise<ReviewOutcome> {
    const root = mkdtempSync(join(tmpdir(), 'candidate-visual-settlement-'));
    try {
        const requests: SingleShotMessage[][] = [];
        const vision = stubVision(script, requests);
        const options = makeOptions(root, vision, fixture);
        const { review } = await reviewCandidateVisually(options);
        return { review, events: options.recorder.toJSON().events, requests };
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}
