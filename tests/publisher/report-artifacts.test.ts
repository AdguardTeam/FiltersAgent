import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import {
    IntakeExtractionPayloadSchema,
    IntakeVerdict,
    ReportProblemType,
} from '../../src/intake/report';
import type { IntakeExtractionPayload } from '../../src/intake/report';
import {
    AGENT_RUN_ARTIFACTS_FILE_NAME,
    LLM_USAGE_FILE_NAME,
    RUN_RESULT_FILE_NAME,
} from '../../src/local/evidence-publication';
import {
    REPORT_SCHEMA_ARTIFACT_FILE_NAME,
    RunArtifactKind,
    collectRunArtifacts,
    renderReportSchemaArtifact,
} from '../../src/publisher/report-artifacts';
import { FixRunArtifactPathsSchema } from '../../src/types/fix-run-result';

const VERIFIED_SCREENSHOTS = {
    before: '/run/artifacts/candidate-before-viewport.png',
    after: '/run/artifacts/candidate-after-viewport.png',
    beforeFullPage: '/run/artifacts/candidate-before-full-page.png',
    afterFullPage: '/run/artifacts/candidate-after-full-page.png',
};

const FILTER_REPORT_PAYLOAD: unknown = {
    verdict: IntakeVerdict.FilterReport,
    report: {
        siteUrls: ['https://example.com/watch?v=1'],
        problemType: ReportProblemType.Ads,
        screenshots: [{ url: 'https://example.com/shot.png', description: 'banner ad visible' }],
        environment: { product: 'AdGuard', version: '4.5' },
        enabledLists: [{ name: 'BaseFilter' }],
        userRules: [],
        reproductionSteps: ['Open the page'],
    },
};

const filterPayload = () => v.parse(IntakeExtractionPayloadSchema, FILTER_REPORT_PAYLOAD);

describe('collectRunArtifacts', () => {
    it('collects the run captures, the verified candidate screenshots, and the fixed generation files', () => {
        const entries = collectRunArtifacts({
            artifactPaths: v.parse(FixRunArtifactPathsSchema, {
                screenshots: [
                    ...Object.values(VERIFIED_SCREENSHOTS),
                    '/run/artifacts/diagnostic.png',
                ],
                domSnapshot: '/run/artifacts/dom.html',
                har: '/run/artifacts/network.har',
                trace: '/run/artifacts/trace.zip',
                verifiedCandidateScreenshots: VERIFIED_SCREENSHOTS,
            }),
        });

        const byPath = new Map(entries.map((entry) => [entry.path, entry]));

        expect(byPath.get('/run/artifacts/network.har')?.kind).toBe(RunArtifactKind.NetworkLog);
        expect(byPath.get('/run/artifacts/trace.zip')?.kind).toBe(RunArtifactKind.Trace);
        expect(byPath.get('/run/artifacts/dom.html')?.kind).toBe(RunArtifactKind.DomSnapshot);
        expect(byPath.get(VERIFIED_SCREENSHOTS.before)?.kind).toBe(RunArtifactKind.Screenshot);
        expect(byPath.get(VERIFIED_SCREENSHOTS.before)?.label).toBe('Candidate before (viewport)');
        expect(byPath.get(VERIFIED_SCREENSHOTS.afterFullPage)?.label).toBe(
            'Candidate after (full page)',
        );

        const kinds = new Set(entries.map((entry) => entry.kind));
        for (const expected of [
            RunArtifactKind.Screenshot,
            RunArtifactKind.NetworkLog,
            RunArtifactKind.Trace,
            RunArtifactKind.DomSnapshot,
            RunArtifactKind.Decision,
            RunArtifactKind.Usage,
            RunArtifactKind.RunResult,
        ]) {
            expect(kinds.has(expected)).toBe(true);
        }
        for (const fixed of [
            AGENT_RUN_ARTIFACTS_FILE_NAME,
            LLM_USAGE_FILE_NAME,
            RUN_RESULT_FILE_NAME,
        ]) {
            expect(byPath.has(fixed)).toBe(true);
        }
    });

    it('gives every run capture its own distinct path and label', () => {
        const entries = collectRunArtifacts({
            artifactPaths: v.parse(FixRunArtifactPathsSchema, {
                screenshots: [
                    ...Object.values(VERIFIED_SCREENSHOTS),
                    '/run/artifacts/diagnostic.png',
                ],
                domSnapshot: '/run/artifacts/dom.html',
                har: '/run/artifacts/network.har',
                trace: '/run/artifacts/trace.zip',
                verifiedCandidateScreenshots: VERIFIED_SCREENSHOTS,
            }),
        });

        const labels = entries.map((entry) => entry.label);
        expect(new Set(labels).size).toBe(labels.length);
        const paths = entries.map((entry) => entry.path);
        expect(new Set(paths).size).toBe(paths.length);
    });

    it('returns entries only for what a failed run collected, keeping the fixed generation files', () => {
        const entries = collectRunArtifacts({
            artifactPaths: v.parse(FixRunArtifactPathsSchema, {
                screenshots: [],
                domSnapshot: null,
                har: null,
                trace: null,
                browserLog: '/run/artifacts/browser.log',
            }),
        });

        const byPath = new Map(entries.map((entry) => [entry.path, entry]));

        expect(byPath.get('/run/artifacts/browser.log')?.kind).toBe(RunArtifactKind.BrowserLog);
        for (const absent of Object.values(VERIFIED_SCREENSHOTS)) {
            expect(byPath.has(absent)).toBe(false);
        }
        for (const fixed of [
            AGENT_RUN_ARTIFACTS_FILE_NAME,
            LLM_USAGE_FILE_NAME,
            RUN_RESULT_FILE_NAME,
        ]) {
            expect(byPath.has(fixed)).toBe(true);
        }
    });

    it('deduplicates a path repeated within and across artifact families, keeping the first entry', () => {
        const entries = collectRunArtifacts({
            artifactPaths: v.parse(FixRunArtifactPathsSchema, {
                screenshots: ['/run/artifacts/dup.png'],
                domSnapshot: null,
                har: '/run/artifacts/dup.png',
                trace: null,
            }),
        });

        expect(entries.filter((entry) => entry.path === '/run/artifacts/dup.png').length).toBe(1);
        expect(entries.find((entry) => entry.path === '/run/artifacts/dup.png')?.kind).toBe(
            RunArtifactKind.Screenshot,
        );
    });

    it('names the extracted report artifact report.json when the intake payload is collected', () => {
        const entries = collectRunArtifacts(
            {
                artifactPaths: v.parse(FixRunArtifactPathsSchema, {
                    screenshots: [],
                    domSnapshot: null,
                    har: null,
                    trace: null,
                }),
            },
            filterPayload(),
        );

        const reportEntry = entries.find(
            (entry) => entry.path === REPORT_SCHEMA_ARTIFACT_FILE_NAME,
        );

        expect(reportEntry?.kind).toBe(RunArtifactKind.ReportSchema);
        expect(reportEntry?.label).toBe('Extracted report');
        // Not redundant with the constant above: the constants travel with any rename, this plain
        // string pins the linked artifact surface so a wholesale rename still trips a test.
        expect(entries.map((entry) => entry.path)).toContain('report.json');
    });
});

describe('renderReportSchemaArtifact', () => {
    it('round-trips a filter-report payload through stable JSON', () => {
        const payload = filterPayload();

        const rendered = renderReportSchemaArtifact(payload);

        expect(v.parse(IntakeExtractionPayloadSchema, JSON.parse(rendered))).toEqual(payload);
        expect(renderReportSchemaArtifact(payload)).toBe(rendered);
    });

    it('keeps the skip reason of a not-a-filter-report payload', () => {
        const payload: IntakeExtractionPayload = v.parse(IntakeExtractionPayloadSchema, {
            verdict: IntakeVerdict.NotAFilterReport,
            reason: 'No filtering defect detected',
        });

        const rendered = renderReportSchemaArtifact(payload);
        const reparsed = JSON.parse(rendered) as IntakeExtractionPayload;

        expect(reparsed.verdict).toBe(IntakeVerdict.NotAFilterReport);
        if (reparsed.verdict === IntakeVerdict.NotAFilterReport) {
            expect(reparsed.reason).toBe('No filtering defect detected');
        }
        expect(renderReportSchemaArtifact(payload)).toBe(rendered);
    });
});
