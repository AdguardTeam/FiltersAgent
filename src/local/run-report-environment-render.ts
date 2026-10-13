/**
 * The environment-selection section of the local agent report: which filtering environment the run
 * locked, what it was asked to provide, and — for a preparable executor selection — the path-free
 * provenance of the preparation it became ready from, or the exact limitation that stopped that
 * preparation.
 *
 * A pure `EnvironmentSelectionSnapshot -> string[]` projection, called by `run-report-render` and
 * calling nothing back.
 */
import { FilterBaselineStatus } from '../environment/filter-baseline-status';
import { EnvironmentPreparationState } from '../environment/environment-vocabulary';
import { type EnvironmentSelectionSnapshot } from '../environment/environment-selection-contract';
import { ExecutorPreparationState } from '../environment/executor-preparation';
import { renderInlineValues, renderItemsOrFallback } from './run-report-values';

/**
 * Render path-free executor preparation provenance or its exact preparation limitation.
 *
 * @param selection - Schema-validated locked environment selection.
 * @returns Markdown lines for preparable-executor selections, or no lines for executors that need
 *   no preparation.
 */
export function renderCliInstallationPreparation(
    selection: EnvironmentSelectionSnapshot,
): string[] {
    const descriptor = selection.descriptor;
    if (
        descriptor === null ||
        descriptor.preparationState !== EnvironmentPreparationState.Preparable
    ) {
        return [];
    }
    const preparation = selection.cliPreparation;
    if (!preparation) {
        return ['', '### Executor preparation', '', '- State: `not_recorded`'];
    }
    if (preparation.state === ExecutorPreparationState.Limited) {
        return [
            '',
            '### Executor preparation',
            '',
            `- State: \`${ExecutorPreparationState.Limited}\``,
            `- Failed stage: \`${preparation.limitation.stage}\``,
            `- Limitation code: \`${preparation.limitation.code}\``,
            `- Detail: ${preparation.limitation.detail}`,
        ];
    }
    const provenance = preparation.provenance;
    return [
        '',
        '### Executor preparation',
        '',
        `- State: \`${ExecutorPreparationState.Ready}\``,
        `- Source: \`${provenance.source}\``,
        `- Product: \`${provenance.product}\``,
        `- Version: \`${provenance.version ?? 'unknown (unavailable)'}\``,
        `- Digest: \`${provenance.digestB32}\``,
    ];
}

/**
 * Render the list selection a declaring blocker's run browsed with.
 *
 * A run whose blocker declares its own lists names those lists, and names whatever the reporter had
 * enabled that the selection does not cover — a fidelity signal, never a refusal. A run whose
 * baseline was resolved against the official catalog renders nothing here; its official identities
 * are already the subject of the rest of this block.
 *
 * @param selection - The locked environment-selection snapshot.
 * @returns Zero lines, or the declared selection and its unmatched reported names.
 */
function renderDeclaredFilterBaseline(selection: EnvironmentSelectionSnapshot): string[] {
    const baseline = selection.filterBaseline;
    if (baseline?.status !== FilterBaselineStatus.Declared) {
        return [];
    }
    return [
        `- Declared list selection: ${renderInlineValues(baseline.listKeys)}`,
        `- Reported lists outside that selection: ${renderInlineValues(
            baseline.unmatchedReportedNames,
        )}`,
    ];
}

/**
 * Render the durable environment choice without conflating declared, observed, reported, or actual
 * provenance.
 *
 * @param selection - Schema-validated selection snapshot from the core result.
 * @returns Markdown lines describing the choice, lock, intent, capabilities, and fidelity gaps.
 */
export function renderEnvironmentSelection(
    selection: EnvironmentSelectionSnapshot | undefined,
): string[] {
    if (!selection) {
        return [
            '## Environment selection',
            '',
            'No environment-selection snapshot is available for this legacy result.',
        ];
    }

    return [
        '## Environment selection',
        '',
        `- Selected kind: \`${selection.selectedKind}\``,
        `- State: \`${selection.state}\``,
        `- Selection rationale: ${selection.rationale}`,
        `- Selection confidence: \`${selection.confidence}\``,
        `- Required capabilities: ${renderInlineValues(selection.requiredCapabilities)}`,
        `- Advertised capabilities: ${renderInlineValues(selection.advertisedCapabilities)}`,
        `- Missing capabilities: ${renderInlineValues(selection.missingCapabilities)}`,
        `- Locked at: \`${selection.lockedAt}\``,
        '',
        '### Declared and observed intent',
        '',
        `- Declared issue-form type: \`${selection.declared.issueFormType ?? 'n/a'}\``,
        `- Issue labels: ${renderInlineValues(selection.declared.labels)}`,
        `- Observed issue type: \`${selection.observed.issueType}\``,
        `- Classification rationale: ${selection.observed.rationale}`,
        `- Classification confidence: \`${selection.observed.confidence}\``,
        '- Classification evidence:',
        ...renderItemsOrFallback(
            selection.observed.evidence,
            (evidence) => `  - \`${evidence.source}\` — ${evidence.observation}`,
            '  - None recorded.',
        ),
        '- Classification conflicts:',
        ...renderItemsOrFallback(
            selection.observed.conflicts,
            (conflict) => `  - ${conflict}`,
            '  - None recorded.',
        ),
        '- Intent history:',
        ...selection.intentHistory.map(
            (intent) =>
                `  - \`${intent.issueType}\` at \`${intent.confidence}\` — ${intent.rationale}`,
        ),
        '',
        '### Reported and actual execution context',
        '',
        `- Reported product: \`${selection.reported.product ?? 'n/a'}\``,
        `- Reported OS: \`${selection.reported.os ?? 'n/a'}\``,
        `- Reported browser: \`${selection.reported.browser ?? 'n/a'}\``,
        `- Actual environment kind: \`${selection.actual?.kind ?? 'n/a'}\``,
        `- Actual product: \`${selection.actual?.product ?? 'n/a'}\``,
        `- Actual product version: \`${selection.actual?.productVersion ?? 'n/a'}\``,
        `- Actual browser: \`${selection.actual?.browser ?? 'n/a'}\``,
        '- Fidelity limitations:',
        ...renderItemsOrFallback(
            selection.fidelityLimitations,
            (limitation) => `  - \`${limitation.code}\` — ${limitation.detail}`,
            '  - None recorded.',
        ),
        '- Capability limits:',
        ...renderItemsOrFallback(
            selection.capabilityLimits,
            (limitation) => {
                const capability = limitation.capability ? ` (\`${limitation.capability}\`)` : '';
                return `  - \`${limitation.code}\`${capability} — ${limitation.detail}`;
            },
            '  - None recorded.',
        ),
        ...renderDeclaredFilterBaseline(selection),
        // Beside the other fidelity gaps, because a reproduction that left a reported source out is
        // exactly that: the executed baseline is narrower than what the reporter was running.
        '- Skipped filter sources:',
        ...renderItemsOrFallback(
            selection.filterBaseline?.skippedSources ?? [],
            (source) => `  - \`${source.kind}\` — ${source.reportedName}`,
            '  - None recorded.',
        ),
        ...renderCliInstallationPreparation(selection),
        '',
        '- Rejected selection requests:',
        ...renderItemsOrFallback(
            selection.rejectedRequests,
            (request) =>
                `  - \`${request.requestedKind}\` at \`${request.rejectedAt}\` ` +
                `(confidence \`${request.confidence}\`) — ${request.rationale}`,
            '  - None recorded.',
        ),
    ];
}
