import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
    closeSync,
    constants,
    existsSync,
    fstatSync,
    fsyncSync,
    ftruncateSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    readdirSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import {
    dirname,
    isAbsolute,
    join,
    relative,
    resolve,
    sep as portableReviewPathSeparator,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    applyRepositoryEdit,
    inspectBoundReviewCandidate,
    MAX_BOUND_TARGET_BYTES,
    type BoundReviewCandidate,
    type ReviewCandidateOperation,
} from '../repo/repository-edit';
import type { PreparedFiltersCheckout } from './filters-preparer';
import { RepositoryEditKind } from '../types/repository-edit-kind';

/**
 * Maximum captured stdout or stderr bytes for one Git command.
 */
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;

/**
 * Maximum canonical candidate diff size.
 */
const MAX_PATCH_BYTES = 4 * 1024 * 1024;

/**
 * Maximum regular files retained in one review checkout.
 */
const MAX_CHECKOUT_FILES = 100_000;

/**
 * Maximum aggregate regular-file bytes retained in one review checkout.
 */
const MAX_CHECKOUT_BYTES = 1024 * 1024 * 1024;

/**
 * Stable review-checkout failure codes suitable for evidence-only publication.
 */
export type ReviewCheckoutFailureCode =
    | 'precondition_failed'
    | 'git_failed'
    | 'unsafe_checkout'
    | 'resource_limit';

/**
 * Sanitized review-checkout failure.
 */
export class ReviewCheckoutError extends Error {
    /**
     * Create a stable materialization failure.
     *
     * The optional detail names the failing operation for job logs; it never carries subprocess
     * environment, secrets, or absolute paths. Anonymous failures cost a full evidence-archive
     * reproduction to diagnose (a bare "unsafe artifact" can hide git refusing a refs-less
     * checkout).
     *
     * @param code - Stable failure code.
     * @param detail - Optional bounded diagnostic naming the failed operation.
     */
    constructor(
        readonly code: ReviewCheckoutFailureCode,
        readonly detail?: string,
    ) {
        let message = 'The isolated Git materialization failed.';
        if (code === 'precondition_failed') {
            message = 'The bound candidate source preimage is no longer exact.';
        } else if (code === 'resource_limit') {
            message = 'The review checkout exceeds a supported resource limit.';
        } else if (code === 'unsafe_checkout') {
            message = 'The review checkout failed its isolation invariants.';
        }
        super(detail === undefined ? message : `${message} [${detail}]`);
        this.name = 'ReviewCheckoutError';
    }
}

/**
 * Integrity receipt for one detached standalone review checkout.
 */
export interface ReviewWorkspaceReceipt {
    /**
     * Publication-relative checkout path.
     */
    checkoutPath: 'review';

    /**
     * Exact locked source commit.
     */
    sourceCommit: string;

    /**
     * Exact detached checkout HEAD.
     */
    headCommit: string;

    /**
     * Exact HEAD tree proving an unchanged index.
     */
    indexTreeDigest: string;

    /**
     * SHA-256 digest of the source file before candidate application.
     */
    candidatePreimageDigest: string;

    /**
     * SHA-256 digest of the canonical unstaged patch.
     */
    patchSha256: string;

    /**
     * Canonical patch byte length.
     */
    patchBytes: number;

    /**
     * Sole repository-relative changed file.
     */
    changedPath: string;

    /**
     * Number of regular files retained in the standalone checkout.
     */
    checkoutFiles: number;

    /**
     * Aggregate regular-file bytes retained in the standalone checkout.
     */
    checkoutBytes: number;

    /**
     * Stable creation timestamp supplied by the Host clock.
     */
    createdAt: string;

    /**
     * Whether the exact owned checkout is eligible for explicit cleanup.
     */
    cleanupEligible: true;
}

/**
 * Successful review materialization output.
 */
export interface ReviewCheckoutMaterialization {
    /**
     * Exact canonical `git diff --binary` bytes.
     */
    patch: Buffer;

    /**
     * Verified detached checkout receipt.
     */
    receipt: ReviewWorkspaceReceipt;
}

/**
 * Inputs for standalone review checkout creation.
 */
export interface MaterializeReviewCheckoutOptions {
    /**
     * Opaque preflighted candidate capability.
     */
    candidate: BoundReviewCandidate;

    /**
     * Exact source checkout that issued the candidate binding.
     */
    source: PreparedFiltersCheckout;

    /**
     * New exact destination ending in `review`.
     */
    checkoutPath: string;

    /**
     * Host-owned deterministic creation timestamp.
     */
    createdAt: string;
}

/**
 * SHA-256 digest exact bytes.
 *
 * @param bytes - Bytes to digest.
 * @returns Lowercase digest.
 */
function sha256(bytes: Buffer | string): string {
    return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Split exact text into logical source lines.
 *
 * @param bytes - UTF-8 file bytes.
 * @returns Logical lines without a synthetic terminal empty line.
 */
function sourceLines(bytes: Buffer): string[] {
    let text: string;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n?/gu, '\n');
    } catch {
        throw new ReviewCheckoutError('precondition_failed');
    }
    const lines = text.length === 0 ? [] : text.split('\n');
    if (lines.at(-1) === '') {
        lines.pop();
    }
    return lines;
}

/**
 * Compute the Git blob object identifier for exact bytes.
 *
 * @param bytes - Exact blob bytes.
 * @param oidLength - Expected repository object identifier length.
 * @returns Lowercase Git blob object identifier.
 */
function gitBlobOid(bytes: Buffer, oidLength: number): string {
    const algorithm = oidLength === 40 ? 'sha1' : oidLength === 64 ? 'sha256' : null;
    if (!algorithm) {
        throw new ReviewCheckoutError('precondition_failed');
    }
    return createHash(algorithm).update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
}

/**
 * Reject a persisted candidate path that could not have passed the original binding boundary.
 *
 * @param filePath - Candidate repository-relative target path.
 */
function assertSafeReviewFilePath(filePath: string): void {
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
        throw new ReviewCheckoutError('precondition_failed');
    }
}

/**
 * Validate the exact source bytes and operation-specific preconditions against a locked candidate.
 *
 * @param operation - Persisted source-bound operation.
 * @param bytes - Exact bytes read from the locked Git object.
 * @param blobOid - Git object identifier resolved from the locked commit and path.
 */
function verifyOperationPreimage(
    operation: ReviewCandidateOperation,
    bytes: Buffer,
    blobOid: string,
): void {
    if (
        bytes.byteLength > MAX_BOUND_TARGET_BYTES ||
        bytes.byteLength !== operation.targetBytes ||
        sha256(bytes) !== operation.targetFileSha256 ||
        blobOid !== operation.targetBlobOid ||
        gitBlobOid(bytes, blobOid.length) !== blobOid
    ) {
        throw new ReviewCheckoutError('precondition_failed');
    }
    const lines = sourceLines(bytes);
    if (lines.length !== operation.targetLines) {
        throw new ReviewCheckoutError('precondition_failed');
    }
    if (operation.operation === 'add') {
        const insertionPoint = operation.line - 1;
        const before = insertionPoint === 0 ? 'BOF' : lines[insertionPoint - 1];
        const after = insertionPoint === lines.length ? 'EOF' : lines[insertionPoint];
        const digest = sha256(
            JSON.stringify({
                filePath: operation.filePath,
                targetBlobOid: operation.targetBlobOid,
                targetFileSha256: operation.targetFileSha256,
                line: operation.line,
                beforeLine: before,
                afterLine: after,
            }),
        );
        if (
            insertionPoint < 0 ||
            insertionPoint > lines.length ||
            lines.includes(operation.addedRule) ||
            before !== operation.beforeLine ||
            after !== operation.afterLine ||
            digest !== operation.insertionBoundarySha256
        ) {
            throw new ReviewCheckoutError('precondition_failed');
        }
        return;
    }
    if (
        operation.line < 1 ||
        operation.line > lines.length ||
        lines[operation.line - 1] !== operation.originalRule ||
        lines.filter((line) => line === operation.originalRule).length !== 1
    ) {
        throw new ReviewCheckoutError('precondition_failed');
    }
}

/**
 * Check that a target remains a single-link regular file and read its exact bytes.
 *
 * @param root - Canonical checkout root.
 * @param filePath - Bound repository-relative path.
 * @returns Exact file bytes.
 */
function readStableFile(root: string, filePath: string): Buffer {
    assertSafeReviewFilePath(filePath);
    const target = resolve(root, filePath);
    const relativeTarget = relative(root, target);
    if (
        relativeTarget === '' ||
        relativeTarget === '..' ||
        relativeTarget.startsWith(`..${portableReviewPathSeparator}`) ||
        isAbsolute(relativeTarget)
    ) {
        throw new ReviewCheckoutError('precondition_failed');
    }
    let cursor = root;
    for (const [index, component] of filePath.split('/').entries()) {
        cursor = join(cursor, component);
        const stats = lstatSync(cursor);
        if (
            stats.isSymbolicLink() ||
            (index === filePath.split('/').length - 1 ? !stats.isFile() : !stats.isDirectory())
        ) {
            throw new ReviewCheckoutError('precondition_failed');
        }
    }
    const before = lstatSync(target);
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_BOUND_TARGET_BYTES) {
        throw new ReviewCheckoutError('precondition_failed');
    }
    let descriptor: number | undefined;
    try {
        descriptor = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const opened = fstatSync(descriptor);
        if (
            opened.dev !== before.dev ||
            opened.ino !== before.ino ||
            opened.size !== before.size ||
            opened.nlink !== 1
        ) {
            throw new ReviewCheckoutError('precondition_failed');
        }
        const bytes = readFileSync(descriptor);
        const after = fstatSync(descriptor);
        if (
            after.dev !== opened.dev ||
            after.ino !== opened.ino ||
            after.size !== opened.size ||
            bytes.byteLength !== opened.size
        ) {
            throw new ReviewCheckoutError('precondition_failed');
        }
        return bytes;
    } catch (error) {
        if (error instanceof ReviewCheckoutError) {
            throw error;
        }
        throw new ReviewCheckoutError('precondition_failed');
    } finally {
        if (descriptor !== undefined) {
            closeSync(descriptor);
        }
    }
}

/**
 * Recheck every exact source precondition before creating destination bytes.
 *
 * @param operation - Opaque candidate payload.
 * @param source - Prepared source checkout.
 */
function verifySourcePreimage(
    operation: ReviewCandidateOperation,
    source: PreparedFiltersCheckout,
): void {
    if (source.provenance.commit.toLowerCase() !== operation.sourceCommit) {
        throw new ReviewCheckoutError('precondition_failed');
    }
    const root = realpathSync(source.checkoutPath);
    const head = runGit(root, ['rev-parse', '--verify', 'HEAD'], null).toString('utf8').trim();
    if (head.toLowerCase() !== operation.sourceCommit) {
        throw new ReviewCheckoutError('precondition_failed');
    }
    const bytes = readStableFile(root, operation.filePath);
    const blob = runGit(
        root,
        ['rev-parse', '--verify', `${operation.sourceCommit}:${operation.filePath}`],
        null,
    )
        .toString('utf8')
        .trim()
        .toLowerCase();
    verifyOperationPreimage(operation, bytes, blob);
}

/**
 * Git execution isolation state.
 */
interface GitIsolation {
    /**
     * Empty private HOME.
     */
    home: string;

    /**
     * Empty global configuration file.
     */
    config: string;

    /**
     * Empty hooks directory.
     */
    hooks: string;

    /**
     * Empty init template directory.
     */
    template: string;
}

/**
 * Run one bounded Git command with host configuration, helpers, prompts and protocols disabled.
 *
 * @param cwd - Fixed working directory.
 * @param args - Exact argv command.
 * @param isolation - Private isolation roots, or null during preflight read-only queries.
 * @param maxBuffer - Maximum captured bytes for this read-only command.
 * @returns Captured stdout bytes.
 */
function runGit(
    cwd: string,
    args: readonly string[],
    isolation: GitIsolation | null,
    maxBuffer = MAX_GIT_OUTPUT_BYTES,
): Buffer {
    const emptyPath = isolation?.hooks ?? '/dev/null';
    try {
        return execFileSync(
            'git',
            [
                '-c',
                `core.hooksPath=${emptyPath}`,
                '-c',
                'credential.helper=',
                '-c',
                'protocol.allow=never',
                '-c',
                'protocol.file.allow=always',
                '-c',
                'diff.external=',
                '-c',
                'core.fsmonitor=false',
                // Artifact transport between the analyze and publish jobs does not preserve
                // file permissions, so executable tracked files (.husky hooks in the filters
                // repository) come back mode-stripped and a filemode-sensitive status calls
                // them modified. The review contract is content-only — no candidate operation
                // ever changes a mode — so both materialization and verification ignore modes
                // uniformly; every content proof below is unaffected.
                '-c',
                'core.filemode=false',
                ...args,
            ],
            {
                cwd,
                encoding: 'buffer',
                maxBuffer,
                env: {
                    PATH: process.env.PATH,
                    LC_ALL: 'C',
                    HOME: isolation?.home ?? '/dev/null',
                    XDG_CONFIG_HOME: isolation?.home ?? '/dev/null',
                    GIT_CONFIG_NOSYSTEM: '1',
                    GIT_CONFIG_GLOBAL: isolation?.config ?? '/dev/null',
                    GIT_TERMINAL_PROMPT: '0',
                    GIT_ASKPASS: '/usr/bin/false',
                    SSH_ASKPASS: '/usr/bin/false',
                    GCM_INTERACTIVE: 'never',
                    GIT_ALLOW_PROTOCOL: 'file',
                },
                stdio: ['ignore', 'pipe', 'pipe'],
            },
        );
    } catch (error) {
        if (error instanceof ReviewCheckoutError) {
            throw error;
        }
        // Name the git subcommand and its first stderr line: never the environment, never an
        // absolute path (git prints repository-relative context under the fixed cwd).
        const stderr =
            error instanceof Error && 'stderr' in error && Buffer.isBuffer(error.stderr)
                ? error.stderr
                : undefined;
        const firstLine = stderr
            ?.toString('utf8')
            .split('\n', 1)[0]
            ?.replaceAll(/[^\x20-\x7E]/gu, '')
            .slice(0, 160);
        throw new ReviewCheckoutError(
            'git_failed',
            `git ${args.find((arg) => !arg.startsWith('-')) ?? '?'}${firstLine ? `: ${firstLine}` : ''}`,
        );
    }
}

/**
 * Write exact candidate bytes without following or replacing the checked-out target.
 *
 * @param root - Canonical review root.
 * @param filePath - Bound target path.
 * @param bytes - Complete replacement bytes.
 */
function writeStableFile(root: string, filePath: string, bytes: Buffer): void {
    const target = resolve(root, filePath);
    const before = lstatSync(target);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
        throw new ReviewCheckoutError('unsafe_checkout');
    }
    let descriptor: number | undefined;
    try {
        descriptor = openSync(target, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
        const opened = fstatSync(descriptor);
        if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1) {
            throw new ReviewCheckoutError('unsafe_checkout');
        }
        ftruncateSync(descriptor, 0);
        writeFileSync(descriptor, bytes);
        fsyncSync(descriptor);
    } catch (error) {
        if (error instanceof ReviewCheckoutError) {
            throw error;
        }
        throw new ReviewCheckoutError('unsafe_checkout');
    } finally {
        if (descriptor !== undefined) {
            closeSync(descriptor);
        }
    }
}

/**
 * Apply one exact bound operation to source text.
 *
 * @param bytes - Exact checked-out source bytes.
 * @param operation - Bound operation.
 * @returns Complete updated UTF-8 bytes.
 */
function applyBoundOperation(bytes: Buffer, operation: ReviewCandidateOperation): Buffer {
    const content = bytes.toString('utf8');
    if (operation.operation === 'add') {
        return Buffer.from(
            applyRepositoryEdit(content, operation.addedRule, {
                kind: RepositoryEditKind.Insert,
                insertionPoint: operation.line - 1,
                ...(operation.afterLine === 'EOF' ? {} : { anchorRule: operation.afterLine }),
                ...(operation.precedingComment === undefined
                    ? {}
                    : { precedingComment: operation.precedingComment }),
            }),
            'utf8',
        );
    }
    if (operation.operation === 'edit') {
        return Buffer.from(
            applyRepositoryEdit(content, operation.replacementRule, {
                kind: RepositoryEditKind.Replace,
                line: operation.line,
                originalRule: operation.originalRule,
                replacementRule: operation.replacementRule,
            }),
            'utf8',
        );
    }
    return Buffer.from(
        applyRepositoryEdit(content, operation.originalRule, {
            kind: RepositoryEditKind.Remove,
            line: operation.line,
            originalRule: operation.originalRule,
        }),
        'utf8',
    );
}

/**
 * Count bounded regular-file resources without accepting links or special files.
 *
 * @param root - Review checkout root.
 * @returns Regular file count and aggregate bytes.
 */
function countCheckoutResources(root: string): {
    /**
     * Number of regular files contained in the checkout.
     */
    files: number;

    /**
     * Aggregate byte size of the checkout's regular files.
     */
    bytes: number;
} {
    let files = 0;
    let bytes = 0;

    /**
     * Walk one owned directory without following links.
     *
     * @param directory - Directory to inspect.
     */
    function walk(directory: string): void {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            const stats = lstatSync(path);
            if (stats.isSymbolicLink()) {
                throw new ReviewCheckoutError('unsafe_checkout');
            }
            if (stats.isDirectory()) {
                walk(path);
                continue;
            }
            if (!stats.isFile() || stats.nlink !== 1) {
                throw new ReviewCheckoutError('unsafe_checkout');
            }
            files += 1;
            bytes += stats.size;
            if (files > MAX_CHECKOUT_FILES || bytes > MAX_CHECKOUT_BYTES) {
                throw new ReviewCheckoutError('resource_limit');
            }
        }
    }

    walk(root);
    return { files, bytes };
}

/**
 * Materialize a bound candidate into one standalone detached shallow review checkout.
 *
 * @param options - Opaque candidate, exact source and new owned destination.
 * @returns Canonical patch bytes and verified workspace receipt.
 */
export function materializeReviewCheckout(
    options: MaterializeReviewCheckoutOptions,
): ReviewCheckoutMaterialization {
    const operation = inspectBoundReviewCandidate(options.candidate);
    verifySourcePreimage(operation, options.source);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(options.createdAt)) {
        throw new ReviewCheckoutError('precondition_failed');
    }
    const checkoutPath = resolve(options.checkoutPath);
    if (
        checkoutPath === parseRoot(checkoutPath) ||
        relative(dirname(checkoutPath), checkoutPath) !== 'review'
    ) {
        throw new ReviewCheckoutError('unsafe_checkout');
    }
    if (existsSync(checkoutPath)) {
        throw new ReviewCheckoutError('unsafe_checkout');
    }
    const parent = dirname(checkoutPath);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const isolationRoot = join(parent, `.git-isolation-${randomUUID()}`);
    const isolation: GitIsolation = {
        home: join(isolationRoot, 'home'),
        config: join(isolationRoot, 'global-config'),
        hooks: join(isolationRoot, 'hooks'),
        template: join(isolationRoot, 'template'),
    };
    let checkoutCreated = false;
    try {
        mkdirSync(isolation.home, { recursive: true, mode: 0o700 });
        mkdirSync(isolation.hooks, { mode: 0o700 });
        mkdirSync(isolation.template, { mode: 0o700 });
        writeFileSync(isolation.config, '', { flag: 'wx', mode: 0o600 });
        mkdirSync(checkoutPath, { mode: 0o700 });
        checkoutCreated = true;
        runGit(checkoutPath, ['init', '--quiet', `--template=${isolation.template}`], isolation);
        const sourceUrl = pathToFileURL(realpathSync(options.source.checkoutPath)).href;
        runGit(
            checkoutPath,
            [
                'fetch',
                '--depth=1',
                '--no-tags',
                '--no-recurse-submodules',
                sourceUrl,
                operation.sourceCommit,
            ],
            isolation,
        );
        runGit(checkoutPath, ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], isolation);

        const checkoutSource = readStableFile(checkoutPath, operation.filePath);
        if (
            checkoutSource.byteLength !== operation.targetBytes ||
            sha256(checkoutSource) !== operation.targetFileSha256
        ) {
            throw new ReviewCheckoutError('precondition_failed');
        }
        writeStableFile(
            checkoutPath,
            operation.filePath,
            applyBoundOperation(checkoutSource, operation),
        );
        const status = runGit(
            checkoutPath,
            ['status', '--porcelain=v1', '--untracked-files=all'],
            isolation,
        ).toString('utf8');
        if (status !== ` M ${operation.filePath}\n`) {
            throw new ReviewCheckoutError('unsafe_checkout');
        }
        const patch = runGit(
            checkoutPath,
            ['diff', '--binary', '--no-ext-diff', '--no-textconv', '--', operation.filePath],
            isolation,
        );
        if (patch.byteLength === 0 || patch.byteLength > MAX_PATCH_BYTES) {
            throw new ReviewCheckoutError('resource_limit');
        }
        const staged = runGit(checkoutPath, ['diff', '--cached', '--binary'], isolation);
        const branch = runGit(checkoutPath, ['branch', '--show-current'], isolation);
        const remotes = runGit(checkoutPath, ['remote'], isolation);
        const tags = runGit(checkoutPath, ['tag'], isolation);
        const commitCount = runGit(checkoutPath, ['rev-list', '--count', 'HEAD'], isolation)
            .toString('utf8')
            .trim();
        const headCommit = runGit(checkoutPath, ['rev-parse', '--verify', 'HEAD'], isolation)
            .toString('utf8')
            .trim()
            .toLowerCase();
        const indexTreeDigest = runGit(checkoutPath, ['rev-parse', 'HEAD^{tree}'], isolation)
            .toString('utf8')
            .trim()
            .toLowerCase();
        if (
            staged.byteLength !== 0 ||
            branch.byteLength !== 0 ||
            remotes.byteLength !== 0 ||
            tags.byteLength !== 0 ||
            commitCount !== '1' ||
            headCommit !== operation.sourceCommit ||
            existsSync(join(checkoutPath, '.git', 'objects', 'info', 'alternates'))
        ) {
            throw new ReviewCheckoutError('unsafe_checkout');
        }
        runGit(checkoutPath, ['cat-file', '-e', `${headCommit}^{tree}`], isolation);
        runGit(checkoutPath, ['cat-file', '-e', operation.targetBlobOid], isolation);
        const resources = countCheckoutResources(checkoutPath);
        return {
            patch,
            receipt: {
                checkoutPath: 'review',
                sourceCommit: operation.sourceCommit,
                headCommit,
                indexTreeDigest,
                candidatePreimageDigest: operation.targetFileSha256,
                patchSha256: sha256(patch),
                patchBytes: patch.byteLength,
                changedPath: operation.filePath,
                checkoutFiles: resources.files,
                checkoutBytes: resources.bytes,
                createdAt: options.createdAt,
                cleanupEligible: true,
            },
        };
    } catch (error) {
        if (checkoutCreated) {
            rmSync(checkoutPath, { recursive: true, force: true });
        }
        if (error instanceof ReviewCheckoutError) {
            throw error;
        }
        throw new ReviewCheckoutError('git_failed');
    } finally {
        rmSync(isolationRoot, { recursive: true, force: true });
    }
}

/**
 * Re-verify a detached review checkout and its canonical patch without its original source.
 *
 * @param checkoutPath - Exact retained review checkout.
 * @param receipt - Creation-time integrity receipt.
 * @param patch - Canonical patch bytes stored beside the checkout.
 * @param operation - Strict persisted operation to rederive from detached HEAD.
 * @returns The unchanged verified receipt.
 */
export function verifyReviewCheckout(
    checkoutPath: string,
    receipt: ReviewWorkspaceReceipt,
    patch: Uint8Array,
    operation: ReviewCandidateOperation,
): ReviewWorkspaceReceipt {
    const root = realpathSync(checkoutPath);
    if (
        root !== resolve(checkoutPath) ||
        relative(dirname(root), root) !== receipt.checkoutPath ||
        receipt.changedPath !== operation.filePath ||
        receipt.sourceCommit !== operation.sourceCommit ||
        receipt.candidatePreimageDigest !== operation.targetFileSha256
    ) {
        throw new ReviewCheckoutError('unsafe_checkout', 'checkout identity or receipt binding');
    }
    const patchBytes = Buffer.from(patch);
    if (
        patchBytes.byteLength !== receipt.patchBytes ||
        sha256(patchBytes) !== receipt.patchSha256
    ) {
        throw new ReviewCheckoutError('unsafe_checkout', 'patch digest vs receipt');
    }
    // A shallow detached-HEAD checkout keeps nothing under .git/refs, and artifact transport
    // (the Actions zip round-trip between the analyze and publish jobs) drops empty
    // directories — git then refuses the whole checkout as "not a git repository" although
    // every content byte survived. The directory's existence carries no information, so
    // restoring it is structural repair, not evidence mutation: every content proof below
    // still runs against the transported bytes.
    mkdirSync(join(root, '.git', 'refs'), { recursive: true, mode: 0o700 });
    const actualPatch = runGit(
        root,
        ['diff', '--binary', '--no-ext-diff', '--no-textconv', '--', receipt.changedPath],
        null,
    );
    const status = runGit(
        root,
        ['status', '--porcelain=v1', '--untracked-files=all'],
        null,
    ).toString('utf8');
    const headCommit = runGit(root, ['rev-parse', '--verify', 'HEAD'], null)
        .toString('utf8')
        .trim()
        .toLowerCase();
    const headBlobOid = runGit(
        root,
        ['rev-parse', '--verify', `${headCommit}:${operation.filePath}`],
        null,
    )
        .toString('utf8')
        .trim()
        .toLowerCase();
    const headBytes = runGit(
        root,
        ['show', `${headCommit}:${operation.filePath}`],
        null,
        MAX_BOUND_TARGET_BYTES + 1024,
    );
    verifyOperationPreimage(operation, headBytes, headBlobOid);
    const workingBytes = readStableFile(root, operation.filePath);
    if (!workingBytes.equals(applyBoundOperation(headBytes, operation))) {
        throw new ReviewCheckoutError('unsafe_checkout', 'working file vs bound operation');
    }
    const indexTreeDigest = runGit(root, ['rev-parse', 'HEAD^{tree}'], null)
        .toString('utf8')
        .trim()
        .toLowerCase();
    const staged = runGit(root, ['diff', '--cached', '--binary'], null);
    const branch = runGit(root, ['branch', '--show-current'], null);
    const remotes = runGit(root, ['remote'], null);
    const commitCount = runGit(root, ['rev-list', '--count', 'HEAD'], null).toString('utf8').trim();
    // One combined rejection hid which fact diverged; each check names itself so a failing
    // verify diagnoses from its own log (values stay bounded and content-free).
    const divergence = !actualPatch.equals(patchBytes)
        ? `regenerated patch ${String(actualPatch.byteLength)}B vs receipt ` +
          `${String(patchBytes.byteLength)}B`
        : status !== ` M ${receipt.changedPath}\n`
          ? `worktree status ${JSON.stringify(status.slice(0, 120))}`
          : headCommit !== receipt.headCommit || headCommit !== receipt.sourceCommit
            ? 'HEAD commit vs receipt'
            : indexTreeDigest !== receipt.indexTreeDigest
              ? 'index tree digest vs receipt'
              : staged.byteLength !== 0
                ? 'staged changes present'
                : branch.byteLength !== 0
                  ? 'named branch present'
                  : remotes.byteLength !== 0
                    ? 'remotes present'
                    : commitCount !== '1'
                      ? `commit count ${commitCount}`
                      : existsSync(join(root, '.git', 'objects', 'info', 'alternates'))
                        ? 'alternates present'
                        : null;
    if (divergence !== null) {
        throw new ReviewCheckoutError('unsafe_checkout', divergence);
    }
    const resources = countCheckoutResources(root);
    if (resources.files !== receipt.checkoutFiles || resources.bytes !== receipt.checkoutBytes) {
        throw new ReviewCheckoutError(
            'unsafe_checkout',
            `checkout resources ${String(resources.files)} files/${String(resources.bytes)}B ` +
                `vs receipt ${String(receipt.checkoutFiles)} files/` +
                `${String(receipt.checkoutBytes)}B`,
        );
    }
    return receipt;
}

/**
 * Return the filesystem root containing an absolute path.
 *
 * @param path - Absolute path.
 * @returns Root path.
 */
function parseRoot(path: string): string {
    let parent = dirname(path);
    let current = path;
    while (parent !== current) {
        current = parent;
        parent = dirname(current);
    }
    return current;
}
