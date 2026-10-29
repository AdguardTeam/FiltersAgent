import type { CoreConfig } from '../../src/config/config';
import type { RawIssue } from '../../src/github/fetch-issue';
import { type IssueFacts, ProblemType } from '../../src/types/issue-facts';
import { testCoreConfig } from '../config/test-core-config';

/**
 * The probe executor name for the two-element core runs: a preparable, activation-scriptable
 * registration distinct from runtime-owned executor classes.
 */
export const CORE_PROBE_NAME = 'probe_proxy';

/**
 * An environment kind the standard selection call fixture can select.
 */
type SelectionFixtureKind =
    | 'browser_extension'
    | 'adguard_cli'
    | 'unsupported_product_case'
    | typeof CORE_PROBE_NAME;

/**
 * The arguments of the standard environment-selection call fixture.
 *
 * @param kind - The environment kind selected.
 * @returns The parsed selection arguments.
 */
export function environmentSelectionArgs(
    kind: SelectionFixtureKind = 'browser_extension',
): Record<string, unknown> {
    return JSON.parse(environmentSelectionCall(kind).function.arguments) as Record<string, unknown>;
}

/**
 * The standard environment-selection call fixture, shaped as a provider tool call.
 *
 * @param kind - The environment kind selected.
 * @returns The tool call selecting that environment.
 */
export function environmentSelectionCall(kind: SelectionFixtureKind = 'browser_extension') {
    return {
        id: `select-${kind}`,
        function: {
            name: 'select_environment',
            arguments: JSON.stringify({
                kind,
                requiredCapabilities:
                    kind === 'browser_extension' ? ['browser_navigation', 'filtering_control'] : [],
                intent: {
                    issueType: kind === 'unsupported_product_case' ? 'product_specific' : 'ads',
                    rationale: 'The agent classified the issue from its prompt-safe evidence.',
                    confidence: 0.9,
                    evidence: [
                        {
                            source: 'issue_body',
                            observation: 'The report describes a website-filtering symptom.',
                        },
                    ],
                    conflicts: [],
                },
                rationale: 'The selected environment best fits the issue and host capabilities.',
                confidence: 0.85,
            }),
        },
    };
}

/**
 * Build a parser-compatible local issue fixture.
 *
 * @returns A local in-scope browser-extension issue.
 */
export function localIssue(): RawIssue {
    return {
        number: 4,
        url: 'https://github.com/example-owner/example-repo/issues/4',
        title: 'Ad placeholder remains visible',
        body: [
            '### Issue URL (Ads)',
            'https://example.com/article',
            '',
            '### System configuration',
            'AdGuard product: | AdGuard Browser Extension v5.4.3',
            'Filters: | AdGuard Base filter',
        ].join('\n'),
        state: 'open',
        labels: ['T: Ads', 'N: AdGuard Browser Extension'],
        assignee: null,
        comments: [],
    };
}

/**
 * The facts a deterministic intake of {@link localIssue} produced — spelled literally now that the
 * parser is gone.
 *
 * @returns The validated-shape issue facts.
 */
export function localFacts(): IssueFacts {
    return {
        issueNumber: 4,
        issueUrl: 'https://github.com/example-owner/example-repo/issues/4',
        reportedSiteUrls: ['https://example.com/article'],
        labels: ['T: Ads', 'N: AdGuard Browser Extension'],
        declaredIssueType: 'Ads',
        problemType: ProblemType.Ads,
        product: 'AdGuard Browser Extension v5.4.3',
        enabledFilters: [{ name: 'AdGuard Base filter', officialFilterId: 2 }],
        screenshots: [],
    };
}

/**
 * Build minimal local core configuration.
 *
 * @param baseUrl - LLM base URL; tests wiring the loop onto the hermetic provider pass its base
 *   URL, everything else keeps the fixture gateway host.
 * @returns GitHub-independent configuration for tests.
 */
export function coreConfig(baseUrl = 'https://llm.example.test/v1'): CoreConfig {
    return testCoreConfig({
        llm: { baseUrl, apiKey: 'local-key', visionModel: 'gemini-3.5-flash' },
    });
}
