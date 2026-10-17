import { toAgentIssueInput, type LocalIssueSnapshot } from '../../src/local/issue-snapshot';
import type { HumanRuleIsolationCandidate } from './historical-case-metadata';

/**
 * Encode one exact text value as it appears inside a JSON-stringified agent input.
 *
 * @param value - Unescaped title, body, comment, label, or attachment field value.
 * @returns Lower-cased escaped JSON fragment without surrounding quotes.
 */
function agentInputTextFragment(value: string): string {
    return JSON.stringify(value).slice(1, -1).toLowerCase();
}

/**
 * Assert that the closed human answer cannot cross the model-input boundary.
 *
 * The raw issue history deliberately remains complete for audit. Only the narrowed
 * {@link toAgentIssueInput} representation is subject to this boundary.
 *
 * @param snapshot - Complete raw issue snapshot used to derive agent-visible input.
 * @param humanFixCommit - Full closed human commit.
 * @param humanRuleCandidates - Transient answer fingerprints extracted from the human diff.
 * @returns Nothing when the human answer is absent from agent-visible input.
 */
export function assertOracleIsolation(
    snapshot: LocalIssueSnapshot,
    humanFixCommit: string,
    humanRuleCandidates: readonly HumanRuleIsolationCandidate[] = [],
): void {
    const agentInput = JSON.stringify(toAgentIssueInput(snapshot));
    const normalizedAgentInput = agentInput.toLowerCase();
    const shortHumanCommit = humanFixCommit.slice(0, 7).toLowerCase();
    if (normalizedAgentInput.includes(shortHumanCommit)) {
        throw new Error('Full or abbreviated human fix commit leaked into agent-visible input.');
    }
    if (
        /github\.com[\\/]adguardteam[\\/]adguardfilters[\\/](?:pull|pulls)[\\/]\d+/iu.test(
            agentInput,
        ) ||
        /\b(?:pr|pull request)\s*:?[ \t]*#?\d+\b/iu.test(agentInput)
    ) {
        throw new Error('Human pull request reference leaked into agent-visible input.');
    }
    for (const candidate of humanRuleCandidates) {
        const canonicalRule = candidate.canonicalRule.trim().toLowerCase();
        const sourceRule = candidate.sourceRule.trim().toLowerCase();
        if (!canonicalRule || !sourceRule) {
            throw new Error('Human rule isolation candidate is incomplete.');
        }
        if (
            normalizedAgentInput.includes(agentInputTextFragment(canonicalRule)) ||
            normalizedAgentInput.includes(agentInputTextFragment(sourceRule))
        ) {
            throw new Error('Human filter rule leaked into agent-visible input.');
        }
    }
}
