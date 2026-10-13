import { describe, expect, it } from 'vitest';
import { EnvironmentCapability } from '../../src/environment/environment-vocabulary';
import {
    extensionDecision,
    cliDecision,
    host,
    readyExecutorPreparation,
} from './environment-selection-fixtures';

describe('EnvironmentSelectionHost preparation', () => {
    it('locks CLI as preparing and binds only path-free ready provenance', () => {
        const selectionHost = host();

        expect(selectionHost.select(cliDecision)).toMatchObject({
            accepted: true,
            kind: 'adguard_cli',
            locked: true,
            state: 'preparing',
        });
        // A network-level executor does not browse the reported page itself, so the run can
        // only approximate the reported product's own filtering.
        expect(selectionHost.snapshot()?.fidelityLimitations).toContainEqual({
            code: 'product_approximation',
            detail: 'The selected executor approximates the reported desktop filtering behavior.',
        });
        expect(selectionHost.snapshot()).toMatchObject({
            selectedKind: 'adguard_cli',
            state: 'preparing',
            descriptor: {
                availability: 'available',
                preparationState: 'preparable',
                capabilities: ['cli_installation', 'cli_activation'],
            },
            cliPreparation: null,
        });

        selectionHost.attachExecutorPreparation(readyExecutorPreparation());
        const snapshot = selectionHost.snapshot();
        expect(snapshot).toMatchObject({
            state: 'ready',
            cliPreparation: {
                state: 'ready',
                provenance: {
                    source: 'official_release',
                    product: 'AdGuard CLI',
                    version: '1.4.13',
                },
            },
            actual: {
                kind: 'adguard_cli',
                product: 'AdGuard CLI',
                productVersion: '1.4.13',
            },
        });
        // The published provenance carries no host paths and no release metadata.
        expect(JSON.stringify(snapshot)).not.toContain('/private/tmp');
        expect(JSON.stringify(snapshot)).not.toContain('sandbox');
        expect(JSON.stringify(snapshot)).not.toContain('archiveSha256');
        expect(JSON.stringify(snapshot)).not.toContain('signatureAlgorithm');
    });

    it('binds a prepared executor without a version claim honestly', () => {
        const selectionHost = host();
        selectionHost.select(cliDecision);

        selectionHost.attachExecutorPreparation({
            ready: true,
            provenance: {
                source: 'local_build',
                product: 'AdGuard CLI',
                version: null,
                digestB32: 'digestb32examplevalue0123456789abcdefghijklmnopqrstuvwxyz',
            },
        });

        const snapshot = selectionHost.snapshot();
        expect(snapshot).toMatchObject({
            state: 'ready',
            cliPreparation: {
                state: 'ready',
                provenance: { source: 'local_build', version: null },
            },
            actual: {
                kind: 'adguard_cli',
                product: 'AdGuard CLI',
                productVersion: null,
            },
        });
        expect(JSON.stringify(snapshot)).not.toContain('sandbox');
    });

    it('reports a missing executor build as a typed preparation limitation', () => {
        const selectionHost = host();
        selectionHost.select(cliDecision);
        selectionHost.attachExecutorPreparation({
            ready: false,
            limitation: {
                stage: 'resolve',
                code: 'adguard_cli_unconfigured',
                detail: 'No proxy build is configured; set the executor binary location.',
            },
        });

        expect(selectionHost.snapshot()).toMatchObject({
            state: 'capability_limited',
            cliPreparation: {
                state: 'limited',
                limitation: { code: 'adguard_cli_unconfigured' },
            },
        });
    });

    it('binds a preparation limitation once without unlocking fallback', () => {
        const selectionHost = host();
        selectionHost.select(cliDecision);
        selectionHost.attachExecutorPreparation({
            ready: false,
            limitation: {
                stage: 'provenance',
                code: 'version_provenance_unavailable',
                detail: 'The verified binary did not report exact build provenance.',
            },
        });

        expect(selectionHost.snapshot()).toMatchObject({
            selectedKind: 'adguard_cli',
            state: 'capability_limited',
            cliPreparation: {
                state: 'limited',
                limitation: { code: 'version_provenance_unavailable' },
            },
        });
        expect(() => selectionHost.attachExecutorPreparation(readyExecutorPreparation())).toThrow(
            /already/u,
        );
        expect(selectionHost.select(extensionDecision)).toMatchObject({
            accepted: false,
            errorKind: 'environment_locked',
            selectedKind: 'adguard_cli',
        });
    });

    it('grants executing capabilities only once the evidence route proved it filters', () => {
        const selectionHost = host();
        selectionHost.select(cliDecision);
        selectionHost.attachExecutorPreparation(readyExecutorPreparation());

        // Preparation alone advertises installation and activation, nothing that executes.
        expect(selectionHost.snapshot()?.advertisedCapabilities).toEqual([
            'cli_installation',
            'cli_activation',
        ]);

        selectionHost.attachCliEvidenceRouteReady('adguard_cli');

        const snapshot = selectionHost.snapshot();
        expect(snapshot?.state).toBe('ready');
        expect(snapshot?.advertisedCapabilities).toEqual(
            expect.arrayContaining([
                'browser_navigation',
                'filtering_control',
                'cli_filtering',
                'candidate_application',
            ]),
        );
        expect(snapshot?.missingCapabilities).toEqual([]);
    });

    it('does not report what the evidence route grants as missing after preparation', () => {
        // The model asked for navigation and candidate application,
        // heard "capability_limited" right after preparation, and wrote that into the report
        // although the route then granted both.
        const selectionHost = host();
        selectionHost.select({
            ...cliDecision,
            requiredCapabilities: [
                EnvironmentCapability.CliInstallation,
                EnvironmentCapability.CliActivation,
                EnvironmentCapability.BrowserNavigation,
                EnvironmentCapability.CandidateApplication,
                EnvironmentCapability.PhaseProof,
            ],
        });

        selectionHost.attachExecutorPreparation(readyExecutorPreparation());
        expect(selectionHost.snapshot()).toMatchObject({
            state: 'ready',
            missingCapabilities: [],
            capabilityLimits: [],
        });

        selectionHost.attachCliEvidenceRouteReady('adguard_cli');
        expect(selectionHost.snapshot()).toMatchObject({
            state: 'ready',
            missingCapabilities: [],
            capabilityLimits: [],
        });
    });

    it('still limits a prepared executor that lacks a capability no route grants', () => {
        const selectionHost = host();
        selectionHost.select({
            ...cliDecision,
            requiredCapabilities: [EnvironmentCapability.ExtensionFiltering],
        });
        const limited = {
            state: 'capability_limited',
            missingCapabilities: [EnvironmentCapability.ExtensionFiltering],
            capabilityLimits: [
                {
                    code: 'required_capability_unavailable',
                    capability: EnvironmentCapability.ExtensionFiltering,
                },
            ],
        };

        selectionHost.attachExecutorPreparation(readyExecutorPreparation());
        expect(selectionHost.snapshot()).toMatchObject(limited);

        // The route grants only its own capabilities, so the limit outlives it.
        selectionHost.attachCliEvidenceRouteReady('adguard_cli');
        expect(selectionHost.snapshot()).toMatchObject(limited);
    });

    it('keeps a route filter approximation through later fidelity recomputation', () => {
        const selectionHost = host();
        selectionHost.select(cliDecision);
        selectionHost.bindActualContext('adguard_cli', {
            product: 'AdGuard CLI',
            productVersion: '1.4.13',
            browser: 'CloakBrowser Chromium',
        });
        selectionHost.recordFilterSelectionApproximation('adguard_cli', 'Unavailable: 214, 224.');

        // Binding context again recomputes product/browser notes; the route's own note must remain.
        selectionHost.bindActualContext('adguard_cli', {
            product: 'AdGuard CLI',
            productVersion: '1.4.13',
            browser: 'CloakBrowser Chromium',
        });
        const snapshot = selectionHost.snapshot();
        expect(snapshot?.fidelityLimitations).toContainEqual({
            code: 'filter_selection_approximation',
            detail: 'Unavailable: 214, 224.',
        });
        // Weaker evidence is not a missing capability: the lock must not degrade.
        expect(snapshot?.state).not.toBe('capability_limited');
    });
});
