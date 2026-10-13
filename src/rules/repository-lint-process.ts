/**
 * The process half of the repository lint command: one shell invocation, bounded in time and
 * output, with none of the run's secrets in its environment. What the command is run over and what
 * its ending means live in `repository-lint-command.ts`.
 */
import { spawn } from 'node:child_process';
import { buildPreparationSubprocessEnvironment } from '../local/preparation-subprocess';

/**
 * Wall-clock bound for one lint run.
 *
 * A locally installed linter over a one-line file finishes in a few seconds, `npx` start-up
 * included; a minute also absorbs `npx` fetching a package it does not find installed. A command
 * still running after that is hung, and every model `lint_rule` call waits for it, so it is killed
 * rather than allowed to eat the investigation's wall clock.
 */
export const REPOSITORY_LINT_TIMEOUT_MS = 60_000;

/**
 * The POSIX shell the command line runs through; present in the action image and on every runner.
 */
const SHELL_PATH = '/bin/sh';

/**
 * Appended to the configured command line: the shell's first positional parameter, which carries
 * the candidate file's path, so the path is one argument whatever characters it holds and never
 * needs quoting.
 */
const CANDIDATE_PATH_ARGUMENT = ' "$1"';

/**
 * `$0` of the `sh -c` invocation, which names the script in the shell's own error messages.
 */
const SHELL_SCRIPT_NAME = 'repository-lint';

/**
 * Environment overrides for the command: colour off, so the output is plain text in a code block
 * and the model reads no escape sequences.
 */
const LINT_ENVIRONMENT_OVERRIDES: NodeJS.ProcessEnv = { NO_COLOR: '1' };

/**
 * Output text cut at a byte bound.
 */
interface BoundedText {
    /**
     * The UTF-8 text up to the bound.
     */
    text: string;

    /**
     * Whether anything the child wrote is missing from the text.
     */
    truncated: boolean;
}

/**
 * Collects a child's combined output up to a byte bound, counting what it dropped.
 */
export class BoundedOutput {
    /**
     * The chunks kept, in arrival order.
     */
    private readonly chunks: Buffer[] = [];

    /**
     * Bytes kept so far.
     */
    private kept = 0;

    /**
     * Bytes received in total, kept or not.
     */
    private received = 0;

    /**
     * Create an empty collector.
     *
     * @param capBytes - How many bytes to keep.
     */
    constructor(private readonly capBytes: number) {}

    /**
     * Append one chunk, keeping only what fits under the bound.
     *
     * @param chunk - Bytes the child wrote.
     */
    append(chunk: Buffer): void {
        this.received += chunk.length;
        const room = this.capBytes - this.kept;
        if (room <= 0) {
            return;
        }
        const piece = chunk.subarray(0, room);
        this.chunks.push(piece);
        this.kept += piece.length;
    }

    /**
     * The kept output as UTF-8 text, cut at a byte bound.
     *
     * @param bytes - The byte bound to cut at.
     * @returns The text and whether anything the child wrote is missing from it.
     */
    text(bytes: number): BoundedText {
        const joined = Buffer.concat(this.chunks);
        return {
            text: joined.subarray(0, bytes).toString('utf8'),
            truncated: this.received > Math.min(bytes, joined.length),
        };
    }

    /**
     * Total bytes the child wrote.
     *
     * @returns The byte count, kept or not.
     */
    receivedBytes(): number {
        return this.received;
    }
}

/**
 * How the child process ended.
 */
export interface ChildEnding {
    /**
     * The exit code, when the child exited by itself.
     */
    exitCode: number | null;

    /**
     * The signal that ended the child, when one did.
     */
    signal: NodeJS.Signals | null;

    /**
     * Whether the time bound expired and the run's process group was killed.
     */
    timedOut: boolean;

    /**
     * The spawn error, when the shell itself could not start.
     */
    startError?: Error;
}

/**
 * Run the shell command with the candidate path appended, bounded in time, in its own process group
 * so a timeout kills everything the command started (an `npx` keeps its node child holding the
 * output pipe).
 *
 * @param command - The configured command line.
 * @param cwd - The checkout root the command runs in.
 * @param candidatePath - The candidate file's checkout-relative path.
 * @param output - Collector for the combined output.
 * @returns How the child ended.
 */
export function runShellCommand(
    command: string,
    cwd: string,
    candidatePath: string,
    output: BoundedOutput,
): Promise<ChildEnding> {
    return new Promise((resolvePromise) => {
        let timedOut = false;
        let settled = false;
        const settle = (ending: ChildEnding): void => {
            if (!settled) {
                settled = true;
                resolvePromise(ending);
            }
        };
        const child = spawn(
            SHELL_PATH,
            ['-c', `${command}${CANDIDATE_PATH_ARGUMENT}`, SHELL_SCRIPT_NAME, candidatePath],
            {
                cwd,
                // No secret of the run reaches the command: the same allowlist preparation
                // commands get, without the git credential.
                env: buildPreparationSubprocessEnvironment(
                    process.env,
                    LINT_ENVIRONMENT_OVERRIDES,
                    undefined,
                    false,
                ),
                detached: true,
                stdio: ['ignore', 'pipe', 'pipe'],
            },
        );
        const timer = setTimeout(() => {
            timedOut = true;
            if (child.pid !== undefined) {
                try {
                    process.kill(-child.pid, 'SIGKILL');
                } catch {
                    // The group already exited between the deadline and the kill.
                }
            }
        }, REPOSITORY_LINT_TIMEOUT_MS);
        child.stdout.on('data', (chunk: Buffer) => output.append(chunk));
        child.stderr.on('data', (chunk: Buffer) => output.append(chunk));
        child.once('error', (error) => {
            clearTimeout(timer);
            settle({ exitCode: null, signal: null, timedOut, startError: error });
        });
        child.once('close', (exitCode, signal) => {
            clearTimeout(timer);
            settle({ exitCode, signal, timedOut });
        });
    });
}
