import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadLocalIssueSnapshot, toAgentIssueInput } from '../../../src/local/issue-snapshot';
import { normalizeRule } from '../../../src/repo/rule-normalizer';
import { loadGoldenHumanOracle, loadGoldenRunCase } from '../../../lab/e2e/golden-case';
import { extractHumanCommitFix } from '../../../lab/e2e/human-commit-oracle';

const agentInputTextFragment = (value: string): string =>
    JSON.stringify(value).slice(1, -1).toLowerCase();

const EXPECTED_PILOT_CASES = {
    'money-pl-235679': {
        issueNumber: 235679,
        extensionVersion: '5.4.3.96',
        filtersBaseSha: '203b5312920118056616596bc62a19318f57d6d3',
        humanFixCommit: 'ba2dd4007fe83ead961c22dda013c5442d7456c4',
    },
    'autoblog-spidersweb-pl-235567': {
        issueNumber: 235567,
        extensionVersion: '5.4.3.95',
        filtersBaseSha: '4e28093e719cbb2bab819b6d3a84c12f441343c6',
        humanFixCommit: '7198627160ef46235fbf83a8e1c0f2658bc2dcd6',
    },
    'e-words-jp-235510': {
        issueNumber: 235510,
        extensionVersion: '5.4.3.84',
        filtersBaseSha: 'cd93c10da43f3dd3197d854adbe1b8218fdf8353',
        humanFixCommit: 'ec975aaaf2675e246a7e47553b28689e2e63582a',
    },
    'jelonka-com-234966': {
        issueNumber: 234966,
        extensionVersion: '5.4.3.87',
        filtersBaseSha: 'a220c34e6e26ce6e473c0ba1e7a339023da4eab3',
        humanFixCommit: '506ed6894a2fe30c15bbb70e912968ac2e8536d3',
    },
    'rmcbfmplay-com-234430': {
        issueNumber: 234430,
        extensionVersion: '5.4.3.79',
        filtersBaseSha: 'd467c114b8d13eb8f0aa795755c5481677b85f83',
        humanFixCommit: '189c379260bf80951560510ff1788320c5789621',
    },
    'sbt-com-br-233534': {
        issueNumber: 233534,
        extensionVersion: '5.4.3.55',
        filtersBaseSha: 'e4efd17f3b92eb3d8ae8e1ec016dd99f03962dda',
        humanFixCommit: '8b2e1e2bbde06d489dc6a7f9f0b3b547d64600a6',
    },
    'gsmarena-com-233493': {
        issueNumber: 233493,
        extensionVersion: '5.4.3.55',
        filtersBaseSha: '2a5b9f8ab0437a720de962e20a4c9d38859bb420',
        humanFixCommit: '47dadcd767561710b1b748f0f0ee840628454272',
    },
    'devsoftwr-com-234282': {
        issueNumber: 234282,
        extensionVersion: '5.4.3.77',
        filtersBaseSha: 'd71b139a1c2079e169b69f2a715195c0a6c65a5d',
        humanFixCommit: '41c2e95df705ac73bdd01d9b4423a6065490182e',
    },
    'yt1s-com-co-234396': {
        issueNumber: 234396,
        extensionVersion: '5.4.3.78',
        filtersBaseSha: 'd632203acbed5c17ef6056ad26cb695d903ef5c7',
        humanFixCommit: 'b6130b6813ca2bc3f2213f9623c397928849b805',
    },
    'ipaomtk-com-232888': {
        issueNumber: 232888,
        extensionVersion: '5.4.3.38',
        filtersBaseSha: '1cf1de199b1a46305062fcedf68f884d6c97eb3e',
        humanFixCommit: 'ef8a6632bbe3531bdc945ac044f082dbb3bd16c1',
    },
} as const;

describe('pilot golden e2e cases', () => {
    it('keep the human answer out of every case agent input', async () => {
        const workspaceRoot = process.cwd();
        for (const [caseName, expected] of Object.entries(EXPECTED_PILOT_CASES)) {
            const caseDirectory = join(workspaceRoot, 'lab', 'benchmark', 'e2e', 'cases', caseName);
            const run = loadGoldenRunCase(caseDirectory);
            const oracle = loadGoldenHumanOracle(caseDirectory);
            const humanFix = await extractHumanCommitFix(oracle.humanFixCommit);
            const snapshot = loadLocalIssueSnapshot(run.issueFile);
            const agentInput = toAgentIssueInput(snapshot);
            const agentInputSource = JSON.stringify(agentInput).toLowerCase();

            expect(run.config.issueNumber).toBe(snapshot.rawIssue.number);
            expect(run.config.issueNumber).toBe(expected.issueNumber);
            expect(run.config.filtersBaseSha).toBe(expected.filtersBaseSha);
            expect(oracle.humanFixCommit).toBe(expected.humanFixCommit);
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
        // Ten sequential shallow fetches from the public AdguardFilters remote; anonymous GitHub
        // fetch latency was observed at 18–27 s each (2026-09-08), so the network-only budget
        // needs that headroom — 120 s previously timed the whole suite red under a slow network
        // even though every assertion was passing.
    }, 600_000);
});
