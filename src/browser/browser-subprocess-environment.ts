/**
 * Process variables required by Chromium on supported desktop and CI runners.
 */
const BROWSER_ENVIRONMENT_ALLOWLIST = [
    'PATH',
    'HOME',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TZ',
    'DISPLAY',
    'XAUTHORITY',
    'WAYLAND_DISPLAY',
    'XDG_RUNTIME_DIR',
    'DBUS_SESSION_BUS_ADDRESS',
    'FONTCONFIG_PATH',
    'SSL_CERT_FILE',
] as const;

/**
 * Build a minimal Chromium child environment without workflow, provider, or oracle credentials.
 *
 * Browser renderers process untrusted sites. They receive only OS/runtime values needed to start;
 * GitHub tokens, LLM keys, event payload paths, proxy credentials, and benchmark metadata remain in
 * the trusted Node.js parent.
 *
 * @param source - Parent process environment.
 * @returns Fresh allowlisted string environment for the Chromium process tree.
 */
export function buildBrowserSubprocessEnvironment(
    source: NodeJS.ProcessEnv,
): Record<string, string> {
    const environment: Record<string, string> = {};
    for (const key of BROWSER_ENVIRONMENT_ALLOWLIST) {
        const value = source[key];
        if (value !== undefined) {
            environment[key] = value;
        }
    }
    return environment;
}
