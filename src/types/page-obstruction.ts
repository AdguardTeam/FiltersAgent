import * as v from 'valibot';

/**
 * What a capture fundamentally shows in place of the site's content, as the vision model judges it
 * over the pixels.
 */
export const PageObstruction = {
    /**
     * The site's own content, including consent dialogs, anti-adblock notices and paywalls: they
     * are the site's content and often the very defect that was reported.
     */
    None: 'none',

    /**
     * A CAPTCHA or bot-verification interstitial replaces the site.
     */
    AntiBotChallenge: 'anti_bot_challenge',

    /**
     * A sign-in page or dialog demands an account before the site shows its content.
     */
    SignInWall: 'sign_in_wall',

    /**
     * A notice says the page or its main content is not available in this country or region.
     */
    RegionBlock: 'region_block',

    /**
     * An error page or an essentially blank capture.
     */
    ErrorOrBlank: 'error_or_blank',
} as const;

/**
 * Every PageObstruction value, for schemas and exhaustive listings.
 */
export const PAGE_OBSTRUCTION_VALUES = Object.values(PageObstruction);

export const PageObstructionSchema = v.picklist(PAGE_OBSTRUCTION_VALUES);

/**
 * PageObstruction value.
 */
export type PageObstruction = (typeof PageObstruction)[keyof typeof PageObstruction];

/**
 * The obstructions that withhold the reported page from this runner for a reason outside the page
 * itself: another session can at most get past a bot check, never supply an account or move the
 * runner to another country.
 */
export type WithheldPageObstruction =
    | typeof PageObstruction.AntiBotChallenge
    | typeof PageObstruction.SignInWall
    | typeof PageObstruction.RegionBlock;

/**
 * Decide whether one vision verdict says the reported page was withheld.
 *
 * @param obstruction - Vision verdict for one capture.
 * @returns Whether the capture shows a bot check, a sign-in wall or a regional block.
 */
export function isWithheldPage(
    obstruction: PageObstruction,
): obstruction is WithheldPageObstruction {
    return (
        obstruction === PageObstruction.AntiBotChallenge ||
        obstruction === PageObstruction.SignInWall ||
        obstruction === PageObstruction.RegionBlock
    );
}

/**
 * The instruction every vision call that classifies a page obstruction appends, so the screenshot
 * tool and the full-page inventory judge walls by one definition.
 *
 * Anti-adblock notices, consent dialogs and paywalls are named explicitly: they are exactly what
 * many reports are about, and counting one as a wall would spend the run's access budget on the
 * reported defect itself.
 */
export const PAGE_OBSTRUCTION_INSTRUCTION = [
    'Also classify what stands in place of the site content as pageObstruction:',
    "'anti_bot_challenge' when a CAPTCHA or bot-verification interstitial replaces the site;",
    "'sign_in_wall' when a sign-in page or dialog demands an account before the site shows its",
    "content; 'region_block' when a notice says the page or its main content, such as a video or",
    "an article, is not available in this country or region; 'error_or_blank' for an error page or",
    "an essentially blank capture; otherwise 'none'. Consent dialogs, anti-adblock notices and",
    "paywalls are the site's own content, often the reported defect itself: classify them as",
    "'none'.",
].join(' ');
