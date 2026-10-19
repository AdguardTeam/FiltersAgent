/**
 * The factual records an Extension candidate experiment keeps per phase: the rules the locked
 * engine executed, the artifacts each phase owns, and the persisted factual validation the review
 * binds to.
 *
 * Split from `browser-extension-ads-observer.ts`, which observes the phases and calls these helpers
 * without holding any state they need.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TraceRecorder } from '../tracer/trace-recorder';
import { TraceEventType } from '../types/trace';
import { formatCandidateArtifactExecutionSuffix } from '../types/candidate-artifact-identity';
import type {
    FactualValidationResult,
    PhaseResult,
    RuleApplicationFact,
} from '../types/validation';
import { phaseCapturedPageState } from '../validator/tile-coverage-proof';
import {
    mapCandidateOverviews,
    type CandidateOverviewPair,
} from '../types/candidate-screenshot-paths';
import type { EnvironmentArtifactReference } from './filtering-environment';

/**
 * Build rule-accounting facts for rules executed by the locked Extension engine.
 *
 * @param rules - Exact repository or candidate rules represented by the phase.
 * @returns Applied facts whose engine proof lives in the adapter phase record.
 */
function extensionRuleFacts(rules: readonly string[]): RuleApplicationFact[] {
    return rules.map((rule) => ({ rule, status: 'applied' as const }));
}

/**
 * Replace injection-oriented rule fields with adapter-owned Extension execution facts.
 *
 * @param result - Phase facts captured without browser-side rule injection.
 * @param rules - Rules whose execution is proven by the adapter state.
 * @returns Compatibility phase result for existing candidate consumers.
 */
export function withExtensionRuleFacts(result: PhaseResult, rules: readonly string[]): PhaseResult {
    return {
        ...result,
        appliedRules: [...rules],
        ruleApplications: extensionRuleFacts(rules),
    };
}

/**
 * Resolve one unique trace artifact into the common environment vocabulary.
 *
 * @param recorder - Authoritative trace artifact registry.
 * @param artifactId - Exact artifact identity to resolve.
 * @param kind - Common artifact role.
 * @returns Canonical common artifact reference.
 */
export function environmentArtifact(
    recorder: TraceRecorder,
    artifactId: string,
    kind: EnvironmentArtifactReference['kind'],
): EnvironmentArtifactReference {
    const matches = recorder.getArtifacts().filter((artifact) => artifact.id === artifactId);
    if (matches.length !== 1) {
        throw new Error(`Environment artifact is missing or ambiguous: ${artifactId}`);
    }
    return { artifactId, kind, path: matches[0].path };
}

/**
 * Resolve every screenshot identity carried by one phase without duplicating references.
 *
 * @param result - Phase result carrying viewport, overview, and tile identities.
 * @returns Ordered unique screenshot identities.
 */
export function phaseScreenshotIds(result: PhaseResult): string[] {
    return [
        result.screenshotArtifactId,
        ...(result.fullPageScreenshotArtifactId ? [result.fullPageScreenshotArtifactId] : []),
        ...(result.tileCoverage?.tiles.map((tile) => tile.artifactId) ?? []),
    ].filter(
        (artifactId, index, values) =>
            artifactId.length > 0 && values.indexOf(artifactId) === index,
    );
}

/**
 * Trace phase naming an Extension phase whose capture proved nothing about the page.
 */
const EXTENSION_PHASE_CAPTURE_TRACE_PHASE = 'extension_phase_capture';

/**
 * Decide whether one phase's capture failed to prove its page state, tracing why.
 *
 * A phase error is already traced by the phase runner at its end. A capture without a viewport, or
 * without an overview and without tiles that prove the state alone, cannot be judged; that gap is
 * traced here with what the tile capture covered.
 *
 * @param result - Phase facts the runner captured.
 * @param recorder - Trace recorder of the run.
 * @param phase - Phase the facts belong to.
 * @returns Whether the phase failed to capture a usable page state.
 */
export function phaseCaptureFailed(
    result: PhaseResult,
    recorder: TraceRecorder,
    phase: PhaseResult['phase'],
): boolean {
    if (result.error) {
        return true;
    }
    if (phaseCapturedPageState(result)) {
        return false;
    }
    recorder.record(TraceEventType.Error, {
        phase: EXTENSION_PHASE_CAPTURE_TRACE_PHASE,
        validationPhase: phase,
        error:
            result.screenshotArtifactId.length === 0
                ? 'The phase captured no viewport screenshot.'
                : 'The phase captured no full-page overview, and its tiles do not prove the ' +
                  `page alone: ${describeTileCoverage(result.tileCoverage)}`,
    });
    return true;
}

/**
 * Say what one phase's tile capture covered, for a trace that explains a failed phase.
 *
 * @param coverage - The phase's tile coverage, when it captured tiles.
 * @returns The capture's own error, or the range its tiles covered.
 */
function describeTileCoverage(coverage: PhaseResult['tileCoverage']): string {
    if (!coverage) {
        return 'no tile coverage was recorded.';
    }
    if (coverage.error) {
        return coverage.error;
    }
    const range = coverage.window
        ? `y=${coverage.window.fromY}..${coverage.window.toY}`
        : 'part of the document';
    return (
        `the tiles cover only ${range} of a ` +
        `${coverage.documentWidth}x${coverage.documentHeight} px document.`
    );
}

/**
 * The before/after screenshots a candidate review compares, bound as environment artifacts.
 */
export interface CandidateScreenshotArtifacts extends CandidateOverviewPair<EnvironmentArtifactReference> {
    /**
     * Phase B viewport.
     */
    beforeViewport: EnvironmentArtifactReference;

    /**
     * Phase C viewport.
     */
    afterViewport: EnvironmentArtifactReference;

    /**
     * Every identity above, in before/after viewport then overview order.
     */
    screenshotArtifactIds: string[];
}

/**
 * Bind the phase B and C screenshots a candidate review compares.
 *
 * @param recorder - Authoritative trace artifact registry.
 * @param before - Phase B facts.
 * @param after - Phase C facts.
 * @returns The bound screenshots; an overview the browser never captured stays absent.
 */
export function candidateScreenshotArtifacts(
    recorder: TraceRecorder,
    before: PhaseResult,
    after: PhaseResult,
): CandidateScreenshotArtifacts {
    const screenshot = (artifactId: string): EnvironmentArtifactReference =>
        environmentArtifact(recorder, artifactId, 'screenshot');
    const beforeViewport = screenshot(before.screenshotArtifactId);
    const afterViewport = screenshot(after.screenshotArtifactId);
    const overviews = mapCandidateOverviews(
        {
            beforeFullPage: before.fullPageScreenshotArtifactId,
            afterFullPage: after.fullPageScreenshotArtifactId,
        },
        screenshot,
    );
    return {
        beforeViewport,
        afterViewport,
        ...overviews,
        screenshotArtifactIds: [
            beforeViewport,
            afterViewport,
            ...[overviews.beforeFullPage, overviews.afterFullPage].filter(
                (artifact) => artifact !== undefined,
            ),
        ].map((artifact) => artifact.artifactId),
    };
}

/**
 * Persist one factual result under the compatibility identity used by existing consumers.
 *
 * @param result - Complete factual candidate experiment.
 * @param candidateRule - Exact candidate bound to the artifact identity.
 * @param executionSuffix - Recorder-token-derived physical execution identity.
 * @param artifactsDir - Runner-owned artifact directory.
 * @param recorder - Trace artifact owner.
 * @returns Canonical validation artifact reference.
 */
export function persistFactualValidation(
    result: FactualValidationResult,
    candidateRule: string,
    executionSuffix: string,
    artifactsDir: string,
    recorder: TraceRecorder,
): EnvironmentArtifactReference {
    const candidateHash = createHash('sha256').update(candidateRule).digest('hex').slice(0, 12);
    const suffix = formatCandidateArtifactExecutionSuffix(executionSuffix);
    const artifactId = `validation-${candidateHash}${suffix}`;
    const path = join(artifactsDir, `factual-validation-${candidateHash}${suffix}.json`);
    mkdirSync(artifactsDir, { recursive: true });
    const serialized = JSON.stringify(result, null, 2);
    writeFileSync(path, serialized);
    recorder.addArtifact({
        id: artifactId,
        path,
        type: 'application/json',
        bytes: Buffer.byteLength(serialized),
    });
    return { artifactId, kind: 'validation', path };
}
