import type { Finding } from '../types/site-analysis';

/**
 * The findings the model reports during one live browser session.
 *
 * The `report_finding` tool appends to it while the agent loop runs, and the replay mode reads the
 * collected findings back once the loop ends.
 */
export class SiteAnalyzer {
    private readonly findings: Finding[] = [];

    /**
     * Return a snapshot of the current findings accumulator.
     *
     * @returns The collected findings so far.
     */
    getFindings(): Finding[] {
        return this.findings;
    }

    /**
     * Append a finding to the accumulator (called by the `report_finding` tool handler).
     *
     * @param finding - The finding reported by the LLM.
     */
    addFinding(finding: Finding): void {
        this.findings.push(finding);
    }
}
