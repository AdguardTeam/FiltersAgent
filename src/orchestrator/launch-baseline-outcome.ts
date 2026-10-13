/**
 * What one launch Baseline application ends in, and how the launch result names it to the model.
 *
 * `phase-application-launch.ts` produces these outcomes; `agent-runtime.ts`'s `launch_browser`
 * spreads `launchBaselineSettingsFields` into its result beside `settingsVerified`, so the model
 * learns not only that the settings did not verify but why, typed where a why has a code.
 */
import type { AdGuardExtensionStateRead } from '../browser/adguard-extension-state-shapes';
import type { ApplicationInstructionGap } from '../environment/application-instruction-gap';
import type { FilterListKey } from '../environment/filter-list-ref';
import type { ListSliceFacts } from '../environment/list-slice';
import { SettingsLimitation } from '../environment/settings-limitation';

/**
 * Kinds one launch Baseline application can end in.
 */
export const LaunchBaselineOutcomeKind = {
    /**
     * The host read the prepared settings back and the Baseline state matched them.
     */
    Verified: 'verified',

    /**
     * The session's baseline is the run instruction's own declaration, credited without a live
     * state read: the family has none the host can read.
     */
    Declared: 'declared',

    /**
     * The instruction's application contract refused before any model turn.
     */
    Refused: 'refused',

    /**
     * The Baseline could not be verified: the steps ran without matching, or the launch could not
     * run them at all (missing context, failed pre-read, non-convergent set, or an abort).
     */
    Unverified: 'unverified',
} as const;

/**
 * LaunchBaselineOutcomeKind value.
 */
export type LaunchBaselineOutcomeKind =
    (typeof LaunchBaselineOutcomeKind)[keyof typeof LaunchBaselineOutcomeKind];

/**
 * Outcome of one prepared session's launch Baseline application.
 */
export type LaunchBaselineOutcome =
    | {
          /**
           * Discriminator: the host read-back verified the prepared settings.
           */
          kind: typeof LaunchBaselineOutcomeKind.Verified;

          /**
           * The complete host read-back the session's settings record is derived from.
           */
          readBack: AdGuardExtensionStateRead;

          /**
           * What the session reports about the list slice it runs, when its launch requested one.
           */
          listSlice?: ListSliceFacts;
      }
    | {
          /**
           * Discriminator: the baseline is the instruction's own declared list selection.
           */
          kind: typeof LaunchBaselineOutcomeKind.Declared;

          /**
           * The executable list keys the session launched with.
           */
          listKeys: readonly FilterListKey[];

          /**
           * Bounded detail naming what the declaration credited and what it could not observe.
           */
          detail: string;
      }
    | {
          /**
           * Discriminator: the application contract refused before any model turn.
           */
          kind: typeof LaunchBaselineOutcomeKind.Refused;

          /**
           * Stable refusal class recording what the instruction is missing.
           */
          gap: ApplicationInstructionGap;

          /**
           * Bounded detail naming what is missing.
           */
          detail: string;
      }
    | {
          /**
           * Discriminator: the Baseline did not verify.
           */
          kind: typeof LaunchBaselineOutcomeKind.Unverified;

          /**
           * Bounded detail naming the mismatch or the failure that prevented a verification.
           */
          detail: string;

          /**
           * The browser limit that made the requested settings unreachable, when the Baseline's
           * credit diagnosed one. The runtime reads it to decide whether reporter parity is still
           * possible; the launch result names it beside the guidance for what to do instead.
           */
          settingsLimitation?: SettingsLimitation;
      };

/**
 * What the model is told when the requested filter set does not fit Chrome's MV3 limits.
 *
 * A reporter's import URL can enable more filters than Chrome's 50 static rulesets (52, for
 * example), and then every `finish_fix` is rejected for want of a verified reporter-parity session
 * that can never exist. The guidance says what can be done instead and what to tell the reporter,
 * whose own MV3 browser cannot run that set either.
 */
const MV3_LIMITS_EXCEEDED_GUIDANCE: readonly string[] = [
    "The reporter's filter set does not fit Chrome's MV3 limits, so it cannot run as a whole here",
    "and could not in the reporter's own MV3 browser either.",
    'Do not relaunch reported_on_current with this import URL; reporter parity is waived for it.',
    'Close this session and continue with a verified defaults_plus_required or agent_selected',
    'session that enables the filters relevant to the reported site.',
    'In the conclusion advise the reporter to disable the filters they do not need and retest.',
];

/**
 * Model guidance for one diagnosed settings limitation, exhaustive over the enumeration so a new
 * limitation without guidance is a compile error.
 */
const SETTINGS_LIMITATION_GUIDANCE: Record<SettingsLimitation, readonly string[]> = {
    [SettingsLimitation.Mv3LimitsExceeded]: MV3_LIMITS_EXCEEDED_GUIDANCE,
};

/**
 * Project one launch Baseline outcome's model-facing failure fields.
 *
 * A refused contract carries its stable gap beside the bounded detail; an unverified Baseline
 * carries the detail, plus the typed limitation and its guidance when the credit diagnosed one. The
 * verified outcome contributes nothing, so the launch result only names what did not verify.
 *
 * @param outcome - The Baseline outcome, or undefined when no Baseline ran (an unfiltered launch).
 * @returns The named fields to spread into the launch result.
 */
export function launchBaselineSettingsFields(
    outcome: LaunchBaselineOutcome | undefined,
): Record<string, unknown> {
    if (outcome === undefined || outcome.kind === LaunchBaselineOutcomeKind.Verified) {
        return {};
    }
    return {
        ...(outcome.kind === LaunchBaselineOutcomeKind.Refused ? { settingsGap: outcome.gap } : {}),
        ...(outcome.kind === LaunchBaselineOutcomeKind.Declared
            ? { settingsEnabledLists: [...outcome.listKeys] }
            : {}),
        ...(outcome.kind === LaunchBaselineOutcomeKind.Unverified &&
        outcome.settingsLimitation !== undefined
            ? {
                  settingsLimitation: outcome.settingsLimitation,
                  guidance: [...SETTINGS_LIMITATION_GUIDANCE[outcome.settingsLimitation]],
              }
            : {}),
        settingsDetail: outcome.detail,
    };
}
