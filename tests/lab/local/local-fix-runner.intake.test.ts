import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    BenchmarkCaseStatus,
    BenchmarkFailureKind,
    classifyAgentOutcome,
} from '../../../lab/e2e/benchmark-outcome';
import { runLocalFix } from '../../../lab/local/local-fix-runner';
import { IntakeExtractionKind } from '../../../src/intake/extract-report';
import { buildLocalIssueSnapshot } from '../../../src/local/issue-snapshot';
import { materializeLocalRunOutputDir } from '../../../src/local/output-directory';
import { readLocalRunOutput } from '../../../src/local/run-output';
import { ExtensionEnvironmentKind } from '../../../src/types/extension-environment-kind';
import { BrowserMode } from '../../../src/types/browser-mode';
import { InfrastructureFailureReason } from '../../../src/types/infrastructure-failure-reason';
import { testCoreConfig } from '../../config/test-core-config';

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

describe('local intake skip result', () => {
    it('seals an intake skip that the benchmark classifies as a failed intake', async () => {
        const root = mkdtempSync(join(tmpdir(), 'local-intake-'));
        roots.push(root);
        const issueFile = join(root, 'issue.json');
        writeFileSync(
            issueFile,
            JSON.stringify(
                buildLocalIssueSnapshot(
                    {
                        number: 42,
                        url: 'https://github.com/example-owner/example-repo/issues/42',
                        title: 'A general question',
                        body: 'How does filtering work?',
                        state: 'open',
                        labels: [],
                        assignee: null,
                        comments: [],
                    },
                    [],
                ),
            ),
        );
        const outputDir = join(root, 'run');
        materializeLocalRunOutputDir(outputDir, process.cwd());

        const paths = await runLocalFix(
            testCoreConfig({
                llm: { model: 'example-reasoning-model', visionModel: 'example-vision-model' },
            }),
            {
                issueFile,
                issueNumber: 42,
                outputDir,
                environment: ExtensionEnvironmentKind.Current,
                keepTemporaryFiles: false,
                browserMode: BrowserMode.Auto,
                verbose: false,
            },
            {
                extractReport: async () => ({
                    kind: IntakeExtractionKind.Skipped,
                    reason: 'No site URL.',
                }),
            },
        );
        const record = readLocalRunOutput(paths.runResultPath);

        expect(record.result.infrastructureFailureReason).toBe(
            InfrastructureFailureReason.InputUnavailable,
        );
        expect(classifyAgentOutcome(record.result)).toMatchObject({
            status: BenchmarkCaseStatus.InfrastructureFailure,
            failureKind: BenchmarkFailureKind.IntakeSkipped,
        });
        expect(record.result.reasoning).toContain('No site URL.');
    });
});
