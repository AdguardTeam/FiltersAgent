import { constants } from 'node:fs';
import { access, readFile, realpath } from 'node:fs/promises';
import {
    createReadTool,
    DEFAULT_MAX_BYTES,
    formatSize,
    type ReadToolDetails,
} from '@earendil-works/pi-coding-agent';
import type { ImageContent, TextContent } from '@earendil-works/pi-ai';
import * as v from 'valibot';
import { isPathAtOrBelow } from '../types/path-containment';
import { SESSION_SKILLS_ROOT, toRealSkillsPath } from './session-logical-paths';
import type { SessionToolSpec } from './session-tool-types';
import { formatIssues } from './valibot-issues';

/**
 * The refusal every read outside the skills directory answers with.
 *
 * The realpath comparison below is what produces it: `..`, an absolute path elsewhere and a symlink
 * pointing out of the directory all end at the same place, so the model reads one reason and cannot
 * learn whether an outside path exists.
 */
export const SKILLS_READ_OUTSIDE_MESSAGE = 'path is outside the skills directory';

/**
 * The refusal of a file that is not text.
 *
 * Pi's read tool builds an image part from a file its MIME detector recognizes, but the detector is
 * not exported; without it every file takes pi's text branch, so a binary file would otherwise
 * reach the model as garbled UTF-8. A NUL byte is the text/binary boundary this adapter checks.
 */
export const SKILLS_READ_BINARY_MESSAGE = 'binary file; read returns text only';

/**
 * The size of the longest single line one read can return, as the model reads it.
 *
 * Pi's read cuts its output at {@link DEFAULT_MAX_BYTES} and cannot split a line, so a line longer
 * than that is never returned in any part. Spelled with pi's own formatter so the tool description
 * and the refusal state the limit pi applies.
 */
export const SKILLS_READ_LINE_LIMIT = formatSize(DEFAULT_MAX_BYTES);

/**
 * The refusal of a path inside the skills directory that cannot be read: missing, or refused by the
 * filesystem.
 *
 * Node's own message names the real path it tried, which is the run's checkout and not the path the
 * model sees, so the refusal names the requested path and keeps only the error code.
 *
 * @param requestedPath - The absolute path pi resolved the call to, as the model would write it.
 * @param code - The filesystem error code, such as `ENOENT`.
 * @returns The model-facing refusal.
 */
export function skillsReadFailureMessage(requestedPath: string, code: string): string {
    return `cannot read ${requestedPath} (${code})`;
}

/**
 * The line a read without an offset starts at, as pi numbers lines.
 */
const FIRST_LINE = 1;

/**
 * The refusal of a line longer than the read limit.
 *
 * Pi answers such a line with a note telling the model to fall back to bash, which no session here
 * offers, and `offset`/`limit` cannot split a line. The refusal says which line is out of reach and
 * where reading goes on, so the model can read the rest of the file.
 *
 * @param line - The 1-indexed line the read started at.
 * @returns The model-facing refusal.
 */
export function skillsReadLongLineMessage(line: number): string {
    return (
        `line ${line} is longer than the ${SKILLS_READ_LINE_LIMIT} read limit and cannot be read; ` +
        `continue with offset=${line + 1}`
    );
}

/**
 * The parameters of the confined read tool: pi's own read shape, with pi's own meanings.
 *
 * Declared as a Valibot schema beside the tool because `read` is not a registry tool: it is added
 * by the session runner when pi loaded at least one skill the model is shown, so no per-mode
 * parameter map carries it.
 */
const SKILLS_READ_PARAMETERS = v.object({
    path: v.pipe(v.string(), v.description('Path to the file to read (relative or absolute)')),
    offset: v.optional(
        v.pipe(v.number(), v.description('Line number to start reading from (1-indexed)')),
    ),
    limit: v.optional(v.pipe(v.number(), v.description('Maximum number of lines to read'))),
});

/**
 * The tool-call id handed to pi's read tool.
 *
 * Pi's read ignores it: it exists so the tool's own signature is satisfied. A constant keeps the
 * adapter from inventing a per-call identifier nothing consumes.
 */
const SKILLS_READ_CALL_ID = 'skills-read';

/**
 * The byte value that marks a file as binary.
 *
 * A NUL byte never appears in the text files a skill ships, while it appears early in most binary
 * formats; pi's own MIME detector is not exported, so this is the boundary the adapter can check.
 */
const NUL_BYTE = 0;

/**
 * Restate one failed filesystem step of a read under the path the model asked for.
 *
 * Only an error that carries a filesystem code is restated; the adapter's own refusals pass through
 * unchanged.
 *
 * @param requestedPath - The absolute path pi resolved the call to.
 * @param error - What the step threw.
 * @returns The error to throw in its place.
 */
function asRequestedPathFailure(requestedPath: string, error: unknown): unknown {
    const { code } = error as NodeJS.ErrnoException;
    return code === undefined
        ? error
        : new Error(skillsReadFailureMessage(requestedPath, code), { cause: error });
}

/**
 * Run one filesystem step of a read, answering its failure under the path the model asked for.
 *
 * @param requestedPath - The absolute path pi resolved the call to.
 * @param step - The filesystem step.
 * @returns What the step returns.
 * @throws {@link skillsReadFailureMessage} When the step fails with a filesystem code.
 */
async function underRequestedPath<T>(requestedPath: string, step: () => Promise<T>): Promise<T> {
    try {
        return await step();
    } catch (error) {
        throw asRequestedPathFailure(requestedPath, error);
    }
}

/**
 * Resolve one read target and require it to live inside the skills directory.
 *
 * A path under the logical skills root first maps to the real directory; any other path is judged
 * as it is. Both sides are then realpath-resolved before the comparison, so a symlink is judged by
 * where it points, not by where it sits. A target that does not exist answers a missing-file error
 * only when its lexical path is inside the directory; a missing path outside answers the same
 * refusal as an existing one, so probing cannot reveal what the runner's filesystem holds.
 *
 * @param skillsDir - Absolute skills directory the session loaded.
 * @param requestedPath - Absolute path pi's read tool resolved the call to.
 * @returns The real path of the readable target.
 * @throws When the target's real path is outside the skills directory, or it is missing inside.
 */
async function confineToSkillsDir(skillsDir: string, requestedPath: string): Promise<string> {
    const target = toRealSkillsPath(skillsDir, requestedPath);
    const root = await underRequestedPath(requestedPath, () => realpath(skillsDir));
    let resolved: string;
    try {
        resolved = await realpath(target);
    } catch (error) {
        if (isPathAtOrBelow(skillsDir, target)) {
            throw asRequestedPathFailure(requestedPath, error);
        }
        throw new Error(SKILLS_READ_OUTSIDE_MESSAGE, { cause: error });
    }
    if (!isPathAtOrBelow(root, resolved)) {
        throw new Error(SKILLS_READ_OUTSIDE_MESSAGE);
    }
    return resolved;
}

/**
 * Join the text parts pi's read tool returns into the seam's single text result.
 *
 * Without a MIME detector pi never builds an image part, so the result is one text part; the
 * flattening keeps the adapter honest if that ever changes, and drops anything that is not text.
 *
 * @param parts - The result parts pi's read tool resolved with.
 * @returns The model-facing text.
 */
function textOf(parts: readonly (TextContent | ImageContent)[]): string {
    return parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
}

/**
 * Build the confined `read` tool a session offers when the repository ships skills.
 *
 * The tool is pi's own `read` over a cwd of `SESSION_SKILLS_ROOT`, the root the system prompt lists
 * the skills under, so the listed location, a path built from it and a path relative to the skills
 * directory all resolve there. Its `operations` map such a path to the real directory, resolve the
 * target's real path and refuse anything outside the directory's real path; a failure inside the
 * directory names the requested path, never the run's checkout. Before calling them pi only checks
 * whether the requested path or a unicode variant of it exists on the host, to pick which one to
 * pass on; every read goes through the operations. Text only: the image detector is omitted, and a
 * file carrying a NUL byte is refused rather than sent as garbled text. A line longer than
 * {@link SKILLS_READ_LINE_LIMIT} is refused with the offset to go on from, in place of pi's note
 * pointing at a bash fallback no session has. Every refusal is thrown, so pi returns it to the
 * model as a tool error and the run continues.
 *
 * @param skillsDir - Absolute skills directory pi loaded the skills from.
 * @param description - Model-facing description of the tool.
 * @returns The confined read tool as a session tool specification.
 */
export function createSkillsReadTool(skillsDir: string, description: string): SessionToolSpec {
    const readTool = createReadTool(SESSION_SKILLS_ROOT, {
        operations: {
            access: async (absolutePath) => {
                const confined = await confineToSkillsDir(skillsDir, absolutePath);
                await underRequestedPath(absolutePath, () => access(confined, constants.R_OK));
            },
            readFile: async (absolutePath) => {
                const confined = await confineToSkillsDir(skillsDir, absolutePath);
                const buffer = await underRequestedPath(absolutePath, () => readFile(confined));
                if (buffer.includes(NUL_BYTE)) {
                    throw new Error(SKILLS_READ_BINARY_MESSAGE);
                }
                return buffer;
            },
        },
    });
    return {
        name: readTool.name,
        description,
        parameters: SKILLS_READ_PARAMETERS,
        execute: async (args, signal) => {
            const parsed = v.safeParse(SKILLS_READ_PARAMETERS, args);
            if (!parsed.success) {
                throw new Error(
                    `${readTool.name}: invalid arguments (${formatIssues(parsed.issues)})`,
                );
            }
            const result = await readTool.execute(SKILLS_READ_CALL_ID, parsed.output, signal);
            const details = result.details as ReadToolDetails | undefined;
            if (details?.truncation?.firstLineExceedsLimit === true) {
                const { offset } = parsed.output;
                throw new Error(
                    skillsReadLongLineMessage(
                        offset !== undefined && offset >= FIRST_LINE ? offset : FIRST_LINE,
                    ),
                );
            }
            return { content: textOf(result.content) };
        },
    };
}
