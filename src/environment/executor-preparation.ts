import * as v from 'valibot';
import { BoundedIdentifierSchema } from './executor-name';

/**
 * The durable executor-preparation vocabulary: the path-free provenance one prepared executor
 * publishes, the limitation a failed preparation is allowed to say out loud, the ready/limited
 * variant the selection snapshot records, and the trusted outcome the preparing host hands to the
 * selection host. Declared once here so the selection host, the report renderer, and every
 * registering executor module share one shape instead of respelling it.
 */

/**
 * Reject host paths and multiline raw output from published preparation detail.
 */
const PreparationDetailSchema = v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1),
    v.maxLength(500),
    v.check(
        (detail) =>
            !/[\r\n]/u.test(detail) &&
            !/(?:^|\s)(?:\/(?:Users|home|private|tmp|var)\/|[A-Za-z]:\\)/u.test(detail),
        'Preparation detail must not contain raw output or host paths.',
    ),
);

/**
 * Path-free bounded provenance of one prepared executor.
 *
 * Carries no host paths and no release identity beyond the four published fields: where the
 * executor came from, the product label it honestly claims, the version it can verify (null when
 * the build does not know one), and the digest that binds the published record to the verified
 * installation.
 */
export const ExecutorPreparedProvenanceSchema = v.strictObject({
    source: BoundedIdentifierSchema,
    product: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
    version: v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
    digestB32: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
});

/**
 * Stable path-free reason one executor preparation attempt did not produce a ready executor.
 */
export const ExecutorPreparationLimitationSchema = v.strictObject({
    stage: BoundedIdentifierSchema,
    code: BoundedIdentifierSchema,
    detail: PreparationDetailSchema,
});

/**
 * The two states one executor preparation attempt settles into: a ready executor with its
 * provenance, or a limited attempt with the limitation that stopped it.
 */
export const ExecutorPreparationState = {
    /**
     * The executor prepared successfully and published its provenance.
     */
    Ready: 'ready',

    /**
     * The executor could not be prepared; the limitation names why.
     */
    Limited: 'limited',
} as const;

/**
 * ExecutorPreparationState value.
 */
export type ExecutorPreparationState =
    (typeof ExecutorPreparationState)[keyof typeof ExecutorPreparationState];

/**
 * Durable ready/limited record of one executor preparation attempt.
 */
export const ExecutorPreparationSchema = v.variant('state', [
    v.strictObject({
        state: v.literal(ExecutorPreparationState.Ready),
        provenance: ExecutorPreparedProvenanceSchema,
    }),
    v.strictObject({
        state: v.literal(ExecutorPreparationState.Limited),
        limitation: ExecutorPreparationLimitationSchema,
    }),
]);

/**
 * Trusted outcome of one executor preparation attempt: the opaque capability is absent by contract
 * — the preparing host keeps runtime-only handles itself and publishes only this path-free evidence
 * to the selection host.
 */
export const ExecutorPreparationOutcomeSchema = v.variant('ready', [
    v.strictObject({
        ready: v.literal(true),
        provenance: ExecutorPreparedProvenanceSchema,
    }),
    v.strictObject({
        ready: v.literal(false),
        limitation: ExecutorPreparationLimitationSchema,
    }),
]);

/**
 * ExecutorPreparationOutcome value.
 */
export type ExecutorPreparationOutcome = v.InferOutput<typeof ExecutorPreparationOutcomeSchema>;
