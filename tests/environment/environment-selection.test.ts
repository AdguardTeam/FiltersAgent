import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import {
    FilteringEnvironmentDescriptorSchema,
    type FilteringEnvironmentDescriptor,
} from '../../src/environment/environment-vocabulary';
import { EnvironmentSelectionHost } from '../../src/environment/environment-selection';
import { reportedFilters } from './reported-filter-fixtures';
import {
    facts,
    intent,
    extensionDecision,
    cliDecision,
    extensionDescriptor,
    cliDescriptor,
    host,
    unavailableExtensionDescriptor,
} from './environment-selection-fixtures';

describe('EnvironmentSelectionHost', () => {
    it('locks the first Extension selection and preserves declared and reported context', () => {
        const selectionHost = host();

        expect(selectionHost.select(extensionDecision)).toMatchObject({
            accepted: true,
            kind: 'browser_extension',
            locked: true,
            state: 'ready',
        });
        expect(selectionHost.snapshot()).toMatchObject({
            selectedKind: 'browser_extension',
            state: 'ready',
            declared: { issueFormType: 'Ads', labels: ['T: Ads', 'N: AdGuard for Windows'] },
            reported: {
                product: 'AdGuard for Windows',
                os: 'Windows 11',
                browser: 'Edge',
            },
            observed: intent,
            rejectedRequests: [],
        });
    });

    it('binds the executable official baseline to the locked Extension environment', () => {
        const selectionHost = host();

        expect(selectionHost.select(extensionDecision)).toMatchObject({
            accepted: true,
            state: 'ready',
            limitationCode: null,
            filterBaseline: { status: 'executable' },
        });
        expect(selectionHost.snapshot()?.filterBaseline).toEqual({
            status: 'executable',
            officialFilters: [
                {
                    filterId: 2,
                    listKey: 'adguard:2',
                    name: 'AdGuard Base filter',
                    reportedName: 'AdGuard Base filter',
                },
            ],
            skippedSources: [],
        });
    });

    it.each([
        ['distinct', ['cli_filtering', 'cli_installation', 'cli_activation'] as const],
        ['repeated', Array.from({ length: 16 }, () => 'cli_filtering' as const)],
    ] as const)(
        'answers %s unadvertised capabilities with a typed capability-limited response',
        (_label, requiredCapabilities) => {
            const selectionHost = host();

            expect(
                selectionHost.select({
                    ...extensionDecision,
                    requiredCapabilities: [...requiredCapabilities],
                }),
            ).toMatchObject({
                accepted: true,
                kind: 'browser_extension',
                locked: true,
                state: 'capability_limited',
                limitationCode: 'required_capability_unavailable',
            });
            const snapshot = selectionHost.snapshot();
            expect(snapshot?.missingCapabilities).toEqual([...new Set(requiredCapabilities)]);
            expect(snapshot?.capabilityLimits.map((limit) => limit.capability)).toEqual([
                ...new Set(requiredCapabilities),
            ]);
        },
    );

    it.each([
        [[] as string[], 'filter_selection_missing'],
        [['AdGuard Bse filter'], 'no_official_filter_baseline'],
        [['EasyList'], 'no_official_filter_baseline'],
    ] as const)(
        'refuses a ready filtering environment for %j and records %s',
        (enabledFilters, code) => {
            for (const decision of [extensionDecision, cliDecision]) {
                const selectionHost = host(reportedFilters(...enabledFilters));

                expect(selectionHost.select(decision)).toMatchObject({
                    accepted: true,
                    kind: decision.kind,
                    state: 'capability_limited',
                    limitationCode: 'filter_selection_not_executable',
                    filterBaseline: { status: 'not_executable', code },
                });
                const snapshot = selectionHost.snapshot();
                expect(snapshot).toMatchObject({
                    state: 'capability_limited',
                    filterBaseline: { status: 'not_executable', code },
                });
                expect(
                    snapshot?.capabilityLimits.filter(
                        (limit) => limit.code === 'filter_selection_not_executable',
                    ),
                ).toHaveLength(1);
            }
        },
    );

    it('locks an unsupported product case without a filter baseline', () => {
        const selectionHost = host([]);

        expect(
            selectionHost.select({
                ...extensionDecision,
                kind: 'unsupported_product_case',
                requiredCapabilities: [],
                rationale: 'The report concerns the Browser Assistant user interface.',
                intent: { ...intent, issueType: 'product_specific' },
            }),
        ).toMatchObject({ accepted: true, state: 'unsupported', filterBaseline: null });
        expect(selectionHost.snapshot()?.filterBaseline).toBeNull();
    });

    it('locks the sole executor deterministically without a model turn', () => {
        const selectionHost = new EnvironmentSelectionHost(facts, [extensionDescriptor], {
            now: () => '2026-07-23T20:00:00.000Z',
        });

        expect(selectionHost.lockSoleExecutor('browser_extension')).toMatchObject({
            accepted: true,
            kind: 'browser_extension',
            locked: true,
            state: 'ready',
        });
        expect(selectionHost.snapshot()).toMatchObject({
            selectedKind: 'browser_extension',
            state: 'ready',
            rationale: 'Sole executor available for this run',
            observed: { issueType: 'unknown', confidence: 1 },
        });
    });

    it('locks a sole preparable executor into its preparing state without a model turn', () => {
        const selectionHost = new EnvironmentSelectionHost(facts, [cliDescriptor], {
            now: () => '2026-07-23T20:00:00.000Z',
        });

        expect(selectionHost.lockSoleExecutor('adguard_cli')).toMatchObject({
            accepted: true,
            kind: 'adguard_cli',
            state: 'preparing',
        });
        expect(selectionHost.snapshot()?.cliPreparation).toBeNull();
    });

    it('rejects a sole lock of a name outside the advertised set', () => {
        const selectionHost = host();

        expect(selectionHost.lockSoleExecutor('ghost_executor')).toMatchObject({
            accepted: false,
            errorKind: 'invalid_environment_selection',
        });
        expect(selectionHost.snapshot()).toBeNull();
    });

    it('rejects an unknown executor selection by naming the advertised set', () => {
        const selectionHost = host();

        const response = selectionHost.select({
            ...extensionDecision,
            kind: 'ghost_executor',
        });
        expect(response).toMatchObject({
            accepted: false,
            errorKind: 'invalid_environment_selection',
        });
        if (response.accepted) {
            expect.unreachable('The host must reject an unknown executor.');
        }
        expect(response.error).toContain('Unknown executor "ghost_executor"');
        expect(response.error).toContain('browser_extension, adguard_cli');
        expect(selectionHost.snapshot()).toBeNull();
    });

    it('rejects duplicate executor descriptors by naming their kind', () => {
        expect(
            () => new EnvironmentSelectionHost(facts, [extensionDescriptor, extensionDescriptor]),
        ).toThrow(/Duplicate executor descriptor for "browser_extension"/u);
    });

    it('rejects an empty run executor set', () => {
        expect(() => new EnvironmentSelectionHost(facts, [])).toThrow(/at least one/i);
    });

    it('records a fresh unavailable-executor limitation with the generic code', () => {
        const selectionHost = new EnvironmentSelectionHost(facts, [
            unavailableExtensionDescriptor(),
        ]);

        const response = selectionHost.select(extensionDecision);
        expect(response).toMatchObject({
            accepted: true,
            state: 'capability_limited',
            limitationCode: 'executor_unavailable',
        });
        expect(selectionHost.snapshot()?.capabilityLimits[0]).toMatchObject({
            kind: 'browser_extension',
            code: 'executor_unavailable',
        });
    });

    it('rejects descriptors whose kind is not a bounded executor identifier', () => {
        const badDescriptor: FilteringEnvironmentDescriptor = {
            ...extensionDescriptor,
            kind: 'Not A Name',
        };
        expect(() =>
            v.parse(v.array(FilteringEnvironmentDescriptorSchema), [badDescriptor]),
        ).toThrow();
        expect(
            v.is(FilteringEnvironmentDescriptorSchema, {
                ...cliDescriptor,
                kind: 'product_cli_proxy',
            }),
        ).toBe(true);
    });

    it('locks an unsupported product case without selecting a filtering descriptor', () => {
        const selectionHost = host();

        expect(
            selectionHost.select({
                ...extensionDecision,
                kind: 'unsupported_product_case',
                requiredCapabilities: [],
                rationale: 'The report concerns the Browser Assistant user interface.',
                intent: { ...intent, issueType: 'product_specific' },
            }),
        ).toMatchObject({
            accepted: true,
            kind: 'unsupported_product_case',
            locked: true,
            state: 'unsupported',
        });
        expect(selectionHost.snapshot()?.descriptor).toBeNull();
    });

    it('rejects every later selection and retains the bounded request audit', () => {
        const selectionHost = host();
        selectionHost.select(cliDecision);

        expect(selectionHost.select(extensionDecision)).toMatchObject({
            accepted: false,
            errorKind: 'environment_locked',
            selectedKind: 'adguard_cli',
        });
        expect(selectionHost.select(cliDecision)).toMatchObject({
            accepted: false,
            errorKind: 'environment_locked',
            selectedKind: 'adguard_cli',
        });
        expect(selectionHost.snapshot()?.rejectedRequests).toHaveLength(2);
    });

    it('refines observed intent without changing declared context or the locked environment', () => {
        const selectionHost = host();
        selectionHost.select(extensionDecision);

        expect(
            selectionHost.updateObservedIntent({
                issueType: 'incorrect_blocking',
                rationale: 'Browser evidence shows filtering causes the missing content.',
                confidence: 0.95,
                evidence: [
                    { source: 'browser', observation: 'The control works and filtering breaks.' },
                ],
                conflicts: ['The issue label says Ads.'],
            }),
        ).toMatchObject({ accepted: true, selectedKind: 'browser_extension' });
        expect(selectionHost.snapshot()).toMatchObject({
            selectedKind: 'browser_extension',
            declared: { issueFormType: 'Ads', labels: ['T: Ads', 'N: AdGuard for Windows'] },
            observed: { issueType: 'incorrect_blocking' },
            intentHistory: [{ issueType: 'ads' }, { issueType: 'incorrect_blocking' }],
        });
    });

    it('allows only the locked integration to bind actual execution context', () => {
        const selectionHost = host();
        selectionHost.select(extensionDecision);

        expect(() =>
            selectionHost.bindActualContext('adguard_cli', {
                product: 'AdGuard CLI',
                browser: 'CloakBrowser Chromium',
                productVersion: '1.0.0',
            }),
        ).toThrow(/locked environment/u);

        selectionHost.bindActualContext('browser_extension', {
            product: 'AdGuard Browser Extension',
            browser: 'CloakBrowser Chromium',
            productVersion: '5.4.3.104',
        });
        expect(selectionHost.snapshot()).toMatchObject({
            reported: { product: 'AdGuard for Windows', browser: 'Edge' },
            actual: {
                kind: 'browser_extension',
                product: 'AdGuard Browser Extension',
                browser: 'CloakBrowser Chromium',
            },
            fidelityLimitations: [
                { code: 'product_approximation' },
                { code: 'browser_approximation' },
            ],
        });
    });

    it('rejects invalid unbounded model input without locking the host', () => {
        const selectionHost = host();
        const invalid = {
            ...extensionDecision,
            rationale: 'x'.repeat(2_001),
        };

        expect(selectionHost.select(invalid)).toMatchObject({
            accepted: false,
            errorKind: 'invalid_environment_selection',
        });
        expect(selectionHost.snapshot()).toBeNull();
    });
});
