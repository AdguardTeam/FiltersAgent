import type { FinishFixValidationRejection } from '../types/terminal-rejection';

/**
 * The identity of one terminal rejection for the terminal tool's same-reason streak.
 *
 * The streak caps a model that resubmits `finish_fix` into the same wall, and "the same wall" has
 * to follow the evidence, not the prose: a rejection's text is word-for-word identical whether or
 * not the model did the browser work it asks for in between. A text-keyed streak seals a run after
 * three same-text rejections even when the model closed its session, launched a fresh
 * `reported_on_current` one and revalidated the candidate between every two of them. What changes
 * when the model makes progress is the requirement's counters and statuses; what changes when it
 * merely repeats itself is session ids, ordinals and artifact ids. The fingerprint keeps the former
 * and drops the latter along with every prose field, so equal fingerprints mean equal progress.
 */

/**
 * Keys whose values never describe progress: prose the model reads, and identities that change on
 * every launch even when nothing else does.
 */
const VOLATILE_KEYS: ReadonlySet<string> = new Set([
    'error',
    'guidance',
    'requiredTools',
    'sessionId',
    'sessionOrdinal',
    'currentSessionId',
    'targetUrl',
]);

/**
 * Keys naming artifact ids (`artifactId`, `missingArtifactIds`, ...): a fresh capture mints fresh
 * ids for the same coverage, so ids are volatile while the counts beside them are progress.
 */
const ARTIFACT_ID_KEY_PATTERN = /artifactids?$/iu;

/**
 * Order items by a string key, so equal sets render identically regardless of the order the
 * producer emitted them in. `Array.prototype.sort` is stable, so items with equal keys keep their
 * relative order.
 *
 * @param items - Items to order.
 * @param keyOf - Sort key of one item.
 * @returns The items in ascending key order.
 */
function orderedItems<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
    return [...items].sort((first, second) => keyOf(first).localeCompare(keyOf(second)));
}

/**
 * Canonical progress value of one rejection field: volatile fields vanish, arrays and objects are
 * ordered, scalars pass through.
 *
 * @param value - The field value.
 * @param key - The field's key, when it sits in an object.
 * @returns The canonical value, or `undefined` for a volatile field.
 */
function progressValue(value: unknown, key?: string): unknown {
    if (key !== undefined && (VOLATILE_KEYS.has(key) || ARTIFACT_ID_KEY_PATTERN.test(key))) {
        return undefined;
    }
    if (Array.isArray(value)) {
        return orderedItems(
            value.map((item) => progressValue(item)).filter((item) => item !== undefined),
            (item) => JSON.stringify(item),
        );
    }
    if (typeof value !== 'object' || value === null) {
        return value;
    }
    return Object.fromEntries(
        orderedItems(
            Object.entries(value)
                .map(([entryKey, entryValue]) => [entryKey, progressValue(entryValue, entryKey)])
                .filter((entry) => entry[1] !== undefined),
            ([entryKey]) => String(entryKey),
        ),
    );
}

/**
 * Fingerprint one terminal rejection by its progress snapshot.
 *
 * @param rejection - The structured host rejection.
 * @returns A string equal for two rejections that describe the same evidence progress.
 */
export function terminalRejectionFingerprint(rejection: FinishFixValidationRejection): string {
    return JSON.stringify(progressValue(rejection));
}
