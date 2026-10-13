import {
    RULE_APPLICATION_SECTION_KEYWORDS,
    STATE_VERIFICATION_SECTION_KEYWORDS,
} from './instruction-application';
import { extractInstructionSection, unfencedInstructionLines } from './instruction-preparation';

/**
 * The `application:` declaration one run instruction may carry: the built-in application route this
 * run applies its candidate rule through, instead of writing the steps out itself.
 *
 * Every other instruction-dependent role resolves per section — an instruction silent about
 * preparation, `launch:`, `placement:`, issue selection or the report template keeps the built-in
 * behaviour for that role. The application contract is the one exception: an instruction replaces
 * the built-in application document wholesale, so an instruction written only to link its
 * repository's guidance documents carries no contract at all. The early file-backed gate cannot
 * catch that (there is no contract to inspect), so without this declaration the run would spend its
 * whole budget before `apply_rule` refuses with `no-application-method`.
 *
 * The declaration is one line, in the same shape as the `read:`, `launch:` and `placement:`
 * declarations: `application: <route>`.
 */

/**
 * Built-in application routes an instruction may declare.
 *
 * One route exists today: the AdGuard Browser Extension in Chromium, whose application document
 * specifies a fixed message protocol the host both performs and reads back itself. A repository
 * whose blocker is that extension declares the route rather than copying the document's steps into
 * its own instruction, where they would then drift from the shipped ones.
 */
export const ApplicationRoute = {
    /**
     * The built-in AdGuard Browser Extension route: the host prepares the pinned release, launches
     * it in Chromium, performs the shipped document's message protocol itself in code, and reads
     * the live extension state back. No model session is involved at any point.
     */
    AdguardExtension: 'adguard-extension',
} as const;

/**
 * Every ApplicationRoute value, for refusal messages and exhaustive listings.
 */
export const APPLICATION_ROUTE_VALUES = Object.values(ApplicationRoute);

/**
 * ApplicationRoute value.
 */
export type ApplicationRoute = (typeof ApplicationRoute)[keyof typeof ApplicationRoute];

/**
 * The declaration grammar: the route name as one space-free token, and nothing else on the line.
 */
const APPLICATION_DECLARATION_LINE_PATTERN = /^application:\s*(\S+)\s*$/;

/**
 * Keyword a line must start with to be read as an application-route declaration.
 */
const APPLICATION_DECLARATION_KEYWORD = 'application:';

/**
 * One unusable `application:` declaration, named so a failed instruction load says what is wrong.
 */
export class InstructionApplicationRouteError extends Error {
    /**
     * Create one unusable-declaration failure.
     *
     * @param message - Full diagnostic quoting the offending declaration text.
     */
    constructor(message: string) {
        super(message);
        this.name = 'InstructionApplicationRouteError';
    }
}

/**
 * The two sections that together are an instruction's own application contract, each as the binding
 * keywords of its heading — the first of which is the full heading phrase the refusal names, so a
 * maintainer reads back exactly what to search the file for.
 */
const OWN_CONTRACT_SECTION_KEYWORDS = [
    RULE_APPLICATION_SECTION_KEYWORDS,
    STATE_VERIFICATION_SECTION_KEYWORDS,
] as const;

/**
 * Name the application-contract sections one instruction carries of its own.
 *
 * A declared route and hand-written application steps are two answers to the same question and the
 * run can honour only one; naming which sections are present is what makes the refusal say so.
 *
 * @param content - Instruction text as loaded.
 * @returns Names of the contract sections the instruction fills itself, in contract order; empty
 *   when it carries neither.
 */
function ownContractSections(content: string): string[] {
    return OWN_CONTRACT_SECTION_KEYWORDS.filter(
        (keywords) => extractInstructionSection(content, keywords) !== undefined,
    ).map((keywords) => keywords[0]);
}

/**
 * Read the built-in application route one run instruction declares.
 *
 * Contract: at most one declaration line anywhere outside a fenced block — fenced text is example
 * material, exactly as it is for the other declarations — and a line that opens with the keyword
 * but names a route the host does not have is a named failure, never a skipped line. Declaring a
 * route while also carrying the instruction's own application contract is a contradiction and fails
 * the same way. An instruction that declares no route and carries its own sections keeps performing
 * those, and one that declares neither still reaches the `no-application-method` gap it reaches
 * today.
 *
 * @param content - Instruction text as loaded.
 * @returns The declared route, or undefined when the instruction declares none.
 * @throws {InstructionApplicationRouteError} For a second declaration, an unknown route name, or a
 *   declaration beside the instruction's own application sections.
 */
export function parseInstructionApplicationRoute(content: string): ApplicationRoute | undefined {
    const declarationLines = unfencedInstructionLines(content).filter((line) =>
        line.startsWith(APPLICATION_DECLARATION_KEYWORD),
    );
    if (declarationLines.length === 0) {
        return undefined;
    }
    if (declarationLines.length > 1) {
        throw new InstructionApplicationRouteError(
            `the instruction carries ${declarationLines.length} application declarations; one run ` +
                'applies its rule one way, so declare it once',
        );
    }
    const declarationLine = declarationLines[0] as string;
    const match = APPLICATION_DECLARATION_LINE_PATTERN.exec(declarationLine);
    const declared = match?.[1];
    const route = APPLICATION_ROUTE_VALUES.find((known) => known === declared);
    if (route === undefined) {
        throw new InstructionApplicationRouteError(
            `the declaration '${declarationLine}' does not name a built-in application route; ` +
                `"application:" accepts only ${APPLICATION_ROUTE_VALUES.join(', ')}`,
        );
    }
    const own = ownContractSections(content);
    if (own.length > 0) {
        throw new InstructionApplicationRouteError(
            `it declares the built-in application route "${route}" and also carries its own ` +
                `${own.join(' and ')} section(s); the run can apply a rule one way only, so ` +
                'either keep the declaration and delete those sections or drop the declaration ' +
                'and keep them',
        );
    }
    return route;
}
