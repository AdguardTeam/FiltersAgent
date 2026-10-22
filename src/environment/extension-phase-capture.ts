/**
 * Assembly of one observed Extension phase: the artifacts it owns, the capture projected from them,
 * and, for the baseline phases only, the single-image inventory that says whether the symptom is
 * reproduced.
 *
 * The candidate phase is assembled without an inventory: the paired before/after review judges it,
 * and `candidate-phase-checks.ts` completes its capture from that review. Split from
 * `browser-extension-ads-observer.ts`, which runs the phases and owns the fixture seams these reads
 * go through.
 */
import type { inspectFullPageVisualCapture } from '../analyzer/full-page-capture-inspection';
import type { NetworkRequestEntry } from '../browser/browser-interfaces';
import type { TraceRecorder } from '../tracer/trace-recorder';
import { CandidateVisualVerdict } from '../types/candidate-visual-review';
import { ReporterSymptomPresence } from '../types/reporter-symptom-presence';
import { PhaseLabel, type PhaseResult, type StructuralSnapshot } from '../types/validation';
import { environmentArtifact, phaseScreenshotIds } from './extension-phase-records';
import type {
    EnvironmentArtifactReference,
    EnvironmentBrowserCapture,
    EnvironmentVisionReference,
} from './filtering-environment';

/**
 * Complete phase material retained until phase C can bind before/after evidence.
 */
export interface ObservedExtensionPhase {
    /**
     * Browser facts and artifact identities emitted by the shared phase runner.
     */
    result: PhaseResult;

    /**
     * Trusted structural snapshot for the candidate target.
     */
    structure: StructuralSnapshot;

    /**
     * Whether the probe measured a selector derived from the candidate rather than the whole
     * document. A network candidate names no element, so its probe falls back to `body`, whose
     * presence proves nothing about the content the reporter lost.
     */
    structureBoundToSelector: boolean;

    /**
     * Semantic presence of the reporter-defined symptom; undecided in phase C until its review.
     */
    symptomPresence: ReporterSymptomPresence;

    /**
     * The single-image inventory's record, which decides phases A and B on its own; null in phase
     * C, which the paired review decides.
     */
    inventoryVision: EnvironmentVisionReference | null;

    /**
     * Canonical screenshot/HAR/DOM/vision references owned by this phase.
     */
    artifacts: EnvironmentArtifactReference[];

    /**
     * The phase's recorded requests, read back from its HAR artifact when the candidate is a host
     * block the runner judges by them; empty otherwise.
     */
    network: NetworkRequestEntry[];

    /**
     * Compatibility capture projected from the canonical phase.
     */
    capture: EnvironmentBrowserCapture;
}

/**
 * What one Extension phase measured before its assembly.
 */
export interface MeasuredExtensionPhase {
    /**
     * Browser facts and artifact identities emitted by the shared phase runner.
     */
    result: PhaseResult;

    /**
     * Trusted structural snapshot for the candidate target.
     */
    structure: StructuralSnapshot;

    /**
     * Whether the probe measured a selector derived from the candidate.
     */
    structureBoundToSelector: boolean;

    /**
     * What the reveal steps did in this phase, when apply_rule received any.
     */
    interactionArtifact: EnvironmentArtifactReference | undefined;
}

/**
 * The reads an assembly delegates to the observer, which owns their fixture seams.
 */
export interface ExtensionPhaseReads {
    /**
     * Authoritative trace artifact registry.
     */
    recorder: TraceRecorder;

    /**
     * Read the phase's requests back from its HAR artifact; null when no decision reads them.
     */
    readNetworkLog: ((har: EnvironmentArtifactReference) => NetworkRequestEntry[]) | null;

    /**
     * Inspect one baseline phase's capture through the single-image inventory.
     */
    inspectCapture: (
        capture: Parameters<typeof inspectFullPageVisualCapture>[1],
    ) => ReturnType<typeof inspectFullPageVisualCapture>;
}

/**
 * The single-image inventory's reading of one baseline phase.
 */
interface PhaseInventoryReading {
    /**
     * Semantic presence of the reporter-defined symptom.
     */
    symptomPresence: ReporterSymptomPresence;

    /**
     * Whether every overview and tile image was conclusively inspected.
     */
    coverageComplete: boolean;

    /**
     * Persisted inventory artifact, or null for the candidate phase.
     */
    artifact: EnvironmentArtifactReference | null;

    /**
     * The inventory's vision record, or null for the candidate phase.
     */
    vision: EnvironmentVisionReference | null;
}

/**
 * Read the reporter symptom from a baseline phase's capture; the candidate phase is left undecided.
 *
 * @param measured - What the phase measured.
 * @param reads - The observer's inventory and registry seams.
 * @returns The inventory's reading, or an undecided one for phase C.
 */
async function readPhaseInventory(
    measured: MeasuredExtensionPhase,
    reads: ExtensionPhaseReads,
): Promise<PhaseInventoryReading> {
    if (measured.result.phase === PhaseLabel.C) {
        return {
            symptomPresence: ReporterSymptomPresence.Indeterminate,
            coverageComplete: false,
            artifact: null,
            vision: null,
        };
    }
    const visualInventory = await reads.inspectCapture({
        // Omitting the viewport screenshot fails the whole phase observation at the schema, not
        // at the vision call; an overview the browser could not capture is simply absent.
        artifactId: measured.result.screenshotArtifactId,
        fullPageArtifactId: measured.result.fullPageScreenshotArtifactId,
        tileCoverage: measured.result.tileCoverage,
    });
    const artifact = environmentArtifact(reads.recorder, visualInventory.artifactId, 'vision');
    return {
        symptomPresence: visualInventory.inventory.reporterSymptomPresence,
        coverageComplete: visualInventory.coverageComplete,
        artifact,
        vision: {
            artifactId: artifact.artifactId,
            verdict: visualInventory.coverageComplete
                ? CandidateVisualVerdict.Verified
                : CandidateVisualVerdict.Inconclusive,
        },
    };
}

/**
 * Assemble one observed Extension phase from what it measured.
 *
 * @param measured - The phase runner's facts, the structural probe and the reveal-steps artifact.
 * @param reads - The observer's network, inventory and registry seams.
 * @returns The observed phase with its artifacts and compatibility capture.
 */
export async function assembleObservedPhase(
    measured: MeasuredExtensionPhase,
    reads: ExtensionPhaseReads,
): Promise<ObservedExtensionPhase> {
    const result = measured.result;
    const recorder = reads.recorder;
    const inventory = await readPhaseInventory(measured, reads);
    const screenshots = phaseScreenshotIds(result).map((artifactId) =>
        environmentArtifact(recorder, artifactId, 'screenshot'),
    );
    const har = environmentArtifact(recorder, result.harArtifactId, 'har');
    const dom = environmentArtifact(recorder, result.domArtifactId, 'dom');
    const viewport = screenshots.find(
        (artifact) => artifact.artifactId === result.screenshotArtifactId,
    );
    const fullPage = screenshots.find(
        (artifact) => artifact.artifactId === result.fullPageScreenshotArtifactId,
    );
    const tileArtifacts =
        result.tileCoverage?.tiles.map((tile) =>
            environmentArtifact(recorder, tile.artifactId, 'screenshot'),
        ) ?? [];
    return {
        result,
        structure: measured.structure,
        structureBoundToSelector: measured.structureBoundToSelector,
        symptomPresence: inventory.symptomPresence,
        inventoryVision: inventory.vision,
        artifacts: [
            ...screenshots,
            har,
            dom,
            ...(inventory.artifact ? [inventory.artifact] : []),
            ...(measured.interactionArtifact ? [measured.interactionArtifact] : []),
        ],
        network: reads.readNetworkLog?.(har) ?? [],
        capture: {
            visionVerified: inventory.coverageComplete,
            viewportArtifactId: viewport?.artifactId ?? null,
            viewport: viewport?.path ?? null,
            fullPageOverviewArtifactId: fullPage?.artifactId ?? null,
            fullPageOverview: fullPage?.path ?? null,
            tileArtifactIds: tileArtifacts.map((artifact) => artifact.artifactId),
            tiles: tileArtifacts.map((artifact) => artifact.path),
            coverageComplete: inventory.coverageComplete,
            reporterSymptomPresence: inventory.symptomPresence,
        },
    };
}
