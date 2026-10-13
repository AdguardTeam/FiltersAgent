/**
 * What a Firefox-family run can prove: its executable baseline and the blocker half of a phase
 * proof.
 *
 * Both answers follow from the launch declaration rather than from anything the host reads out of
 * the browser, which is what separates this family from the Chromium/AdGuard one — a signed XPI is
 * never unpacked and `moz-extension://` pages cannot be driven. Keeping the two constructions here
 * leaves the adapter beside them with only its lifecycle and its phase orchestration.
 */
import { createHash } from 'node:crypto';
import * as v from 'valibot';
import type { SettingsProfileKind } from '../types/settings-profile-kind';
import { PhaseLabel } from '../types/validation';
import {
    EnvironmentPhaseConfigurationOutcome,
    type EnvironmentPhaseConfigurationResult,
} from './browser-extension-environment';
import {
    PublishedBaselineProvenanceSchema,
    type ExtensionAdapterProofSchema,
    type PublishedBaselineProvenance,
} from './environment-proofs';
import type { FilterListKey } from './filter-list-ref';
import type { AdapterPhaseLease, EnvironmentPhaseRequest } from './filtering-environment';
import { normalizeRulesContent, observedRulesDigest } from './rules-content';

/**
 * The build identity a signed-XPI install can prove.
 *
 * Firefox installs a signed archive and validates it itself; the host never unpacks it, so neither
 * a package version nor a manifest generation is ever read. The proof carries this marker in both
 * slots rather than a number nobody observed — what actually ran is named by the adapter's own
 * execution context and by the prepared-extension provenance beside it.
 */
export const SIGNED_XPI_BUILD_MARKER = 'signed-xpi';

/**
 * The declared facts one executable baseline is locked from.
 */
export interface DeclaredBaselineInput {
    /**
     * Executor name the baseline is recorded under.
     */
    environment: PublishedBaselineProvenance['environment'];

    /**
     * Extension id the enterprise policies force-install.
     */
    extensionId: string;

    /**
     * Immutable digest of the launch declaration this baseline belongs to.
     */
    buildDigest: string;

    /**
     * The list keys the declaration selects, user filters included.
     */
    declaredListKeys: readonly FilterListKey[];

    /**
     * Timestamp the baseline was acquired at.
     */
    acquiredAt: string;
}

/**
 * Lock the executable baseline a run's instruction declared.
 *
 * The declaration's list selection is the baseline. No list file is ever opened, so the provenance
 * carries no resources and names every enabled list unattributed — exactly the field that exists
 * for lists which filter but whose bytes no observer can bind — and the aggregate digest is taken
 * over the declaration instead of over bytes.
 *
 * @param input - The declared facts of the run's blocker.
 * @returns The locked baseline, or the validation issues that stopped it.
 */
export function lockDeclaredBaseline(input: DeclaredBaselineInput):
    | {
          /**
           * Discriminator: the declaration is a valid executable baseline.
           */
          ready: true;

          /**
           * The locked baseline provenance.
           */
          baseline: PublishedBaselineProvenance;
      }
    | {
          /**
           * Discriminator: the declaration cannot be an executable baseline.
           */
          ready: false;

          /**
           * Why it cannot, in the validator's own words.
           */
          detail: string;
      } {
    const enabledListKeys = [...input.declaredListKeys];
    if (enabledListKeys.length === 0) {
        return {
            ready: false,
            detail:
                "The run instruction's managed-storage declaration selects no filter list, so " +
                'this environment has no executable baseline to run.',
        };
    }
    const parsed = v.safeParse(PublishedBaselineProvenanceSchema, {
        environment: input.environment,
        acquiredAt: input.acquiredAt,
        enabledListKeys,
        resources: [],
        aggregateDigest: createHash('sha256')
            .update(
                JSON.stringify({
                    extensionId: input.extensionId,
                    buildDigest: input.buildDigest,
                    enabledListKeys,
                }),
            )
            .digest('hex'),
        unattributedListKeys: enabledListKeys,
    });
    if (!parsed.success) {
        return {
            ready: false,
            detail:
                'The declared list selection is not a valid executable baseline: ' +
                parsed.issues.map((issue) => issue.message).join('; '),
        };
    }
    return { ready: true, baseline: parsed.output };
}

/**
 * Everything the blocker half of one Firefox phase proof is built from.
 */
export interface FirefoxPhaseProofInput {
    /**
     * The phase request being proved.
     */
    request: EnvironmentPhaseRequest;

    /**
     * The credited application, or null for the unfiltered control phase.
     */
    application: EnvironmentPhaseConfigurationResult | null;

    /**
     * Digest of the candidate line for phase C, null otherwise.
     */
    candidateDigest: string | null;

    /**
     * The list keys the declaration selects; the enabled set every B and C proof reports.
     */
    declaredListKeys: readonly FilterListKey[];

    /**
     * Settings profile kind the run's sessions were launched with.
     */
    profileKind: SettingsProfileKind;

    /**
     * Complete prepared-build provenance, when the run recorded one.
     */
    extensionProvenance?: v.InferOutput<typeof ExtensionAdapterProofSchema>['provenance'];
}

/**
 * Build the blocker half of one Firefox-family phase proof.
 *
 * Phase A loads no blocker, so it carries none. For B and C the credited application supplies the
 * user-filter facts, and the enabled set is the declaration's own selection: the file read-back
 * cannot observe it, and the declaration is what the browser applied at startup, so reporting it is
 * an observation rather than a guess.
 *
 * @param input - The phase, the credited application, and the run's declared facts.
 * @returns The blocker proof, or null when the phase ran unfiltered or was never credited.
 */
export function firefoxPhaseExtensionProof(
    input: FirefoxPhaseProofInput,
): AdapterPhaseLease['adapterProof']['extension'] {
    const { request, application, candidateDigest } = input;
    if (
        request.phase === PhaseLabel.A ||
        application === null ||
        application.kind !== EnvironmentPhaseConfigurationOutcome.Applied
    ) {
        return null;
    }
    return {
        packageVersion: SIGNED_XPI_BUILD_MARKER,
        manifestVersion: SIGNED_XPI_BUILD_MARKER,
        profileKind: input.profileKind,
        enabledListKeys: [...input.declaredListKeys],
        // A signed XPI exposes no compiled-ruleset inventory to read, so the set is unobserved —
        // null, not an empty array that would read as a verified "no rulesets active".
        activeRulesetListKeys: null,
        // Tracking protection is an AdGuard setting; this blocker reports none.
        stealthEnabled: null,
        userRulesDigest:
            request.phase === PhaseLabel.C
                ? (observedRulesDigest(application.readBack) ?? candidateDigest)
                : null,
        application: {
            method: application.method,
            appliedRules:
                request.phase === PhaseLabel.C && request.candidate
                    ? [normalizeRulesContent(request.candidate.rule)]
                    : [],
            actionLog: application.actionLog,
            ...(application.detail === undefined ? {} : { detail: application.detail }),
        },
        ...(input.extensionProvenance ? { provenance: input.extensionProvenance } : {}),
    };
}
