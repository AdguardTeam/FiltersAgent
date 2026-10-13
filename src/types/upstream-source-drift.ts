import * as v from 'valibot';

export const UpstreamSourceDriftSchema = v.pipe(
    v.strictObject({
        status: v.picklist(['in_sync', 'upstream_ahead', 'unobserved']),
        pinnedCommit: v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/iu)),
        upstreamCommit: v.nullable(v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/iu))),
        observedAt: v.pipe(v.string(), v.isoTimestamp()),
    }),
    v.check(
        (drift) =>
            (drift.status === 'unobserved') === (drift.upstreamCommit === null) &&
            (drift.status !== 'in_sync' || drift.upstreamCommit === drift.pinnedCommit) &&
            (drift.status !== 'upstream_ahead' || drift.upstreamCommit !== drift.pinnedCommit),
        'An upstream drift record must agree with the commits it names.',
    ),
);

/**
 * Where upstream stood relative to the commit one run is bound to.
 *
 * A drift record is a pair of commits and a finite status: it carries no remote URL, ref name, or
 * local path, because it reports where the source moved, never how to reach it.
 */
export type UpstreamSourceDrift = v.InferOutput<typeof UpstreamSourceDriftSchema>;
