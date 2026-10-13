/**
 * The blocker contract on the wire: one JSON object per line, requests from the agent on the
 * module's stdin and responses on its stdout, each response carrying the id of the request it
 * answers. A module may be written by anyone, so the agent validates every response here, once, and
 * trusts the parsed values downstream.
 */
import * as v from 'valibot';
import {
    BlockerEventKind,
    BlockerKind,
    PageEvidenceFormat,
    type BlockerApplied,
    type BlockerDescription,
    type BlockerLogRead,
    type BlockerRunning,
    type BlockerState,
    type BlockerStopped,
} from './blocker-contract';

/**
 * The contract operations as wire method names.
 */
export const BlockerMethod = {
    Describe: 'describe',
    Start: 'start',
    Apply: 'apply',
    State: 'state',
    Log: 'log',
    Stop: 'stop',
} as const;

/**
 * BlockerMethod value.
 */
export type BlockerMethod = (typeof BlockerMethod)[keyof typeof BlockerMethod];

/**
 * One request line the agent writes.
 */
export interface BlockerWireRequest {
    /**
     * Request id the response repeats.
     */
    id: number;

    /**
     * The operation.
     */
    method: BlockerMethod;

    /**
     * The operation's argument, or null for none.
     */
    params: unknown;
}

const RouteSchema = v.object({
    proxyUrl: v.pipe(v.string(), v.url()),
    certificateDerBase64: v.pipe(v.string(), v.base64()),
});

const RunningSchema = v.object({
    route: RouteSchema,
    revision: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

export const BlockerDescriptionSchema = v.object({
    contractVersion: v.pipe(v.number(), v.integer()),
    product: v.pipe(v.string(), v.nonEmpty()),
    version: v.nullable(v.string()),
    binarySha256: v.pipe(v.string(), v.hexadecimal(), v.length(64)),
    kind: v.picklist(Object.values(BlockerKind)),
    covers: v.string(),
    notReported: v.array(v.string()),
    pageEvidence: v.nullable(
        v.object({
            format: v.picklist(Object.values(PageEvidenceFormat)),
            contentScriptHost: v.pipe(v.string(), v.nonEmpty()),
        }),
    ),
});

export const BlockerRunningSchema = RunningSchema;

export const BlockerAppliedSchema = v.object({
    ...RunningSchema.entries,
    restarted: v.boolean(),
});

export const BlockerStateSchema = v.object({
    running: v.boolean(),
    revision: v.pipe(v.number(), v.integer(), v.minValue(0)),
    port: v.nullable(v.pipe(v.number(), v.integer())),
    lists: v.array(
        v.object({
            id: v.pipe(v.number(), v.integer()),
            sha256: v.pipe(v.string(), v.hexadecimal(), v.length(64)),
        }),
    ),
    userRules: v.array(v.string()),
});

export const BlockerLogReadSchema = v.object({
    revision: v.pipe(v.number(), v.integer(), v.minValue(0)),
    cursor: v.string(),
    events: v.array(
        v.variant('kind', [
            v.object({
                kind: v.literal(BlockerEventKind.Request),
                url: v.string(),
                rule: v.string(),
                handshakeBlock: v.boolean(),
            }),
            v.object({
                kind: v.literal(BlockerEventKind.HtmlElementRemoved),
                url: v.string(),
                element: v.string(),
                rule: v.string(),
            }),
            v.object({
                kind: v.literal(BlockerEventKind.UnfilteredHost),
                host: v.string(),
                reason: v.string(),
            }),
        ]),
    ),
});

export const BlockerStoppedSchema = v.object({
    licenceReleased: v.boolean(),
});

export const BlockerWireResponseSchema = v.union([
    v.object({ id: v.pipe(v.number(), v.integer()), result: v.unknown() }),
    v.object({ id: v.pipe(v.number(), v.integer()), error: v.object({ message: v.string() }) }),
]);

/**
 * The schema each method's result is parsed with, so a module answering one method with another's
 * shape fails at the boundary.
 */
export const BLOCKER_RESULT_SCHEMAS = {
    [BlockerMethod.Describe]: BlockerDescriptionSchema,
    [BlockerMethod.Start]: BlockerRunningSchema,
    [BlockerMethod.Apply]: BlockerAppliedSchema,
    [BlockerMethod.State]: BlockerStateSchema,
    [BlockerMethod.Log]: BlockerLogReadSchema,
    [BlockerMethod.Stop]: BlockerStoppedSchema,
} as const;

/**
 * The parsed result type of each method; the schemas above must produce exactly the contract types.
 */
export interface BlockerResults {
    /**
     * Result of describe.
     */
    [BlockerMethod.Describe]: BlockerDescription;

    /**
     * Result of start.
     */
    [BlockerMethod.Start]: BlockerRunning;

    /**
     * Result of apply.
     */
    [BlockerMethod.Apply]: BlockerApplied;

    /**
     * Result of state.
     */
    [BlockerMethod.State]: BlockerState;

    /**
     * Result of log.
     */
    [BlockerMethod.Log]: BlockerLogRead;

    /**
     * Result of stop.
     */
    [BlockerMethod.Stop]: BlockerStopped;
}
