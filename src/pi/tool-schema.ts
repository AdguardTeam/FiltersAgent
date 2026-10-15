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
 * A tool whose arguments branch cannot be advertised as converted, because a root union is what
 * providers refuse; it advertises a separate flat object instead. The flat object relaxes every
 * branch: the discriminator as an enum of all branch values, each branch field with the same leaf
 * schema and optional unless every branch requires it, and the same unknown-key handling. pi checks
 * the discriminator, the types and bounds of every field present whatever the branch, and the
 * fields every branch requires. The invariant holds because the authoritative schema pipes that
 * same flat object first and the branches after it (`FixOutcomeSchema`): a field of another branch
 * that pi refuses, the Valibot check refuses by name too. Which fields a branch requires is left to
 * the branch stage at execute time.
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
 * upstream.
 */
const OBJECT_ROOT_TYPE = 'object';

/**
 * The composition keywords a provider refuses at the root of a tool's parameters.
 *
 * Anthropic (Claude Platform and Amazon Bedrock alike) fails the whole request with `input_schema
 * does not support oneOf, allOf, or anyOf at the top level`, so one such tool keeps a run from
 * starting at all. `@valibot/to-json-schema` renders a `v.union` of objects as a root `anyOf` and a
 * `v.variant` as a root `oneOf`. Nested below a property the keywords are accepted.
 */
const ROOT_COMPOSITION_KEYWORDS = ['anyOf', 'oneOf', 'allOf'] as const;

/**
 * Convert a Valibot tool-parameters schema into the JSON Schema object pi advertises to the model.
 *
 * The root must be one plain object: a tool whose arguments branch on a discriminator advertises a
 * flat object with the discriminator as an enum and validates the branches at execute time (see
 * `TerminalToolOptions.parameters`, and `launch_browser`'s separate advertisement). Refusing here
 * rather than at the provider surfaces such a tool in every test that builds its surface.
 *
 * @param schema - The Valibot schema declared on a tool spec.
 * @param toolName - The tool the schema belongs to, named in the refusal.
 * @returns The JSON Schema registered as the tool's parameters.
 * @throws When the converted root is not a plain `type: "object"` schema.
 */
export function toAdvertisedSchema(
    schema: v.GenericSchema,
    toolName: string,
): Record<string, unknown> {
    // `$schema` names the dialect of the DOCUMENT, not a constraint on the call, and pi forwards
    // `tool.parameters` verbatim into the provider request body (`api/openai-completions.js`).
    // Stripping it keeps the wire schema to keywords that describe the arguments.
    const { $schema: _dialect, ...advertised } = toJsonSchema(schema) as Record<string, unknown>;
    const composition = ROOT_COMPOSITION_KEYWORDS.filter((keyword) => keyword in advertised);
    if (advertised['type'] !== OBJECT_ROOT_TYPE || composition.length > 0) {
        const found =
            composition.length > 0 ? composition.join(', ') : `type ${String(advertised['type'])}`;
        throw new Error(
            `Parameters of tool ${toolName} must be one plain JSON object, but the root has ` +
                `${found}. ` +
                'Advertise a flat object and validate the branches at execute time.',
        );
    }
    return advertised;
}
