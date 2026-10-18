/**
 * Bounds on validating one candidate that the model is told about as well as held to.
 *
 * They live below both the runtime that enforces them and the tool guidance that quotes them, so
 * the guidance states the number the runtime counts to.
 */

/**
 * Most browser-bound runs one candidate gets in all: its first `apply_rule` experiment, plus the
 * repeats an inconclusive vision review, new reveal steps or new DOM checks admit.
 *
 * No repeat spends a candidate attempt, so this bound alone keeps one candidate from re-running
 * without end; past it, the same candidate answers `duplicate_candidate`.
 */
export const MAX_CANDIDATE_VALIDATION_EXECUTIONS = 3;
