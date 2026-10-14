/**
 * Undo one provider quirk before pi validates a tool call: a nested object or array argument sent
 * as its JSON text.
 *
 * Some models serialize a structured argument a second time. A long fix session on DeepSeek V4.1
 * Flash submitted `finish_fix` with `ruleProposal: "{\"rule\": ...}"` and `policyDecision: "{...}"`
 * on every attempt, so pi's pre-execute check bounced each call with "must be object" and the run
 * sealed on the rejection cap with a rule the model had already verified. The same model sends real
 * objects on short requests; the quirk shows up deep into a session.
 *
 * Pi coerces primitives against the advertised schema (`"1"` to `1`, `1` to `"1"`) but never parses
 * a string into an object, so this fills that one gap and nothing else. A string is parsed only
 * where the advertised schema cannot accept a string at all and does expect an object or an array,
 * and the parsed value is kept only when it is one. Every other value goes through unchanged, and
 * pi's validation and the Valibot re-check still judge the result.
 */

/**
 * The JSON Schema `type` of a value with named properties.
 */
const OBJECT_TYPE = 'object';

/**
 * The JSON Schema `type` of a list.
 */
const ARRAY_TYPE = 'array';

/**
 * The JSON Schema `type` of text.
 */
const STRING_TYPE = 'string';

/**
 * One node of an advertised parameters schema, reduced to the keywords the unwrapping walks.
 * `toAdvertisedSchema` renders it from the tool's own Valibot schema.
 */
interface SchemaNode {
    /**
     * The declared JSON type, or several of them.
     */
    type?: string | string[];

    /**
     * The single value the node allows.
     */
    const?: unknown;

    /**
     * The values the node allows.
     */
    enum?: unknown[];

    /**
     * The schemas of an object's named properties.
     */
    properties?: Record<string, SchemaNode>;

    /**
     * The schema of an object's other properties, when it constrains them.
     */
    additionalProperties?: boolean | SchemaNode;

    /**
     * The schema of every list item, or of each position in a tuple.
     */
    items?: SchemaNode | SchemaNode[];

    /**
     * Union branches: the value matches at least one.
     */
    anyOf?: SchemaNode[];

    /**
     * Union branches: the value matches exactly one.
     */
    oneOf?: SchemaNode[];

    /**
     * Intersection parts: the value matches every one.
     */
    allOf?: SchemaNode[];
}

/**
 * One argument the unwrapping parsed out of its JSON text.
 */
export interface UnwrappedArgument {
    /**
     * Dotted path of the argument inside the call, such as `ruleProposal` or `steps.0`.
     */
    path: string;
}

/**
 * The call's arguments after the unwrapping, with every argument it parsed.
 */
export interface StringifiedArgumentsResult {
    /**
     * The arguments to validate.
     */
    args: unknown;

    /**
     * The arguments that arrived as JSON text and were parsed; empty when the call needed nothing.
     */
    unwrapped: UnwrappedArgument[];
}

/**
 * A node together with every union branch and intersection part below it, flattened.
 *
 * @param nodes - The schema nodes that describe one value.
 * @returns The nodes and all their composition members.
 */
function expandComposition(nodes: SchemaNode[]): SchemaNode[] {
    return nodes.flatMap((node) => [
        node,
        ...expandComposition([...(node.anyOf ?? []), ...(node.oneOf ?? []), ...(node.allOf ?? [])]),
    ]);
}

/**
 * The JSON types a node declares, counting a string `const` or `enum` as a string type.
 *
 * @param node - One schema node.
 * @returns The declared types.
 */
function declaredTypes(node: SchemaNode): string[] {
    const types = node.type === undefined ? [] : [node.type].flat();
    const allowsStringValue =
        typeof node.const === 'string' ||
        (node.enum ?? []).some((value) => typeof value === 'string');
    return allowsStringValue ? [...types, STRING_TYPE] : types;
}

/**
 * The schema nodes of one named property across the given object nodes.
 *
 * @param nodes - The expanded nodes of the object that holds the property.
 * @param key - The property name.
 * @returns The nodes that describe the property's value; empty when none constrains it.
 */
function propertyNodes(nodes: SchemaNode[], key: string): SchemaNode[] {
    return nodes.flatMap((node) => {
        const named = node.properties?.[key];
        if (named !== undefined) {
            return [named];
        }
        return typeof node.additionalProperties === 'object' ? [node.additionalProperties] : [];
    });
}

/**
 * The schema nodes of one list position across the given array nodes.
 *
 * @param nodes - The expanded nodes of the list.
 * @param index - The item's position.
 * @returns The nodes that describe the item; empty when none constrains it.
 */
function itemNodes(nodes: SchemaNode[], index: number): SchemaNode[] {
    return nodes.flatMap((node) => {
        if (Array.isArray(node.items)) {
            const positional = node.items[index];
            return positional === undefined ? [] : [positional];
        }
        return node.items === undefined ? [] : [node.items];
    });
}

/**
 * Parse a string as an object or array, keeping the string when it is not one.
 *
 * @param text - The string the model sent.
 * @returns The parsed object or array, or the string unchanged.
 */
function parseContainer(text: string): unknown {
    try {
        const parsed: unknown = JSON.parse(text);
        return typeof parsed === 'object' && parsed !== null ? parsed : text;
    } catch {
        // Not JSON: the string is the model's real answer, and pi's validation reports it.
        return text;
    }
}

/**
 * Unwrap one value against the nodes that describe it, recording each parsed path.
 *
 * @param value - The value the model sent.
 * @param nodes - The schema nodes that describe it.
 * @param path - The value's path inside the call.
 * @param unwrapped - Collects every parsed path.
 * @returns The value with any stringified containers parsed.
 */
function unwrapValue(
    value: unknown,
    nodes: SchemaNode[],
    path: string[],
    unwrapped: UnwrappedArgument[],
): unknown {
    const expanded = expandComposition(nodes);
    const types = expanded.flatMap(declaredTypes);
    let next = value;
    if (
        typeof next === 'string' &&
        !types.includes(STRING_TYPE) &&
        (types.includes(OBJECT_TYPE) || types.includes(ARRAY_TYPE))
    ) {
        next = parseContainer(next);
        if (next !== value) {
            unwrapped.push({ path: path.join('.') });
        }
    }
    if (Array.isArray(next)) {
        return next.map((item: unknown, index) =>
            unwrapValue(item, itemNodes(expanded, index), [...path, String(index)], unwrapped),
        );
    }
    if (typeof next === 'object' && next !== null) {
        return Object.fromEntries(
            Object.entries(next).map(([key, item]) => [
                key,
                unwrapValue(item, propertyNodes(expanded, key), [...path, key], unwrapped),
            ]),
        );
    }
    return next;
}

/**
 * Parse every object or array argument the model sent as JSON text, against the tool's advertised
 * parameters schema.
 *
 * @param args - The raw arguments of one tool call.
 * @param schema - The tool's advertised parameters schema.
 * @returns The arguments to validate and the paths that were parsed.
 */
export function unwrapStringifiedArguments(
    args: unknown,
    schema: Record<string, unknown>,
): StringifiedArgumentsResult {
    const unwrapped: UnwrappedArgument[] = [];
    const result = unwrapValue(args, [schema as SchemaNode], [], unwrapped);
    return { args: unwrapped.length === 0 ? args : result, unwrapped };
}
