import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadLocalIssueSnapshot, toAgentIssueInput } from '../../../src/local/issue-snapshot';
import { normalizeRule } from '../../../src/repo/rule-normalizer';
import { loadGoldenHumanOracle, loadGoldenRunCase } from '../../../lab/e2e/golden-case';
import { extractHumanCommitFix } from '../../../lab/e2e/human-commit-reader';
import { listGoldenCaseNames } from '../../../lab/e2e/golden-suite';

const agentInputTextFragment = (value: string): string =>
    JSON.stringify(value).slice(1, -1).toLowerCase();

describe('pilot golden e2e cases', () => {
    it('keep the human answer out of every case agent input', async () => {
        const casesRoot = join(process.cwd(), 'lab', 'benchmark', 'e2e', 'cases');
        const caseNames = listGoldenCaseNames(casesRoot);
        expect(caseNames.length).toBeGreaterThan(0);
        for (const caseName of caseNames) {
            const caseDirectory = join(casesRoot, caseName);
            const run = loadGoldenRunCase(caseDirectory);
            const oracle = loadGoldenHumanOracle(caseDirectory);
            const humanFix = await extractHumanCommitFix(oracle.humanFixCommit);
            const snapshot = loadLocalIssueSnapshot(run.issueFile);
            const agentInput = toAgentIssueInput(snapshot);
            const agentInputSource = JSON.stringify(agentInput).toLowerCase();

            expect(run.config.issueNumber).toBe(snapshot.rawIssue.number);
            expect(snapshot.rawIssue.state).toBe('closed');
            expect(agentInput.attachments.length).toBeGreaterThan(0);
            expect(agentInputSource).not.toContain(oracle.humanFixCommit.toLowerCase());
            expect(agentInputSource).not.toContain(oracle.humanFixCommit.slice(0, 7).toLowerCase());
            expect(humanFix.candidates.length).toBeGreaterThan(0);
            for (const candidate of humanFix.candidates) {
                const canonicalRule = normalizeRule(candidate.rule).canonical.toLowerCase();
                const canonicalSourceRule = normalizeRule(
                    candidate.sourceRule,
                ).canonical.toLowerCase();
                expect(agentInputSource).not.toContain(
                    agentInputTextFragment(candidate.rule.trim()),
                );
                expect(agentInputSource).not.toContain(
                    agentInputTextFragment(candidate.sourceRule.trim()),
                );
                expect(agentInputSource).not.toContain(agentInputTextFragment(canonicalRule));
                expect(agentInputSource).not.toContain(agentInputTextFragment(canonicalSourceRule));
            }
            expect(readFileSync(run.runConfigPath, 'utf8')).not.toContain(oracle.humanFixCommit);
        }
        // One sequential shallow fetch per case from the public AdguardFilters remote; anonymous
        // GitHub fetch latency was observed at 18–27 s each (2026-09-08), so the network-only
        // budget needs that headroom — 120 s previously timed the whole suite red under a slow
        // network even though every assertion was passing.
    }, 600_000);
});
