/**
 * Canonical browser names recorded in the actual environment context of a run.
 *
 * Every environment adapter that binds an actual context — the browser-extension environment, the
 * CLI proxy environment, the environment selection, and the agent runtime — reports the engine it
 * really drove under one of these names, and readers of a `FixRunResult` compare and render that
 * name verbatim. Spelling it per emitter is what lets one run report a different browser than
 * another for the same engine, so the label lives here and every emitter reads it.
 */
export const BrowserDisplayName = {
    /**
     * The stealth Chromium engine every browser route drives: a reporter's named browser plays back
     * through the generic engine, and a named browser the run did not drive surfaces as the
     * environment selection's browser-approximation fidelity limitation.
     */
    CloakBrowserChromium: 'CloakBrowser Chromium',

    /**
     * The Playwright Firefox build a Firefox-family prepared extension is force-installed into
     * through enterprise policies: the one route that drives a browser other than the stealth
     * Chromium engine.
     */
    PlaywrightFirefox: 'Playwright Firefox',
} as const;

/**
 * One canonical browser name recorded in an actual environment context.
 */
export type BrowserDisplayName = (typeof BrowserDisplayName)[keyof typeof BrowserDisplayName];
