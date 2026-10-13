/**
 * How the two filter dialects in scope spell scriptlet injection, and what name a spelled body
 * injects.
 *
 * AdGuard writes the injection as `//scriptlet('name', 'arg')` — behind its own `#%#` / `#@%#`
 * separators, or behind `#$#` / `#@$#`, which also carry CSS injection. uBlock Origin writes it as
 * `+js(name, arg)` behind the plain element-hiding `##` / `#@#`. Both dialects therefore hide a
 * scriptlet behind a separator that means something else on its own, so the body is what decides.
 */

/**
 * AdGuard's scriptlet-injection marker, as it opens a `#$#` or `#@$#` rule body.
 *
 * The same separators also carry CSS injection, so only the marker tells the two apart.
 */
const ADGUARD_SCRIPTLET_BODY_PATTERN = /^\/\/scriptlet\s*\(/iu;

/**
 * The scriptlet name inside an AdGuard `//scriptlet(...)` body: the call's first quoted argument.
 *
 * AdGuard quotes every scriptlet argument, so the name is the call's first quoted token.
 */
const ADGUARD_SCRIPTLET_NAME_PATTERN = /\/\/scriptlet\(\s*['"]([^'"]+)['"]/u;

/**
 * The uBlock Origin scriptlet-injection marker, as it opens a `##` or `#@#` rule body.
 *
 * In uBO, scriptlet injection is spelled `example.com##+js(name, arg1, arg2)` and its exception
 * `example.com#@#+js(name, ...)`, so a uAssets checkout carries its scriptlets behind the
 * element-hiding separator. The match is anchored and case-sensitive because `+js` is uBO's literal
 * token: an unanchored match would read an element-hiding selector that merely mentions `+js(`
 * further along as an injection, and `+jsx(` is a different token entirely.
 */
const UBO_SCRIPTLET_BODY_PATTERN = /^\+js\s*\(/u;

/**
 * The scriptlet name inside a uBO `+js(...)` body: the call's first comma-separated argument.
 *
 * Arguments in uBO are unquoted and whitespace-trimmed, so the name ends at the first comma or the
 * closing parenthesis. An argument-less `+js()` names no scriptlet at all — uBO reads it as
 * "disable every scriptlet on this site" — and the capture is then empty.
 */
const UBO_SCRIPTLET_NAME_PATTERN = /^\+js\s*\(\s*([^,)]*)/u;

/**
 * Whether a rule body is AdGuard's `//scriptlet(...)` injection.
 *
 * @param body - Whitespace-collapsed rule body following the cosmetic separator.
 * @returns True when the body opens with AdGuard's scriptlet call.
 */
export function isAdGuardScriptletBody(body: string): boolean {
    return ADGUARD_SCRIPTLET_BODY_PATTERN.test(body);
}

/**
 * Whether a rule body is uBlock Origin's `+js(...)` injection.
 *
 * @param body - Whitespace-collapsed rule body following the cosmetic separator.
 * @returns True when the body opens with uBO's scriptlet call.
 */
export function isUboScriptletBody(body: string): boolean {
    return UBO_SCRIPTLET_BODY_PATTERN.test(body);
}

/**
 * Extract the name of the injected scriptlet from a scriptlet rule body, in either spelling.
 *
 * @param body - Whitespace-collapsed rule body following the cosmetic separator.
 * @returns The scriptlet name, or undefined when the body names none.
 */
export function scriptletNameFromBody(body: string): string | undefined {
    const ubo = UBO_SCRIPTLET_NAME_PATTERN.exec(body);
    if (ubo) {
        const name = ubo[1].trim();
        return name.length > 0 ? name : undefined;
    }
    return ADGUARD_SCRIPTLET_NAME_PATTERN.exec(body)?.[1];
}
