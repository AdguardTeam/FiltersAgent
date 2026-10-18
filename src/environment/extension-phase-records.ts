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
import { formatCandidateArtifactExecutionSuffix } from '../types/candidate-artifact-identity';
import type {
    FactualValidationResult,
    PhaseResult,
    RuleApplicationFact,
} from '../types/validation';
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
