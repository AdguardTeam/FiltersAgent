import { spawn } from 'node:child_process';
import { gitHttpAuthEnvironment } from './git-http-auth';

/**
 * Environment keys required by disposable git and package-manager preparation commands.
 */
const PREPARATION_ENVIRONMENT_ALLOWLIST = [
    'PATH',
    'HOME',
    'TMPDIR',
    'TMP',
    'TEMP',
    'SHELL',
    'USER',
    'LOGNAME',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TERM',
    'CI',
    'NO_COLOR',
    'COREPACK_HOME',
    'PNPM_HOME',
    'XDG_CACHE_HOME',
] as const;

/**
 * The one executable that receives a host-scoped GitHub credential instead of nothing at all.
 */
const GIT_EXECUTABLE = 'git';

/**
 * Grace between SIGTERM and SIGKILL on the timeout kill path.
 *
 * One second lets a well-behaved child flush its output and unwind; anything still alive after that
 * is wedged and gets SIGKILL — captured output has already been streamed and is not lost.
 */
const TIMEOUT_TERMINATION_GRACE_MS = 1_000;

/**
 * Exit status reported when the opt-in timeout bound expired and the command was killed.
 *
 * Matches the "runtime supplied no status" convention of a null close code, so callers see the one
 * code for "the command did not finish by itself".
 */
const TIMED_OUT_EXIT_CODE = -1;

/**
 * One argv-only command used to prepare historical browser dependencies.
 */
export interface PreparationSubprocessCommand {
    /**
     * Executable invoked directly without a shell.
     */
    executable: string;

    /**
     * Arguments passed directly to the executable.
     */
    args: string[];

    /**
     * Optional working directory for the subprocess.
     */
    cwd?: string;

    /**
     * Optional non-secret execution variables filtered through the same allowlist.
     */
    environment?: NodeJS.ProcessEnv;

    /**
     * Opt-in wall-clock bound for this one command in milliseconds; absent means unbounded.
     *
     * Deliberately not a default: host callers clone whole filter repositories, and an implicit
     * bound would SIGKILL work that completes today. Only the model-driven preparation path passes
     * a bound, because a hung model step must not consume the whole phase budget.
     */
    timeoutMs?: number;

    /**
     * Whether the executable that is git alone may receive the GitHub credential derived from
     * GITHUB_TOKEN; defaults to true so host calls keep today's behavior.
     *
     * Model-driven preparation passes false to keep the derived credential out of every
     * model-invoked command: the preparation environment must hold neither the LLM key nor any
     * token, and the derived `GIT_CONFIG_*` form is a token for all practical purposes.
     */
    allowGitCredential?: boolean;

    /**
     * The caller-supplied host-scoped token, used only for git when `allowGitCredential` is not
     * false; absent falls back to a `GITHUB_TOKEN` present in the source environment.
     *
     * The container action keeps the resolved token in an action input, not in its environment;
     * attaching it here lets `ls-remote`/`fetch` authenticate without mutating `process.env`.
     */
    gitCredentialToken?: string;

    /**
     * The unprivileged uid the child runs as, when a privileged host requests the drop; absent
     * keeps the parent process's identity.
     *
     * Model-issued preparation commands must not run as root: a child running as `nobody` cannot
     * read the run process's environment through `/proc/1/environ`.
     */
    uid?: number;

    /**
     * The gid paired with {@link uid}, when a privileged host requests the drop; absent keeps the
     * parent process's identity.
     */
    gid?: number;

    /**
     * Content written to the child's standard input and closed immediately after, when supplied;
     * absent closes standard input without writing anything.
     *
     * The one caller that supplies this is the unprivileged `write_file` dispatch: it feeds a
     * file's exact content to a small writer executable running as the unprivileged identity,
     * instead of the parent process (root, on a privileged host) ever calling `fs.writeFile`
     * itself.
     */
    stdin?: string;
}

/**
 * Captured output and exit status from one preparation subprocess.
 */
export interface PreparationSubprocessResult {
    /**
     * Process exit status, or -1 when the runtime supplied no status.
     */
    exitCode: number;

    /**
     * Whether the command was killed because its opt-in timeoutMs bound expired. Never true when no
     * bound was set.
     */
    timedOut: boolean;

    /**
     * Complete UTF-8 standard output.
     */
    stdout: string;

    /**
     * Complete UTF-8 standard error.
     */
    stderr: string;
}

/**
 * Build the minimal environment inherited by disposable preparation subprocesses.
 *
 * API keys, GitHub credentials, provider secrets, proxy credentials, and arbitrary caller variables
 * are deliberately omitted as variables. Git commands are the one exception, and only in derived
 * form and only when {@link allowGitCredential} is on: when the parent holds `GITHUB_TOKEN` — or
 * the caller supplies an explicit token — git receives a credential scoped to github.com through
 * `GIT_CONFIG_*` — anonymous clones from a shared runner IP trip GitHub's secondary rate limit and
 * fail with "could not read Username", while the raw token still never reaches any child. Git also
 * receives a non-interactive prompt policy.
 *
 * @param source - Parent environment from which safe execution paths may be copied.
 * @param overrides - Optional command-specific values subject to the same allowlist.
 * @param executable - Executable about to be spawned; only git earns the GitHub credential.
 * @param allowGitCredential - Whether the derived git credential is allowed at all; defaults to
 *   true (host behavior), and model-driven preparation passes false.
 * @param gitCredentialToken - Explicit host-scoped token used in place of a `GITHUB_TOKEN` from the
 *   combined environment; absent keeps the environment-derived behavior.
 * @returns A fresh allowlisted subprocess environment without API credentials.
 */
export function buildPreparationSubprocessEnvironment(
    source: NodeJS.ProcessEnv,
    overrides: NodeJS.ProcessEnv = {},
    executable?: string,
    allowGitCredential = true,
    gitCredentialToken?: string,
): NodeJS.ProcessEnv {
    const combined = { ...source, ...overrides };
    const environment: NodeJS.ProcessEnv = {
        GIT_TERMINAL_PROMPT: '0',
    };
    for (const key of PREPARATION_ENVIRONMENT_ALLOWLIST) {
        const value = combined[key];
        if (value !== undefined) {
            environment[key] = value;
        }
    }
    const githubToken = (gitCredentialToken ?? combined.GITHUB_TOKEN)?.trim();
    if (allowGitCredential && executable === GIT_EXECUTABLE && githubToken) {
        Object.assign(environment, gitHttpAuthEnvironment(githubToken));
    }
    return environment;
}

/**
 * Execute one disposable preparation command without exposing parent-process secrets.
 *
 * Contract: the command either exits by itself or, when an opt-in timeoutMs bound was supplied and
 * expires, is killed SIGTERM → 1s grace → SIGKILL. Either way the call resolves — never throws —
 * with everything the command produced up to that point, so a failed or killed preparation step is
 * always diagnosable from its captured output.
 *
 * @param command - Executable, arguments, optional working directory, environment overrides,
 *   optional timeout bound, optional credential gating, optional explicit credential token, an
 *   optional unprivileged uid/gid the child runs under, and optional content piped to standard
 *   input.
 * @param sourceEnvironment - Parent environment, injectable for deterministic unit tests.
 * @returns Captured process output after exit or after the timeout kill.
 */
export async function runPreparationSubprocess(
    command: PreparationSubprocessCommand,
    sourceEnvironment: NodeJS.ProcessEnv = process.env,
): Promise<PreparationSubprocessResult> {
    return await new Promise((resolve, reject) => {
        const child = spawn(command.executable, command.args, {
            cwd: command.cwd,
            env: buildPreparationSubprocessEnvironment(
                sourceEnvironment,
                command.environment,
                command.executable,
                command.allowGitCredential,
                command.gitCredentialToken,
            ),
            shell: false,
            // Always piped, even with no stdin content to send: a literal three-'pipe' tuple is
            // the one stdio shape Node's types resolve to non-null stdin/stdout/stderr streams, and
            // closing an empty pipe immediately below signals EOF exactly like the 'ignore' this
            // replaced — no command here reads from standard input when the caller supplies none.
            stdio: ['pipe', 'pipe', 'pipe'],
            ...(command.uid !== undefined ? { uid: command.uid } : {}),
            ...(command.gid !== undefined ? { gid: command.gid } : {}),
        });
        // A child that exits before reading (a bad executable, a permission refusal at open())
        // closes its end of the pipe first; without this handler that EPIPE surfaces as an
        // unhandled 'error' event on the stream instead of the ordinary non-zero exit the 'close'
        // handler below already reports.
        child.stdin.on('error', () => {});
        if (command.stdin === undefined) {
            child.stdin.end();
        } else {
            child.stdin.end(command.stdin, 'utf8');
        }
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let graceKillTimer: NodeJS.Timeout | undefined;
        const boundKillTimer =
            command.timeoutMs === undefined
                ? undefined
                : setTimeout(() => {
                      timedOut = true;
                      child.kill('SIGTERM');
                      graceKillTimer = setTimeout(() => {
                          child.kill('SIGKILL');
                      }, TIMEOUT_TERMINATION_GRACE_MS);
                      graceKillTimer.unref();
                  }, command.timeoutMs);
        boundKillTimer?.unref();
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
            stdout += chunk;
        });
        child.stderr.on('data', (chunk: string) => {
            stderr += chunk;
        });
        child.once('error', reject);
        child.once('close', (code) => {
            clearTimeout(boundKillTimer);
            clearTimeout(graceKillTimer);
            resolve({
                exitCode: timedOut ? TIMED_OUT_EXIT_CODE : (code ?? -1),
                timedOut,
                stdout,
                stderr,
            });
        });
    });
}
