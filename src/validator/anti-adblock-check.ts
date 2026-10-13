import type { TrustedPageEvaluator } from '../browser/trusted-page-evaluator';

/**
 * JavaScript expression that probes the page for anti-adblock wall indicators.
 *
 * Checks for: 1. Elements with class or ID matching common anti-adblock patterns. 2. Large overlays
 * (z-index > 10000) containing "adblock" or "ad blocker" text. 3. Body text containing "please
 * disable your ad blocker" or similar phrases.
 *
 * Returns `true` if any probe matches, `false` otherwise.
 */
const ANTI_ADBLOCK_PROBE = `
(function () {
    var patterns = [
        'adblock-wall', 'adb-enabled', 'anti-adblock', 'adb-popup',
        'detected-adblock', 'adblock-detected', 'adblock-notice', 'adb-notification'
    ];

    // 1. Check for elements with anti-adblock class/ID
    for (var i = 0; i < patterns.length; i++) {
        var p = patterns[i];
        if (document.querySelector('.' + p) || document.getElementById(p)) {
            return true;
        }
    }

    // 2. Check for large overlays mentioning adblock
    var allDivs = document.querySelectorAll('div');
    for (var j = 0; j < allDivs.length; j++) {
        var d = allDivs[j];
        var style = window.getComputedStyle(d);
        var zIndex = parseInt(style.zIndex, 10);
        if (zIndex > 10000) {
            var text = (d.textContent || '').toLowerCase();
            if (text.indexOf('adblock') !== -1 || text.indexOf('ad blocker') !== -1) {
                return true;
            }
        }
    }

    // 3. Check body text for anti-adblock phrases
    var bodyText = (document.body.textContent || '').toLowerCase();
    if (
        bodyText.indexOf('please disable your ad blocker') !== -1 ||
        bodyText.indexOf('please turn off your ad blocker') !== -1
    ) {
        return true;
    }

    return false;
})()
`;

/**
 * Check whether an anti-adblock wall is present on the current page.
 *
 * Evaluates a JavaScript expression in a trusted isolated world that probes for common anti-adblock
 * patterns: dedicated anti-adblock DOM elements, overlay walls, and redirect banners.
 *
 * Evaluation errors and malformed results conservatively return `true` because a failed probe must
 * never authorize browser verification.
 *
 * @param evaluator - Trusted isolated-world page evaluator.
 * @returns `true` if a wall was detected or the trusted probe failed, otherwise `false`.
 */
export async function checkAntiAdblock(evaluator: TrustedPageEvaluator): Promise<boolean> {
    try {
        const result = await evaluator.evaluate(ANTI_ADBLOCK_PROBE);
        if (typeof result === 'boolean') {
            return result;
        }
        return true;
    } catch {
        return true;
    }
}
