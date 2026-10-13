/**
 * What a proxy blocker reports inside the pages it filters, in the format its description names
 * ({@link PageEvidenceFormat}). Only the agent holds the page, so the agent reads these reports
 * itself.
 *
 * {@link PageEvidenceFormat.AdguardMarkers}: the AdGuard proxy switches every developer-mode flag
 * on, so its cosmetic filtering reports itself: every element-hiding rule marks what it hides with
 * `content: 'adguard<list>;<rule>'`, and the content script the proxy injects lists every script
 * rule it runs with its text. The content script also logs its hits to the page console, but the
 * stealth browser passes no page console message to the run at all, so the report is read where it
 * lands: the markers on the elements of every frame, and the content-script bodies the page loads.
 */
import type { Frame, Page, Response } from 'playwright-core';
import type { Logger } from '../logger/logger';
import type { PageEvidence } from './blocker-contract';

/**
 * The `type` a content-script request carries to the injections host.
 */
const CONTENT_SCRIPT_REQUEST_TYPE = 'content-script';

/**
 * The query parameter naming the frame a content script was requested for.
 */
const FRAME_URL_PARAMETER = 'url';

/**
 * Prefix of the element-hiding marker, the content script's own `CONTENT_ATTR_PREFIX`.
 */
const HIDING_MARKER_PREFIX = 'adguard';

/**
 * One decoded marker: the list number before the first `;`, then the rule text.
 */
const DECODED_MARKER = /^adguard-?\d+;(?<rule>.+)$/su;

/**
 * One script entry of a content script, as jsfilter serializes it: the rule text as a JSON string,
 * the list number, then the wrapped script.
 */
const SCRIPT_ENTRY =
    /\{ruleText:(?<text>"(?:[^"\\]|\\.)*"),filterId:(?<list>-?\d+),func:\(function\(api\)\{/gu;

/**
 * The list number of the script the proxy adds on its own (its stealth script), not a rule.
 */
const PROXY_OWN_SCRIPT_LIST = '-1';

/**
 * How long one frame may take to answer the marker scan. A frame busy with its own script must not
 * hold the whole read; the frames that answer still report.
 */
const FRAME_SCAN_TIMEOUT_MS = 5_000;

/**
 * One script rule the proxy injected into a frame.
 */
export interface InjectedScript {
    /**
     * The rule text.
     */
    rule: string;

    /**
     * The frame it was injected into.
     */
    frameUrl: string;
}

/**
 * One element an element-hiding rule hides.
 */
export interface HiddenElement {
    /**
     * The rule text the marker names. Page-authored: a page can write the same marker itself.
     */
    rule: string;

    /**
     * Tag, id and classes of the element.
     */
    element: string;
}

/**
 * One marked element as the frame scan returns it, still encoded.
 */
interface MarkedElement {
    /**
     * The element's computed `content`, quotes included.
     */
    marker: string;

    /**
     * Tag, id and classes of the element.
     */
    element: string;
}

/**
 * One element as the frame scan sees it.
 */
interface ScannedElement {
    /**
     * Upper-case tag name.
     */
    tagName: string;

    /**
     * The element id, empty when it has none.
     */
    id: string;

    /**
     * The class attribute; not a string on SVG elements.
     */
    className: unknown;
}

/**
 * The part of an element's computed style the frame scan reads.
 */
interface ComputedContent {
    /**
     * The computed `content`; a string value keeps its quotes.
     */
    content: string;
}

/**
 * The page globals the frame scan reads.
 */
interface ScannedPage {
    /**
     * The frame's document.
     */
    document: {
        /**
         * Every element of the document.
         *
         * @param selector - `*`.
         * @returns The elements.
         */
        querySelectorAll(selector: string): ArrayLike<ScannedElement>;
    };

    /**
     * Computed style of one element.
     *
     * @param element - The element.
     * @returns Its computed style; only `content` is read.
     */
    getComputedStyle(element: ScannedElement): ComputedContent;
}

/**
 * What the proxy reported inside the session's pages.
 */
export interface PageReports {
    /**
     * Script rules injected into the session's frames since the watch started.
     *
     * @returns Every injection, in load order.
     */
    injectedScripts(): Promise<InjectedScript[]>;

    /**
     * Elements an element-hiding rule hides in the session's frames right now.
     *
     * @returns Every marked element.
     */
    hiddenElements(): Promise<HiddenElement[]>;
}

/**
 * Collect every element whose computed `content` carries the hiding marker. Runs inside a frame, so
 * it stays self-contained: no helper functions, nothing from this module's scope.
 *
 * @param prefix - The marker prefix.
 * @returns The marked elements.
 */
function scanMarkedElements(prefix: string): MarkedElement[] {
    const page = globalThis as unknown as ScannedPage;
    const marked: MarkedElement[] = [];
    for (const element of Array.from(page.document.querySelectorAll('*'))) {
        const marker = page.getComputedStyle(element).content;
        // A string value computes to its quoted form, so the prefix follows the quote.
        if (!marker.slice(1).startsWith(prefix)) {
            continue;
        }
        const classes =
            typeof element.className === 'string'
                ? element.className
                      .split(/\s+/u)
                      .filter((name) => name.length > 0)
                      .map((name) => `.${name}`)
                      .join('')
                : '';
        const id = element.id.length > 0 ? `#${element.id}` : '';
        marked.push({ marker, element: `${element.tagName.toLowerCase()}${id}${classes}` });
    }
    return marked;
}

/**
 * The rule a marker names, or nothing when the marker is not one the proxy writes.
 *
 * @param marker - The computed `content`, quotes included.
 * @returns The rule text.
 */
function markedRule(marker: string): string | undefined {
    let decoded: string;
    try {
        decoded = decodeURIComponent(marker.slice(1, -1));
    } catch (error) {
        // The proxy encodes every marker it writes; a malformed one was written by the page.
        if (error instanceof URIError) {
            return undefined;
        }
        throw error;
    }
    return DECODED_MARKER.exec(decoded)?.groups?.['rule'];
}

/**
 * The script rules one content-script body injects.
 *
 * @param body - The content script as the proxy served it.
 * @param frameUrl - The frame it was served for.
 * @returns Its rules, the proxy's own script left out.
 */
function scriptsIn(body: string, frameUrl: string): InjectedScript[] {
    return [...body.matchAll(SCRIPT_ENTRY)]
        .filter((entry) => entry.groups!['list'] !== PROXY_OWN_SCRIPT_LIST)
        .map((entry) => ({ rule: JSON.parse(entry.groups!['text']!) as string, frameUrl }));
}

/**
 * Scan one frame for marked elements, within the frame budget.
 *
 * @param frame - The frame.
 * @param logger - Run logger for a frame that could not be scanned.
 * @returns The frame's marked elements; none when it could not be scanned.
 */
async function scanFrame(frame: Frame, logger: Logger): Promise<MarkedElement[]> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            frame.evaluate(scanMarkedElements, HIDING_MARKER_PREFIX),
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                    reject(new Error(`no answer within ${FRAME_SCAN_TIMEOUT_MS} ms`));
                }, FRAME_SCAN_TIMEOUT_MS);
            }),
        ]);
    } catch (error) {
        logger.warn(
            { err: error, frameUrl: frame.url() },
            'a frame could not be scanned for element-hiding markers',
        );
        return [];
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Start watching what the blocker reports inside one session's pages. Call it before the session
 * navigates: a content script served earlier is not seen.
 *
 * @param page - The session's page.
 * @param evidence - Where the blocker serves its content scripts.
 * @param logger - Run logger for what could not be read.
 * @returns The session's page reports.
 */
export function watchPageEvidence(page: Page, evidence: PageEvidence, logger: Logger): PageReports {
    const injections: Array<Promise<InjectedScript[]>> = [];
    page.on('response', (response: Response) => {
        const url = new URL(response.url());
        if (
            url.hostname !== evidence.contentScriptHost ||
            url.searchParams.get('type') !== CONTENT_SCRIPT_REQUEST_TYPE
        ) {
            return;
        }
        const frameUrl = url.searchParams.get(FRAME_URL_PARAMETER) ?? '';
        injections.push(
            response.text().then(
                (body) => scriptsIn(body, frameUrl),
                (error: unknown) => {
                    logger.warn(
                        { err: error, contentScriptUrl: response.url() },
                        'a blocker content script body could not be read',
                    );
                    return [];
                },
            ),
        );
    });
    return {
        injectedScripts: async () => (await Promise.all(injections)).flat(),
        hiddenElements: async () => {
            const scans = await Promise.all(page.frames().map((frame) => scanFrame(frame, logger)));
            return scans.flat().flatMap(({ marker, element }) => {
                const rule = markedRule(marker);
                return rule === undefined ? [] : [{ rule, element }];
            });
        },
    };
}
