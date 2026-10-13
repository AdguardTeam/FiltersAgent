import { ApplicationInstructionGap } from '../environment/application-instruction-gap';
import {
    BLOCKER_VERIFICATION_METHOD_VALUES,
    BlockerVerificationMethod,
} from '../environment/environment-proofs';
import { ExtensionLaunchFamily } from '../environment/extension-launch';
import { sha256OfContent } from '../environment/rules-content';
import {
    declaredExtensionLaunchFamily,
    extractInstructionSection,
} from './instruction-preparation';

/**
 * Application-contract parsing of a run instruction.
 *
 * The model performs the candidate application between phase open and observation by following the
 * instruction's own rule-application steps, while the host reads the blocker state back itself. The
 * instruction must therefore carry one `## Rule application` heading (the steps, performed
 * verbatim) and one `## State verification` heading declaring how the host may read the state back
 * (`read: <method> <target?>`). An instruction that does not carry both is a recorded refusal — the
 * host never invents an application method.
 */

/**
 * Keywords binding a Markdown `##` heading to the rule-application role, checked case-insensitively
 * in the heading text.
 */
export const RULE_APPLICATION_SECTION_KEYWORDS = ['rule application', 'application'] as const;

/**
 * Keywords binding a Markdown `##` heading to the state-verification role, checked
 * case-insensitively in the heading text.
 */
export const STATE_VERIFICATION_SECTION_KEYWORDS = ['state verification', 'verification'] as const;

/**
 * Maximum characters of the declared method token quoted into a refusal detail.
 *
 * The grammar treats the method token as an identifier; a longer token is not one, so it is quoted
 * truncated and the refusal detail stays single-line bounded without naming an unbounded upstream
 * string. The target path is never truncated: a wrong path is worse than a long one.
 */
export const DECLARATION_METHOD_TOKEN_MAX = 64;

/**
 * One instruction section bound to the rule-application role.
 */
export interface RuleApplicationSection {
    /**
     * Application steps exactly as written between the application heading and the next `##`
     * heading (or the end of the instruction), without the heading line itself.
     */
    content: string;

    /**
     * SHA-256 over the exact content bytes, so run evidence can state what was applied from.
     */
    sha256: string;
}

/**
 * One verification declaration the instruction makes to the host.
 */
export interface BlockerVerificationDeclaration {
    /**
     * How the host reads the blocker state back after the application steps.
     */
    method: BlockerVerificationMethod;

    /**
     * Exact path the declaration reads for the file-backed methods (`user-rules-file`,
     * `managed-storage-file`); never present for `extension-state`, whose target is the live
     * extension and whose trailing words are documentation of which state to read.
     */
    target?: string;
}

/**
 * One typed application-contract refusal recording what the instruction is missing.
 */
export interface ApplicationInstructionRefusal {
    /**
     * The stable refusal class recording what the instruction is missing.
     */
    gap: ApplicationInstructionGap;

    /**
     * Bounded detail naming what is missing, quoting declared tokens at fault.
     */
    detail: string;
}

/**
 * Outcome of parsing one instruction's application contract.
 *
 * Either the instruction describes how to apply a rule and how the host verifies it, or it is one
 * typed refusal recording exactly what is missing.
 */
export type RuleApplicationParse =
    | {
          /**
           * The application section with its digest over the exact bytes.
           */
          application: RuleApplicationSection;

          /**
           * The verification declaration the host must honor.
           */
          verification: BlockerVerificationDeclaration;
      }
    | ApplicationInstructionRefusal;

/**
 * The `read:` declaration grammar: `read: <method>` optionally followed by one target token or a
 * short state qualifier.
 */
const VERIFICATION_DECLARATION_LINE_PATTERN = /^read:\s*(\S+)(?:\s+(.*\S))?\s*$/;

/**
 * Build the refusal for a verification declaration that cannot be honored, naming what is wrong.
 *
 * @param gap - The stable refusal class.
 * @param detail - Bounded detail naming the missing or malformed part.
 * @returns The refusal record.
 */
function verificationRefusal(
    gap: ApplicationInstructionGap,
    detail: string,
): ApplicationInstructionRefusal {
    return { gap, detail };
}

/**
 * Parse one `read:` declaration line into a typed verification declaration.
 *
 * The method token must be one of the known verification methods; the file-backed methods require
 * exactly their target path, while `extension-state` never carries a target (its trailing words
 * name which state to read and are never consumed as a path).
 *
 * @param declarationLine - One non-empty line of the verification section starting with `read:`.
 * @returns The parsed declaration, or the typed refusal it fails as.
 */
function parseVerificationDeclaration(
    declarationLine: string,
): BlockerVerificationDeclaration | ApplicationInstructionRefusal {
    const match = VERIFICATION_DECLARATION_LINE_PATTERN.exec(declarationLine);
    if (match === null) {
        return verificationRefusal(
            ApplicationInstructionGap.NoVerificationMethod,
            'The state-verification section never declares a usable "read:" line.',
        );
    }
    const methodToken = (match[1] ?? '').slice(0, DECLARATION_METHOD_TOKEN_MAX);
    const rest = match[2] ?? '';
    if (!BLOCKER_VERIFICATION_METHOD_VALUES.includes(methodToken as BlockerVerificationMethod)) {
        return verificationRefusal(
            ApplicationInstructionGap.UnknownVerificationMethod,
            `The state verification declares an unknown method "${methodToken}"; known methods: ` +
                `${BLOCKER_VERIFICATION_METHOD_VALUES.join(', ')}.`,
        );
    }
    const method = methodToken as BlockerVerificationMethod;
    if (method === BlockerVerificationMethod.ExtensionState) {
        // The trailing words of an extension-state declaration name the state family to read; the
        // host reads the live extension, so no target path exists to honor.
        return { method };
    }
    const target = rest.trim();
    if (target.length === 0) {
        return verificationRefusal(
            ApplicationInstructionGap.NoVerificationMethod,
            `The state verification declares method "${method}" without the path to read.`,
        );
    }
    return { method, target };
}

/**
 * Parse the application contract one run instruction must carry.
 *
 * Contract: the first `##` heading bound by the rule-application keywords and the first bound by
 * the state-verification keywords are extracted verbatim (fenced `##` lines neither bind nor
 * bound); the verification section must carry one usable `read:` declaration line, whose method
 * token must be known and whose file-backed target must be present. Every missed requirement is a
 * typed gap — never a guessed fallback.
 *
 * @param content - Instruction text as loaded.
 * @returns The application section with its digest plus the verification declaration, or the typed
 *   refusal recording what the instruction is missing.
 */
export function parseRuleApplication(content: string): RuleApplicationParse {
    const applicationContent = extractInstructionSection(
        content,
        RULE_APPLICATION_SECTION_KEYWORDS,
    );
    if (applicationContent === undefined) {
        return {
            gap: ApplicationInstructionGap.NoApplicationMethod,
            detail:
                'The instruction carries no rule-application section: nothing describes how ' +
                'to apply a rule.',
        };
    }
    const verificationContent = extractInstructionSection(
        content,
        STATE_VERIFICATION_SECTION_KEYWORDS,
    );
    if (verificationContent === undefined) {
        return verificationRefusal(
            ApplicationInstructionGap.NoVerificationMethod,
            'The instruction carries no state-verification section: the host is not told how to ' +
                'read the blocker state back.',
        );
    }
    const declarationLine = verificationContent
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.startsWith('read:'));
    if (declarationLine === undefined) {
        return verificationRefusal(
            ApplicationInstructionGap.NoVerificationMethod,
            'The state-verification section never declares a usable "read:" line.',
        );
    }
    const parsedDeclaration = parseVerificationDeclaration(declarationLine);
    if ('gap' in parsedDeclaration) {
        return parsedDeclaration;
    }
    return {
        application: {
            content: applicationContent,
            sha256: sha256OfContent(applicationContent),
        },
        verification: parsedDeclaration,
    };
}

/**
 * Detail explaining why a run must refuse before any paid work, when the instruction's application
 * contract declares a file-backed verification method the host cannot apply.
 *
 * Exactly one file-backed pairing runs: `managed-storage-file` beside a `launch: firefox`
 * declaration in the preparation section. There the host itself maintains the declared file between
 * phases — it writes the file, rebuilds the Firefox enterprise policies from the instruction's
 * managed-storage declaration, relaunches the browser so it reads them at startup, and reads the
 * file back. Every other file-backed declaration has nobody who writes the file the read names:
 * `user-rules-file` reaches a Chromium blocker whose own storage the host cannot write, and a
 * `managed-storage-file` without a Firefox launch declaration names no policies to rebuild — so the
 * host would always read back a file the run itself never populated and the phase could never
 * verify.
 *
 * This is the one gate every face calls at the earliest point it holds the loaded instruction,
 * before the issue is fetched, intake extraction runs, or any other paid work starts, so a run that
 * can never succeed never pays for one.
 *
 * @param content - The run instruction's Markdown content.
 * @returns The refusal detail naming the declared method and what a runnable declaration would have
 *   to say, or undefined when the instruction carries no application contract, declares a method
 *   other than the two file-backed ones, or declares the one file-backed pairing that runs.
 */
export function fileBackedApplicationRefusalDetail(content: string): string | undefined {
    const contract = parseRuleApplication(content);
    if ('gap' in contract) {
        return undefined;
    }
    const { method } = contract.verification;
    if (
        method !== BlockerVerificationMethod.UserRulesFile &&
        method !== BlockerVerificationMethod.ManagedStorageFile
    ) {
        return undefined;
    }
    if (
        method === BlockerVerificationMethod.ManagedStorageFile &&
        declaredExtensionLaunchFamily(content) === ExtensionLaunchFamily.Firefox
    ) {
        return undefined;
    }
    return (
        `The run instruction declares the file-backed verification method "${method}", which no ` +
        'session or host step in this run can apply: the only file-backed application that runs ' +
        `is "${BlockerVerificationMethod.ManagedStorageFile}" beside a ` +
        `"launch: ${ExtensionLaunchFamily.Firefox}" declaration in the preparation section, where ` +
        'the host maintains the declared file and rebuilds the enterprise policies around it. As ' +
        'declared, the host would read back a file the run itself never populated, so the phase ' +
        'could never verify.'
    );
}
