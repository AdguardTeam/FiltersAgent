/**
 * Symlink-safe workdir containment and the unprivileged write dispatch `write_file` needs.
 *
 * A lexical containment check alone is not containment: a preparation command run earlier in the
 * same session can create a symlink inside the workdir that points outside it (for example to a
 * root-owned directory), and a lexically-inside request that walks through that link resolves —
 * and, unresolved, would write — somewhere else entirely. {@link resolveRealPathInsideWorkdir}
 * closes that at the application level, by re-checking the real (symlink-resolved) path against the
 * workdir's own real path; {@link writeFileAsUnprivilegedIdentity} closes the remaining check/use
 * race at the kernel, by running the actual directory creation and write as the same unprivileged
 * identity `run_command` already uses on a privileged host — the kernel then refuses anything that
 * identity does not itself own or may write, whatever the application-level check found a moment
 * earlier.
 */
import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { runPreparationSubprocess } from '../local/preparation-subprocess';

/**
 * One in-workdir resolution: the absolute resolved path.
 */
interface ResolvedPreparationWrite {
    /**
     * The absolute path inside the workdir the request resolves to.
     */
    resolved: string;

    /**
     * Never set on the inside-workdir arm; keeps the two arms structurally distinct.
     */
    refusal?: undefined;
}

/**
 * One refused resolution: the model-facing reason the write did not happen.
 */
interface EscapedPreparationWrite {
    /**
     * Never set on the escaped arm.
     */
    resolved: undefined;

    /**
     * Why the request was refused.
     */
    refusal: string;
}

/**
 * Resolve one requested write path against the preparation workdir.
 *
 * @param workDir - Absolute preparation workdir.
 * @param requestedPath - Model-supplied path fragment (relative expected).
 * @returns The absolute resolved path, or the refusal reason when the request escapes — an absolute
 *   path request or a resolution outside the workdir.
 */
function resolveInsideWorkdir(
    workDir: string,
    requestedPath: string,
): ResolvedPreparationWrite | EscapedPreparationWrite {
    if (isAbsolute(requestedPath)) {
        return {
            resolved: undefined,
            refusal:
                `write_file writes only inside the preparation workdir: an absolute path ` +
                `"${requestedPath}" is refused.`,
        };
    }
    const resolved = resolve(workDir, requestedPath);
    const back = relative(workDir, resolved);
    if (back.length > 0 && (back.startsWith('..') || isAbsolute(back))) {
        return {
            resolved: undefined,
            refusal:
                `write_file writes only inside the preparation workdir: "${requestedPath}" ` +
                'resolves outside it.',
        };
    }
    return { resolved };
}

/**
 * The nearest existing ancestor of a lexical path and that ancestor's own real (symlink-resolved)
 * path.
 */
interface NearestExistingRealAncestor {
    /**
     * The nearest prefix of the requested path that exists on disk — the requested path itself when
     * it already exists.
     */
    existing: string;

    /**
     * {@link existing}'s real path, with every symlink along it resolved.
     */
    real: string;
}

/**
 * Find the nearest existing ancestor of a lexical path and resolve that ancestor's symlinks.
 *
 * A path segment that does not exist yet cannot itself be a symlink, so walking up to the first
 * segment that does exist and resolving only that one is enough to know the real location anything
 * under it would land at: the caller reattaches the non-existent suffix unresolved.
 *
 * @param path - Absolute lexical path to resolve.
 * @returns The nearest existing ancestor and its real path.
 */
async function nearestExistingRealAncestor(path: string): Promise<NearestExistingRealAncestor> {
    let candidate = path;
    for (;;) {
        try {
            const real = await realpath(candidate);
            return { existing: candidate, real };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
            }
            const parent = dirname(candidate);
            // An absolute path's root is its own dirname, so this is reached only if even the
            // filesystem root does not resolve — a host too broken for any of this to matter.
            if (parent === candidate) {
                throw error;
            }
            candidate = parent;
        }
    }
}

/**
 * Resolve one requested write path against the preparation workdir, through any symlink along the
 * way.
 *
 * {@link resolveInsideWorkdir}'s lexical check alone is not containment: a preparation command run
 * earlier in the same session can create a symlink inside the workdir that points outside it (for
 * example to a root-owned directory), and a lexically-inside request that walks through that link
 * resolves — and, unresolved, would write — somewhere else entirely. This resolves the real path of
 * the nearest existing ancestor and re-checks containment against the workdir's own real path
 * before ever touching the filesystem.
 *
 * @param workDir - Absolute preparation workdir.
 * @param requestedPath - Model-supplied path fragment (relative expected).
 * @returns The absolute lexical path to write, once its real location is confirmed inside the
 *   workdir, or the refusal reason when the request escapes it — lexically or through a symlink.
 */
export async function resolveRealPathInsideWorkdir(
    workDir: string,
    requestedPath: string,
): Promise<ResolvedPreparationWrite | EscapedPreparationWrite> {
    const lexical = resolveInsideWorkdir(workDir, requestedPath);
    if (lexical.resolved === undefined) {
        return lexical;
    }
    const [{ real: realWorkDir }, { existing, real: realExisting }] = await Promise.all([
        nearestExistingRealAncestor(workDir),
        nearestExistingRealAncestor(lexical.resolved),
    ]);
    const unresolvedSuffix = relative(existing, lexical.resolved);
    const effectiveReal = resolve(realExisting, unresolvedSuffix);
    const back = relative(realWorkDir, effectiveReal);
    if (back.length > 0 && (back.startsWith('..') || isAbsolute(back))) {
        return {
            resolved: undefined,
            refusal:
                `write_file writes only inside the preparation workdir: "${requestedPath}" ` +
                'resolves outside it through a symlink.',
        };
    }
    return { resolved: lexical.resolved };
}

/**
 * Executable used to create a `write_file` destination directory as the unprivileged identity.
 */
const UNPRIVILEGED_MKDIR_EXECUTABLE = 'mkdir';

/**
 * Executable used to write a `write_file` destination's content as the unprivileged identity.
 *
 * `tee` always creates or truncates its destination before writing every stdin byte, matching
 * `fs.writeFile`'s own semantics exactly; the copy it also emits to its own stdout is captured and
 * discarded like any other preparation subprocess output, never treated as the tool's result.
 */
const UNPRIVILEGED_WRITE_EXECUTABLE = 'tee';

/**
 * Write one file's content through the unprivileged preparation identity instead of the run
 * process's own (root, on a privileged host).
 *
 * Root can create a symlink anywhere and therefore write anywhere, so a `write_file` that itself
 * writes as root would defeat {@link resolveRealPathInsideWorkdir}'s check on a check/use race — a
 * symlink swapped in after the check and before the write. Routing the directory creation and the
 * content write through the same unprivileged child `run_command` already uses closes that race at
 * the kernel: the child can create or write through a path only to the extent the unprivileged
 * identity itself already owns or may write, whatever the application-level check found a moment
 * earlier.
 *
 * @param runSubprocess - The subprocess seam, injectable so tests observe the exact dispatch
 *   without starting a process.
 * @param workDir - Absolute preparation workdir, used as the child's cwd and HOME.
 * @param uid - The unprivileged uid the child runs under.
 * @param gid - The unprivileged gid the child runs under.
 * @param targetPath - Absolute resolved destination path, already confirmed to resolve inside the
 *   workdir.
 * @param content - The file content to write.
 * @param sourceEnvironment - Parent environment the child's minimal environment is derived from.
 * @returns Bounded failure detail naming the failing step, or `undefined` on success.
 */
export async function writeFileAsUnprivilegedIdentity(
    runSubprocess: typeof runPreparationSubprocess,
    workDir: string,
    uid: number,
    gid: number,
    targetPath: string,
    content: string,
    sourceEnvironment: NodeJS.ProcessEnv,
): Promise<string | undefined> {
    const identityFields = {
        uid,
        gid,
        environment: { HOME: workDir },
    };
    const mkdirResult = await runSubprocess(
        {
            executable: UNPRIVILEGED_MKDIR_EXECUTABLE,
            args: ['-p', dirname(targetPath)],
            cwd: workDir,
            allowGitCredential: false,
            ...identityFields,
        },
        sourceEnvironment,
    );
    if (mkdirResult.exitCode !== 0) {
        return (
            `mkdir -p "${dirname(targetPath)}" exit ${mkdirResult.exitCode} stderr: ` +
            mkdirResult.stderr
        );
    }
    const writeResult = await runSubprocess(
        {
            executable: UNPRIVILEGED_WRITE_EXECUTABLE,
            args: [targetPath],
            cwd: workDir,
            allowGitCredential: false,
            stdin: content,
            ...identityFields,
        },
        sourceEnvironment,
    );
    if (writeResult.exitCode !== 0) {
        return `tee "${targetPath}" exit ${writeResult.exitCode} stderr: ${writeResult.stderr}`;
    }
    return undefined;
}
