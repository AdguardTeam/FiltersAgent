/**
 * Reporter parity, waived only after a launch proved it impossible.
 *
 * A report that carries a settings import URL is decided only from a verified `reported_on_current`
 * session launched with that exact URL. When the reporter's filter set does not fit Chrome's MV3
 * limits no such session can exist: the extension keeps what Chrome enabled and disables the rest,
 * so the launch Baseline ends unverified with `SettingsLimitation.Mv3LimitsExceeded`. Without a
 * waiver such a run seals after every `finish_fix` is rejected for want of that session — for
 * example 52 filters requested, 50 static rulesets allowed, 2 kept.
 *
 * This record turns that proof into the waiver: once a `reported_on_current` launch with one of the
 * reporter's own URLs (the same digest rule the launch check and the terminal gate apply) ends with
 * the MV3 marker, the run no longer requires reporter settings at termination, any verified current
 * prepared session qualifies — exactly as for a report without an import URL — and the report
 * carries the approximation as a fidelity limitation.
 */
import type { AdGuardExtensionSettingsProfile } from '../browser/adguard-extension-settings';
import { canonicalAdGuardSettingsImportUrlSha256 } from '../browser/adguard-settings-import-url';
import type { EnvironmentSelectionHost } from '../environment/environment-selection';
import { SettingsLimitation } from '../environment/settings-limitation';
import type { Logger } from '../logger/logger';
import { SettingsProfileKind } from '../types/settings-profile-kind';
import { recordMv3LimitsFidelity } from './filter-fidelity-records';
import { LaunchBaselineOutcomeKind, type LaunchBaselineOutcome } from './launch-baseline-outcome';

/**
 * The run's record of whether reporter parity was proven impossible.
 */
export class ReporterSettingsLimits {
    /**
     * The Baseline credit's diagnosis of the proving launch, once one ended with the MV3 marker.
     */
    private proof: string | undefined;

    /**
     * @param reporterUrls - The reporter's import URLs keyed by canonical digest, as the terminal
     *   gate reads them from the issue.
     * @param environmentHost - The run's environment-selection host the fidelity record lands in.
     * @param logger - Run logger receiving the waiver and any launch the proof did not accept.
     */
    constructor(
        private readonly reporterUrls: ReadonlyMap<string, string>,
        private readonly environmentHost: EnvironmentSelectionHost,
        private readonly logger: Logger,
    ) {}

    /**
     * Whether a launch with the reporter's own settings proved that the set cannot run here.
     *
     * @returns True once the proof was recorded; reporter parity is then waived for the run.
     */
    parityProvenImpossible(): boolean {
        return this.proof !== undefined;
    }

    /**
     * Record one prepared launch's Baseline outcome, waiving reporter parity when it is the proof.
     *
     * Only a `reported_on_current` request whose import URL is one of the reporter's counts: an
     * edited URL proves nothing about the reporter's set, and the launch check already refused it
     * before any browser started.
     *
     * @param settings - The settings profile the launch requested, when the launch was prepared.
     * @param outcome - The launch Baseline outcome, or undefined when no Baseline ran.
     */
    recordLaunchOutcome(
        settings: AdGuardExtensionSettingsProfile | undefined,
        outcome: LaunchBaselineOutcome | undefined,
    ): void {
        if (
            this.proof !== undefined ||
            settings?.kind !== SettingsProfileKind.ReportedOnCurrent ||
            outcome?.kind !== LaunchBaselineOutcomeKind.Unverified ||
            outcome.settingsLimitation !== SettingsLimitation.Mv3LimitsExceeded
        ) {
            return;
        }
        const digest = this.importDigest(settings.importUrl);
        if (digest === undefined || !this.reporterUrls.has(digest)) {
            this.logger.warn(
                { importUrl: settings.importUrl, detail: outcome.detail },
                "the MV3 limits were exceeded with an import URL that is not the reporter's; " +
                    'reporter parity stays required',
            );
            return;
        }
        this.proof = outcome.detail;
        this.logger.warn(
            { importUrl: settings.importUrl, detail: outcome.detail },
            "reporter parity waived: the reporter's filter set exceeds the MV3 limits, so no " +
                'reported_on_current session can verify it; any verified current prepared session ' +
                'now qualifies for the terminal decision',
        );
        recordMv3LimitsFidelity(this.environmentHost, outcome.detail, this.logger);
    }

    /**
     * The canonical digest of one requested import URL, as the reporter URL map is keyed.
     *
     * @param importUrl - The import URL the launch requested.
     * @returns The digest, or undefined when the URL does not parse (logged; such a launch never
     *   reached a Baseline with the reporter's set anyway).
     */
    private importDigest(importUrl: string): string | undefined {
        try {
            return canonicalAdGuardSettingsImportUrlSha256(new URL(importUrl).href);
        } catch (error) {
            this.logger.warn(
                { importUrl, error: error instanceof Error ? error.message : String(error) },
                'the reported_on_current import URL of the MV3-limited launch does not parse',
            );
            return undefined;
        }
    }
}
