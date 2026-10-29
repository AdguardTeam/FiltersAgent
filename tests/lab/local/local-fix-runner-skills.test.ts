import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runLocalFix } from '../../../lab/local/local-fix-runner';
import type { CoreConfig } from '../../../src/config/config';
import { REPOSITORY_SKILLS_PATH } from '../../../src/knowledge/repository-skills';
import { buildLocalIssueSnapshot } from '../../../src/local/issue-snapshot';
import type { FixCoreIssueInput, FixCoreOptions } from '../../../src/orchestrator/fix-core-inputs';
import { BrowserMode } from '../../../src/types/browser-mode';
import { ExtensionEnvironmentKind } from '../../../src/types/extension-environment-kind';
import { REPORT_STYLE_SKILL, writeSkill } from '../../pi/skill-fixtures';
import {
    coreConfig,
    coreResult,
    extractionSeam,
    observeNoUpstream,
    prepareKnowledgeBase,
    preparedCheckoutStub,
    rawIssue,
} from './local-fix-runner-fixtures';

describe('runLocalFix repository skills', () => {
    it.each([
        {
            name: 'hands the core the checkout skills directory',
            refuseRepositoryInstruction: undefined,
        },
        {
            name: 'omits the checkout skills directory when repository instructions are refused',
            refuseRepositoryInstruction: true,
        },
    ])('$name', async ({ refuseRepositoryInstruction }) => {
        const caseDir = mkdtempSync(join(tmpdir(), 'local-skills-'));
        const checkoutPath = join(caseDir, 'checkout');
        writeSkill(join(checkoutPath, REPOSITORY_SKILLS_PATH), REPORT_STYLE_SKILL);
        const issueFile = join(caseDir, 'issue.json');
        const snapshot = buildLocalIssueSnapshot(
            { ...rawIssue, url: 'https://github.com/example-owner/example-repo/issues/4' },
            [],
        );
        writeFileSync(issueFile, JSON.stringify(snapshot), 'utf8');
        const runCore = vi.fn(
            async (_config: CoreConfig, _issue: FixCoreIssueInput, _options: FixCoreOptions) =>
                coreResult(),
        );

        try {
            await runLocalFix(
                coreConfig,
                {
                    issueNumber: 4,
                    issueFile,
                    environment: ExtensionEnvironmentKind.Current,
                    outputDir: join(caseDir, 'output'),
                    keepTemporaryFiles: false,
                    browserMode: BrowserMode.Auto,
                    verbose: false,
                    ...(refuseRepositoryInstruction === undefined
                        ? {}
                        : { refuseRepositoryInstruction }),
                },
                {
                    ...extractionSeam,
                    runFixCore: runCore,
                    withPreparedFiltersCheckout: preparedCheckoutStub(checkoutPath),
                    withPreparedKnowledgeBase: prepareKnowledgeBase,
                    observeUpstreamDrift: observeNoUpstream,
                },
            );

            expect(runCore).toHaveBeenCalledOnce();
            const options = runCore.mock.calls[0]?.[2] as FixCoreOptions;
            expect(options.skillsDir).toBe(
                refuseRepositoryInstruction === true
                    ? undefined
                    : join(checkoutPath, REPOSITORY_SKILLS_PATH),
            );
        } finally {
            rmSync(caseDir, { recursive: true, force: true });
        }
    });
});
