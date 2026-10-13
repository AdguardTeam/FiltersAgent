/**
 * The `inspect_page_state` probe: one bounded, redacted read of the page state a filter rule can
 * depend on — cookie identities (never their values), localStorage and sessionStorage keys with
 * redacted values, and the frame inventory. It is the single successor of the removed
 * get_cookies/get_storage/get_frames trio and the only path to those APIs, because the general
 * `evaluate_js` validator rejects cookie and storage access outright while the product still ships
 * storage-backed rule families (`set-local-storage-item` and its siblings).
 *
 * Collection and redaction live here; the result's byte budget lives in `page-state-budget.ts` and
 * its shape in `types/page-state-inspection.ts`.
 */
import type { Page } from 'playwright-core';
import { redactSensitiveText, redactStorageValues } from './har-redactor';
import { createTrustedPageEvaluator } from './trusted-page-evaluator';
import { fillWithinBudget } from './page-state-budget';
import type {
    CookieSummary,
    FrameSummary,
    PageStateInspection,
    PageStateStorageSnapshot,
    StorageAreaSnapshot,
} from '../types/page-state-inspection';

/**
 * Maximum cookies returned for one page.
 *
 * The rule-relevant cookies are the consent/CMP decision, the paywall or session marker, and the
 * anti-adblock flag — a handful. A site that sets hundreds is enumerating analytics identifiers,
 * which this probe has no business listing for the model. 40 covers every real case and keeps the
 * section a bounded share of the result budget.
 */
const MAX_COOKIE_ENTRIES = 40;

/**
 * Maximum keys read from one storage area (localStorage, sessionStorage).
 *
 * A storage-backed rule targets one key; a consent check reads one or two. 40 per area is generous
 * for that job while bounding both the in-page loop and the bytes crossing the CDP boundary on a
 * site that keeps hundreds of cache entries.
 */
const MAX_STORAGE_ENTRIES_PER_AREA = 40;

/**
 * Maximum frames described in the inventory.
 *
 * An ad-heavy page runs a few dozen iframes; the inventory exists to name the frame a rule must be
 * scoped to, not to catalogue every creative. 20 keeps the main frame plus the significant children
 * while stopping an ad chain that spawns hundreds of nested slots from owning the result.
 */
const MAX_FRAME_ENTRIES = 20;

/**
 * Ceiling on one identifier string returned to the model (cookie name, domain, path; frame name and
 * URL; storage key), in characters.
 *
 * Real identifiers are far shorter, but a page mints them freely, and every one of these strings is
 * untrusted page content pasted into the model's context. A string cut here keeps its recognizable
 * head and is marked with an ellipsis, so a truncated key can never be mistaken for a verbatim one
 * usable in a rule.
 */
const MAX_STATE_IDENTIFIER_CHARS = 256;

/**
 * Ceiling on one storage value returned to the model, in characters.
 *
 * The probe's purpose is key names and short flags: a persistence check reads a boolean, a
 * `set-local-storage-item` rule needs the key and a small value. 200 characters keeps every real
 * flag intact while collapsing data caches — a streaming site can cache its entire movie catalog in
 * localStorage, and one untruncated 5.9 MB dump overflows the model's context in a single turn.
 */
const MAX_STORAGE_VALUE_CHARS = 200;

/**
 * Ceiling on a storage value the page is allowed to hand back at all, in characters.
 *
 * Above it the value is dropped whole in the page and only its length is reported. Dropping beats
 * truncating in the page for two reasons: the 5.9 MB catalog never crosses the CDP boundary, and
 * redaction still sees in full every value it does inspect — `redactStorageValues` matches an
 * anchored JWT pattern, so a value pre-cut in the page could smuggle a partial token past it.
 * 20,000 characters is orders of magnitude above any flag and far below a cache entry.
 */
const MAX_COLLECTED_STORAGE_VALUE_CHARS = 20_000;

/**
 * Remove C0, DEL and C1 control characters from an untrusted identifier.
 *
 * Cookie names, storage keys and frame names are page-authored text pasted straight into the
 * model's context; control characters carry no rule-relevant meaning there and are exactly what a
 * page would use to smuggle framing into a tool result.
 *
 * @param value - Raw page-authored text.
 * @returns The text without control characters.
 */
function stripControlCharacters(value: string): string {
    let stripped = '';
    for (const character of value) {
        const code = character.codePointAt(0) ?? 0;
        if (code > 0x1f && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)) {
            stripped += character;
        }
    }
    return stripped;
}

/**
 * Fixed, no-argument storage read executed in a browser isolated world.
 *
 * Runs outside the site's main world so a page that monkeypatched `localStorage.getItem` cannot
 * choose what the agent sees. Each area is read defensively: an origin that denies storage access
 * (sandboxed document, blocked third-party storage) reports its error instead of failing the
 * probe.
 */
const PAGE_STATE_STORAGE_EXPRESSION = `
(function () {
    'use strict';

    const MAX_ENTRIES = ${MAX_STORAGE_ENTRIES_PER_AREA};
    const MAX_VALUE_CHARS = ${MAX_COLLECTED_STORAGE_VALUE_CHARS};

    const readArea = function (name) {
        try {
            const area = window[name];
            const totalKeyCount = area.length;
            const entries = [];
            for (let index = 0; index < totalKeyCount && entries.length < MAX_ENTRIES; index++) {
                const key = area.key(index);
                if (key === null) {
                    continue;
                }
                const raw = area.getItem(key);
                const text = raw === null ? '' : String(raw);
                entries.push({
                    key: String(key),
                    value: text.length > MAX_VALUE_CHARS ? null : text,
                    valueLength: text.length,
                });
            }
            return { entries: entries, totalKeyCount: totalKeyCount, error: null };
        } catch (error) {
            return {
                entries: [],
                totalKeyCount: 0,
                error: String((error && error.message) || error),
            };
        }
    };

    return {
        localStorage: readArea('localStorage'),
        sessionStorage: readArea('sessionStorage'),
    };
})()
`;

/**
 * The marker replacing a storage value the page was not asked to hand over, for its size.
 *
 * @param length - Length of the omitted value in characters.
 * @returns The model-facing marker.
 */
function omittedValueMarker(length: number): string {
    return `[omitted: ${length} chars]`;
}

/**
 * Cut an untrusted page identifier to the model-facing ceiling and strip control characters.
 *
 * @param value - Raw identifier read from the page or the browser.
 * @returns Bounded, control-character-free identifier, marked when it was cut.
 */
function boundedIdentifier(value: string): string {
    const stripped = stripControlCharacters(value);
    return stripped.length > MAX_STATE_IDENTIFIER_CHARS
        ? `${stripped.slice(0, MAX_STATE_IDENTIFIER_CHARS)}…`
        : stripped;
}

/**
 * Apply the model-facing value ceiling to one already-redacted storage value.
 *
 * Runs after redaction on purpose: `redactStorageValues` matches an anchored JWT pattern, so it has
 * to see the complete value first.
 *
 * @param value - Redacted storage value.
 * @returns The value, cut to the ceiling and marked when it was cut.
 */
function boundedStorageValue(value: string): string {
    if (value.length <= MAX_STORAGE_VALUE_CHARS) {
        return value;
    }
    const omitted = value.length - MAX_STORAGE_VALUE_CHARS;
    return `${value.slice(0, MAX_STORAGE_VALUE_CHARS)}… [truncated ${omitted} more chars]`;
}

/**
 * Redact one storage value under its own key.
 *
 * The key drives the decision — `redactStorageValues` matches it against the sensitive-key patterns
 * — so the pair travels together through a prototype-free record; a page key that cannot become an
 * own property (`__proto__`) then yields no value rather than corrupting one.
 *
 * @param key - Page-authored storage key.
 * @param value - Complete storage value as the page returned it.
 * @returns The redacted value.
 */
function redactStorageValue(key: string, value: string): string {
    const pair: Record<string, string> = Object.create(null);
    pair[key] = value;
    const [redacted = ''] = Object.values(redactStorageValues(pair));
    return redacted;
}

/**
 * One collected section of page state: the capped entries plus the total the page holds.
 */
interface CollectedSection<T> {
    /**
     * Entries kept after the section's entry cap.
     */
    entries: T[];

    /**
     * Entries the page holds, before any cap.
     */
    total: number;
}

/**
 * Redact and bound one storage area's entries into ordered key/value pairs.
 *
 * @param area - Parsed area snapshot from the page.
 * @returns Ordered pairs whose keys are bounded and whose values are redacted, then truncated.
 */
function boundedStorageEntries(area: StorageAreaSnapshot): [string, string][] {
    return area.entries.map((entry) => {
        const value =
            entry.value === null
                ? omittedValueMarker(entry.valueLength)
                : boundedStorageValue(redactStorageValue(entry.key, entry.value));
        return [boundedIdentifier(entry.key), value];
    });
}

/**
 * Collect the cookie identities of the page's browser context, without their values.
 *
 * @param page - The active page.
 * @returns Capped cookie summaries and the context's cookie total.
 */
async function collectCookies(page: Page): Promise<CollectedSection<CookieSummary>> {
    const cookies = await page.context().cookies();
    return {
        total: cookies.length,
        entries: cookies.slice(0, MAX_COOKIE_ENTRIES).map((cookie) => ({
            name: boundedIdentifier(cookie.name),
            domain: boundedIdentifier(cookie.domain),
            path: boundedIdentifier(cookie.path),
            httpOnly: cookie.httpOnly,
            secure: cookie.secure,
            sameSite: cookie.sameSite,
            // Playwright reports a session cookie's expiry as -1; anything else is a stored date.
            session: cookie.expires === -1,
        })),
    };
}

/**
 * Collect the page's frame inventory with redacted URLs.
 *
 * @param page - The active page.
 * @returns Capped frame summaries and the page's frame total.
 */
function collectFrames(page: Page): CollectedSection<FrameSummary> {
    const frames = page.frames();
    return {
        total: frames.length,
        entries: frames.slice(0, MAX_FRAME_ENTRIES).map((frame) => {
            const parentUrl = frame.parentFrame()?.url();
            return {
                url: boundedIdentifier(redactSensitiveText(frame.url())),
                name: boundedIdentifier(frame.name()),
                ...(parentUrl === undefined
                    ? {}
                    : { parentUrl: boundedIdentifier(redactSensitiveText(parentUrl)) }),
            };
        }),
    };
}

/**
 * Read the page's storage areas through the fixed isolated-world expression.
 *
 * The shape is this module's own: {@link PAGE_STATE_STORAGE_EXPRESSION} is a fixed literal, every
 * one of its branches returns the same record, and a page that denies storage access is already
 * caught in-page into `error`. Only the key and value strings are page-authored, and nothing
 * downstream believes anything about them. So the snapshot is cast rather than re-validated: a
 * shape that does not match could only be a bug in the expression, and that must fail loudly here
 * instead of being reported to the model as if the origin had refused the read.
 *
 * @param page - The active page.
 * @returns The snapshot as the expression returned it.
 */
async function collectStorage(page: Page): Promise<PageStateStorageSnapshot> {
    const evaluator = await createTrustedPageEvaluator(page);
    return (await evaluator.evaluate(PAGE_STATE_STORAGE_EXPRESSION)) as PageStateStorageSnapshot;
}

/**
 * Inspect the active page's cookies, storage and frames in one bounded, redacted result.
 *
 * Cookie values are never collected. Storage values pass through `redactStorageValues` — sensitive
 * keys and JWT-looking values become `[redacted]` — before they are cut to
 * {@link MAX_STORAGE_VALUE_CHARS}. Every section is capped by entry count and the whole result by
 * the budget, with the counts reporting what the page actually held.
 *
 * @param page - The active page of the live browser session.
 * @returns The bounded page-state result.
 */
export async function inspectPageState(page: Page): Promise<PageStateInspection> {
    const [cookies, storage] = await Promise.all([collectCookies(page), collectStorage(page)]);
    const frames = collectFrames(page);
    const storageErrors: Record<string, string> = {};
    if (storage.localStorage.error !== null) {
        storageErrors.localStorage = boundedIdentifier(storage.localStorage.error);
    }
    if (storage.sessionStorage.error !== null) {
        storageErrors.sessionStorage = boundedIdentifier(storage.sessionStorage.error);
    }
    return fillWithinBudget({
        cookies: cookies.entries,
        localStorage: boundedStorageEntries(storage.localStorage),
        sessionStorage: boundedStorageEntries(storage.sessionStorage),
        frames: frames.entries,
        totals: {
            cookies: cookies.total,
            localStorage: storage.localStorage.totalKeyCount,
            sessionStorage: storage.sessionStorage.totalKeyCount,
            frames: frames.total,
        },
        storageErrors,
    });
}
