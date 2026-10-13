/**
 * Version-update decision of the Publisher.
 *
 * A small pure comparison between the blocker version the report declares (`Report` →
 * `environment.version`, verbatim) and the executor version the run actually observed — the same
 * value the report's `{{executorVersion}}` fill names. When the reported version is strictly older
 * and the run observed the reported symptom absent (`SymptomObservation.NotReproduced`), the report
 * suggests updating instead of fixing: the problem is most likely already fixed in the current
 * build. Every other combination — reproduced symptom, missing or unparseable versions, an
 * indeterminate observation — decides to no suggestion, and the report stays exactly as it is.
 *
 * The comparator is deliberately conservative: dotted-numeric versions only. Free-form tags
 * (`nightly`, `MV2`/`MV3` labels, prerelease names) are incomparable and never suggest an update —
 * under-suggestion is safe, a false suggestion is the failure mode to guard against. An
 * incomparable version never fails the report; it only leaves it without a hint.
 */

import { SymptomObservation } from '../types/fix-run-result';

/**
 * The version-update suggestion a report may make, decided once per render from the reported and
 * executor versions plus the symptom observation.
 */
export const VersionUpdateDecision = {
    /**
     * The reported version is older and the symptom does not reproduce — the report suggests
     * updating.
     */
    SuggestUpdate: 'suggest_update',

    /**
     * No update suggestion: the report stays a normal one naming the current version.
     */
    None: 'none',
} as const;

/**
 * VersionUpdateDecision value.
 */
export type VersionUpdateDecision =
    (typeof VersionUpdateDecision)[keyof typeof VersionUpdateDecision];

/**
 * Whole-string shape of a parseable version: one or more digits-only segments joined by dots.
 */
const DOTTED_NUMERIC_VERSION_PATTERN = /^\d+(\.\d+)*$/;

/**
 * Inputs of one version-update decision.
 */
export interface VersionUpdateDecisionInput {
    /**
     * The blocker version the report declares, verbatim from `Report` → `environment.version`.
     */
    reportedVersion?: string;

    /**
     * The executor version the run observed — the value the report's `{{executorVersion}}` fill
     * names.
     */
    currentExecutorVersion?: string;

    /**
     * The browser observation of the exact reported defect.
     */
    symptomObservation?: SymptomObservation;
}

/**
 * Parse a dotted-numeric version into numeric segments.
 *
 * Leading zeros normalize per segment through numeric coercion; anything with a non-digit segment
 * or no digits at all is unparsed.
 *
 * @param version - Raw version string, as the report declared it.
 * @returns The numeric segments, or undefined when the version is not a parseable dotted-numeric
 *   version.
 */
function parseVersionSegments(version: string): number[] | undefined {
    if (!DOTTED_NUMERIC_VERSION_PATTERN.test(version)) {
        return undefined;
    }
    return version.split('.').map((segment) => Number(segment));
}

/**
 * Compare two version strings numerically, segment by segment.
 *
 * A missing segment counts as zero and leading zeros are insensitive, so `1.2` equals `1.2.0` and
 * `1.02.0` equals `1.2.0`.
 *
 * @param left - Reported version string, or undefined when the report declared none.
 * @param right - Executor version string, or undefined when the run observed none.
 * @returns Negative when left is older, zero when equal, positive when newer; undefined when either
 *   side is missing or not a parseable dotted-numeric version.
 */
function compareVersionStrings(
    left: string | undefined,
    right: string | undefined,
): number | undefined {
    const leftSegments = left === undefined ? undefined : parseVersionSegments(left);
    const rightSegments = right === undefined ? undefined : parseVersionSegments(right);
    if (leftSegments === undefined || rightSegments === undefined) {
        return undefined;
    }
    const widest = Math.max(leftSegments.length, rightSegments.length);
    for (let index = 0; index < widest; index += 1) {
        const leftSegment = leftSegments[index] ?? 0;
        const rightSegment = rightSegments[index] ?? 0;
        if (leftSegment !== rightSegment) {
            return leftSegment < rightSegment ? -1 : 1;
        }
    }
    return 0;
}

/**
 * Decide whether the report may suggest updating instead of fixing.
 *
 * The suggestion fires exactly when both versions parse as dotted-numeric versions, the reported
 * version is strictly older than the executor version, and the run observed the reported symptom
 * absent. Anything else — an equal or newer report, missing or unparsed versions, a reproduced or
 * indeterminate observation — decides to no suggestion; an incomparable version never errors.
 *
 * @param input - Reported version, executor version, and symptom observation; each optional.
 * @returns The suggestion decision for this render.
 */
export function decideVersionUpdate(input: VersionUpdateDecisionInput): VersionUpdateDecision {
    const comparison = compareVersionStrings(input.reportedVersion, input.currentExecutorVersion);
    if (comparison === undefined || comparison >= 0) {
        return VersionUpdateDecision.None;
    }
    if (input.symptomObservation !== SymptomObservation.NotReproduced) {
        return VersionUpdateDecision.None;
    }
    return VersionUpdateDecision.SuggestUpdate;
}

/**
 * Render the fixed one-line hint that suggests an update, raw and unescaped.
 *
 * The wording is fixed; the reported and executor versions interpolate verbatim — escaping stays at
 * fill-build time in `report-render.ts`, exactly like the other untrusted fills.
 *
 * @param input - Reported version, executor version, and symptom observation; each optional.
 * @returns The raw hint text, or the empty string when the decision carries no suggestion.
 */
export function renderVersionUpdateHint(input: VersionUpdateDecisionInput): string {
    if (decideVersionUpdate(input) !== VersionUpdateDecision.SuggestUpdate) {
        return '';
    }
    const reportedVersion = input.reportedVersion ?? '';
    const executorVersion = input.currentExecutorVersion ?? '';
    return (
        `The reported version ${reportedVersion} is older than the version this run used ` +
        `(${executorVersion}), and the reported problem does not reproduce. ` +
        'Please update the product — the problem is most likely already fixed.'
    );
}
