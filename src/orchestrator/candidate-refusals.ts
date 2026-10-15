/**
 * Refusals of one `apply_rule` candidate that leave the environment able to verify the next one.
 *
 * An experiment can stop on a limitation of the environment, which ends rule verification for the
 * run, or on a limitation of the candidate it was handed: an operation the environment cannot run,
 * or a published line that is not exactly one line of the lists it executes. This module tells the
 * two apart, words the refusal for the model, and remembers it, so a repeat is answered without
 * running its phases again.
 */

import {
    BaselineLineRefusal,
    CandidateOperation,
    EnvironmentAdapterLimitationCode,
    type EnvironmentAdapterLimitation,
    type EnvironmentCandidate,
} from '../environment/filtering-environment';

/**
 * Every refusal `apply_rule` answers with when the environment refused the one candidate it was
 * handed and stays able to verify the next one.
 */
export const CandidateRefusalKind = {
    /**
     * The environment cannot perform the requested candidate operation.
     */
    OperationUnsupported: EnvironmentAdapterLimitationCode.CandidateOperationUnsupported,

    /**
     * The published line an edit or removal names is in no list the environment runs.
     */
    BaselineLineNotFound: BaselineLineRefusal.NotFound,

    /**
     * The published line an edit or removal names occurs more than once in those lists.
     */
    BaselineLineNotUnique: BaselineLineRefusal.NotUnique,
} as const;

/**
 * CandidateRefusalKind value.
 */
export type CandidateRefusalKind = (typeof CandidateRefusalKind)[keyof typeof CandidateRefusalKind];

/**
 * Every CandidateRefusalKind value, for telling a refusal of one candidate from any other result.
 */
const CANDIDATE_REFUSAL_KIND_VALUES: readonly unknown[] = Object.values(CandidateRefusalKind);

/**
 * The typed refusal `apply_rule` answers with when the environment refused one candidate and not
 * itself: no experiment ran for it, and the next candidate still runs.
 *
 * A type alias rather than an interface: tool results are `Record<string, unknown>`, which an
 * interface, having no index signature, is not assignable to.
 */
export type CandidateRefusal = {
    /**
     * No experiment ran.
     */
    validationSkipped: true;

    /**
     * What was refused and what to submit instead.
     */
    error: string;

    /**
     * Finite refusal class.
     */
    errorKind: CandidateRefusalKind;

    /**
     * The same call can never succeed in this environment.
     */
    retryable: false;

    /**
     * The environment's own account of the refusal, when an experiment produced it.
     */
    limitation?: EnvironmentAdapterLimitation;
};

/**
 * How to validate the same change as an added rule, which needs no published line to exist.
 *
 * The domain-list case is spelled out because it leads to an edit most often; see
 * {@link unsupportedCandidateOperationRefusal} for why naming the scoped rule matters.
 */
const ADDED_RULE_RECOVERY =
    "Validate the change as an added rule instead (operation 'add'): to extend an existing rule's " +
    'domain list, the rule scoped to the reported domain alone — the host merges it into the ' +
    'existing rule when it builds the patch; to undo a rule, an exception for the reported domain.';

/**
 * Refuse a candidate operation the environment cannot perform, and say what does work.
 *
 * The earlier wording ended in "propose an added exception or replacement rule instead". A model
 * that had just been shown an extension plan read "replacement rule" as that plan's merged line and
 * validated the merged multi-domain rule as an added one, which the candidate safety gate then
 * refused. The recovery is therefore spelled out for the case that leads here most often: to extend
 * an existing rule's domain list, the rule to validate is the one scoped to the reported domain.
 *
 * @param operation - The candidate operation the model asked for.
 * @param environment - How the refusing environment is named to the model.
 * @returns The refusal returned to the model.
 */
export function unsupportedCandidateOperationRefusal(
    operation: string,
    environment: string,
): CandidateRefusal {
    return {
        validationSkipped: true,
        error:
            `Candidate operation '${operation}' is not supported ${environment}: only a rule added ` +
            "on top of the baseline can be validated (operation 'add'). To extend an existing " +
            "rule's domain list, validate the rule scoped to the reported domain alone — the host " +
            'merges it into the existing rule when it builds the patch.',
        errorKind: CandidateRefusalKind.OperationUnsupported,
        retryable: false,
    };
}

/**
 * Answer a limitation that refused one candidate alone, or report that it lost the environment.
 *
 * Only these limitations judge the candidate: the operation the environment cannot run, and a
 * published line that is not exactly one line of the lists it executes. The line comes from the
 * repository checkout and the environment executes the published lists, which drift apart in both
 * directions, so its absence says nothing about the environment. Every other limitation means the
 * environment can no longer verify rules — an unsupported `add` included, since adding is the one
 * operation every candidate environment must run.
 *
 * @param limitation - What stopped the experiment.
 * @param operation - The candidate operation the experiment ran.
 * @returns The refusal of this candidate, or null when the environment itself was lost.
 */
export function candidateRefusal(
    limitation: EnvironmentAdapterLimitation,
    operation: CandidateOperation,
): CandidateRefusal | null {
    switch (limitation.code) {
        case EnvironmentAdapterLimitationCode.CandidateOperationUnsupported:
            return operation === CandidateOperation.Add
                ? null
                : {
                      ...unsupportedCandidateOperationRefusal(operation, 'by this environment'),
                      limitation,
                  };
        case EnvironmentAdapterLimitationCode.BaselineLineNotFound:
            return {
                validationSkipped: true,
                error:
                    'The published line to change is not in the filter lists this environment ' +
                    `runs, so it cannot be changed here with operation '${operation}'. The ` +
                    'repository and the published lists differ: the line changed in one of them ' +
                    `after the other was built. ${ADDED_RULE_RECOVERY}`,
                errorKind: CandidateRefusalKind.BaselineLineNotFound,
                retryable: false,
                limitation,
            };
        case EnvironmentAdapterLimitationCode.BaselineLineNotUnique:
            return {
                validationSkipped: true,
                error:
                    'The published line to change occurs more than once in the filter lists this ' +
                    'environment runs, so the change cannot be attributed to one line. ' +
                    ADDED_RULE_RECOVERY,
                errorKind: CandidateRefusalKind.BaselineLineNotUnique,
                retryable: false,
                limitation,
            };
        default:
            return null;
    }
}

/**
 * Tell whether an `apply_rule` result refused one candidate rather than judging it.
 *
 * @param errorKind - The result's error kind.
 * @returns Whether the result is a {@link CandidateRefusal}.
 */
export function isCandidateRefusal(errorKind: unknown): boolean {
    return CANDIDATE_REFUSAL_KIND_VALUES.includes(errorKind);
}

/**
 * The published line a candidate edits or removes.
 *
 * @param candidate - The candidate an experiment runs.
 * @returns The line, or null for an added rule, which names none.
 */
function publishedLine(candidate: EnvironmentCandidate): string | null {
    switch (candidate.operation) {
        case CandidateOperation.Edit:
            return candidate.originalRule ?? null;
        case CandidateOperation.Remove:
            return candidate.originalRule ?? candidate.rule;
        default:
            return null;
    }
}

/**
 * The refusals one run has already answered, so a repeat is answered without opening its phases.
 *
 * The published lists are locked and the environment's operations are fixed for the run, so a
 * candidate refused for its operation or for the line it names is refused the same way every time.
 * A refusal releases the candidate's attempt slot, so without this memory a repeat would cost
 * phases A and B before phase C refused it again, with nothing to stop the loop.
 */
export class CandidateRefusalMemo {
    /**
     * Refusals by what they judged: the operation, or the published line.
     */
    private readonly refusals = new Map<string, CandidateRefusal>();

    /**
     * Find the refusal a candidate already got for its operation or its line.
     *
     * @param candidate - The candidate about to run.
     * @returns The earlier refusal, or undefined when the candidate has to run.
     */
    recall(candidate: EnvironmentCandidate): CandidateRefusal | undefined {
        const line = publishedLine(candidate);
        return (
            this.refusals.get(operationKey(candidate.operation)) ??
            (line === null ? undefined : this.refusals.get(lineKey(line)))
        );
    }

    /**
     * Remember a refusal under what it judged.
     *
     * @param candidate - The candidate the refusal answered.
     * @param refusal - The refusal.
     */
    remember(candidate: EnvironmentCandidate, refusal: CandidateRefusal): void {
        if (refusal.errorKind === CandidateRefusalKind.OperationUnsupported) {
            this.refusals.set(operationKey(candidate.operation), refusal);
            return;
        }
        const line = publishedLine(candidate);
        if (line !== null) {
            this.refusals.set(lineKey(line), refusal);
        }
    }
}

/**
 * Key of a refusal that judged the candidate's operation.
 *
 * @param operation - The refused operation.
 * @returns The memo key.
 */
function operationKey(operation: CandidateOperation): string {
    return `operation:${operation}`;
}

/**
 * Key of a refusal that judged the published line a candidate names.
 *
 * @param line - The refused line.
 * @returns The memo key.
 */
function lineKey(line: string): string {
    return `line:${line}`;
}
