import * as v from 'valibot';
import { PreparedExtensionProvenanceSchema } from '../../src/environment/environment-proofs';
import { describe, expect, it } from 'vitest';
import {
    decideVersionUpdate,
    renderVersionUpdateHint,
    VersionUpdateDecision,
} from '../../src/publisher/report-version-decision';
import type { VersionUpdateDecisionInput } from '../../src/publisher/report-version-decision';
import {
    buildReportTemplateValues,
    renderReportComment,
    summarizeReportOutcome,
    type ReportRunResultInput,
} from '../../src/publisher/report-render';
import { BUILT_IN_REPORT_TEMPLATE } from '../../src/publisher/report-template';
import {
    ExtensionManifestVersion,
    PreparedExtensionSource,
} from '../../src/environment/extension-preparation';
import { FixRunStatus, SymptomObservation } from '../../src/types/fix-run-result';
import { ARTIFACTS_LINK, LIST_SOURCE } from './report-fixtures';

// `Report`-shaped environment fixture mirroring the intake field this decision consumes
// (`environment.version`, verbatim); the tests feed the plain string extracted from it below,
// never the fixture object.
const REPORT_ENVIRONMENT_FIXTURE = {
    environment: {
        product: 'AdGuard Ad Filter',
        version: '4.1.2',
    },
} as const;

// The reported version verbatim, as the run wiring would extract it from the fixture.
const REPORTED_VERSION: string = REPORT_ENVIRONMENT_FIXTURE.environment.version;

// The AC1 trigger: a reported version older than the executor build, symptom observed absent.
const OLDER_VERSION_NOT_REPRODUCED: VersionUpdateDecisionInput = {
    reportedVersion: REPORTED_VERSION,
    currentExecutorVersion: '4.6.0',
    symptomObservation: SymptomObservation.NotReproduced,
};

describe('decideVersionUpdate', () => {
    it('suggests an update when the reported version is older and the symptom does not reproduce', () => {
        expect(decideVersionUpdate(OLDER_VERSION_NOT_REPRODUCED)).toBe(
            VersionUpdateDecision.SuggestUpdate,
        );
    });

    it('decides to no suggestion when the symptom reproduces (AC2: normal report)', () => {
        const input: VersionUpdateDecisionInput = {
            ...OLDER_VERSION_NOT_REPRODUCED,
            symptomObservation: SymptomObservation.Reproduced,
        };

        expect(decideVersionUpdate(input)).toBe(VersionUpdateDecision.None);
    });

    it('decides to no suggestion when the reported version equals or is newer than the current one', () => {
        const equalVersion: VersionUpdateDecisionInput = {
            ...OLDER_VERSION_NOT_REPRODUCED,
            reportedVersion: '4.6.0',
        };
        const newerVersion: VersionUpdateDecisionInput = {
            ...OLDER_VERSION_NOT_REPRODUCED,
            reportedVersion: '4.7.0',
        };

        expect(decideVersionUpdate(equalVersion)).toBe(VersionUpdateDecision.None);
        expect(decideVersionUpdate(newerVersion)).toBe(VersionUpdateDecision.None);
    });

    it('decides to no suggestion when either version is missing or empty', () => {
        const missingReported: VersionUpdateDecisionInput = {
            currentExecutorVersion: '4.6.0',
            symptomObservation: SymptomObservation.NotReproduced,
        };
        const emptyReported: VersionUpdateDecisionInput = {
            ...OLDER_VERSION_NOT_REPRODUCED,
            reportedVersion: '',
        };
        const missingCurrent: VersionUpdateDecisionInput = {
            reportedVersion: REPORTED_VERSION,
            symptomObservation: SymptomObservation.NotReproduced,
        };
        const emptyCurrent: VersionUpdateDecisionInput = {
            ...OLDER_VERSION_NOT_REPRODUCED,
            currentExecutorVersion: '',
        };

        for (const input of [missingReported, emptyReported, missingCurrent, emptyCurrent]) {
            expect(decideVersionUpdate(input)).toBe(VersionUpdateDecision.None);
        }
    });

    it('decides to no suggestion when either version is not dotted-numeric', () => {
        const alphaReported: VersionUpdateDecisionInput = {
            ...OLDER_VERSION_NOT_REPRODUCED,
            reportedVersion: 'beta2',
        };
        const labelReported: VersionUpdateDecisionInput = {
            ...OLDER_VERSION_NOT_REPRODUCED,
            reportedVersion: 'MV3',
        };
        const alphaCurrent: VersionUpdateDecisionInput = {
            ...OLDER_VERSION_NOT_REPRODUCED,
            currentExecutorVersion: 'beta2',
        };
        const labelCurrent: VersionUpdateDecisionInput = {
            ...OLDER_VERSION_NOT_REPRODUCED,
            currentExecutorVersion: 'MV3',
        };

        for (const input of [alphaReported, labelReported, alphaCurrent, labelCurrent]) {
            expect(decideVersionUpdate(input)).toBe(VersionUpdateDecision.None);
        }
    });

    it('decides to no suggestion when the observation is indeterminate or not attempted', () => {
        const indeterminate: VersionUpdateDecisionInput = {
            ...OLDER_VERSION_NOT_REPRODUCED,
            symptomObservation: SymptomObservation.Indeterminate,
        };
        const notAttempted: VersionUpdateDecisionInput = {
            ...OLDER_VERSION_NOT_REPRODUCED,
            symptomObservation: SymptomObservation.NotAttempted,
        };
        const noObservation: VersionUpdateDecisionInput = {
            reportedVersion: REPORTED_VERSION,
            currentExecutorVersion: '4.6.0',
        };

        for (const input of [indeterminate, notAttempted, noObservation]) {
            expect(decideVersionUpdate(input)).toBe(VersionUpdateDecision.None);
        }
    });

    it('compares per numeric segment: missing segments as zeros, leading zeros insensitive', () => {
        // Lexicographic order would flip this pair; only numeric per-segment comparison can suggest.
        const numericLadder: VersionUpdateDecisionInput = {
            ...OLDER_VERSION_NOT_REPRODUCED,
            reportedVersion: '4.1.2',
            currentExecutorVersion: '4.10.0',
        };
        // A missing segment counts as zero, so a shorter version can only tie or lose here.
        const shorterReported: VersionUpdateDecisionInput = {
            ...OLDER_VERSION_NOT_REPRODUCED,
            reportedVersion: '1.2',
            currentExecutorVersion: '1.2.0',
        };
        // Leading zeros normalize per segment through numeric coercion.
        const leadingZeros: VersionUpdateDecisionInput = {
            ...OLDER_VERSION_NOT_REPRODUCED,
            reportedVersion: '1.02.0',
            currentExecutorVersion: '1.2.0',
        };
        // A letter inside a segment leaves the version unparsed — never suggested for it.
        const letterInsideSegment: VersionUpdateDecisionInput = {
            ...OLDER_VERSION_NOT_REPRODUCED,
            reportedVersion: '1.2a.0',
            currentExecutorVersion: '1.2.5',
        };

        expect(decideVersionUpdate(numericLadder)).toBe(VersionUpdateDecision.SuggestUpdate);
        for (const input of [shorterReported, leadingZeros, letterInsideSegment]) {
            expect(decideVersionUpdate(input)).toBe(VersionUpdateDecision.None);
        }
    });
});

describe('renderVersionUpdateHint', () => {
    it('renders a non-empty hint naming both versions for the AC1 suggestion', () => {
        const hint = renderVersionUpdateHint(OLDER_VERSION_NOT_REPRODUCED);

        expect(hint.length).toBeGreaterThan(0);
        expect(hint).toContain('4.1.2');
        expect(hint).toContain('4.6.0');
        expect(hint.toLowerCase()).toContain('update');
        expect(hint.toLowerCase()).toContain('already fixed');
    });

    it('renders the empty hint for every no-suggestion outcome', () => {
        const reproduced: VersionUpdateDecisionInput = {
            ...OLDER_VERSION_NOT_REPRODUCED,
            symptomObservation: SymptomObservation.Reproduced,
        };
        const equalVersion: VersionUpdateDecisionInput = {
            ...OLDER_VERSION_NOT_REPRODUCED,
            reportedVersion: '4.6.0',
        };
        const unparsedVersion: VersionUpdateDecisionInput = {
            ...OLDER_VERSION_NOT_REPRODUCED,
            reportedVersion: 'MV3',
        };

        expect(renderVersionUpdateHint(reproduced)).toBe('');
        expect(renderVersionUpdateHint(equalVersion)).toBe('');
        expect(renderVersionUpdateHint(unparsedVersion)).toBe('');
    });
});

/**
 * Fix the run shape the version-update hint decision rides on: an executor build whose version tag
 * the report names as the current version, with the symptom observation as the caller decides it.
 */
function olderReportedRun(symptomObservation: SymptomObservation): ReportRunResultInput {
    return {
        runStatus: FixRunStatus.NotReproduced,
        fallbackReason: null,
        fallbackDetail: null,
        symptomObservation,
        candidatePatch: null,
        extensionProvenance: v.parse(PreparedExtensionProvenanceSchema, {
            source: PreparedExtensionSource.PinnedRelease,
            extensionPath: '/run/extension',
            manifestVersion: ExtensionManifestVersion.Mv3,
            extensionSourceSha256: 'c'.repeat(64),
            // A real pinned release's tag, never a bare dotted-numeric version; the hint must
            // compare against environmentSelection.actual.productVersion below, not this display
            // value.
            extensionSourceTag: 'v4.6.0',
        }),
        environmentSelection: { actual: { productVersion: '4.6.0' } },
    };
}

describe('version update hint in the report', () => {
    it('renders the update suggestion into the built-in report for an older version that does not reproduce', () => {
        const summary = summarizeReportOutcome(
            olderReportedRun(SymptomObservation.NotReproduced),
            {},
            ARTIFACTS_LINK,
            LIST_SOURCE,
            REPORTED_VERSION,
        );
        const values = buildReportTemplateValues(summary);

        expect(values.versionUpdateHint.length).toBeGreaterThan(0);
        expect(values.versionUpdateHint).toContain('4.1.2');
        expect(values.versionUpdateHint).toContain('4.6.0');

        const rendered = renderReportComment(BUILT_IN_REPORT_TEMPLATE, values);
        expect(rendered).toContain('4.1.2');
        expect(rendered).toContain('4.6.0');
    });

    it('keeps the hint empty and the current version named when the symptom reproduces', () => {
        const summary = summarizeReportOutcome(
            olderReportedRun(SymptomObservation.Reproduced),
            {},
            ARTIFACTS_LINK,
            LIST_SOURCE,
            REPORTED_VERSION,
        );
        const values = buildReportTemplateValues(summary);

        expect(values.versionUpdateHint).toBe('');
        // The display executor version is still the provenance tag, unaffected by the hint's own
        // (unused, since the symptom reproduced) comparison input.
        expect(values.executorVersion).toBe('v4.6.0');

        const rendered = renderReportComment(BUILT_IN_REPORT_TEMPLATE, values);
        expect(rendered).toContain('4.6.0');
    });

    it('leaves the hint empty when the run carries no reported version', () => {
        const summary = summarizeReportOutcome(
            olderReportedRun(SymptomObservation.NotReproduced),
            {},
            ARTIFACTS_LINK,
            LIST_SOURCE,
        );

        expect(summary.versionUpdateHint).toBe('');
        expect(buildReportTemplateValues(summary).versionUpdateHint).toBe('');
    });
});
