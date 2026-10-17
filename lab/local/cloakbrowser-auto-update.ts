import {
    CLOAKBROWSER_AUTO_UPDATE_VAR,
    CLOAKBROWSER_AUTO_UPDATE_DISABLED,
} from '../../src/browser/cloakbrowser-auto-update';

/**
 * Preserve an explicit browser-update setting or disable automatic binary updates.
 *
 * @param env - Environment after workspace configuration has been applied.
 * @returns Configured update setting, or the stable browser default.
 */
export function resolveCloakBrowserAutoUpdate(env: NodeJS.ProcessEnv): string {
    return env[CLOAKBROWSER_AUTO_UPDATE_VAR] ?? CLOAKBROWSER_AUTO_UPDATE_DISABLED;
}
