import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * What one Firefox launch needs of its own before the browser starts: a home directory the process
 * user owns, and the sandbox facts that explain what the browser will say about its own sandbox.
 *
 * Firefox refuses to start as root under a foreign-owned `$HOME`: the container action's `HOME` is
 * the runner's mounted home (`/github/home`, uid 1001), and a launch there dies with "Running
 * Nightly as root in a regular user's session is not supported. ($HOME is /github/home which is
 * owned by uid 1001.)". The check compares the _owner_ of `$HOME` against the effective uid, so the
 * fix is a home the launching process owns — not a different uid, not a disabled check. A
 * per-launch temporary directory is the smallest thing that satisfies it, and it also keeps the
 * browser's own profile leftovers out of a shared home.
 */

/**
 * Prefix of every per-launch Firefox home directory, so a leaked directory is identifiable.
 */
const FIREFOX_HOME_DIR_PREFIX = 'firefox-launch-home-';

/**
 * Permissions of a per-launch Firefox home directory: owner-only, like a real home.
 *
 * The browser writes its own caches and crash state here; nothing else on the host has any reason
 * to read them, and on a shared CI runner the directory lives in the world-writable temp root.
 */
const FIREFOX_HOME_DIR_MODE = 0o700;

/**
 * Kernel knob capping how many user namespaces an unprivileged process may create; `0` means the
 * sandbox's `clone()` cannot succeed at all.
 */
const MAX_USER_NAMESPACES_PATH = '/proc/sys/user/max_user_namespaces';

/**
 * Debian-family kernel knob gating unprivileged `CLONE_NEWUSER`; absent on mainline kernels.
 */
const UNPRIVILEGED_USERNS_CLONE_PATH = '/proc/sys/kernel/unprivileged_userns_clone';

/**
 * One launch's private Firefox home directory.
 */
export interface FirefoxLaunchHome {
    /**
     * Absolute path handed to the browser process as `HOME`.
     */
    path: string;

    /**
     * Owner uid of the created directory, when the platform reports one.
     *
     * Read back rather than assumed: the whole point of the directory is that Firefox's own
     * ownership check passes, so the launch log states what the check will see.
     */
    ownerUid?: number;

    /**
     * Best-effort recursive removal; safe to call twice and after the browser already exited.
     *
     * @returns Nothing.
     */
    dispose: () => void;
}

/**
 * Best-effort sandbox facts of the host a Firefox process is about to start on.
 *
 * A launch in the container action also logs "Sandbox: CanCreateUserNamespace() clone() failure:
 * EPERM" beside the `$HOME` refusal. That is a property of the container's uid mapping and seccomp
 * policy, not of the launch arguments, so every launch records what the kernel would answer instead
 * of guessing later. Every field is optional: on a host without procfs the snapshot is simply
 * smaller, and it must never break a launch.
 */
export interface FirefoxSandboxSnapshot {
    /**
     * Real uid of the launching process, when the platform exposes one.
     */
    uid?: number;

    /**
     * Effective uid of the launching process — the uid Firefox compares `$HOME`'s owner against.
     */
    effectiveUid?: number;

    /**
     * Value of `/proc/sys/user/max_user_namespaces`, when readable; `0` explains an `EPERM` from
     * the content sandbox's `clone()` on its own.
     */
    maxUserNamespaces?: number;

    /**
     * Value of `/proc/sys/kernel/unprivileged_userns_clone`, when the knob exists; `0` is the other
     * way that same `clone()` fails.
     */
    unprivilegedUsernsClone?: number;
}

/**
 * Injectable OS seams so a test can pin exact procfs contents.
 */
export interface FirefoxSandboxSnapshotDeps {
    /**
     * Read a procfs file as text.
     *
     * @param path - Absolute procfs file path.
     * @returns File contents.
     */
    readText?(path: string): string;
}

/**
 * Create the private home directory for one Firefox launch.
 *
 * Anchored at `os.tmpdir()`: the requirement is only that the launching process owns the directory,
 * and the OS temp root is the one writable place every supported host agrees on.
 *
 * @returns The directory path, its owner uid when readable, and its disposal handle.
 */
export function createFirefoxLaunchHome(): FirefoxLaunchHome {
    const path = mkdtempSync(join(tmpdir(), FIREFOX_HOME_DIR_PREFIX));
    chmodSync(path, FIREFOX_HOME_DIR_MODE);
    let ownerUid: number | undefined;
    try {
        ownerUid = statSync(path).uid;
    } catch {
        // Ownership is a log detail, not a precondition: a stat that cannot run leaves the field
        // absent rather than failing a launch that would have worked.
    }
    return {
        path,
        ...(ownerUid === undefined ? {} : { ownerUid }),
        dispose: () => rmSync(path, { recursive: true, force: true }),
    };
}

/**
 * Read one numeric procfs knob, tolerating its absence.
 *
 * @param readText - The procfs reader in use.
 * @param path - Absolute procfs file path.
 * @returns The parsed value, or undefined when the file is missing or not a number.
 */
function readNumericKnob(readText: (path: string) => string, path: string): number | undefined {
    try {
        const parsed = Number(readText(path).trim());
        return Number.isFinite(parsed) ? parsed : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Capture the sandbox snapshot of the launching host, omitting anything unreadable.
 *
 * @param deps - Optional procfs seam for tests.
 * @returns Populated fields only; an empty object on a host that exposes none of them.
 */
export function readFirefoxSandboxSnapshot(
    deps: FirefoxSandboxSnapshotDeps = {},
): FirefoxSandboxSnapshot {
    const readText = deps.readText ?? ((path: string) => readFileSync(path, 'utf8'));
    const snapshot: FirefoxSandboxSnapshot = {};
    const uid = process.getuid?.();
    if (uid !== undefined) {
        snapshot.uid = uid;
    }
    const effectiveUid = process.geteuid?.();
    if (effectiveUid !== undefined) {
        snapshot.effectiveUid = effectiveUid;
    }
    const maxUserNamespaces = readNumericKnob(readText, MAX_USER_NAMESPACES_PATH);
    if (maxUserNamespaces !== undefined) {
        snapshot.maxUserNamespaces = maxUserNamespaces;
    }
    const unprivilegedUsernsClone = readNumericKnob(readText, UNPRIVILEGED_USERNS_CLONE_PATH);
    if (unprivilegedUsernsClone !== undefined) {
        snapshot.unprivilegedUsernsClone = unprivilegedUsernsClone;
    }
    return snapshot;
}
