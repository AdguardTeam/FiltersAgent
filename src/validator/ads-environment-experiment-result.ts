/**
 * What a shared Ads A/B/C environment experiment concludes: its verdict, the phases it recorded,
 * and, when something diagnosable stopped it early, why.
 */
import type { EnvironmentPhase } from '../environment/environment-proofs';
import type {
    EnvironmentAdapterLimitation,
    EnvironmentPhaseEvidence,
} from '../environment/filtering-environment';
import type { BrowserFallbackOrigin } from '../types/browser-fallback-origin';

/**
 * Intent-aware provisional verdict of a shared Ads A/B/C environment experiment.
 */
export const AdsEnvironmentExperimentVerdict = {
    /**
     * The controlled baseline and candidate phases together confirmed the intended effect.
     */
    Verified: 'verified',

    /**
     * The experiment completed without establishing whether the intended effect held.
     */
    Inconclusive: 'inconclusive',

    /**
     * A required environment capability was not available to complete the experiment.
     */
    CapabilityLimited: 'capability_limited',

    /**
     * A phase stopped with an environment or cleanup failure rather than a limitation.
     */
    Failed: 'failed',
} as const;

/**
 * AdsEnvironmentExperimentVerdict value.
 */
export type AdsEnvironmentExperimentVerdict =
    (typeof AdsEnvironmentExperimentVerdict)[keyof typeof AdsEnvironmentExperimentVerdict];

/**
 * Why an inconclusive experiment stopped, when the cause is diagnosable evidence rather than an
 * environment fault.
 */
export const ExperimentInconclusiveReason = {
    /**
     * Every phase ran cleanly but the reporter symptom was not observed in the controlled baseline,
     * so phase C was never worth running.
     */
    BaselineSymptomAbsent: 'baseline_symptom_absent',

    /**
     * A phase browser could not load the reported page, so the candidate was never judged.
     */
    PhaseNavigationFailed: 'phase_navigation_failed',
} as const;

/**
 * ExperimentInconclusiveReason value.
 */
export type ExperimentInconclusiveReason =
    (typeof ExperimentInconclusiveReason)[keyof typeof ExperimentInconclusiveReason];

/**
 * What every shared Ads A/B/C experiment result records.
 */
interface AdsEnvironmentExperimentRecord {
    /**
     * Intent-aware provisional verdict.
     */
    verdict: AdsEnvironmentExperimentVerdict;

    /**
     * Canonical recorder-owned phase evidence completed before the verdict.
     */
    phases: EnvironmentPhaseEvidence[];

    /**
     * Stable limitation when a phase could not be established or observed.
     */
    limitation: EnvironmentAdapterLimitation | null;
}

/**
 * An experiment that reached a verdict, or stopped on an environment fault.
 */
interface UndiagnosedExperimentResult extends AdsEnvironmentExperimentRecord {
    /**
     * Absent: nothing diagnosable stopped the experiment.
     */
    inconclusiveReason?: undefined;
}

/**
 * An experiment whose filtered baseline did not show the reported symptom.
 */
interface BaselineSymptomAbsentResult extends AdsEnvironmentExperimentRecord {
    /**
     * The baseline showed no symptom, so phase C was never worth running.
     */
    inconclusiveReason: typeof ExperimentInconclusiveReason.BaselineSymptomAbsent;
}

/**
 * An experiment a phase browser could not load the reported page for.
 */
interface PhaseNavigationFailedResult extends AdsEnvironmentExperimentRecord {
    /**
     * A phase could not load the page, so the candidate was never judged.
     */
    inconclusiveReason: typeof ExperimentInconclusiveReason.PhaseNavigationFailed;

    /**
     * The phase that stopped and why.
     */
    failedNavigation: FailedPhaseNavigation;
}

/**
 * Result of a shared Ads A/B/C experiment before outer cleanup finalization.
 */
export type AdsEnvironmentExperimentResult =
    | UndiagnosedExperimentResult
    | BaselineSymptomAbsentResult
    | PhaseNavigationFailedResult;

/**
 * The phase whose browser could not load the reported page.
 */
export interface FailedPhaseNavigation {
    /**
     * Phase that stopped.
     */
    phase: EnvironmentPhase;

    /**
     * Public detail naming the navigation error and its classification.
     */
    detail: string;

    /**
     * Who stopped the navigation: the site, our own guard, or a cause nothing recorded separates.
     */
    origin: BrowserFallbackOrigin;
}
