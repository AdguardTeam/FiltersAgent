/**
 * The `inspect_page_state` vocabulary: the model-facing result shape of the bounded page-state
 * probe, and the snapshot shape the probe's own fixed isolated-world expression returns.
 */

/**
 * One storage entry as the fixed probe expression reports it.
 */
export interface StorageEntry {
    /**
     * Page-authored storage key.
     */
    key: string;

    /**
     * The stored value in full, or null when the page withheld it for exceeding the collection
     * ceiling.
     */
    value: string | null;

    /**
     * Length of the stored value in characters, reported even for a withheld value.
     */
    valueLength: number;
}

/**
 * One storage area as the page reported it: bounded entries, the area's real key count, and the
 * access error when the origin refused the read.
 */
export interface StorageAreaSnapshot {
    /**
     * Entries kept after the expression's own per-area entry cap, in the area's key order.
     */
    entries: StorageEntry[];

    /**
     * Keys the area holds, before that cap.
     */
    totalKeyCount: number;

    /**
     * Why the area could not be read, null when the read succeeded.
     */
    error: string | null;
}

/**
 * Both storage areas as the fixed isolated-world expression returns them.
 */
export interface PageStateStorageSnapshot {
    /**
     * The page origin's localStorage.
     */
    localStorage: StorageAreaSnapshot;

    /**
     * The page origin's sessionStorage.
     */
    sessionStorage: StorageAreaSnapshot;
}

/**
 * One cookie's identity and flags. The cookie's value is never collected, so it cannot be returned.
 */
export interface CookieSummary {
    /**
     * Cookie name.
     */
    name: string;

    /**
     * Domain the cookie is scoped to.
     */
    domain: string;

    /**
     * Path the cookie is scoped to.
     */
    path: string;

    /**
     * Whether the cookie is hidden from page scripts.
     */
    httpOnly: boolean;

    /**
     * Whether the cookie is sent only over HTTPS.
     */
    secure: boolean;

    /**
     * The cookie's SameSite policy as the browser reports it.
     */
    sameSite: string;

    /**
     * Whether the cookie expires with the session rather than at a stored date.
     */
    session: boolean;
}

/**
 * One frame of the page, including every iframe.
 */
export interface FrameSummary {
    /**
     * Frame URL, with sensitive query parameters redacted.
     */
    url: string;

    /**
     * Frame name attribute, empty when the frame is unnamed.
     */
    name: string;

    /**
     * URL of the parent frame, absent for the main frame.
     */
    parentUrl?: string;
}

/**
 * How much of one section the page held against how much the result carries.
 */
export interface PageStateSectionCount {
    /**
     * Entries the page holds.
     */
    total: number;

    /**
     * Entries the result carries after the entry caps and the byte budget.
     */
    returned: number;
}

/**
 * Per-section totals of the inspected page state.
 */
export interface PageStateCounts {
    /**
     * Cookie counts.
     */
    cookies: PageStateSectionCount;

    /**
     * LocalStorage key counts.
     */
    localStorage: PageStateSectionCount;

    /**
     * SessionStorage key counts.
     */
    sessionStorage: PageStateSectionCount;

    /**
     * Frame counts.
     */
    frames: PageStateSectionCount;
}

/**
 * The bounded, redacted page-state result returned to the model.
 */
export interface PageStateInspection {
    /**
     * Cookie identities and flags; values are never collected.
     */
    cookies: CookieSummary[];

    /**
     * LocalStorage keys with redacted, truncated values.
     */
    localStorage: Record<string, string>;

    /**
     * SessionStorage keys with redacted, truncated values.
     */
    sessionStorage: Record<string, string>;

    /**
     * Frame inventory in document order, main frame first.
     */
    frames: FrameSummary[];

    /**
     * Totals against returned entries for every section.
     */
    counts: PageStateCounts;

    /**
     * Whether any section returned fewer entries than the page holds.
     */
    truncated: boolean;

    /**
     * Why the result is short, present only when it is.
     */
    notice?: string;

    /**
     * Why a storage area could not be read, keyed by area name, present only when one failed.
     */
    storageErrors?: Record<string, string>;
}
