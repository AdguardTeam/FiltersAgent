/**
 * How the run's Chromium presents itself to sites. Requests the run sends outside the browser
 * present the same identity, so a site answers them as it answers the browser instead of dropping a
 * client it does not recognise.
 */

/**
 * Platform token of the desktop user agents the run presents.
 */
export const DESKTOP_PLATFORM = 'Windows NT 10.0; Win64; x64';

/**
 * Chromium version the run's Chromium-family user agents claim: Chrome's own token and the Edge
 * token on top of it carry the same engine version, so they change together.
 */
export const CHROMIUM_VERSION = '145.0.0.0';

/**
 * The `Accept` header Chromium sends with a page navigation.
 */
export const CHROMIUM_NAVIGATION_ACCEPT =
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,' +
    '*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';

/**
 * Build the Chromium user agent for one platform.
 *
 * @param platform - Platform token inside the parentheses, such as {@link DESKTOP_PLATFORM}.
 * @param mobile - Whether the device is a phone.
 * @returns The user-agent string.
 */
export function chromiumUserAgent(platform: string, mobile: boolean): string {
    return (
        `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) ` +
        `Chrome/${CHROMIUM_VERSION} ${mobile ? 'Mobile ' : ''}Safari/537.36`
    );
}

/**
 * The desktop Chromium user agent, the one the run's browser presents unless the report asks for
 * another browser or a phone.
 */
export const DESKTOP_CHROMIUM_USER_AGENT = chromiumUserAgent(DESKTOP_PLATFORM, false);
