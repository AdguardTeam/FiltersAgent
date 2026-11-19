import {
    closeSync,
    constants,
    fstatSync,
    lstatSync,
    openSync,
    readFileSync,
    realpathSync,
    statSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    isAbsolute,
    join,
    relative,
    resolve,
    sep as repositoryCheckoutPathSeparator,
} from 'node:path';
import { placementRuleTypeOfRule } from './candidate-rule-type';
import { declaredPlacementForTarget } from './declared-placement';
import { selectExtensionCandidate } from './extension-target';
import { filterFileLines } from './filter-file-lines';
import { extendRuleDomains } from './rule-family';
import { planPositionedInsert } from './positioned-insert';
import { SINGLE_LINE_RULE_MESSAGE, isSingleLineRule, normalizeRule } from './rule-normalizer';
import { describeSharedRuleExtension } from './shared-rule-extension';
import { CandidateOperation } from '../environment/filtering-environment';
import {
    declaredPlacementFor,
    type DeclaredPlacement,
    type DeclaredPlacementSet,
} from '../types/declared-placement';
import type { PreparedFiltersCheckout } from '../local/filters-preparer';
import type { LocalRunRecord } from '../local/run-output';
import type { CandidatePatch } from '../types/fix-run-result';
import type { InsertRepositoryEdit, RepositoryEdit } from '../types/repository-edit';
import { RepositoryEditKind } from '../types/repository-edit-kind';
import { PlacementBasis } from '../types/placement-basis';
import type { PlacementPosition } from '../types/rule-proposal';
import { type ReviewCandidateDisposition } from '../types/review-candidate-disposition';
import { CandidateBindingFailureCode } from '../types/candidate-binding-failure-code';
import { GIT_OBJECT_ID_PATTERN } from '../types/git-object-id';

/**
 * Maximum exact target file size accepted by candidate binding.
 *
 * Every tracked filter list is orders of magnitude smaller, so 16 MiB accepts every real target
 * while bounding both the whole-file buffer this process holds in memory and the `maxBuffer` it
 * grants Git when reading the same blob back. Review checkout caps the identical source preimage on
 * read-back verification with this constant rather than its own copy: a larger cap there would bind
 * candidates that verification refuses to re-read, and a smaller one would reject bindings this
 * module has already created.
 */
export const MAX_BOUND_TARGET_BYTES = 16 * 1024 * 1024;

/**
 * Maximum exact target line count accepted by candidate binding.
 */
const MAX_BOUND_TARGET_LINES = 500_000;

/**
 * Maximum UTF-8 byte length accepted for one rule.
 */
const MAX_BOUND_RULE_BYTES = 16 * 1024;

/**
 * Stable failure codes exposed outside the candidate-binding trust boundary.
 */
export type { CandidateBindingFailureCode } from '../types/candidate-binding-failure-code';

/**
 * Source preimage fields shared by every immutable review operation.
 */
interface ReviewCandidateOperationBase {
    /**
     * Exact source commit that contains the target blob.
     */
    sourceCommit: string;

    /**
     * Repository-relative path of the target filter file.
     */
    filePath: string;

    /**
     * Git object identifier of the exact target blob.
     */
    targetBlobOid: string;

    /**
     * SHA-256 digest of the exact target file bytes.
     */
    targetFileSha256: string;

    /**
     * Exact target file size in bytes.
     */
    targetBytes: number;

    /**
     * Exact number of logical lines in the target file.
     */
    targetLines: number;

    /**
     * One-based source line associated with the operation.
     */
    line: number;
}

/**
 * Immutable operation that inserts one rule at an exact source boundary.
 */
export interface AddReviewCandidateOperation extends ReviewCandidateOperationBase {
    /**
     * Add-operation discriminator.
     */
    operation: typeof CandidateOperation.Add;

    /**
     * Exact preceding line, or the beginning-of-file sentinel.
     */
    beforeLine: string | 'BOF';

    /**
     * Exact following line, or the end-of-file sentinel.
     */
    afterLine: string | 'EOF';

    /**
     * SHA-256 digest of the exact insertion boundary.
     */
    insertionBoundarySha256: string;

    /**
     * Exact rule to insert.
     */
    addedRule: string;

    /**
     * Comment line written immediately before the added rule, when the run instruction's declared
     * placement asked for one; absent everywhere else.
     */
    precedingComment?: string;
}

/**
 * Immutable operation that replaces one exact existing rule.
 */
export interface EditReviewCandidateOperation extends ReviewCandidateOperationBase {
    /**
     * Edit-operation discriminator.
     */
    operation: typeof CandidateOperation.Edit;

    /**
     * Exact existing rule that must be present.
     */
    originalRule: string;

    /**
     * Exact replacement rule.
     */
    replacementRule: string;
}

/**
 * Immutable operation that removes one exact existing rule.
 */
export interface RemoveReviewCandidateOperation extends ReviewCandidateOperationBase {
    /**
     * Remove-operation discriminator.
     */
    operation: typeof CandidateOperation.Remove;

    /**
     * Exact existing rule that must be removed.
     */
    originalRule: string;
}

/**
 * Exact immutable repository operation carried by an opaque candidate binding.
 */
export type ReviewCandidateOperation =
    | AddReviewCandidateOperation
    | EditReviewCandidateOperation
    | RemoveReviewCandidateOperation;

declare const opaqueCandidateBrand: unique symbol;

/**
 * Host-issued capability proving that a candidate was bound to one exact source preimage.
 */
export interface BoundReviewCandidate {
    /**
     * Compile-time opaque candidate marker.
     */
    readonly [opaqueCandidateBrand]: true;
}

/**
 * Successful candidate/source binding outcome.
 */
interface BoundReviewCandidateBindingOutcome {
    /**
     * Successful binding discriminator.
     */
    kind: 'bound';

    /**
     * Host-issued opaque candidate capability.
     */
    candidate: BoundReviewCandidate;
}

/**
 * Legitimate outcome for a run that cannot produce a review candidate.
 */
interface NotApplicableReviewCandidateBindingOutcome {
    /**
     * Not-applicable binding discriminator.
     */
    kind: 'not_applicable';

    /**
     * Stable reason that no candidate can be bound.
     */
    disposition: ReviewCandidateDisposition;
}

/**
 * Sanitized candidate-binding failure exposed outside the trust boundary.
 */
interface ReviewCandidateBindingFailure {
    /**
     * Stable allowlisted binding failure code.
     */
    code: CandidateBindingFailureCode;

    /**
     * Pipeline stage that produced the failure.
     */
    stage: 'candidate_binding';

    /**
     * Stable sanitized failure description.
     */
    detail: string;
}

/**
 * Failed candidate/source binding outcome.
 */
interface FailedReviewCandidateBindingOutcome {
    /**
     * Failed binding discriminator.
     */
    kind: 'failed';

    /**
     * Sanitized binding failure.
     */
    failure: ReviewCandidateBindingFailure;
}

/**
 * Typed result of candidate/source binding.
 */
export type ReviewCandidateBindingOutcome =
    | BoundReviewCandidateBindingOutcome
    | NotApplicableReviewCandidateBindingOutcome
    | FailedReviewCandidateBindingOutcome;

/**
 * Private exact operations keyed by Host-issued opaque objects.
 */
const boundCandidateOperations = new WeakMap<object, ReviewCandidateOperation>();

/**
 * Stable public detail for each candidate-binding failure.
 */
const BINDING_FAILURE_DETAILS: Record<CandidateBindingFailureCode, string> = {
    candidate_mismatch: 'The candidate does not match the immutable run result.',
    source_commit_mismatch: 'The source commit does not match every locked provenance value.',
    unsafe_target: 'The candidate target is not a safe regular source file.',
    target_unavailable: 'The candidate target could not be read safely.',
    target_too_large: 'The candidate target exceeds the supported byte limit.',
    target_too_many_lines: 'The candidate target exceeds the supported line limit.',
    invalid_rule: 'The candidate contains an invalid or oversized rule.',
    stale_preimage: 'The exact candidate source precondition is stale.',
    ambiguous_preimage: 'The exact candidate source line is ambiguous.',
    source_preimage_mismatch: 'The checked-out bytes do not match the locked Git blob.',
};

/**
 * Internal typed candidate-binding failure.
 */
class CandidateBindingError extends Error {
    /**
     * Create one internal failure carrying only an allowlisted public code.
     *
     * @param code - Stable failure code.
     */
    constructor(readonly code: CandidateBindingFailureCode) {
        super(BINDING_FAILURE_DETAILS[code]);
        this.name = 'CandidateBindingError';
    }
}

/**
 * Runner-derived target file and exact mutation for one candidate rule.
 */
export interface RepositoryEditPlan {
    /**
     * Checkout-relative file containing the insertion point or shared rule being extended.
     */
    filePath: string;

    /**
     * Exact edit to apply inside {@link RepositoryEditPlan.filePath}.
     */
    edit: RepositoryEdit;
}

/**
 * Convert an absolute checkout descendant to a portable repository-relative path.
 *
 * @param checkoutRoot - Canonical checkout root.
 * @param absolutePath - Canonical descendant path.
 * @returns Slash-separated repository-relative path.
 */
function repositoryRelativePath(checkoutRoot: string, absolutePath: string): string {
    return relative(checkoutRoot, absolutePath).split(repositoryCheckoutPathSeparator).join('/');
}

/**
 * Resolve a trusted checkout-relative filter path without allowing traversal.
 *
 * @param checkoutPath - Absolute checkout root.
 * @param filePath - Repository-relative target file.
 * @returns Existing absolute path contained by the checkout root, or undefined when absent.
 */
function resolveFilterPath(checkoutPath: string, filePath: string): string | undefined {
    if (
        !filePath.endsWith('.txt') ||
        isAbsolute(filePath) ||
        filePath.includes('\\') ||
        filePath.includes('\0') ||
        filePath.split('/').some((part) => part.length === 0 || part.startsWith('.'))
    ) {
        throw new Error(`Unsafe candidate file path: ${filePath}`);
    }
    const root = realpathSync(checkoutPath);
    const unresolvedTarget = resolve(root, filePath);
    let target: string;
    try {
        target = realpathSync(unresolvedTarget);
    } catch {
        return undefined;
    }
    if (target !== root && !target.startsWith(`${root}${repositoryCheckoutPathSeparator}`)) {
        throw new Error(`Candidate file escapes checkout: ${filePath}`);
    }
    if (!statSync(target).isFile()) {
        throw new Error(`Candidate target is not a regular file: ${filePath}`);
    }
    return target;
}

/**
 * Plan the edit one declared placement asks for.
 *
 * The declaration replaces the whole placement search: no shared-rule owner may retarget the edit
 * to another file. What it says about the position depends on whether it declares a comment. A
 * comment naming the issue makes the file a chronological log — uAssets writes one above every
 * added rule — and the rule belongs at the end behind it, so a declared comment ignores the
 * position. Without a comment the declaration says only _which_ file, and the agent's position
 * inside it applies exactly as it does for an undeclared file.
 *
 * @param checkoutPath - Root of the pinned filters checkout.
 * @param declared - The declaration governing this candidate's kind, rendered for this run.
 * @param candidateRule - Locked issue-scoped candidate rule.
 * @param position - The position the agent named inside the declared file, when it named one.
 * @returns The declared file and the insertion the declaration asks for.
 * @throws {Error} Naming the declared file when this checkout does not hold it, so the caller
 *   reports a plan it cannot make instead of planning against a file that is not there.
 */
function planDeclaredPlacement(
    checkoutPath: string,
    declared: DeclaredPlacement,
    candidateRule: string,
    position: PlacementPosition | undefined,
): RepositoryEditPlan {
    const targetPath = resolveFilterPath(checkoutPath, declared.filePath);
    if (!targetPath) {
        throw new Error(
            `The declared placement target does not exist in the checkout: ${declared.filePath}`,
        );
    }
    const filePath = repositoryRelativePath(realpathSync(checkoutPath), targetPath);
    if (declared.commentLine === undefined) {
        return {
            filePath,
            edit: planPositionedInsert(
                filterFileLines(readFileSync(targetPath, 'utf8')),
                filePath,
                candidateRule,
                position,
            ),
        };
    }
    return {
        filePath,
        edit: {
            kind: RepositoryEditKind.Insert,
            basis: PlacementBasis.AppendEof,
            precedingComment: declared.commentLine,
        },
    };
}

/**
 * Plan the exact edit a locked candidate makes to the file the agent chose, without modifying the
 * checkout.
 *
 * The agent decides the file and the position inside it; this only computes the edit the position
 * resolves to and refuses a position that would break the file. A rule of the candidate's form
 * already shared by other sites in that file gets the reported domain added to it instead, and that
 * edit ignores the position. A run instruction that declares where rules of the candidate's kind go
 * makes that file the only one allowed, planned the way the declaration says.
 *
 * @param checkoutPath - Root of the pinned filters checkout.
 * @param filePath - Repository-relative file the agent chose.
 * @param candidateRule - Locked issue-scoped candidate rule.
 * @param declared - The run instruction's declared placements, rendered for this run, or undefined
 *   when it declares none.
 * @param position - The position the agent named inside the file, or undefined when a new line is
 *   asked for without one.
 * @returns Deterministic target file and insert or domain-extension edit.
 * @throws When the candidate cannot be inserted into the chosen file at that position, naming why.
 */
export function planRepositoryEdit(
    checkoutPath: string,
    filePath: string,
    candidateRule: string,
    declared: DeclaredPlacementSet | undefined,
    position: PlacementPosition | undefined,
): RepositoryEditPlan {
    const governing = declaredPlacementForTarget(filePath, candidateRule, declared);
    if (governing !== undefined) {
        return planDeclaredPlacement(checkoutPath, governing, candidateRule, position);
    }
    const kindDeclaration = declaredPlacementFor(declared, placementRuleTypeOfRule(candidateRule));
    if (kindDeclaration !== undefined) {
        throw new Error(
            `The run instruction declares ${kindDeclaration.filePath} for rules of this kind, ` +
                `not ${filePath}.`,
        );
    }
    const targetPath = resolveFilterPath(checkoutPath, filePath);
    if (!targetPath) {
        throw new Error(
            `The chosen file does not exist in the checkout: ${filePath}. Use a file path exactly ` +
                'as search_rules reports it.',
        );
    }
    const chosenPath = repositoryRelativePath(realpathSync(checkoutPath), targetPath);
    const extension = selectExtensionCandidate(targetPath, candidateRule);
    const replacementRule = extension
        ? extendRuleDomains(extension.rule, normalizeRule(candidateRule).domains[0])
        : undefined;
    if (!extension || replacementRule === undefined) {
        return {
            filePath: chosenPath,
            edit: planPositionedInsert(
                filterFileLines(readFileSync(targetPath, 'utf8')),
                chosenPath,
                candidateRule,
                position,
            ),
        };
    }
    return {
        filePath: chosenPath,
        edit: {
            kind: RepositoryEditKind.ExtendDomains,
            line: extension.line,
            originalRule: extension.rule,
            replacementRule,
        },
    };
}

/**
 * Apply a locked repository edit to filter text without touching the filesystem.
 *
 * @param fileContent - Existing target file content.
 * @param candidateRule - Locked issue-scoped candidate rule.
 * @param edit - Runner-derived exact repository mutation.
 * @returns Updated content preserving newline style and final-newline state.
 */
export function applyRepositoryEdit(
    fileContent: string,
    candidateRule: string,
    edit: RepositoryEdit,
): string {
    if (!isSingleLineRule(candidateRule)) {
        throw new Error(SINGLE_LINE_RULE_MESSAGE);
    }
    const newline = fileContent.includes('\r\n') ? '\r\n' : '\n';
    const normalizedContent = fileContent.replace(/\r\n?/g, '\n');
    const finalNewline = normalizedContent.endsWith('\n');
    const lines = normalizedContent.length === 0 ? [] : normalizedContent.split('\n');
    if (finalNewline) {
        lines.pop();
    }

    if (edit.kind === RepositoryEditKind.Insert) {
        if (lines.includes(candidateRule)) {
            throw new Error('Candidate rule already exists in the target file.');
        }
        const insertionPoint = edit.insertionPoint ?? lines.length;
        if (
            !Number.isInteger(insertionPoint) ||
            insertionPoint < 0 ||
            insertionPoint > lines.length
        ) {
            throw new Error(`Candidate insertion point ${insertionPoint} is out of range.`);
        }
        if (edit.anchorRule !== undefined && lines[insertionPoint] !== edit.anchorRule) {
            throw new Error('The locked insertion anchor is stale.');
        }
        if (edit.precedingComment !== undefined && !isSingleLineRule(edit.precedingComment)) {
            throw new Error('The locked preceding comment must be a non-empty single line.');
        }
        // The declared comment belongs to the insertion, so it lands with the rule in one splice:
        // a repository that precedes every added rule with the issue URL gets both lines or
        // neither, never a rule whose comment was written by some later step.
        lines.splice(
            insertionPoint,
            0,
            ...(edit.precedingComment === undefined
                ? [candidateRule]
                : [edit.precedingComment, candidateRule]),
        );
    } else if (edit.kind === RepositoryEditKind.ExtendDomains) {
        const sourceIndex = edit.line - 1;
        if (
            sourceIndex < 0 ||
            sourceIndex >= lines.length ||
            lines[sourceIndex] !== edit.originalRule
        ) {
            throw new Error('The locked extend_domains source line is stale.');
        }
        if (!describeSharedRuleExtension(candidateRule, edit.originalRule, edit.replacementRule)) {
            throw new Error('The locked extend_domains replacement changes rule semantics.');
        }
        lines[sourceIndex] = edit.replacementRule;
    } else {
        const sourceIndex = edit.line - 1;
        if (
            sourceIndex < 0 ||
            sourceIndex >= lines.length ||
            lines[sourceIndex] !== edit.originalRule
        ) {
            throw new Error(`The locked ${edit.kind} source line is stale.`);
        }
        if (lines.filter((line) => line === edit.originalRule).length !== 1) {
            throw new Error(`The locked ${edit.kind} source line is ambiguous.`);
        }
        if (edit.kind === RepositoryEditKind.Replace) {
            if (!isSingleLineRule(edit.replacementRule)) {
                throw new Error('The locked replacement must be a non-empty single line.');
            }
            lines[sourceIndex] = edit.replacementRule;
        } else {
            lines.splice(sourceIndex, 1);
        }
    }
    return lines.join(newline) + (finalNewline ? newline : '');
}

/**
 * Return a stable typed binding failure without exposing internal diagnostics.
 *
 * @param code - Allowlisted failure code.
 * @returns Sanitized failed outcome.
 */
function bindingFailure(code: CandidateBindingFailureCode): ReviewCandidateBindingOutcome {
    return {
        kind: 'failed',
        failure: {
            code,
            stage: 'candidate_binding',
            detail: BINDING_FAILURE_DETAILS[code],
        },
    };
}

/**
 * Validate one repository-relative filter target before any filesystem access.
 *
 * @param filePath - Candidate-supplied repository-relative path.
 */
function assertSafeBoundFilePath(filePath: string): void {
    if (
        !filePath.endsWith('.txt') ||
        isAbsolute(filePath) ||
        filePath.includes('\\') ||
        [...filePath].some((character) => {
            const codePoint = character.codePointAt(0) ?? 0;
            return codePoint <= 0x1f || codePoint === 0x7f || character === ':';
        }) ||
        filePath
            .split('/')
            .some(
                (component) =>
                    component.length === 0 ||
                    component === '.' ||
                    component === '..' ||
                    component.startsWith('.'),
            )
    ) {
        throw new CandidateBindingError(CandidateBindingFailureCode.UnsafeTarget);
    }
}

/**
 * Check one exact filter rule against publication resource limits.
 *
 * @param rule - Rule value to validate.
 */
function assertBoundRule(rule: string): void {
    if (
        rule.length === 0 ||
        /[\r\n]/u.test(rule) ||
        Buffer.byteLength(rule, 'utf8') > MAX_BOUND_RULE_BYTES
    ) {
        throw new CandidateBindingError(CandidateBindingFailureCode.InvalidRule);
    }
}

/**
 * Compare the identity-relevant fields of two filesystem snapshots.
 *
 * @param left - First snapshot.
 * @param right - Second snapshot.
 * @returns Whether both snapshots identify the same unchanged object.
 */
function sameFileSnapshot(left: Stats, right: Stats): boolean {
    return (
        left.dev === right.dev &&
        left.ino === right.ino &&
        left.size === right.size &&
        left.mtimeMs === right.mtimeMs &&
        left.ctimeMs === right.ctimeMs &&
        left.nlink === right.nlink
    );
}

/**
 * Read one exact target through a stable no-follow single-link descriptor.
 *
 * @param checkoutRoot - Canonical source checkout root.
 * @param filePath - Validated repository-relative path.
 * @returns Exact bytes and canonical target path.
 */
function readBoundTarget(
    checkoutRoot: string,
    filePath: string,
): {
    /**
     * Exact target file bytes.
     */
    bytes: Buffer;

    /**
     * Canonical target filesystem path.
     */
    targetPath: string;
} {
    let cursor = checkoutRoot;
    const components = filePath.split('/');
    for (const [index, component] of components.entries()) {
        cursor = join(cursor, component);
        let stats: ReturnType<typeof lstatSync>;
        try {
            stats = lstatSync(cursor);
        } catch {
            throw new CandidateBindingError(CandidateBindingFailureCode.TargetUnavailable);
        }
        if (stats.isSymbolicLink()) {
            throw new CandidateBindingError(CandidateBindingFailureCode.UnsafeTarget);
        }
        if (index === components.length - 1 ? !stats.isFile() : !stats.isDirectory()) {
            throw new CandidateBindingError(CandidateBindingFailureCode.UnsafeTarget);
        }
    }
    const targetPath = cursor;
    const projected = resolve(checkoutRoot, filePath);
    const relativeTarget = relative(checkoutRoot, projected);
    if (
        relativeTarget === '' ||
        relativeTarget === '..' ||
        relativeTarget.startsWith(`..${repositoryCheckoutPathSeparator}`) ||
        isAbsolute(relativeTarget)
    ) {
        throw new CandidateBindingError(CandidateBindingFailureCode.UnsafeTarget);
    }
    const before = lstatSync(targetPath);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
        throw new CandidateBindingError(CandidateBindingFailureCode.UnsafeTarget);
    }
    if (before.size > MAX_BOUND_TARGET_BYTES) {
        throw new CandidateBindingError(CandidateBindingFailureCode.TargetTooLarge);
    }

    let descriptor: number | undefined;
    try {
        descriptor = openSync(targetPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const opened = fstatSync(descriptor);
        if (!opened.isFile() || opened.nlink !== 1 || !sameFileSnapshot(before, opened)) {
            throw new CandidateBindingError(CandidateBindingFailureCode.UnsafeTarget);
        }
        const bytes = readFileSync(descriptor);
        const afterDescriptor = fstatSync(descriptor);
        const afterPath = lstatSync(targetPath);
        if (
            bytes.byteLength !== opened.size ||
            !sameFileSnapshot(opened, afterDescriptor) ||
            !sameFileSnapshot(opened, afterPath)
        ) {
            throw new CandidateBindingError(CandidateBindingFailureCode.SourcePreimageMismatch);
        }
        return { bytes, targetPath };
    } finally {
        if (descriptor !== undefined) {
            closeSync(descriptor);
        }
    }
}

/**
 * Run one bounded read-only Git query in the prepared checkout.
 *
 * @param checkoutRoot - Exact prepared Git checkout.
 * @param args - Read-only Git arguments.
 * @param encoding - Optional UTF-8 output mode.
 * @returns Captured output.
 */
function runBindingGit(checkoutRoot: string, args: readonly string[], encoding: 'utf8'): string;
function runBindingGit(checkoutRoot: string, args: readonly string[]): Buffer;
function runBindingGit(
    checkoutRoot: string,
    args: readonly string[],
    encoding?: 'utf8',
): Buffer | string {
    try {
        return execFileSync(
            'git',
            ['-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', ...args],
            {
                cwd: checkoutRoot,
                encoding,
                maxBuffer: MAX_BOUND_TARGET_BYTES + 1024,
                env: {
                    PATH: process.env.PATH,
                    LC_ALL: 'C',
                    GIT_CONFIG_NOSYSTEM: '1',
                    GIT_CONFIG_GLOBAL: '/dev/null',
                    GIT_TERMINAL_PROMPT: '0',
                    GIT_ALLOW_PROTOCOL: 'file',
                },
                stdio: ['ignore', 'pipe', 'ignore'],
            },
        );
    } catch {
        throw new CandidateBindingError(CandidateBindingFailureCode.SourcePreimageMismatch);
    }
}

/**
 * Decode exact UTF-8 source bytes and apply line-count limits.
 *
 * @param bytes - Exact target bytes.
 * @returns Normalized logical source lines.
 */
function decodeBoundLines(bytes: Buffer): string[] {
    let content: string;
    try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        throw new CandidateBindingError(CandidateBindingFailureCode.SourcePreimageMismatch);
    }
    const normalized = content.replace(/\r\n?/gu, '\n');
    const lines = normalized.length === 0 ? [] : normalized.split('\n');
    if (lines.at(-1) === '') {
        lines.pop();
    }
    if (lines.length > MAX_BOUND_TARGET_LINES) {
        throw new CandidateBindingError(CandidateBindingFailureCode.TargetTooManyLines);
    }
    return lines;
}

/**
 * One exact target blob, proven to be the committed content of a locked source snapshot.
 */
export interface LockedSourcePreimage {
    /**
     * Exact source commit proven to be the checkout HEAD.
     */
    sourceCommit: string;

    /**
     * Repository-relative path of the target filter file.
     */
    filePath: string;

    /**
     * Git object identifier of the exact target blob.
     */
    targetBlobOid: string;

    /**
     * SHA-256 digest of the exact target file bytes.
     */
    targetFileSha256: string;

    /**
     * Exact target file size in bytes.
     */
    targetBytes: number;

    /**
     * Exact number of logical lines in the target file.
     */
    targetLines: number;

    /**
     * Exact logical lines, newline-normalized, without a synthetic terminal empty line.
     */
    lines: readonly string[];
}

/**
 * Prove one target file is the exact committed content of a locked source snapshot.
 *
 * Read-only. Every failure raises an internal typed error carrying only an allowlisted code.
 *
 * @param checkoutPath - Prepared clean source checkout.
 * @param sourceCommit - Exact commit the run is bound to.
 * @param filePath - Repository-relative target filter file.
 * @returns Exact proven preimage of the target file.
 */
function readLockedPreimage(
    checkoutPath: string,
    sourceCommit: string,
    filePath: string,
): LockedSourcePreimage {
    const commit = sourceCommit.toLowerCase();
    if (!/^[0-9a-f]{40}$/u.test(commit)) {
        throw new CandidateBindingError(CandidateBindingFailureCode.SourceCommitMismatch);
    }
    const checkoutRoot = realpathSync(checkoutPath);
    const actualHead = runBindingGit(checkoutRoot, ['rev-parse', '--verify', 'HEAD'], 'utf8')
        .trim()
        .toLowerCase();
    if (actualHead !== commit) {
        throw new CandidateBindingError(CandidateBindingFailureCode.SourceCommitMismatch);
    }
    assertSafeBoundFilePath(filePath);
    const { bytes } = readBoundTarget(checkoutRoot, filePath);
    const lines = decodeBoundLines(bytes);
    const targetBlobOid = runBindingGit(
        checkoutRoot,
        ['rev-parse', '--verify', `${commit}:${filePath}`],
        'utf8',
    )
        .trim()
        .toLowerCase();
    if (!GIT_OBJECT_ID_PATTERN.test(targetBlobOid)) {
        throw new CandidateBindingError(CandidateBindingFailureCode.SourcePreimageMismatch);
    }
    const committedBytes = runBindingGit(checkoutRoot, ['cat-file', 'blob', targetBlobOid]);
    if (!committedBytes.equals(bytes)) {
        throw new CandidateBindingError(CandidateBindingFailureCode.SourcePreimageMismatch);
    }
    return {
        sourceCommit: commit,
        filePath,
        targetBlobOid,
        targetFileSha256: createHash('sha256').update(bytes).digest('hex'),
        targetBytes: bytes.byteLength,
        targetLines: lines.length,
        lines,
    };
}

/**
 * Bind one rule to an exact insertion boundary inside an already proven preimage.
 *
 * @param preimage - Exact proven target preimage.
 * @param rule - Exact single-line rule to insert.
 * @param edit - Runner-derived insertion with its optional anchor.
 * @returns Exact immutable add operation.
 */
function buildAddOperation(
    preimage: LockedSourcePreimage,
    rule: string,
    edit: InsertRepositoryEdit,
): AddReviewCandidateOperation {
    const lines = preimage.lines;
    const insertionPoint = edit.insertionPoint ?? lines.length;
    if (
        !Number.isInteger(insertionPoint) ||
        insertionPoint < 0 ||
        insertionPoint > lines.length ||
        lines.includes(rule)
    ) {
        throw new CandidateBindingError(CandidateBindingFailureCode.StalePreimage);
    }
    if (edit.anchorRule !== undefined && lines[insertionPoint] !== edit.anchorRule) {
        throw new CandidateBindingError(CandidateBindingFailureCode.StalePreimage);
    }
    const beforeLine = insertionPoint === 0 ? 'BOF' : lines[insertionPoint - 1];
    const afterLine = insertionPoint === lines.length ? 'EOF' : lines[insertionPoint];
    const insertionBoundarySha256 = createHash('sha256')
        .update(
            JSON.stringify({
                filePath: preimage.filePath,
                targetBlobOid: preimage.targetBlobOid,
                targetFileSha256: preimage.targetFileSha256,
                line: insertionPoint + 1,
                beforeLine,
                afterLine,
            }),
        )
        .digest('hex');
    return Object.freeze({
        operation: CandidateOperation.Add,
        ...lockedOperationBase(preimage),
        line: insertionPoint + 1,
        beforeLine,
        afterLine,
        insertionBoundarySha256,
        addedRule: rule,
        ...(edit.precedingComment === undefined ? {} : { precedingComment: edit.precedingComment }),
    });
}

/**
 * Project the source-preimage fields every immutable review operation carries.
 *
 * @param preimage - Exact proven target preimage.
 * @returns Shared operation preimage fields without the decoded lines.
 */
function lockedOperationBase(
    preimage: LockedSourcePreimage,
): Omit<ReviewCandidateOperationBase, 'line'> {
    return {
        sourceCommit: preimage.sourceCommit,
        filePath: preimage.filePath,
        targetBlobOid: preimage.targetBlobOid,
        targetFileSha256: preimage.targetFileSha256,
        targetBytes: preimage.targetBytes,
        targetLines: preimage.targetLines,
    };
}

/**
 * Derive the legitimate no-candidate disposition from a terminal run.
 *
 * @param record - Immutable local run record.
 * @returns Stable candidate disposition.
 */
function noCandidateDisposition(
    record: LocalRunRecord,
): NotApplicableReviewCandidateBindingOutcome['disposition'] {
    if (record.result.runStatus === 'unsupported_product_case') {
        return 'unsupported';
    }
    if (record.result.runStatus === 'failed') {
        return 'inconclusive';
    }
    if (
        record.result.runStatus === 'already_fixed_current' ||
        record.result.runStatus === 'fixed_upstream_pending_extension' ||
        record.result.runStatus === 'fixed_in_source_pending_publication'
    ) {
        return 'no_candidate';
    }
    return 'not_verified';
}

/**
 * Normalize a verified candidate and bind it to one exact Git source preimage.
 *
 * This function is read-only. Every failure is converted to a stable sanitized tagged outcome.
 *
 * @param candidate - Candidate carried by the completed run, or null.
 * @param source - Prepared exact AdguardFilters checkout.
 * @param record - Immutable canonical run record.
 * @returns Opaque bound candidate, legitimate no-candidate disposition, or sanitized failure.
 */
export function bindReviewCandidate(
    candidate: CandidatePatch | null,
    source: PreparedFiltersCheckout,
    record: LocalRunRecord,
): ReviewCandidateBindingOutcome {
    try {
        if (JSON.stringify(candidate) !== JSON.stringify(record.result.candidatePatch)) {
            throw new CandidateBindingError(CandidateBindingFailureCode.CandidateMismatch);
        }
        if (candidate === null) {
            return { kind: 'not_applicable', disposition: noCandidateDisposition(record) };
        }
        if (record.result.runStatus !== 'patch_proposed') {
            throw new CandidateBindingError(CandidateBindingFailureCode.CandidateMismatch);
        }
        const sourceCommit = source.provenance.commit.toLowerCase();
        const runCommit = record.result.filtersBaseSha?.toLowerCase();
        if (!/^[0-9a-f]{40}$/u.test(sourceCommit) || runCommit !== sourceCommit) {
            throw new CandidateBindingError(CandidateBindingFailureCode.SourceCommitMismatch);
        }
        assertBoundRule(candidate.rule);
        const preimage = readLockedPreimage(source.checkoutPath, sourceCommit, candidate.filePath);
        const lines = preimage.lines;
        const common = lockedOperationBase(preimage);
        const edit = candidate.repositoryEdit ?? {
            kind: RepositoryEditKind.Insert,
            ...(candidate.insertionPoint === undefined
                ? {}
                : { insertionPoint: candidate.insertionPoint }),
        };
        let operation: ReviewCandidateOperation;
        if (edit.kind === RepositoryEditKind.Insert) {
            operation = buildAddOperation(preimage, candidate.rule, edit);
        } else {
            assertBoundRule(edit.originalRule);
            const sourceIndex = edit.line - 1;
            if (
                sourceIndex < 0 ||
                sourceIndex >= lines.length ||
                lines[sourceIndex] !== edit.originalRule
            ) {
                throw new CandidateBindingError(CandidateBindingFailureCode.StalePreimage);
            }
            if (lines.filter((line) => line === edit.originalRule).length !== 1) {
                throw new CandidateBindingError(CandidateBindingFailureCode.AmbiguousPreimage);
            }
            if (edit.kind === RepositoryEditKind.Remove) {
                operation = Object.freeze({
                    operation: 'remove',
                    ...common,
                    line: edit.line,
                    originalRule: edit.originalRule,
                });
            } else {
                assertBoundRule(edit.replacementRule);
                operation = Object.freeze({
                    operation: 'edit',
                    ...common,
                    line: edit.line,
                    originalRule: edit.originalRule,
                    replacementRule: edit.replacementRule,
                });
            }
        }
        const opaque = Object.freeze({}) as BoundReviewCandidate;
        boundCandidateOperations.set(opaque, operation);
        return { kind: 'bound', candidate: opaque };
    } catch (error) {
        return bindingFailure(
            error instanceof CandidateBindingError
                ? error.code
                : CandidateBindingFailureCode.TargetUnavailable,
        );
    }
}

/**
 * Inspect the exact immutable operation carried by a Host-issued candidate capability.
 *
 * This function exists for the trusted review materializer and rejects every forged object.
 *
 * @param candidate - Opaque Host-issued candidate.
 * @returns Exact frozen operation bound by the Host.
 */
export function inspectBoundReviewCandidate(
    candidate: BoundReviewCandidate,
): ReviewCandidateOperation {
    const operation = boundCandidateOperations.get(candidate);
    if (!operation) {
        throw new Error('Invalid opaque review candidate capability.');
    }
    return operation;
}
