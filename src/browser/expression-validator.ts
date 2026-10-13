import { parse, type AnyNode, type MemberExpression, type Node, type Pattern } from 'acorn';

/**
 * Read-only guard for evaluate_js expressions.
 *
 * The expression is parsed and judged as syntax, not scanned as text: a write is an assignment,
 * update or delete whose target is page state, a call of a method that mutates the page, or a call
 * that defers or hides code. Variables the expression declares are its own, and so are the object
 * and array literals it declares, so walking a parent chain with a loop variable, counting with
 * `++`, or filling a local `out` object is read-only. A text-level lexer cannot tell a local from
 * the page and refuses all of those — nearly every real read-only diagnostic — which quarantines
 * the tool and leaves a run spending its whole budget probing selectors through `stabilize_page`.
 */
/**
 * Literal patterns that are never valid in a read-only evaluate_js diagnostic, matched on the raw
 * text before parsing: outbound channels, navigation, sensitive storage and dynamic loading have no
 * read-only use in a diagnostic, wherever they appear.
 */
const DANGEROUS_PATTERNS = [
    'fetch(',
    'XMLHttpRequest',
    'document.cookie',
    'localStorage.',
    'sessionStorage.',
    'indexedDB',
    'location.href',
    'location.assign',
    'location.replace',
    'location.reload',
    'window.open',
    'WebSocket',
    'EventSource',
    'sendBeacon',
    'serviceWorker',
    'SharedWorker',
    'import(',
    'require(',
    'process.',
    'globalThis.',
];

/**
 * Methods that mutate DOM, browser, event, or observable page state.
 */
const MUTATING_METHOD_NAMES = [
    'addEventListener',
    'after',
    'animate',
    'append',
    'appendChild',
    'before',
    'blur',
    'click',
    'close',
    'deleteProperty',
    'deleteRule',
    'defineProperties',
    'defineProperty',
    'dispatchEvent',
    'execCommand',
    'focus',
    'insertAdjacentElement',
    'insertAdjacentHTML',
    'insertAdjacentText',
    'insertBefore',
    'insertRule',
    'observe',
    'pause',
    'play',
    'prepend',
    'pushState',
    'remove',
    'removeAttribute',
    'removeAttributeNS',
    'removeEventListener',
    'removeProperty',
    'replaceChild',
    'replaceChildren',
    'replaceState',
    'replaceSync',
    'replaceWith',
    'requestSubmit',
    'reset',
    'scroll',
    'scrollBy',
    'scrollIntoView',
    'scrollTo',
    'setAttribute',
    'setAttributeNS',
    'setPointerCapture',
    'setProperty',
    'setPrototypeOf',
    'show',
    'showModal',
    'submit',
    'write',
    'writeln',
];

/**
 * Global scheduling and dynamic-code APIs that can defer or hide page mutations.
 */
const SIDE_EFFECTFUL_GLOBAL_CALLS = [
    'cancelAnimationFrame',
    'cancelIdleCallback',
    'clearInterval',
    'clearTimeout',
    'eval',
    'Function',
    'queueMicrotask',
    'requestAnimationFrame',
    'requestIdleCallback',
    'setInterval',
    'setTimeout',
];

/**
 * Property names of the `classList` mutators whose names also have read-only uses on other types
 * (`Set.add`, `String.replace`), so they are refused only on a `classList` receiver.
 */
const CLASS_LIST_MUTATORS: ReadonlySet<string> = new Set(['add', 'remove', 'replace', 'toggle']);

/**
 * Node types that open a function scope: `var` declarations and parameters bind here.
 */
const FUNCTION_SCOPE_TYPES: ReadonlySet<string> = new Set([
    'Program',
    'FunctionDeclaration',
    'FunctionExpression',
    'ArrowFunctionExpression',
    'StaticBlock',
]);

/**
 * Node types that open a block scope: `let` and `const` declarations bind here.
 */
const BLOCK_SCOPE_TYPES: ReadonlySet<string> = new Set([
    'BlockStatement',
    'ForStatement',
    'ForInStatement',
    'ForOfStatement',
    'SwitchStatement',
    'CatchClause',
]);

/**
 * Node fields that are not child nodes.
 */
const NON_CHILD_FIELDS: ReadonlySet<string> = new Set(['type', 'start', 'end', 'loc', 'range']);

/**
 * Longest source excerpt quoted back in a rejection.
 */
const MAX_QUOTED_SOURCE_LENGTH = 80;

/**
 * Prefix of every rejection the syntax rules raise.
 */
const READ_ONLY_REJECTION_PREFIX = 'expression rejected by read-only validator: ';

/**
 * Why an expression was refused, as the tool result reports it.
 */
export const ExpressionRejectionKind = {
    /**
     * The expression breaks the read-only policy or the safety blocklist.
     */
    Policy: 'policy_rejection',

    /**
     * The expression is not JavaScript the validator can judge, so it never reaches the page.
     */
    Syntax: 'syntax_error',
} as const;

/**
 * ExpressionRejectionKind value.
 */
export type ExpressionRejectionKind =
    (typeof ExpressionRejectionKind)[keyof typeof ExpressionRejectionKind];

/**
 * One refused expression: what to tell the model and which failure class it is.
 */
export interface ExpressionRejection {
    /**
     * The model-facing reason, naming the construct and the source it refused.
     */
    message: string;

    /**
     * The failure class; only a policy rejection counts toward the tool's quarantine.
     */
    kind: ExpressionRejectionKind;
}

/**
 * One lexical scope of the expression and what it declares.
 */
interface Scope {
    /**
     * The enclosing scope, or null for the program scope.
     */
    parent: Scope | null;

    /**
     * Whether `var` declarations and parameters bind here.
     */
    functionScope: boolean;

    /**
     * Names declared in this scope, each with whether it is a fresh object or array literal.
     */
    declared: Map<string, boolean>;
}

/**
 * The scope model of one parsed expression.
 */
interface ScopeModel {
    /**
     * The scope each scope-opening node created.
     */
    scopes: Map<Node, Scope>;

    /**
     * Every name that is the target of an assignment or update anywhere in the expression.
     */
    reassigned: Set<string>;
}

/**
 * Iterate the child nodes of one node, in source order.
 *
 * @param node - The parent node.
 * @yields Each child node.
 */
function* childNodes(node: Node): Generator<AnyNode> {
    for (const [field, value] of Object.entries(node)) {
        if (NON_CHILD_FIELDS.has(field)) {
            continue;
        }
        if (Array.isArray(value)) {
            for (const item of value) {
                if (isNode(item)) {
                    yield item;
                }
            }
        } else if (isNode(value)) {
            yield value;
        }
    }
}

/**
 * Whether a field value is an AST node.
 *
 * @param value - Any field value.
 * @returns Whether it carries a node type.
 */
function isNode(value: unknown): value is AnyNode {
    return typeof value === 'object' && value !== null && typeof (value as Node).type === 'string';
}

/**
 * Collect the names a binding pattern declares.
 *
 * @param pattern - The declaration target.
 * @param names - The set to add the names to.
 */
function collectPatternNames(pattern: Pattern | null, names: Set<string>): void {
    if (pattern === null) {
        return;
    }
    switch (pattern.type) {
        case 'Identifier':
            names.add(pattern.name);
            break;
        case 'ObjectPattern':
            for (const property of pattern.properties) {
                collectPatternNames(
                    property.type === 'RestElement' ? property : property.value,
                    names,
                );
            }
            break;
        case 'ArrayPattern':
            for (const element of pattern.elements) {
                collectPatternNames(element, names);
            }
            break;
        case 'RestElement':
            collectPatternNames(pattern.argument, names);
            break;
        case 'AssignmentPattern':
            collectPatternNames(pattern.left, names);
            break;
        case 'MemberExpression':
            break;
    }
}

/**
 * Whether a declarator initializes a fresh object or array literal the expression owns.
 *
 * @param init - The declarator's initializer.
 * @returns Whether writes to its own properties can touch nothing but that literal.
 */
function isFreshContainer(init: AnyNode | null | undefined): boolean {
    return init?.type === 'ObjectExpression' || init?.type === 'ArrayExpression';
}

/**
 * Declare names into the scope a declaration binds to.
 *
 * @param scope - The scope of the node the declaration appears in.
 * @param names - The declared names.
 * @param kind - `var` binds to the nearest function scope, anything else to the scope itself.
 * @param container - Whether the declaration initializes a fresh object or array literal.
 */
function declare(scope: Scope, names: Iterable<string>, kind: string, container: boolean): void {
    let target = scope;
    if (kind === 'var') {
        while (!target.functionScope && target.parent) {
            target = target.parent;
        }
    }
    for (const name of names) {
        target.declared.set(name, container && !target.declared.has(name));
    }
}

/**
 * Build the scope model: which names each scope declares and which names are ever reassigned.
 *
 * @param node - The node to model.
 * @param scope - The scope the node appears in.
 * @param model - The model under construction.
 */
function modelScopes(node: AnyNode, scope: Scope, model: ScopeModel): void {
    let current = scope;
    if (FUNCTION_SCOPE_TYPES.has(node.type) || BLOCK_SCOPE_TYPES.has(node.type)) {
        current = {
            parent: scope,
            functionScope: FUNCTION_SCOPE_TYPES.has(node.type),
            declared: new Map(),
        };
        model.scopes.set(node, current);
    }
    switch (node.type) {
        case 'FunctionDeclaration':
        case 'FunctionExpression':
        case 'ArrowFunctionExpression': {
            const names = new Set<string>();
            for (const param of node.params) {
                collectPatternNames(param, names);
            }
            declare(current, names, 'param', false);
            if (node.type === 'FunctionDeclaration' && node.id) {
                declare(scope, [node.id.name], 'let', false);
            } else if (node.type === 'FunctionExpression' && node.id) {
                declare(current, [node.id.name], 'let', false);
            }
            break;
        }
        case 'ClassDeclaration':
            if (node.id) {
                declare(scope, [node.id.name], 'let', false);
            }
            break;
        case 'CatchClause':
            if (node.param) {
                const names = new Set<string>();
                collectPatternNames(node.param, names);
                declare(current, names, 'let', false);
            }
            break;
        case 'VariableDeclaration':
            for (const declarator of node.declarations) {
                const names = new Set<string>();
                collectPatternNames(declarator.id, names);
                declare(current, names, node.kind, isFreshContainer(declarator.init));
            }
            break;
        case 'AssignmentExpression':
            if (node.left.type === 'Identifier') {
                model.reassigned.add(node.left.name);
            }
            break;
        case 'UpdateExpression':
            if (node.argument.type === 'Identifier') {
                model.reassigned.add(node.argument.name);
            }
            break;
        case 'ForInStatement':
        case 'ForOfStatement':
            if (node.left.type === 'Identifier') {
                model.reassigned.add(node.left.name);
            }
            break;
        default:
            break;
    }
    for (const child of childNodes(node)) {
        modelScopes(child, current, model);
    }
}

/**
 * Resolve a name through the scope chain.
 *
 * @param scope - The innermost scope.
 * @param name - The identifier name.
 * @returns Whether the name is declared, and whether as a fresh container; undefined when it is not
 *   declared by the expression at all and so names page state.
 */
function resolve(scope: Scope, name: string): boolean | undefined {
    for (let current: Scope | null = scope; current; current = current.parent) {
        const declared = current.declared.get(name);
        if (declared !== undefined) {
            return declared;
        }
    }
    return undefined;
}

/**
 * The name a member access reads, when it is spelled out in the source.
 *
 * @param node - The member expression.
 * @returns The property name, or undefined for a computed access the source does not name.
 */
function memberName(node: MemberExpression): string | undefined {
    if (!node.computed && node.property.type === 'Identifier') {
        return node.property.name;
    }
    if (node.property.type === 'Literal' && typeof node.property.value === 'string') {
        return node.property.value;
    }
    return undefined;
}

/**
 * Quote the source of one node back to the model.
 *
 * @param source - The whole expression.
 * @param node - The node to quote.
 * @returns The bounded source excerpt in double quotes.
 */
function quote(source: string, node: Node): string {
    const text = source.slice(node.start, node.end);
    return `"${text.length > MAX_QUOTED_SOURCE_LENGTH ? `${text.slice(0, MAX_QUOTED_SOURCE_LENGTH)}…` : text}"`;
}

/**
 * The read-only rule one node breaks, if any.
 *
 * @param node - The node to judge.
 * @param scope - The innermost scope the node appears in.
 * @param model - The expression's scope model.
 * @param source - The whole expression, for the quoted excerpt.
 * @returns The rejection reason, or undefined when the node is read-only.
 */
function ruleBrokenBy(
    node: AnyNode,
    scope: Scope,
    model: ScopeModel,
    source: string,
): string | undefined {
    switch (node.type) {
        case 'AssignmentExpression':
        case 'ForInStatement':
        case 'ForOfStatement': {
            const target = node.left;
            if (target.type === 'VariableDeclaration') {
                return undefined;
            }
            if (target.type === 'Identifier') {
                return resolve(scope, target.name) === undefined
                    ? `assignment to ${quote(source, target)} is not allowed: only a variable ` +
                          'the expression declares may be assigned'
                    : undefined;
            }
            if (
                target.type === 'MemberExpression' &&
                target.object.type === 'Identifier' &&
                resolve(scope, target.object.name) === true &&
                !model.reassigned.has(target.object.name)
            ) {
                return undefined;
            }
            return (
                `assignment to ${quote(source, target)} is not allowed: only a variable the ` +
                'expression declares, or a property of an object or array literal it declares, ' +
                'may be assigned'
            );
        }
        case 'UpdateExpression':
            return node.argument.type === 'Identifier' &&
                resolve(scope, node.argument.name) !== undefined
                ? undefined
                : `${node.operator} on ${quote(source, node.argument)} is not allowed: only a ` +
                      'variable the expression declares may be updated';
        case 'UnaryExpression':
            return node.operator === 'delete'
                ? `delete is not allowed (${quote(source, node)})`
                : undefined;
        case 'MemberExpression': {
            const name = memberName(node);
            if (name === undefined) {
                return undefined;
            }
            if (MUTATING_METHOD_NAMES.includes(name)) {
                return `${quote(source, node)} mutates the page: ${name} is not allowed`;
            }
            if (
                CLASS_LIST_MUTATORS.has(name) &&
                node.object.type === 'MemberExpression' &&
                memberName(node.object) === 'classList'
            ) {
                return `${quote(source, node)} mutates the page: classList.${name} is not allowed`;
            }
            if (
                name === 'assign' &&
                node.object.type === 'Identifier' &&
                node.object.name === 'Object'
            ) {
                return `${quote(source, node)} mutates its target: Object.assign is not allowed`;
            }
            if (SIDE_EFFECTFUL_GLOBAL_CALLS.includes(name)) {
                return `${quote(source, node)} defers or hides code: ${name} is not allowed`;
            }
            return undefined;
        }
        case 'CallExpression':
        case 'NewExpression':
            return node.callee.type === 'Identifier' &&
                SIDE_EFFECTFUL_GLOBAL_CALLS.includes(node.callee.name)
                ? `${quote(source, node)} defers or hides code: ${node.callee.name} is not allowed`
                : undefined;
        case 'ImportExpression':
            return `${quote(source, node)} loads code: import() is not allowed`;
        case 'WithStatement':
            return 'with statements are not allowed';
        default:
            return undefined;
    }
}

/**
 * Walk the expression and report the first read-only rule it breaks.
 *
 * @param node - The node to walk.
 * @param scope - The innermost scope the node appears in.
 * @param model - The expression's scope model.
 * @param source - The whole expression.
 * @returns The first rejection reason, or undefined when every node is read-only.
 */
function firstBrokenRule(
    node: AnyNode,
    scope: Scope,
    model: ScopeModel,
    source: string,
): string | undefined {
    const current = model.scopes.get(node) ?? scope;
    const broken = ruleBrokenBy(node, current, model, source);
    if (broken !== undefined) {
        return broken;
    }
    for (const child of childNodes(node)) {
        const childBroken = firstBrokenRule(child, current, model, source);
        if (childBroken !== undefined) {
            return childBroken;
        }
    }
    return undefined;
}

/**
 * Validate an evaluate_js expression against the safety blocklist, the read-only rules and the
 * length cap.
 *
 * @param expr - The JavaScript expression string from the LLM.
 * @param maxLen - The maximum allowed length in characters.
 * @returns `null` if valid, otherwise the rejection to answer with.
 */
export function validateExpression(expr: string, maxLen: number): ExpressionRejection | null {
    if (expr.length > maxLen) {
        return {
            kind: ExpressionRejectionKind.Policy,
            message: `expression exceeds maximum length of ${maxLen} characters`,
        };
    }
    const lower = expr.toLowerCase();
    for (const pattern of DANGEROUS_PATTERNS) {
        if (lower.includes(pattern.toLowerCase())) {
            return {
                kind: ExpressionRejectionKind.Policy,
                message: `expression rejected by safety validator: contains blocked pattern "${pattern}"`,
            };
        }
    }
    let program: AnyNode;
    try {
        program = parse(expr, {
            ecmaVersion: 'latest',
            sourceType: 'script',
            allowAwaitOutsideFunction: true,
        });
    } catch (error) {
        return {
            kind: ExpressionRejectionKind.Syntax,
            message: `expression is not valid JavaScript: ${(error as Error).message}`,
        };
    }
    const model: ScopeModel = { scopes: new Map(), reassigned: new Set() };
    const root: Scope = { parent: null, functionScope: true, declared: new Map() };
    modelScopes(program, root, model);
    const broken = firstBrokenRule(program, root, model, expr);
    return broken === undefined
        ? null
        : { kind: ExpressionRejectionKind.Policy, message: READ_ONLY_REJECTION_PREFIX + broken };
}

/**
 * Return a JSON-safe description of a large arbitrary read-only evaluation result.
 *
 * @param value - Browser evaluation result that is too large to inline.
 * @returns Compact structural preview without recursively copying the full result.
 */
export function describeLargeEvaluationResult(value: unknown): Record<string, unknown> {
    if (Array.isArray(value)) {
        return {
            kind: 'array',
            itemCount: value.length,
            itemTypes: [...new Set(value.slice(0, 20).map((item) => typeof item))],
        };
    }
    if (value !== null && typeof value === 'object') {
        return {
            kind: 'object',
            keys: Object.keys(value as Record<string, unknown>).slice(0, 20),
        };
    }
    if (typeof value === 'string') {
        return {
            kind: 'string',
            characterCount: value.length,
            preview: value.slice(0, 512),
        };
    }
    return { kind: value === null ? 'null' : typeof value };
}
