/**
 * Projections from the finished agent runtime's evidence onto the published {@link FixRunResult}:
 * the settings proof, the browser session inventory, the configuration-specific comparison matrix,
 * and the verified candidate binding a published patch must carry.
 */
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { SETTINGS_PROOF_FILE_NAME, writeSettingsProof } from '../local/settings-proof';
import type { AdGuardExtensionSettingsEvidence } from '../browser/adguard-extension-state-shapes';
import type { PreparedExtension } from '../local/prepared-extension';
import { ExtensionLaunchFamily } from '../environment/extension-launch';
import { adguardListKey, type FilterListKey } from '../environment/filter-list-ref';
import { FixOutcomeKind, ReproductionStatus, type FixOutcome } from '../types/fix-outcome';
import type { TraceRecorder } from '../tracer/trace-recorder';
import {
    ExtensionMode,
    SymptomObservation,
    type AgentBrowserSessionEvidence,
    type AgentCandidateValidationEvidence,
    type AgentConfigurationComparisonEvidence,
    type AgentExtensionProvenance,
    type AgentSettingsEvidence,
    type VerifiedCandidateScreenshotPaths,
} from '../types/fix-run-result';
import { reproEnvironmentsEqual } from '../types/repro-profile';
import { type CandidateValidationSelection } from './candidate-validation-selection';
import type {
    AgentRuntimeCandidateValidationBinding,
    AgentRuntimeEnvironmentEvidence,
    AgentRuntimePageCaptureEvidence,
} from './agent-runtime-session-evidence';
import { ReporterSymptomPresence, type SymptomPresence } from '../types/reporter-symptom-presence';
import { SettingsProfileKind } from '../types/settings-profile-kind';

/**
 * Complete same-build reporter-versus-controlled evidence selected for configuration diagnosis.
 */
export interface ConfigurationSpecificEnvironmentMatrix {
    /**
     * Prepared session reproducing the exact reporter symptom under reporter settings.
     */
    reporter: AgentRuntimeEnvironmentEvidence;

    /**
     * Exact complete capture that proves the reporter symptom is present.
     */
    reporterCapture: AgentRuntimePageCaptureEvidence;

    /**
     * Prepared session where the same symptom is absent under controlled settings.
     */
    controlled: AgentRuntimeEnvironmentEvidence;

    /**
     * Exact complete capture that proves the reporter symptom is absent.
     */
    controlledCapture: AgentRuntimePageCaptureEvidence;
}

/**
 * Persist the bounded settings evidence retained by the stateful agent runtime.
 *
 * @param evidence - Settings evidence the host read back from the blocker state.
 * @param artifactsDir - Per-run artifact directory.
 * @param recorder - Runtime artifact registry.
 * @returns Persisted proof path.
 */
export function persistAgentSettingsProof(
    evidence: AdGuardExtensionSettingsEvidence,
    artifactsDir: string,
    recorder: TraceRecorder,
): string {
    mkdirSync(artifactsDir, { recursive: true });
    const proofPath = join(artifactsDir, SETTINGS_PROOF_FILE_NAME);
    const serialized = writeSettingsProof(proofPath, evidence);
    // The proof's identity is the exact record it carries: the same observed state names the same
    // artifact, and no launch-time request digest exists anymore.
    const proofDigest = createHash('sha256').update(serialized, 'utf8').digest('hex');
    recorder.addArtifact({
        id: `settings-proof-${proofDigest.slice(0, 12)}`,
        path: proofPath,
        type: 'settings-proof',
        bytes: Buffer.byteLength(serialized),
    });
    return proofPath;
}

/**
 * Convert the read-back-sourced settings record to the bounded locked-result representation.
 *
 * @param evidence - Exact settings the host read back from the blocker state.
 * @returns Serializable settings proof derived only from that read-back.
 */
export function serializeAgentSettingsEvidence(
    evidence: AdGuardExtensionSettingsEvidence,
): AgentSettingsEvidence {
    return {
        profileKind: evidence.profileKind,
        // An unobserved enabled set stays null; the locked evidence never invents an empty list.
        enabledListKeys:
            evidence.enabledFilterIds === null
                ? null
                : evidence.enabledFilterIds.map(adguardListKey),
        enabledFilters: evidence.enabledFilters.map((filter) => ({
            listKey: adguardListKey(filter.filterId),
            ...(filter.name === undefined ? {} : { name: filter.name }),
        })),
        // An unobserved ruleset set stays null too; the locked evidence never invents an empty one.
        activeRulesetListKeys:
            evidence.activeRulesetFilterIds === null
                ? null
                : evidence.activeRulesetFilterIds.map(adguardListKey),
        stealthEnabled: evidence.stealthEnabled,
        limitsExceeded: evidence.limitsExceeded,
    };
}

/**
 * Publish the settings a declared-baseline session ran with.
 *
 * A blocker that declares its own list selection is credited from that declaration: there is no
 * live state to read back, so the declared keys are the enabled set. The MV3 fields do not apply to
 * such a blocker — it has no rulesets, no Stealth mode and no rule limits — and the record says so
 * plainly rather than inventing an observation.
 *
 * @param profileKind - The settings profile the model selected for the session.
 * @param listKeys - The declared list selection the session was credited with.
 * @returns The published settings evidence of the declared baseline.
 */
export function serializeDeclaredBaselineSettings(
    profileKind: AgentSettingsEvidence['profileKind'],
    listKeys: readonly FilterListKey[],
): AgentSettingsEvidence {
    return {
        profileKind,
        enabledListKeys: [...listKeys],
        // No live state was read back, so nothing was observed about compiled rulesets: null, not
        // an empty array a reader would take for a verified "no rulesets active".
        activeRulesetListKeys: null,
        stealthEnabled: null,
        limitsExceeded: false,
    };
}

/**
 * The settings evidence one session publishes: the read-back's when the session was credited by a
 * live state read, the declared selection when the blocker declared its own baseline, and nothing
 * when the session was credited by neither.
 *
 * The browser-session records, the final result and the candidate binding all publish through this
 * one function, so the binding can never disagree with the session it names. Before it existed the
 * binding demanded a read-back record, and a uBlock Origin session in Firefox — credited by its
 * declared lists — lost its verified candidate at the very last step.
 *
 * @param environment - Detached evidence of one runtime session.
 * @returns The published settings evidence, or undefined for an uncredited session.
 */
export function publishedSessionSettingsEvidence(
    environment: AgentRuntimeEnvironmentEvidence,
): AgentSettingsEvidence | undefined {
    if (environment.settingsEvidence !== undefined) {
        return serializeAgentSettingsEvidence(environment.settingsEvidence);
    }
    if (
        environment.declaredBaselineListKeys !== undefined &&
        environment.selectedSettingsProfileKind !== undefined
    ) {
        return serializeDeclaredBaselineSettings(
            environment.selectedSettingsProfileKind,
            environment.declaredBaselineListKeys,
        );
    }
    return undefined;
}

/**
 * Convert the run's one host-prepared extension build to locked-result provenance.
 *
 * This is the one projection from the runtime record onto the durable schema, and the only place
 * that knows which identity fields each launch family carries: a Chromium build names the unpacked
 * directory and the manifest generation read from it — exactly the record every run wrote before
 * the families were distinguished, so no discriminant — and a Firefox build names its family, the
 * extension id and the signed XPI the enterprise policies force-installed. The managed-storage
 * declaration is launch input, not provenance, so it never reaches the durable record.
 *
 * @param extension - Exact extension loaded by a prepared browser session.
 * @returns Bounded build identity suitable for session and candidate bindings.
 */
export function serializeAgentExtensionProvenance(
    extension: PreparedExtension,
): AgentExtensionProvenance {
    const tag =
        extension.extensionSourceTag === undefined
            ? {}
            : { extensionSourceTag: extension.extensionSourceTag };
    if (extension.launchFamily === ExtensionLaunchFamily.Firefox) {
        return {
            source: extension.source,
            launchFamily: extension.launchFamily,
            extensionId: extension.extensionId,
            xpiPath: extension.xpiPath,
            extensionSourceSha256: extension.extensionSourceSha256,
            ...tag,
        };
    }
    return {
        source: extension.source,
        extensionPath: extension.extensionPath,
        manifestVersion: extension.manifestVersion,
        extensionSourceSha256: extension.extensionSourceSha256,
        ...tag,
    };
}

/**
 * Test whether one environment has complete vision for one exact reporter-symptom state.
 *
 * @param environment - Browser session evidence retained by AgentRuntime.
 * @param presence - Exact structured vision state required from a complete capture.
 * @returns Whether the environment contains matching complete classified evidence.
 */
export function findCompleteReporterSymptomCapture(
    environment: AgentRuntimeEnvironmentEvidence,
    presence: SymptomPresence,
): AgentRuntimePageCaptureEvidence | undefined {
    if (!environment.navigationVerified || !environment.fullVisionVerified) {
        return undefined;
    }
    for (let index = environment.pageCaptures.length - 1; index >= 0; index -= 1) {
        const capture = environment.pageCaptures[index];
        if (
            capture?.visionVerified &&
            capture.coverageComplete &&
            capture.reporterSymptomPresence === presence &&
            capture.viewport?.path &&
            capture.fullPageOverview?.path &&
            capture.tiles.length > 0 &&
            capture.tiles.every((tile) => tile.path !== null)
        ) {
            return capture;
        }
    }
    return undefined;
}

/**
 * Select an explicit same-provenance reporter-versus-controlled configuration matrix.
 *
 * @param environments - Detached browser environments in launch order.
 * @returns Latest complete configuration matrix, or undefined when either side is missing.
 */
export function selectConfigurationSpecificEnvironmentMatrix(
    environments: AgentRuntimeEnvironmentEvidence[],
): ConfigurationSpecificEnvironmentMatrix | undefined {
    for (let reporterIndex = environments.length - 1; reporterIndex >= 0; reporterIndex -= 1) {
        const reporter = environments[reporterIndex]!;
        const reporterCapture = findCompleteReporterSymptomCapture(reporter, 'present');
        // The run's one host-prepared build is the current pinned release by construction, so the
        // reporter-present session qualifies through either current-build profile kind.
        const reporterProfileMatches =
            reporter.selectedSettingsProfileKind === SettingsProfileKind.ReportedOnCurrent ||
            reporter.selectedSettingsProfileKind === SettingsProfileKind.AgentSelected;
        if (
            reporter.extensionMode !== ExtensionMode.Prepared ||
            reporter.settingsEvidence === undefined ||
            reporter.settingsEvidence.profileKind !== reporter.selectedSettingsProfileKind ||
            !reporterProfileMatches ||
            reporterCapture === undefined
        ) {
            continue;
        }
        for (
            let controlledIndex = environments.length - 1;
            controlledIndex >= 0;
            controlledIndex -= 1
        ) {
            const controlled = environments[controlledIndex]!;
            const controlledCapture = findCompleteReporterSymptomCapture(controlled, 'absent');
            if (
                controlled.extensionMode === ExtensionMode.Prepared &&
                controlled.selectedSettingsProfileKind ===
                    SettingsProfileKind.DefaultsPlusRequired &&
                controlled.settingsEvidence?.profileKind ===
                    SettingsProfileKind.DefaultsPlusRequired &&
                // One run carries one extension build: identity is the proof both sessions loaded it.
                JSON.stringify(controlled.extension) === JSON.stringify(reporter.extension) &&
                reproEnvironmentsEqual(
                    reporter.targetUrl,
                    reporter.profile,
                    controlled.targetUrl,
                    controlled.profile,
                ) &&
                controlledCapture !== undefined
            ) {
                return { reporter, reporterCapture, controlled, controlledCapture };
            }
        }
    }
    return undefined;
}

/**
 * Serialize an explicit configuration comparison bound to locked browser-session identities.
 *
 * @param matrix - Complete runtime reporter-versus-controlled evidence.
 * @returns Typed locked-result comparison reference.
 */
export function serializeConfigurationSpecificEnvironmentMatrix(
    matrix: ConfigurationSpecificEnvironmentMatrix,
): AgentConfigurationComparisonEvidence {
    return {
        extensionProvenance: serializeAgentExtensionProvenance(matrix.reporter.extension!),
        reporter: {
            sessionId: matrix.reporter.sessionId,
            profileKind: matrix.reporter.selectedSettingsProfileKind!,
            reporterSymptomPresence: ReporterSymptomPresence.Present,
            viewportArtifactId: matrix.reporterCapture.viewport!.artifactId,
            fullPageOverviewArtifactId: matrix.reporterCapture.fullPageOverview!.artifactId,
            tileArtifactIds: matrix.reporterCapture.tiles.map((tile) => tile.artifactId),
        },
        controlled: {
            sessionId: matrix.controlled.sessionId,
            profileKind: SettingsProfileKind.DefaultsPlusRequired,
            reporterSymptomPresence: ReporterSymptomPresence.Absent,
            viewportArtifactId: matrix.controlledCapture.viewport!.artifactId,
            fullPageOverviewArtifactId: matrix.controlledCapture.fullPageOverview!.artifactId,
            tileArtifactIds: matrix.controlledCapture.tiles.map((tile) => tile.artifactId),
        },
    };
}

/**
 * Serialize browser screenshots under the exact sessions that produced and inspected them.
 *
 * Missing recorder paths remain null and make the corresponding capture ineligible for durable
 * publication. This prevents a flat diagnostic screenshot list from being attributed to a different
 * extension/settings profile.
 *
 * @param environments - Detached session evidence returned in launch order by AgentRuntime.
 * @returns Bounded session records suitable for local reports and publication checks.
 */
export function serializeAgentBrowserSessions(
    environments: AgentRuntimeEnvironmentEvidence[],
): AgentBrowserSessionEvidence[] {
    return environments.map((environment) => {
        const captures = environment.pageCaptures.map((capture) => {
            const viewport = capture.viewport?.path ? capture.viewport : null;
            const fullPageOverview = capture.fullPageOverview?.path
                ? capture.fullPageOverview
                : null;
            const tiles = capture.tiles.flatMap((tile) =>
                tile.path === null ? [] : [{ artifactId: tile.artifactId, path: tile.path }],
            );
            const pathsComplete =
                fullPageOverview !== null && tiles.length === capture.tiles.length;
            return {
                visionVerified: capture.visionVerified && pathsComplete,
                viewportArtifactId: viewport?.artifactId ?? null,
                viewport: viewport?.path ?? null,
                fullPageOverviewArtifactId: fullPageOverview?.artifactId ?? null,
                fullPageOverview: fullPageOverview?.path ?? null,
                tileArtifactIds: tiles.map((tile) => tile.artifactId),
                tiles: tiles.map((tile) => tile.path),
                coverageComplete: capture.coverageComplete && pathsComplete,
                reporterSymptomPresence: capture.reporterSymptomPresence,
            };
        });
        const session: AgentBrowserSessionEvidence = {
            sessionId: environment.sessionId,
            targetUrl: environment.targetUrl,
            extensionMode: environment.extensionMode,
            profile: {
                viewport: environment.profile.viewport,
                locale: environment.profile.locale,
                timezone: environment.profile.timezone,
                ...(environment.profile.geolocation
                    ? { geolocation: { ...environment.profile.geolocation } }
                    : {}),
                ...(environment.profile.proxyRegion
                    ? { proxyRegion: environment.profile.proxyRegion }
                    : {}),
                userAgentProfile: environment.profile.userAgentProfile,
                consentStrategy: environment.profile.consentStrategy,
            },
            navigationVerified: environment.navigationVerified,
            fullVisionVerified:
                environment.fullVisionVerified &&
                captures.some((capture) => capture.visionVerified),
            captures,
        };
        if (environment.selectedSettingsProfileKind) {
            session.selectedSettingsProfileKind = environment.selectedSettingsProfileKind;
        }
        if (environment.extension) {
            session.extensionProvenance = serializeAgentExtensionProvenance(environment.extension);
        }
        const settingsEvidence = publishedSessionSettingsEvidence(environment);
        if (settingsEvidence) {
            session.settingsEvidence = settingsEvidence;
        }
        return session;
    });
}

/**
 * Name every field that stops a verified candidate binding from serializing.
 *
 * The serializer collapses a twenty-field agreement into `undefined`, and a run that reaches it has
 * already paid for a complete experiment: without the field names the reader cannot tell a genuine
 * mismatch from a plumbing slip.
 *
 * @param binding - Runtime-owned binding for the validated candidate.
 * @param selection - Selected validation identity and its visual review.
 * @param screenshots - Verified before/after screenshot paths.
 * @returns Field names that disagree; empty when the binding serializes.
 */
export function describeVerifiedCandidateBindingFailure(
    binding: AgentRuntimeCandidateValidationBinding | undefined,
    selection: CandidateValidationSelection | undefined,
    screenshots: VerifiedCandidateScreenshotPaths | undefined,
): string[] {
    if (!binding) {
        return ['binding missing'];
    }
    const failures: string[] = [];
    if (!selection?.validationArtifactId) {
        failures.push('selection.validationArtifactId missing');
    }
    if (!selection?.visualReview) {
        failures.push('selection.visualReview missing');
    }
    if (!selection?.visualReviewArtifactPath) {
        failures.push('selection.visualReviewArtifactPath missing');
    }
    if (!screenshots) {
        failures.push('verified screenshots missing');
    }
    if (binding.sessionId !== binding.environment.sessionId) {
        failures.push('binding session drift');
    }
    if (selection && binding.validationArtifactId !== selection.validationArtifactId) {
        failures.push('validationArtifactId differs from the selected validation');
    }
    if (selection && binding.visualReviewArtifact.path !== selection.visualReviewArtifactPath) {
        failures.push('visual review artifact path differs');
    }
    if (
        selection &&
        JSON.stringify(binding.visualReview) !== JSON.stringify(selection.visualReview)
    ) {
        failures.push('visual review payload differs');
    }
    const artifactPairs: Array<[string, string | undefined, string | undefined]> = selection
        ? [
              [
                  'beforeViewport',
                  binding.beforeViewport.artifactId,
                  selection.beforeScreenshotArtifactId,
              ],
              [
                  'afterViewport',
                  binding.afterViewport.artifactId,
                  selection.afterScreenshotArtifactId,
              ],
              [
                  'beforeFullPage',
                  binding.beforeFullPage.artifactId,
                  selection.beforeFullPageScreenshotArtifactId,
              ],
              [
                  'afterFullPage',
                  binding.afterFullPage.artifactId,
                  selection.afterFullPageScreenshotArtifactId,
              ],
          ]
        : [];
    for (const [name, bound, selected] of artifactPairs) {
        if (bound !== selected) {
            failures.push(`${name} artifactId differs`);
        }
    }
    const pathPairs: Array<[string, string, string | undefined]> = screenshots
        ? [
              ['beforeViewport', binding.beforeViewport.path, screenshots.before],
              ['afterViewport', binding.afterViewport.path, screenshots.after],
              ['beforeFullPage', binding.beforeFullPage.path, screenshots.beforeFullPage],
              ['afterFullPage', binding.afterFullPage.path, screenshots.afterFullPage],
          ]
        : [];
    for (const [name, bound, expected] of pathPairs) {
        if (bound !== expected) {
            failures.push(`${name} path differs`);
        }
    }
    if (binding.cli === undefined) {
        if (binding.environment.extensionMode !== ExtensionMode.Prepared) {
            failures.push(`bound session mode ${binding.environment.extensionMode}`);
        }
        if (
            binding.extension === undefined ||
            binding.environment.extension === undefined ||
            JSON.stringify(binding.extension) !== JSON.stringify(binding.environment.extension)
        ) {
            failures.push('extension provenance differs from the bound session');
        }
        if (
            JSON.stringify(binding.settingsEvidence) !==
            JSON.stringify(binding.environment.settingsEvidence)
        ) {
            failures.push('settings evidence differs from the bound session');
        }
        if (publishedSessionSettingsEvidence(binding.environment) === undefined) {
            failures.push(
                'the bound session was credited by neither a settings read-back nor a declared baseline',
            );
        }
    }
    return failures;
}

/**
 * Serialize candidate proof only when the selected validation, persisted review, exact screenshot
 * pairs, prepared browser session, and browser-observed settings all describe the same attempt.
 *
 * @param binding - Runtime-owned prepared-session binding for one validation artifact.
 * @param selection - Artifact selection for the exact final candidate rule.
 * @param screenshots - Exact viewport and full-page paths resolved for that selection.
 * @returns Locked candidate proof, or undefined when any identity/path crosses attempts.
 */
export function serializeVerifiedCandidateBinding(
    binding: AgentRuntimeCandidateValidationBinding | undefined,
    selection: CandidateValidationSelection | undefined,
    screenshots: VerifiedCandidateScreenshotPaths | undefined,
): AgentCandidateValidationEvidence | undefined {
    if (
        !binding ||
        !selection?.validationArtifactId ||
        !selection.visualReview ||
        !selection.visualReviewArtifactPath ||
        !screenshots ||
        binding.sessionId !== binding.environment.sessionId ||
        binding.validationArtifactId !== selection.validationArtifactId ||
        binding.visualReviewArtifact.path !== selection.visualReviewArtifactPath ||
        JSON.stringify(binding.visualReview) !== JSON.stringify(selection.visualReview) ||
        binding.beforeViewport.artifactId !== selection.beforeScreenshotArtifactId ||
        binding.afterViewport.artifactId !== selection.afterScreenshotArtifactId ||
        binding.beforeFullPage.artifactId !== selection.beforeFullPageScreenshotArtifactId ||
        binding.afterFullPage.artifactId !== selection.afterFullPageScreenshotArtifactId ||
        binding.beforeViewport.path !== screenshots.before ||
        binding.afterViewport.path !== screenshots.after ||
        binding.beforeFullPage.path !== screenshots.beforeFullPage ||
        binding.afterFullPage.path !== screenshots.afterFullPage
    ) {
        return undefined;
    }
    if (binding.cli !== undefined) {
        // The desktop executor binds through its CLI proof; the bound session provably ran no
        // extension, so no extension evidence may appear beside it.
        if (
            binding.environment.extensionMode !== ExtensionMode.None ||
            binding.environment.extension !== undefined ||
            binding.environment.settingsEvidence !== undefined
        ) {
            return undefined;
        }
        return {
            validationArtifactId: binding.validationArtifactId,
            sessionId: binding.sessionId,
            cli: binding.cli,
            validationArtifact: binding.validationArtifact,
            visualReviewArtifact: binding.visualReviewArtifact,
            beforeViewport: binding.beforeViewport,
            afterViewport: binding.afterViewport,
            beforeFullPage: binding.beforeFullPage,
            afterFullPage: binding.afterFullPage,
        };
    }
    const publishedSettings = publishedSessionSettingsEvidence(binding.environment);
    if (
        binding.environment.extensionMode !== ExtensionMode.Prepared ||
        binding.extension === undefined ||
        binding.environment.extension === undefined ||
        JSON.stringify(binding.extension) !== JSON.stringify(binding.environment.extension) ||
        JSON.stringify(binding.settingsEvidence) !==
            JSON.stringify(binding.environment.settingsEvidence) ||
        publishedSettings === undefined
    ) {
        return undefined;
    }
    return {
        validationArtifactId: binding.validationArtifactId,
        sessionId: binding.sessionId,
        extensionProvenance: serializeAgentExtensionProvenance(binding.extension),
        settingsEvidence: publishedSettings,
        validationArtifact: binding.validationArtifact,
        visualReviewArtifact: binding.visualReviewArtifact,
        beforeViewport: binding.beforeViewport,
        afterViewport: binding.afterViewport,
        beforeFullPage: binding.beforeFullPage,
        afterFullPage: binding.afterFullPage,
    };
}

/**
 * Map the typed terminal decision to the reporter-symptom state needed by the publication gate.
 *
 * @param outcome - Accepted finish_fix payload.
 * @returns Explicit reproduced/not-reproduced state, or indeterminate for report-only outcomes.
 */
export function symptomFromTerminal(outcome: FixOutcome): SymptomObservation {
    if (outcome.outcome === FixOutcomeKind.ProposeRule) {
        return SymptomObservation.Reproduced;
    }
    if (outcome.outcome === FixOutcomeKind.ResolveWithoutPatch) {
        return SymptomObservation.Indeterminate;
    }
    if (
        outcome.outcome === FixOutcomeKind.ProposeClose &&
        outcome.reproductionStatus === ReproductionStatus.NotReproduced
    ) {
        return SymptomObservation.NotReproduced;
    }
    return SymptomObservation.Indeterminate;
}
