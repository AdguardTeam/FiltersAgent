import {
    PromptRenderError,
    extractPlaceholders,
    renderTemplate,
    type PlaceholderValues,
} from '../prompts/template';
import type { DeclaredPlacement, DeclaredPlacementSet } from '../types/declared-placement';
import { PLACEMENT_RULE_TYPE_VALUES, type PlacementRuleType } from '../types/placement-rule-type';
import { unfencedInstructionLines } from './instruction-preparation';

/**
 * The `placement:` declarations one run instruction may carry: which file an accepted rule of each
 * kind goes into, and the comment line that precedes it.
 *
 * Without a declaration the agent chooses the file from where the repository already keeps rules
 * like the candidate. A uAssets-style repository instead appends every rule to the current year's
 * file behind a comment naming the issue, which nothing in the existing rules shows; an instruction
 * that declares its placement says so, and a draft naming any other file for a declared kind is
 * returned to the agent.
 *
 * Each declaration is one line, in the same shape as the `read:` and `launch:` declarations:
 * `placement: [<kind>] <path template> [comment: <comment template>]`. The optional leading kind is
 * one of the placement rule types, so a repository that files by kind can say so — EasyList keeps
 * site-specific hiding, site-specific blocking and ad servers in three different files, which one
 * line cannot express. A line naming no kind covers every kind that has no line of its own. The
 * path template may carry `{{year}}`, the comment template `{{issueUrl}}`; no comment part means no
 * comment line, and the position inside the file is then inferred exactly as it is without a
 * declaration.
 */

/**
 * Placeholder names a placement declaration may carry, so the parser validates and the renderer
 * fills the same two names.
 */
export const PlacementPlaceholder = {
    /**
     * Four-digit current year, in UTC, filled when the run renders the declared path.
     */
    Year: 'year',

    /**
     * Web URL of the issue the run is fixing, filled into the declared comment line.
     */
    IssueUrl: 'issueUrl',
} as const;

/**
 * PlacementPlaceholder value.
 */
export type PlacementPlaceholder = (typeof PlacementPlaceholder)[keyof typeof PlacementPlaceholder];

/**
 * Placeholders the declared path template may carry.
 */
const PLACEMENT_PATH_PLACEHOLDERS: readonly PlacementPlaceholder[] = [PlacementPlaceholder.Year];

/**
 * Placeholders the declared comment template may carry.
 */
const PLACEMENT_COMMENT_PLACEHOLDERS: readonly PlacementPlaceholder[] = [
    PlacementPlaceholder.IssueUrl,
];

/**
 * The declaration head: an optional rule-kind token followed by the path template, both space-free.
 */
const PLACEMENT_DECLARATION_HEAD_PATTERN = /^(?:(\S+)\s+)?(\S+)$/;

/**
 * Boundary between the declaration head and its `comment:` part.
 */
const PLACEMENT_COMMENT_KEYWORD_PATTERN = /\s+comment:\s*/;

/**
 * Keyword a line must start with to be read as a placement declaration.
 */
const PLACEMENT_DECLARATION_KEYWORD = 'placement:';

/**
 * The grammar a malformed declaration is quoted against.
 */
const PLACEMENT_DECLARATION_GRAMMAR = 'placement: [<kind>] <path> [comment: <text>]';

/**
 * Character ceiling on the declared path template.
 *
 * A checkout-relative list path is short — the shipped `filters/filters-{{year}}.txt` is 27
 * characters — so the cap is generous for a nested layout while keeping an unbounded declaration
 * out of every answer that quotes the rendered path: the terminal placement check, the insertion
 * plan, and the published report.
 */
export const MAX_PLACEMENT_PATH_TEMPLATE_CHARACTERS = 200;

/**
 * Character ceiling on the declared comment template.
 *
 * The comment is one line of a filter list holding an issue URL; the same bound as the path keeps
 * one long declaration from reaching the file the run edits.
 */
export const MAX_PLACEMENT_COMMENT_TEMPLATE_CHARACTERS = 200;

/**
 * One malformed placement declaration, named so a failed instruction load says what is wrong.
 */
export class InstructionPlacementError extends Error {
    /**
     * Create one malformed-declaration failure.
     *
     * @param message - Full diagnostic quoting the offending declaration text.
     */
    constructor(message: string) {
        super(message);
        this.name = 'InstructionPlacementError';
    }
}

/**
 * One placement declaration exactly as the instruction writes it, before any rendering.
 */
export interface InstructionPlacementTarget {
    /**
     * Checkout-relative path template of the file accepted rules go into, possibly carrying
     * `{{year}}`.
     */
    pathTemplate: string;

    /**
     * Template of the comment line written immediately before the rule, possibly carrying
     * `{{issueUrl}}`; absent when the declaration asks for no comment.
     */
    commentTemplate?: string;
}

/**
 * Every placement declaration one instruction carries, before any rendering.
 */
export interface InstructionPlacement {
    /**
     * Declarations that named a rule kind, keyed by that kind.
     */
    byRuleType: Partial<Record<PlacementRuleType, InstructionPlacementTarget>>;

    /**
     * The declaration that named no kind; it covers every kind without a line of its own.
     */
    unqualified?: InstructionPlacementTarget;
}

/**
 * What one run fills a placement declaration's placeholders from.
 */
export interface PlacementRenderContext {
    /**
     * Moment the run renders the declaration; its UTC year fills `{{year}}`.
     */
    now: Date;

    /**
     * Web URL of the issue under investigation, filling `{{issueUrl}}`; absent when the caller
     * holds no issue, which is a failed render for a declaration that asks for the URL.
     */
    issueUrl?: string;
}

/**
 * Reject a path template that is not a relative checkout path.
 *
 * The declaration names a file inside the run's own checkout: an absolute path, a Windows
 * separator, or a `..` segment would send the edit outside it, so each is a named refusal rather
 * than a path the run tries to resolve.
 *
 * @param pathTemplate - Declared path template as written.
 * @throws {InstructionPlacementError} When the template is not a bounded relative checkout path.
 */
function assertRelativeCheckoutPath(pathTemplate: string): void {
    if (pathTemplate.length > MAX_PLACEMENT_PATH_TEMPLATE_CHARACTERS) {
        throw new InstructionPlacementError(
            `the declared path is ${pathTemplate.length} characters, above the ` +
                `${MAX_PLACEMENT_PATH_TEMPLATE_CHARACTERS}-character cap`,
        );
    }
    if (pathTemplate.startsWith('/') || /^[A-Za-z]:/.test(pathTemplate)) {
        throw new InstructionPlacementError(
            `the declared path '${pathTemplate}' is absolute; declare it relative to the checkout`,
        );
    }
    if (pathTemplate.includes('\\')) {
        throw new InstructionPlacementError(
            `the declared path '${pathTemplate}' carries a backslash; use '/' separators`,
        );
    }
    const segments = pathTemplate.split('/');
    if (segments.some((segment) => segment.length === 0)) {
        throw new InstructionPlacementError(
            `the declared path '${pathTemplate}' carries an empty path segment`,
        );
    }
    if (segments.includes('..')) {
        throw new InstructionPlacementError(
            `the declared path '${pathTemplate}' escapes the checkout through '..'`,
        );
    }
}

/**
 * Reject a template carrying a placeholder the declaration does not support.
 *
 * @param template - Declared path or comment template.
 * @param allowed - Placeholders this template position supports.
 * @param position - Which part of the declaration is being checked, for the message.
 * @throws {InstructionPlacementError} For a malformed `{{` token or an unsupported placeholder.
 */
function assertSupportedPlaceholders(
    template: string,
    allowed: readonly PlacementPlaceholder[],
    position: string,
): void {
    let declared: string[];
    try {
        declared = extractPlaceholders(template, `placement ${position}`);
    } catch (error) {
        throw new InstructionPlacementError(
            error instanceof PromptRenderError ? error.message : String(error),
        );
    }
    for (const name of declared) {
        if (!(allowed as readonly string[]).includes(name)) {
            throw new InstructionPlacementError(
                `the declared ${position} carries the unsupported placeholder '{{${name}}}'; ` +
                    `it may use only ${allowed.map((value) => `{{${value}}}`).join(', ')}`,
            );
        }
    }
}

/**
 * One parsed declaration line together with the rule kind it named, if any.
 */
interface ParsedDeclarationLine {
    /**
     * Rule kind the line named, or undefined for the unqualified declaration.
     */
    ruleType?: PlacementRuleType;

    /**
     * The declared target the line carries.
     */
    target: InstructionPlacementTarget;
}

/**
 * Read the optional rule-kind token a declaration leads with.
 *
 * @param token - The token preceding the path, when the line carries two.
 * @param declarationLine - The whole declaration, for the message.
 * @returns The named rule kind.
 * @throws {InstructionPlacementError} When the token is not one of the placement rule types.
 */
function parseDeclaredRuleType(token: string, declarationLine: string): PlacementRuleType {
    const named = PLACEMENT_RULE_TYPE_VALUES.find((value) => value === token);
    if (named === undefined) {
        throw new InstructionPlacementError(
            `the declaration '${declarationLine}' names an unknown rule kind '${token}'; the ` +
                `kinds are ${PLACEMENT_RULE_TYPE_VALUES.join(', ')}`,
        );
    }
    return named;
}

/**
 * Parse one declaration line into the rule kind it governs and the target it declares.
 *
 * @param declarationLine - Trimmed instruction line starting with the declaration keyword.
 * @returns The named rule kind, when the line names one, and the declared target.
 * @throws {InstructionPlacementError} When the line does not follow the grammar or carries an
 *   unusable kind, path, or comment template.
 */
function parseDeclarationLine(declarationLine: string): ParsedDeclarationLine {
    const remainder = declarationLine.slice(PLACEMENT_DECLARATION_KEYWORD.length).trim();
    const commentBoundary = PLACEMENT_COMMENT_KEYWORD_PATTERN.exec(remainder);
    const head =
        commentBoundary === null ? remainder : remainder.slice(0, commentBoundary.index).trim();
    const commentTemplate =
        commentBoundary === null
            ? undefined
            : remainder.slice(commentBoundary.index + commentBoundary[0].length).trim();
    const headMatch = PLACEMENT_DECLARATION_HEAD_PATTERN.exec(head);
    if (headMatch === null || commentTemplate === '') {
        throw new InstructionPlacementError(
            `the declaration '${declarationLine}' does not follow ` +
                `"${PLACEMENT_DECLARATION_GRAMMAR}"`,
        );
    }
    const ruleTypeToken = headMatch[1];
    const pathTemplate = headMatch[2] ?? '';
    assertRelativeCheckoutPath(pathTemplate);
    assertSupportedPlaceholders(pathTemplate, PLACEMENT_PATH_PLACEHOLDERS, 'path');
    const ruleType =
        ruleTypeToken === undefined
            ? undefined
            : parseDeclaredRuleType(ruleTypeToken, declarationLine);
    if (commentTemplate === undefined) {
        return { ...(ruleType === undefined ? {} : { ruleType }), target: { pathTemplate } };
    }
    if (commentTemplate.length > MAX_PLACEMENT_COMMENT_TEMPLATE_CHARACTERS) {
        throw new InstructionPlacementError(
            `the declared comment is ${commentTemplate.length} characters, above the ` +
                `${MAX_PLACEMENT_COMMENT_TEMPLATE_CHARACTERS}-character cap`,
        );
    }
    assertSupportedPlaceholders(commentTemplate, PLACEMENT_COMMENT_PLACEHOLDERS, 'comment');
    return {
        ...(ruleType === undefined ? {} : { ruleType }),
        target: { pathTemplate, commentTemplate },
    };
}

/**
 * Read the placements one run instruction declares.
 *
 * Contract: any number of declaration lines outside a fenced block — fenced text is example
 * material, exactly as it is for the other declarations — but at most one per rule kind plus at
 * most one naming no kind. A line that opens with the keyword but does not follow the grammar is a
 * named failure, never a skipped line, and so is a kind declared twice: a repository that names two
 * files for its cosmetic rules has not said where they go. An instruction that declares no
 * placement leaves the choice of file to the agent.
 *
 * @param content - Instruction text as loaded.
 * @returns The declared placements, or undefined when the instruction declares none.
 * @throws {InstructionPlacementError} For a repeated kind, a repeated unqualified line, or a
 *   malformed one.
 */
export function parseInstructionPlacement(content: string): InstructionPlacement | undefined {
    const declarationLines = unfencedInstructionLines(content).filter((line) =>
        line.startsWith(PLACEMENT_DECLARATION_KEYWORD),
    );
    if (declarationLines.length === 0) {
        return undefined;
    }
    const byRuleType: Partial<Record<PlacementRuleType, InstructionPlacementTarget>> = {};
    let unqualified: InstructionPlacementTarget | undefined;
    for (const declarationLine of declarationLines) {
        const parsed = parseDeclarationLine(declarationLine);
        if (parsed.ruleType === undefined) {
            if (unqualified !== undefined) {
                throw new InstructionPlacementError(
                    'the instruction declares placement for every remaining rule kind twice; ' +
                        'declare the unqualified fallback once, or name a kind on each line',
                );
            }
            unqualified = parsed.target;
            continue;
        }
        if (byRuleType[parsed.ruleType] !== undefined) {
            throw new InstructionPlacementError(
                `the instruction declares placement for '${parsed.ruleType}' twice; one rule ` +
                    'kind goes to one place, so declare each kind once',
            );
        }
        byRuleType[parsed.ruleType] = parsed.target;
    }
    return { byRuleType, ...(unqualified === undefined ? {} : { unqualified }) };
}

/**
 * Render one template with exactly the placeholders it declares.
 *
 * The prompt renderer is strict in both directions, so the fills are narrowed to the template's own
 * placeholders: a declaration that names no placeholder renders verbatim, and one that names a
 * placeholder the run cannot fill fails named instead of rendering a hole.
 *
 * @param template - Declared path or comment template.
 * @param values - Values available for the supported placeholders.
 * @param position - Which part of the declaration is being rendered, for the message.
 * @returns The rendered text.
 */
function renderDeclaredTemplate(
    template: string,
    values: PlaceholderValues,
    position: string,
): string {
    const source = `placement ${position}`;
    const fills: PlaceholderValues = {};
    for (const name of extractPlaceholders(template, source)) {
        const value = values[name];
        if (value !== undefined) {
            fills[name] = value;
        }
    }
    return renderTemplate(template, fills, source);
}

/**
 * Render one declared target: the exact file path and comment line this run would write.
 *
 * @param target - One declaration as parsed at load.
 * @param values - Values available for the supported placeholders.
 * @returns The rendered placement a draft must name and the edit writes.
 */
function renderDeclaredTarget(
    target: InstructionPlacementTarget,
    values: PlaceholderValues,
): DeclaredPlacement {
    const filePath = renderDeclaredTemplate(target.pathTemplate, values, 'path');
    if (target.commentTemplate === undefined) {
        return { filePath };
    }
    return {
        filePath,
        commentLine: renderDeclaredTemplate(target.commentTemplate, values, 'comment'),
    };
}

/**
 * Render one run's declared placements: the exact file path and comment line per rule kind.
 *
 * @param placement - The instruction's declarations as parsed at load.
 * @param context - Run facts filling the declarations' placeholders.
 * @returns The rendered placements a draft must name and the edit writes.
 * @throws {PromptRenderError} When a declaration names a placeholder the run cannot fill — a
 *   comment declaring `{{issueUrl}}` in a run that holds no issue URL.
 */
export function renderInstructionPlacement(
    placement: InstructionPlacement,
    context: PlacementRenderContext,
): DeclaredPlacementSet {
    const values: PlaceholderValues = {
        [PlacementPlaceholder.Year]: String(context.now.getUTCFullYear()),
        ...(context.issueUrl === undefined
            ? {}
            : { [PlacementPlaceholder.IssueUrl]: context.issueUrl }),
    };
    const byRuleType: Partial<Record<PlacementRuleType, DeclaredPlacement>> = {};
    for (const ruleType of PLACEMENT_RULE_TYPE_VALUES) {
        const target = placement.byRuleType[ruleType];
        if (target !== undefined) {
            byRuleType[ruleType] = renderDeclaredTarget(target, values);
        }
    }
    return {
        byRuleType,
        ...(placement.unqualified === undefined
            ? {}
            : { unqualified: renderDeclaredTarget(placement.unqualified, values) }),
    };
}

/**
 * Render the placements one run declares, as its whole run then uses them.
 *
 * The run renders its declarations exactly once, at start, and hands the rendered value to every
 * consumer — the terminal placement check, the candidate safety gate, and the patch the publication
 * builds. Rendering them again later would let a run that straddles a UTC new year answer with one
 * year's file and publish into another's.
 *
 * @param placement - The declarations parsed at instruction load, when the run carries any.
 * @param issueUrl - Web URL of the issue under investigation, filling `{{issueUrl}}`.
 * @returns The rendered placements, or undefined when the run declares none.
 * @throws {PromptRenderError} When a declaration names a placeholder the run cannot fill.
 */
export function declaredPlacementForRun(
    placement: InstructionPlacement | undefined,
    issueUrl: string | undefined,
): DeclaredPlacementSet | undefined {
    if (placement === undefined) {
        return undefined;
    }
    return renderInstructionPlacement(placement, {
        now: new Date(),
        ...(issueUrl === undefined ? {} : { issueUrl }),
    });
}
