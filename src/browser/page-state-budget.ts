/**
 * The byte budget of the `inspect_page_state` result: the ceiling itself and the round-robin
 * admission that fills cookies, both storage areas and the frame inventory into it, so that one
 * call can never approach the session's tool-result ceiling and the counts stay honest about what
 * the page held.
 */
import { MAX_TOOL_RESULT_BYTES } from '../pi/tool-result-envelope';
import type {
    CookieSummary,
    FrameSummary,
    PageStateCounts,
    PageStateInspection,
} from '../types/page-state-inspection';

/**
 * Ceiling on the complete serialized `inspect_page_state` result, in UTF-8 bytes.
 *
 * The session envelope cuts any tool result above {@link MAX_TOOL_RESULT_BYTES}, and a cut state
 * probe is strictly worse than a smaller one: the model would receive a severed JSON body instead
 * of honest counts. Half of that ceiling is a chosen share, not the cost of the probe's entry caps
 * at their worst: those caps — 40 cookies, 40 keys per storage area, 20 frames — do not fit inside
 * it once their identifiers approach the 256-character cut, since 40 such cookies alone serialize
 * to roughly 34 KB and the fully capped worst case to roughly 86 KB. So the entry caps decide how
 * much of a page comes back only while its identifiers stay well under that cut, which is every
 * real page; above it this budget binds first and the counts stay honest about what was dropped. A
 * smaller share would start dropping entries on ordinary pages; a larger one would let the probe
 * become the call that trips the envelope.
 */
export const MAX_PAGE_STATE_RESULT_BYTES = MAX_TOOL_RESULT_BYTES / 2;

/**
 * JSON bytes reserved for the separator between two admitted entries.
 */
const ENTRY_SEPARATOR_BYTES = 1;

/**
 * The notice carried by a result whose sections did not all fit.
 */
const TRUNCATION_NOTICE =
    'Page state exceeded the probe budget; counts report the totals against what was returned.';

/**
 * One section's admission state while the result is filled against the byte budget.
 */
interface SectionAdmission<T> {
    /**
     * Candidate entries in page order.
     */
    candidates: readonly T[];

    /**
     * Entries admitted so far; always a prefix of the candidates.
     */
    admitted: T[];

    /**
     * Whether the section stopped admitting because its next entry did not fit.
     */
    closed: boolean;
}

/**
 * The sections of a page-state result before the byte budget is applied.
 */
export interface PageStateCandidates {
    /**
     * Cookie candidates, already capped by the probe's entry cap.
     */
    cookies: CookieSummary[];

    /**
     * LocalStorage pairs, already capped by the probe's entry cap.
     */
    localStorage: [string, string][];

    /**
     * SessionStorage pairs, already capped by the probe's entry cap.
     */
    sessionStorage: [string, string][];

    /**
     * Frame candidates, already capped by the probe's entry cap.
     */
    frames: FrameSummary[];

    /**
     * Section totals as the page holds them, before any cap.
     */
    totals: Record<keyof PageStateCounts, number>;

    /**
     * Per-area storage read errors, empty when both areas were readable.
     */
    storageErrors: Record<string, string>;
}

/**
 * The byte budget still available to the sections being filled.
 */
interface RemainingBudget {
    /**
     * Bytes left before the result reaches its ceiling; decremented as entries are admitted.
     */
    bytes: number;
}

/**
 * Open one section's admission state.
 *
 * @param candidates - Candidate entries in page order.
 * @returns The section's admission state.
 */
function openSection<T>(candidates: readonly T[]): SectionAdmission<T> {
    return { candidates, admitted: [], closed: false };
}

/**
 * Admit one section's next entry when the remaining byte budget covers it.
 *
 * @param section - The section's admission state, mutated in place.
 * @param remaining - Remaining byte budget, decremented in place when an entry is admitted.
 * @returns Whether an entry was admitted.
 */
function admitNextEntry<T>(section: SectionAdmission<T>, remaining: RemainingBudget): boolean {
    if (section.closed) {
        return false;
    }
    const entry = section.candidates[section.admitted.length];
    if (entry === undefined) {
        section.closed = true;
        return false;
    }
    const cost = Buffer.byteLength(JSON.stringify(entry)) + ENTRY_SEPARATOR_BYTES;
    if (cost > remaining.bytes) {
        section.closed = true;
        return false;
    }
    remaining.bytes -= cost;
    section.admitted.push(entry);
    return true;
}

/**
 * Measure the result envelope the admitted entries have to fit inside.
 *
 * Measured with every count at its page total and the notice present, so the shell can only
 * over-state what the finished result serializes to — never under-state it.
 *
 * @param candidates - The capped candidate sections and their page totals.
 * @returns Serialized byte length of the empty result envelope.
 */
function shellBytes(candidates: PageStateCandidates): number {
    const counts: PageStateCounts = {
        cookies: { total: candidates.totals.cookies, returned: candidates.totals.cookies },
        localStorage: {
            total: candidates.totals.localStorage,
            returned: candidates.totals.localStorage,
        },
        sessionStorage: {
            total: candidates.totals.sessionStorage,
            returned: candidates.totals.sessionStorage,
        },
        frames: { total: candidates.totals.frames, returned: candidates.totals.frames },
    };
    const shell: PageStateInspection = {
        cookies: [],
        localStorage: {},
        sessionStorage: {},
        frames: [],
        counts,
        truncated: true,
        notice: TRUNCATION_NOTICE,
        ...(Object.keys(candidates.storageErrors).length > 0
            ? { storageErrors: candidates.storageErrors }
            : {}),
    };
    return Buffer.byteLength(JSON.stringify(shell));
}

/**
 * Fill the result from the candidates round-robin until the byte budget is exhausted.
 *
 * Round-robin rather than section after section: a page with forty cookies must not be able to
 * starve the storage keys a rule is actually written against.
 *
 * @param candidates - The capped candidate sections and their page totals.
 * @returns The bounded result, whose serialization stays within
 *   {@link MAX_PAGE_STATE_RESULT_BYTES}.
 */
export function fillWithinBudget(candidates: PageStateCandidates): PageStateInspection {
    const sections = {
        frames: openSection(candidates.frames),
        cookies: openSection(candidates.cookies),
        localStorage: openSection(candidates.localStorage),
        sessionStorage: openSection(candidates.sessionStorage),
    };
    const remaining: RemainingBudget = {
        bytes: MAX_PAGE_STATE_RESULT_BYTES - shellBytes(candidates),
    };
    let admitting = true;
    while (admitting) {
        admitting = [
            admitNextEntry(sections.frames, remaining),
            admitNextEntry(sections.cookies, remaining),
            admitNextEntry(sections.localStorage, remaining),
            admitNextEntry(sections.sessionStorage, remaining),
        ].includes(true);
    }
    const counts: PageStateCounts = {
        cookies: { total: candidates.totals.cookies, returned: sections.cookies.admitted.length },
        localStorage: {
            total: candidates.totals.localStorage,
            returned: sections.localStorage.admitted.length,
        },
        sessionStorage: {
            total: candidates.totals.sessionStorage,
            returned: sections.sessionStorage.admitted.length,
        },
        frames: { total: candidates.totals.frames, returned: sections.frames.admitted.length },
    };
    const truncated = Object.values(counts).some((count) => count.returned < count.total);
    return {
        cookies: sections.cookies.admitted,
        localStorage: Object.fromEntries(sections.localStorage.admitted),
        sessionStorage: Object.fromEntries(sections.sessionStorage.admitted),
        frames: sections.frames.admitted,
        counts,
        truncated,
        ...(truncated ? { notice: TRUNCATION_NOTICE } : {}),
        ...(Object.keys(candidates.storageErrors).length > 0
            ? { storageErrors: candidates.storageErrors }
            : {}),
    };
}
