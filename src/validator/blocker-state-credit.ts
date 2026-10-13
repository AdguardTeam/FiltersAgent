/**
 * The one credit rule of an application: how the host judges the blocker state it read back.
 *
 * An application may claim only this: the candidate is credited only when the state carries exactly
 * the candidate rule, the baseline only when it carries no user rule at all, and both only when the
 * enabled filter set the read-back can observe still equals the prepared one. There are two
 * application paths (the between-phases procedure and the host's own file-backed application, with
 * no model session at all), so the judgment lives here rather than inside either path: both credit
 * by one rule, and a state that would fail in one can never pass in the other.
 */
import type { ActionLogEntry, BlockerVerificationMethod } from '../environment/environment-proofs';
import {
    normalizeRulesContent,
    observedRulesDigest,
    sha256OfContent,
} from '../environment/rules-content';
import { sortListKeys, type FilterListKey } from '../environment/filter-list-ref';
import { SettingsLimitation } from '../environment/settings-limitation';
import type { Logger } from '../logger/logger';
import type { BlockerStateRead, Mv3RulesLimits } from './blocker-state-readers';
import {
    ApplicationGoalKind,
    PhaseApplicationOutcomeKind,
    type ApplicationGoal,
    type PhaseApplicationResult,
} from './phase-application-contract';

/**
 * Whether two filter list key collections are the same set.
 *
 * @param left - One collection of list keys.
 * @param right - The other collection of list keys.
 * @returns True when both carry exactly the same distinct keys.
 */
function sameKeySet(left: readonly FilterListKey[], right: readonly FilterListKey[]): boolean {
    const sortedLeft = sortListKeys([...new Set(left)]);
    const sortedRight = sortListKeys([...new Set(right)]);
    return (
        sortedLeft.length === sortedRight.length &&
        sortedLeft.every((key, index) => key === sortedRight[index])
    );
}

/**
 * Required keys absent from an available collection, in ascending registry order.
 *
 * @param required - Keys that must all be present.
 * @param available - The observed key collection to check membership against.
 * @returns The required keys `available` does not contain; empty when it contains every one.
 */
function missingKeys(
    required: readonly FilterListKey[],
    available: readonly FilterListKey[],
): FilterListKey[] {
    const availableSet = new Set(available);
    return sortListKeys(required.filter((key) => !availableSet.has(key)));
}

/**
 * What one credit judgment is given: the state read back, the goal it must satisfy, and the
 * prepared expectation the phase session carried.
 */
export interface BlockerStateCreditInput {
    /**
     * The blocker state the host read back itself.
     */
    read: BlockerStateRead;

    /**
     * The expected blocker state the read-back is credited against.
     */
    goal: ApplicationGoal;

    /**
     * The verification method that produced the read-back, named in every detail it explains.
     */
    method: BlockerVerificationMethod;

    /**
     * Host-assembled trace of what the application did.
     */
    actionLog: ActionLogEntry[];

    /**
     * Enabled filter list key set the environment previously proved, compared as a set against a
     * read-back that can observe it.
     */
    preparedEnabledFilterIds?: readonly FilterListKey[];

    /**
     * Exact Tracking-protection state the prepared expectation requires, when one is known.
     */
    expectedStealthEnabled?: boolean;

    /**
     * Run logger receiving every mismatch before it becomes a bounded detail.
     */
    logger: Logger;
}

/**
 * Render the MV3 counters as `enabled/maximum` pairs for the unverified detail, when the reader
 * carried them.
 *
 * @param limits - The counters the read-back carried, or undefined when it observed only the flag.
 * @returns The bounded counters sentence, or an empty string without counters.
 */
function mv3LimitsCountersDetail(limits: Mv3RulesLimits | undefined): string {
    if (limits === undefined) {
        return '';
    }
    return (
        ` Static rulesets enabled/maximum: ${limits.staticFiltersEnabledCount}/` +
        `${limits.staticFiltersMaximumCount}; static rules enabled/maximum: ` +
        `${limits.staticRulesEnabledCount}/${limits.staticRulesMaximumCount}.`
    );
}

/**
 * The unverified outcome of a read-back whose enabled set differs from the prepared one while the
 * extension reports MV3 limits exceeded: the requested set does not fit Chrome's static ruleset
 * limits, so the outcome names the limitation, how many filters were requested, which ones the
 * extension kept, and the counters behind the verdict.
 *
 * @param input - The credit input carrying the logger and action log.
 * @param prepared - The prepared enabled set the application was asked to reach.
 * @param observed - The enabled set the read-back reports.
 * @returns The unverified outcome marked `SettingsLimitation.Mv3LimitsExceeded`.
 */
function judgeMv3LimitsMismatch(
    input: BlockerStateCreditInput,
    prepared: readonly FilterListKey[],
    observed: readonly FilterListKey[],
): PhaseApplicationResult {
    const { read, goal, actionLog, logger } = input;
    const requestedCount = new Set(prepared).size;
    const keptKeys = sortListKeys([...new Set(observed)]);
    logger.warn(
        {
            goal: goal.kind,
            requestedCount,
            preparedKeys: sortListKeys([...prepared]),
            keptKeys,
            rulesLimits: read.rulesLimits,
        },
        'the requested filter set exceeds the MV3 limits: the extension kept only what Chrome enabled',
    );
    return {
        kind: PhaseApplicationOutcomeKind.Unverified,
        settingsLimitation: SettingsLimitation.Mv3LimitsExceeded,
        detail:
            `The requested filter set exceeds Chrome's MV3 limits: ${requestedCount} filter(s) ` +
            `were requested and the extension kept only [${keptKeys.join(', ')}] after Chrome ` +
            `refused the rest.${mv3LimitsCountersDetail(read.rulesLimits)}`,
        actionLog,
    };
}

/**
 * Judge the enabled filter set and Tracking-protection state a matching read-back reports against
 * the prepared expectation, the last step of both goals: the baseline plugs exactly that set back
 * in, and the candidate is applied on top of it. This is the only place the prepared state is
 * judged; the environment that consumes the result trusts it. A reader that cannot observe the set
 * (the file-backed methods) credits on the rules content alone and records that in the detail; a
 * reader that cannot observe stealth leaves the Tracking-protection state out of the judgment.
 *
 * @param input - The read-back whose rules content already matched, with its goal and expectation.
 * @returns Applied, with the unobservable-set detail when the reader cannot report the set, or
 *   unverified with the bounded mismatch.
 */
function judgeEnabledFilterSet(input: BlockerStateCreditInput): PhaseApplicationResult {
    const { read, goal, method, actionLog, logger } = input;
    const prepared = input.preparedEnabledFilterIds;
    const expectedStealth = input.expectedStealthEnabled;
    if (
        read.stealthEnabled !== undefined &&
        expectedStealth !== undefined &&
        read.stealthEnabled !== expectedStealth
    ) {
        logger.warn(
            {
                goal: goal.kind,
                expectedStealth,
                observedStealth: read.stealthEnabled,
            },
            'the read-back Tracking-protection state does not match the prepared state',
        );
        return {
            kind: PhaseApplicationOutcomeKind.Unverified,
            detail:
                'The Tracking-protection state read back does not equal the prepared state: ' +
                `observed ${read.stealthEnabled ? 'enabled' : 'disabled'} where ` +
                `${expectedStealth ? 'enabled' : 'disabled'} was expected.`,
            actionLog,
        };
    }
    const credited =
        goal.kind === ApplicationGoalKind.Candidate
            ? 'the candidate was credited on the exact user-rules content alone'
            : 'the baseline was credited on the empty user-rules state alone';
    const observed = read.enabledFilterIds;
    if (observed === undefined) {
        logger.info(
            { method, goal: goal.kind },
            'the read-back does not expose the enabled filter set; credited on the rules content alone',
        );
        return {
            kind: PhaseApplicationOutcomeKind.Applied,
            actionLog,
            readBack: read,
            detail: `The ${method} read-back does not expose the enabled filter set; ${credited}.`,
        };
    }
    if (prepared === undefined) {
        return {
            kind: PhaseApplicationOutcomeKind.Unverified,
            detail:
                'The phase session carried no prepared enabled filter set to compare the read-back ' +
                'against.',
            actionLog,
        };
    }
    if (!sameKeySet(prepared, observed)) {
        // A mismatch the extension itself reports as MV3 limits exceeded is not an application
        // that went wrong: Chrome refused the requested static rulesets as a whole, the extension
        // kept what Chrome accepted and disabled the rest, and no re-application can reach the
        // prepared set. Checked before the generic mismatch below, so a run never seals on the
        // bare mismatch detail with the cause dropped.
        if (read.limitsExceeded === true) {
            return judgeMv3LimitsMismatch(input, prepared, observed);
        }
        logger.warn(
            {
                goal: goal.kind,
                preparedKeys: sortListKeys([...prepared]),
                observedKeys: sortListKeys([...observed]),
            },
            'the enabled filter list set does not match the prepared set',
        );
        return {
            kind: PhaseApplicationOutcomeKind.Unverified,
            detail:
                'The enabled filter list set read back does not equal the prepared baseline set: ' +
                `observed [${sortListKeys([...new Set(observed)]).join(', ')}].`,
            actionLog,
        };
    }
    // Requested/options credit alone proves a filter is switched on, never that its MV3 ruleset
    // actually compiled and activated within the browser's limits, so a reader that can observe
    // both gaps (the live extension state) is held to that bar.
    if (read.limitsExceeded === true) {
        logger.warn(
            { goal: goal.kind },
            'the read-back reports MV3 filter or rule limits exceeded',
        );
        return {
            kind: PhaseApplicationOutcomeKind.Unverified,
            detail:
                'The read-back reports MV3 filter or rule limits exceeded after the application; ' +
                'the requested filters cannot be trusted to run.',
            actionLog,
        };
    }
    if (read.activeRulesetFilterIds !== undefined) {
        const missing = missingKeys(prepared, read.activeRulesetFilterIds);
        if (missing.length > 0) {
            logger.warn(
                {
                    goal: goal.kind,
                    preparedKeys: sortListKeys([...prepared]),
                    activeRulesetKeys: sortListKeys([...read.activeRulesetFilterIds]),
                },
                'the active MV3 rulesets do not contain every expected filter',
            );
            return {
                kind: PhaseApplicationOutcomeKind.Unverified,
                detail:
                    'The active MV3 rulesets do not contain every expected filter: missing ' +
                    `[${missing.join(', ')}] from the active set ` +
                    `[${sortListKeys([...read.activeRulesetFilterIds]).join(', ')}].`,
                actionLog,
            };
        }
    }
    return { kind: PhaseApplicationOutcomeKind.Applied, actionLog, readBack: read };
}

/**
 * Credit one application from the blocker state the host read back.
 *
 * @param input - The read-back, the goal, the verification method, the prepared expectation and the
 *   host-assembled action log.
 * @returns Applied when the state contains exactly the goal's content; unverified with the bounded
 *   mismatch detail otherwise.
 */
export function creditBlockerStateRead(input: BlockerStateCreditInput): PhaseApplicationResult {
    const { read, goal, method, actionLog, logger } = input;
    if (goal.kind === ApplicationGoalKind.Candidate) {
        // Both sides digest through the one normalization: the reader reports content normalized,
        // and the expected rule is normalized the same way, so a trailing newline on the goal rule
        // cannot make an exact application look mismatched.
        const observedDigest = observedRulesDigest(read);
        if (observedDigest === undefined) {
            return {
                kind: PhaseApplicationOutcomeKind.Unverified,
                detail: 'The read-back state carried no user-rules content to compare against the candidate.',
                actionLog,
            };
        }
        const expectedDigest = sha256OfContent(normalizeRulesContent(goal.rule));
        if (observedDigest !== expectedDigest) {
            logger.warn(
                {
                    expectedDigest,
                    observedDigest,
                    observedRuleCount:
                        read.rulesContent === undefined
                            ? undefined
                            : read.rulesContent.split('\n').length,
                },
                'the blocker state does not contain exactly the candidate',
            );
            return {
                kind: PhaseApplicationOutcomeKind.Unverified,
                detail:
                    'The blocker state does not contain exactly the candidate rule: the host read ' +
                    `back content digest ${observedDigest} where ${expectedDigest} was expected.`,
                actionLog,
            };
        }
        return judgeEnabledFilterSet(input);
    }
    // The baseline contract requires no user rule in the credited state, which only the rules
    // content itself can show: a read-back without it (a digest alone) proves nothing about
    // absence, so it is refused rather than collapsed to "empty".
    if (read.rulesContent === undefined) {
        return {
            kind: PhaseApplicationOutcomeKind.Unverified,
            detail:
                `The ${method} read-back reported no rules content, so the absence of user rules ` +
                'in the baseline state cannot be shown.',
            actionLog,
        };
    }
    // Any content left after the shared normalization fails the credit, whatever the enabled
    // filter list says.
    const leftoverRules = normalizeRulesContent(read.rulesContent);
    if (leftoverRules.length > 0) {
        const ruleLineCount = leftoverRules.split('\n').length;
        logger.warn({ method, ruleLineCount }, 'the baseline state still carries user rules');
        return {
            kind: PhaseApplicationOutcomeKind.Unverified,
            detail:
                `The baseline state must contain no user rules, but the ${method} read-back ` +
                `still reports ${ruleLineCount} rule line(s): ${leftoverRules}`,
            actionLog,
        };
    }
    return judgeEnabledFilterSet(input);
}
