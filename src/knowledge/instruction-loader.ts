import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
    GUIDANCE_DOCUMENT_ROLE_VALUES,
    GuidanceDocumentOrigin,
    GuidanceDocumentRole,
    MAX_LINKED_DOCUMENTS,
    RuleGuidanceSourceKind,
    type InstructionGuidanceSource,
    type InstructionLinkedDocument,
} from './guidance-source';
import {
    parseInstructionApplicationRoute,
    type ApplicationRoute,
} from './instruction-application-route';
import { parseInstructionPlacement, type InstructionPlacement } from './instruction-placement';
import {
    downloadLinkedDocument,
    LinkedDocumentDownloadError,
    MAX_LINKED_DOCUMENT_BYTES,
} from './linked-document-downloader';

/**
 * Checkout-relative path probed when the run supplies no explicit instruction path.
 *
 * The default lives under `.github/filters-agent/`, so it never collides with a repository's own
 * root `AGENTS.md` — the coding agent's file, which is never a run instruction. An explicit
 * `instructionPath` override always wins over this default.
 */
export const DEFAULT_INSTRUCTION_PATH = '.github/filters-agent/AGENTS.md';

/**
 * Character ceiling on the instruction text itself.
 *
 * The instruction rides the run prompt exactly once, so an instruction file that outgrows the
 * prompt budget is a typed run-start failure naming the path — never a silent truncation that would
 * leave the model working from partial rules.
 */
export const MAX_INSTRUCTION_CHARACTERS = 16_000;

/**
 * Stable failure classes of the instruction loader.
 */
export const InstructionLoadFailureCode = {
    /**
     * An explicitly supplied instruction path is missing or cannot be read; the message names the
     * path. Never a silent built-in fallback: the built-in belongs to absence only.
     */
    InstructionUnreadable: 'instruction_unreadable',

    /**
     * A linked document could not be loaded: unreachable URL, missing checkout path, path outside
     * the checkout, oversized, or empty; the message names the failed link.
     */
    DocumentUnreachable: 'document_unreachable',

    /**
     * The instruction text exceeds MAX_INSTRUCTION_CHARACTERS; the message names the path.
     */
    InstructionTooLarge: 'instruction_too_large',

    /**
     * The instruction's `placement:` declaration cannot be read: a second declaration, a line that
     * does not follow the grammar, an unusable path, or an unsupported placeholder. A run whose
     * repository has stated where its rules go must not proceed on a guess about it.
     */
    InstructionPlacementInvalid: 'instruction_placement_invalid',

    /**
     * The instruction's `application:` declaration cannot be honored: a second declaration, a route
     * the host does not have, or a declaration beside the instruction's own application contract. A
     * run must never guess which of two application methods its repository meant.
     */
    InstructionApplicationRouteInvalid: 'instruction_application_route_invalid',
} as const;

/**
 * InstructionLoadFailureCode value.
 */
export type InstructionLoadFailureCode =
    (typeof InstructionLoadFailureCode)[keyof typeof InstructionLoadFailureCode];

/**
 * Stable, path-and-link-naming instruction load failure.
 *
 * The message always names what failed (the explicit instruction path or the exact link) and
 * carries the underlying cause, so a failed run start is diagnosable from the error alone.
 */
export class InstructionLoadError extends Error {
    /**
     * Stable public failure classification.
     */
    readonly code: InstructionLoadFailureCode;

    /**
     * Underlying cause observed at load time, when one exists.
     */
    override readonly cause?: unknown;

    /**
     * Create one named instruction load failure.
     *
     * @param code - Stable public failure classification.
     * @param message - Full diagnostic naming the path or link that failed and why.
     * @param cause - Underlying error, when one exists.
     */
    constructor(code: InstructionLoadFailureCode, message: string, cause?: unknown) {
        super(message);
        this.name = 'InstructionLoadError';
        this.code = code;
        this.cause = cause;
    }
}

/**
 * One instruction loaded at run start, ready to ride the prompt and back the guidance source.
 */
export interface LoadedInstruction {
    /**
     * Instruction file path as reported at load: checkout-relative when it resolves inside the
     * checkout, absolute for an operator-supplied out-of-tree override.
     */
    path: string;

    /**
     * Instruction text exactly as read, bounded by MAX_INSTRUCTION_CHARACTERS.
     */
    content: string;

    /**
     * SHA-256 over the exact instruction bytes as read.
     */
    sha256: string;

    /**
     * Role-linked documents loaded at run start, in binding order; empty when the instruction links
     * no guidance role.
     */
    documents: readonly InstructionLinkedDocument[];

    /**
     * The placement the instruction declares, parsed once at load; absent when the instruction
     * declares none and the deterministic placement routing stays in charge.
     */
    placement?: InstructionPlacement;

    /**
     * The built-in application route the instruction declares, parsed once at load; absent when the
     * instruction declares none, in which case its own application contract is what the run
     * performs.
     */
    applicationRoute?: ApplicationRoute;
}

/**
 * Inputs for one instruction load at run start.
 */
export interface LoadInstructionOptions {
    /**
     * Absolute root of the run's filters checkout; both the default instruction and every
     * checkout-relative link target resolve against it.
     */
    checkoutRoot: string;

    /**
     * Explicit operator-supplied instruction path: absolute as given, or checkout-relative.
     * Supplying it means this run must fail named when the file is missing or unreadable — the
     * built-in default belongs to absence only.
     */
    instructionPath?: string;

    /**
     * Injectable fetch for the instruction's https-linked documents; production uses global fetch.
     */
    fetchImpl?: typeof fetch;
}

/**
 * One Markdown link extracted from the instruction text.
 */
interface InstructionLink {
    /**
     * Link label, the place where a role keyword binds the document.
     */
    label: string;

    /**
     * Link target as written: an http(s) URL or a checkout-relative path.
     */
    target: string;
}

/**
 * Label keyword binding a link to its guidance role, checked case-insensitively.
 *
 * The instruction author names the role naturally in the label ("AdGuard syntax guide",
 * "contributing guidelines"); the loader binds on these fixed keywords.
 */
const GUIDANCE_DOCUMENT_ROLE_KEYWORDS: Record<GuidanceDocumentRole, readonly string[]> = {
    [GuidanceDocumentRole.Syntax]: ['syntax'],
    [GuidanceDocumentRole.Policy]: ['policy'],
    [GuidanceDocumentRole.Contributing]: ['contributing', 'contribution', 'contribute'],
};

/**
 * Role values in binding-check order; the first keyword match in this order wins for one label.
 */
const GUIDANCE_DOCUMENT_ROLE_BIND_ORDER = GUIDANCE_DOCUMENT_ROLE_VALUES;

/**
 * Markdown link shape extracted from the instruction: a non-empty label and a space-free target.
 */
const INSTRUCTION_LINK_PATTERN = /\[([^\]\r\n]+)\]\(([^)(\s]+)\)/gu;

/**
 * Generic URL-scheme prefix that marks a link target as remote instead of checkout-relative.
 */
const HTTP_TARGET_PATTERN = /^https?:\/\//iu;

/**
 * Read a load error's errno classification without assuming the error shape.
 *
 * @param error - Caught read error.
 * @returns The errno code like ENOENT, when the error carries one.
 */
function errnoOf(error: unknown): string | undefined {
    return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Build a concise upstream-cause description for failure messages.
 *
 * @param error - Caught error of any shape.
 * @returns Message text suitable for embedding in a typed failure.
 */
function describeCause(error: unknown): string {
    if (error instanceof LinkedDocumentDownloadError) {
        return error.message;
    }
    return error instanceof Error ? error.message : String(error);
}

/**
 * Compute the SHA-256 hex digest over exact bytes.
 *
 * @param bytes - Exact loaded bytes.
 * @returns Lowercase hex digest.
 */
function sha256Hex(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Report the instruction path the way the loaded instruction names it.
 *
 * @param checkoutRoot - Absolute checkout root the instruction was resolved against.
 * @param absolutePath - Absolute resolved instruction path.
 * @returns Checkout-relative path inside the checkout, absolute path for an out-of-tree override.
 */
function describeInstructionPath(checkoutRoot: string, absolutePath: string): string {
    const rootPrefix = checkoutRoot.endsWith(sep) ? checkoutRoot : `${checkoutRoot}${sep}`;
    return absolutePath === checkoutRoot || absolutePath.startsWith(rootPrefix)
        ? relative(checkoutRoot, absolutePath)
        : absolutePath;
}

/**
 * Test whether a resolved path stays inside the checkout; anything escaping it, including an
 * absolute host path, must never be read as a linked document.
 *
 * @param checkoutRoot - Absolute checkout root.
 * @param absolutePath - Resolved candidate path.
 * @returns True when the path resolves inside the checkout tree.
 */
function isInsideCheckout(checkoutRoot: string, absolutePath: string): boolean {
    const rootPrefix = checkoutRoot.endsWith(sep) ? checkoutRoot : `${checkoutRoot}${sep}`;
    return absolutePath === checkoutRoot || absolutePath.startsWith(rootPrefix);
}

/**
 * Bind a link label to its guidance role.
 *
 * @param label - Link label from the instruction.
 * @returns The first role whose keyword occurs in the label, or undefined for no role.
 */
function roleForLabel(label: string): GuidanceDocumentRole | undefined {
    const lowered = label.toLowerCase();
    return GUIDANCE_DOCUMENT_ROLE_BIND_ORDER.find((role) =>
        GUIDANCE_DOCUMENT_ROLE_KEYWORDS[role].some((keyword) => lowered.includes(keyword)),
    );
}

/**
 * Extract the instruction's Markdown links in document order.
 *
 * @param content - Instruction text as read.
 * @returns Links in the order they appear.
 */
function extractLinks(content: string): InstructionLink[] {
    return [...content.matchAll(INSTRUCTION_LINK_PATTERN)].map((match) => ({
        label: match[1] ?? '',
        target: match[2] ?? '',
    }));
}

/**
 * One linked document's loaded text with the SHA-256 over its exact bytes.
 */
interface LoadedDocumentText {
    /**
     * Complete UTF-8 text of the document.
     */
    content: string;

    /**
     * SHA-256 over the exact loaded bytes.
     */
    sha256: string;
}

/**
 * Load one linked document from a checkout-relative target.
 *
 * Absolute filesystem paths outside the checkout and traversal escaping the checkout are refused
 * here: a link may not read arbitrary host paths. A missing, oversized or empty file is a named
 * failure for its link.
 *
 * @param checkoutRoot - Absolute checkout root the target resolves against.
 * @param link - The instruction link being loaded.
 * @returns The document text and its SHA-256 over the exact bytes.
 * @throws {InstructionLoadError} DocumentUnreachable naming the link for every refusal.
 */
async function loadCheckoutDocument(
    checkoutRoot: string,
    link: InstructionLink,
): Promise<LoadedDocumentText> {
    const resolved = resolve(checkoutRoot, link.target);
    if (!isInsideCheckout(checkoutRoot, resolved)) {
        throw new InstructionLoadError(
            InstructionLoadFailureCode.DocumentUnreachable,
            `Linked document from instruction link [${link.label}](${link.target}) resolves ` +
                `outside the run checkout and is refused: ${resolved}`,
        );
    }
    let bytes: Buffer;
    try {
        bytes = await readFile(resolved);
    } catch (error) {
        throw new InstructionLoadError(
            InstructionLoadFailureCode.DocumentUnreachable,
            `Linked document from instruction link [${link.label}](${link.target}) could not be ` +
                `read (${errnoOf(error) ?? 'unknown error'}): ${describeCause(error)}`,
            error,
        );
    }
    if (bytes.byteLength > MAX_LINKED_DOCUMENT_BYTES) {
        throw new InstructionLoadError(
            InstructionLoadFailureCode.DocumentUnreachable,
            `Linked document from instruction link [${link.label}](${link.target}) is ` +
                `${bytes.byteLength} bytes, above the ${MAX_LINKED_DOCUMENT_BYTES}-byte cap, ` +
                'and is refused rather than truncated',
        );
    }
    const content = new TextDecoder('utf-8').decode(bytes);
    if (content.trim().length === 0) {
        throw new InstructionLoadError(
            InstructionLoadFailureCode.DocumentUnreachable,
            `Linked document from instruction link [${link.label}](${link.target}) is empty`,
        );
    }
    return { content, sha256: sha256Hex(bytes) };
}

/**
 * Load one linked document over http(s) through the bounded downloader.
 *
 * @param link - The instruction link being loaded.
 * @param fetchImpl - Injectable fetch for deterministic tests.
 * @returns The document text and its SHA-256.
 * @throws {InstructionLoadError} DocumentUnreachable naming the link when the download fails.
 */
async function loadRemoteDocument(
    link: InstructionLink,
    fetchImpl: typeof fetch,
): Promise<LoadedDocumentText> {
    try {
        const document = await downloadLinkedDocument(link.target, fetchImpl);
        return { content: document.content, sha256: document.sha256 };
    } catch (error) {
        throw new InstructionLoadError(
            InstructionLoadFailureCode.DocumentUnreachable,
            `Linked document from instruction link [${link.label}](${link.target}) could not ` +
                `be downloaded: ${describeCause(error)}`,
            error,
        );
    }
}

/**
 * Load the run instruction and every document its role links point at.
 *
 * Contract: the default instruction at {@link DEFAULT_INSTRUCTION_PATH} is probed only when no
 * override is supplied, and its absence yields null (built-in mode); an explicitly supplied path
 * that is missing or unreadable is a typed failure naming the path, never a silent built-in
 * fallback. Links bind by role keyword in the label, first match wins, one document per role, one
 * URL once; https targets download through the bounded downloader, bare relative targets read from
 * the checkout, and every failed link is a typed failure naming it.
 *
 * @param options - Checkout root, optional override path, injectable fetch.
 * @returns The loaded instruction, or null only for built-in mode (absence of default and override
 *   alike).
 * @throws {InstructionLoadError} With a stable code naming the failed path or link.
 */
export async function loadInstruction(
    options: LoadInstructionOptions,
): Promise<LoadedInstruction | null> {
    const { checkoutRoot } = options;
    const overrideSupplied = options.instructionPath !== undefined;
    const absolutePath =
        overrideSupplied && isAbsolute(options.instructionPath as string)
            ? (options.instructionPath as string)
            : resolve(checkoutRoot, options.instructionPath ?? DEFAULT_INSTRUCTION_PATH);

    let bytes: Buffer;
    try {
        bytes = await readFile(absolutePath);
    } catch (error) {
        if (!overrideSupplied && errnoOf(error) === 'ENOENT') {
            return null;
        }
        throw new InstructionLoadError(
            InstructionLoadFailureCode.InstructionUnreadable,
            `Run instruction at ${describeInstructionPath(checkoutRoot, absolutePath)} could ` +
                `not be read (${errnoOf(error) ?? 'unknown error'}): ${describeCause(error)}`,
            error,
        );
    }

    const content = new TextDecoder('utf-8').decode(bytes);
    if (content.length > MAX_INSTRUCTION_CHARACTERS) {
        throw new InstructionLoadError(
            InstructionLoadFailureCode.InstructionTooLarge,
            `Run instruction at ${describeInstructionPath(checkoutRoot, absolutePath)} is ` +
                `${content.length} characters, above the ${MAX_INSTRUCTION_CHARACTERS}-character ` +
                'cap; it is refused rather than truncated',
        );
    }

    let placement: InstructionPlacement | undefined;
    try {
        placement = parseInstructionPlacement(content);
    } catch (error) {
        throw new InstructionLoadError(
            InstructionLoadFailureCode.InstructionPlacementInvalid,
            `Run instruction at ${describeInstructionPath(checkoutRoot, absolutePath)} declares ` +
                `an unusable placement: ${describeCause(error)}`,
            error,
        );
    }

    let applicationRoute: ApplicationRoute | undefined;
    try {
        applicationRoute = parseInstructionApplicationRoute(content);
    } catch (error) {
        throw new InstructionLoadError(
            InstructionLoadFailureCode.InstructionApplicationRouteInvalid,
            `Run instruction at ${describeInstructionPath(checkoutRoot, absolutePath)} cannot be ` +
                `applied as declared: ${describeCause(error)}`,
            error,
        );
    }

    const documents: InstructionLinkedDocument[] = [];
    const boundRoles = new Set<GuidanceDocumentRole>();
    const takenTargets = new Set<string>();
    const fetchImpl = options.fetchImpl ?? fetch;
    for (const link of extractLinks(content)) {
        if (documents.length >= MAX_LINKED_DOCUMENTS) {
            break;
        }
        const role = roleForLabel(link.label);
        if (role === undefined || boundRoles.has(role) || takenTargets.has(link.target)) {
            continue;
        }
        const isRemote = HTTP_TARGET_PATTERN.test(link.target);
        const loaded = isRemote
            ? await loadRemoteDocument(link, fetchImpl)
            : await loadCheckoutDocument(checkoutRoot, link);
        boundRoles.add(role);
        takenTargets.add(link.target);
        documents.push({
            role,
            origin: isRemote ? GuidanceDocumentOrigin.Url : GuidanceDocumentOrigin.CheckoutFile,
            url: link.target,
            content: loaded.content,
            sha256: loaded.sha256,
        });
    }

    return {
        path: describeInstructionPath(checkoutRoot, absolutePath),
        content,
        sha256: sha256Hex(bytes),
        documents,
        ...(placement === undefined ? {} : { placement }),
        ...(applicationRoute === undefined ? {} : { applicationRoute }),
    };
}

/**
 * Build the guidance source the instruction run threads to its agent session.
 *
 * The loader produces one consistently shaped source; the guidance session re-asserts the same
 * bounds at construction, so a hand-built or drifted source fails named before serving.
 *
 * @param instruction - Instruction loaded by loadInstruction.
 * @returns The instruction-branch rule guidance source.
 */
export function toInstructionGuidanceSource(
    instruction: LoadedInstruction,
): InstructionGuidanceSource {
    return {
        kind: RuleGuidanceSourceKind.Instruction,
        path: instruction.path,
        sha256: instruction.sha256,
        documents: instruction.documents,
    };
}
