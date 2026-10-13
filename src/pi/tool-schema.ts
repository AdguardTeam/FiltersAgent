import type * as v from 'valibot';
import { toJsonSchema } from '@valibot/to-json-schema';

/**
 * Advertisement conversion of one tool's Valibot parameter schema: the JSON Schema pi registers as
 * the tool's parameters, advertises to the model, and pre-validates every call against.
 *
 * The schema is advertised as converted, with no projection. pi validates a tool call by compiling
 * the advertised schema with TypeBox (`Compile` + `Value.Check` inside pi-ai's
 * `validateToolArguments`), which is a JSON Schema validator: `minLength`, `maxLength`, `minimum`,
 * `maximum`, `pattern`, `enum`, `const`, `minItems`, `maxItems`, `anyOf`/`oneOf`, `required`,
 * `additionalProperties` and `$ref`/`$defs` are all compiled and enforced natively. Dropping the
 * bound keywords and re-rendering them as a prose "Constraints:" sentence would buy nothing and
 * cost the model a machine-checkable contract.
 *
 * The one invariant this seam owes is that pi's pre-execute check must never be STRICTER than the
 * adapter's authoritative Valibot re-check, and `toJsonSchema` gives that for free:
 * `@valibot/to-json-schema` throws on any schema or action it cannot convert (its `errorMode`
 * defaults to `throw`), so every keyword it emits is a faithful projection of a Valibot action the
 * re-check enforces too. Unknown-key handling follows from the same rule rather than from a special
 * case: a plain `v.object` emits no `additionalProperties` and keeps stripping unknown keys on both
 * sides, while `v.strictObject` emits `false` and rejects them on both sides.
 *
 * Nor is pi's own bounce a lost failure path: `tool-bounce.ts` counts pi's pre-execute rejections
 * through `tool_execution_end` — which is how the terminal tool caps a model that keeps
 * resubmitting an invalid payload — and records each one, with the submitted arguments and pi's
 * reason, into the run trace.
 */

/**
 * The JSON Schema `type` every function-parameters schema must declare at its root.
 *
 * The OpenAI function-calling contract, and the strict OpenAI-compatible upstreams an LLM gateway
 * may route to, refuse a `parameters` object whose root lacks `type: "object"`: a fix run fails
 * mid-session with `Invalid schema for function 'finish_fix': schema must be a JSON Schema of
 * 'type: "object"', got 'type: null'` once the gateway's load balancer moves it onto such an
 * upstream. `@valibot/to-json-schema` renders a `v.union` of objects as a bare `anyOf` with no root
 * type, which is what those upstreams reject.
 */
const OBJECT_ROOT_TYPE = 'object';

/**
 * The composition keywords under which a union of object branches hides its root type.
 */
const UNION_KEYWORDS = ['anyOf', 'oneOf'] as const;

/**
 * Whether every branch of a rendered union declares the object type itself.
 *
 * @param branches - The rendered union branches.
 * @returns True when the union can only ever match an object.
 */
function everyBranchIsObject(branches: unknown): boolean {
    return (
        Array.isArray(branches) &&
        branches.length > 0 &&
        branches.every(
            (branch) =>
                typeof branch === 'object' &&
                branch !== null &&
                (branch as Record<string, unknown>)['type'] === OBJECT_ROOT_TYPE,
        )
    );
}

/**
 * Convert a Valibot tool-parameters schema into the JSON Schema object pi advertises to the model.
 *
 * A union of object shapes gets its root `type: "object"` stated explicitly. That adds no
 * constraint — every branch already requires an object, so pi's pre-execute check accepts and
 * rejects exactly what it did before — but it is the root declaration strict upstreams insist on.
 *
 * @param schema - The Valibot schema declared on a tool spec.
 * @returns The JSON Schema registered as the tool's parameters.
 */
export function toAdvertisedSchema(schema: v.GenericSchema): Record<string, unknown> {
    // `$schema` names the dialect of the DOCUMENT, not a constraint on the call, and pi forwards
    // `tool.parameters` verbatim into the provider request body (`api/openai-completions.js`).
    // Stripping it keeps the wire schema to keywords that describe the arguments.
    const { $schema: _dialect, ...advertised } = toJsonSchema(schema) as Record<string, unknown>;
    if (
        advertised['type'] === undefined &&
        UNION_KEYWORDS.some((keyword) => everyBranchIsObject(advertised[keyword]))
    ) {
        return { type: OBJECT_ROOT_TYPE, ...advertised };
    }
    return advertised;
}
