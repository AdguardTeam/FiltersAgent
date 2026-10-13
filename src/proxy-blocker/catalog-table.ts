/**
 * Finite reason a complete `filters list --all` output could not be read as a catalog table.
 *
 * Every member is a statement about the _output format_, never about which filters the caller
 * wanted: catalog membership, titles, group names and surrounding notices belong to upstream and
 * are free to change, so a consumer decides those for itself on the rows returned here.
 */
export type ProxyBlockerFilterListRejection =
    | 'ansi_wrapper_unsupported'
    | 'table_header_absent'
    | 'enabled_row_unreadable'
    | 'duplicate_catalog_id';

/**
 * Parsed catalog row from one complete native list.
 */
export interface ProxyBlockerCatalogRow {
    /**
     * Numeric catalog ID; the built-in user filter uses a negative pseudo-ID.
     */
    id: number;
    /**
     * Observed catalog title without the volatile last-update column.
     */
    title: string;
    /**
     * Observed last-update column exactly as displayed.
     */
    status: string;
    /**
     * Whether the catalog row is installed.
     */
    installed: boolean;
    /**
     * Native enabled checkbox state.
     */
    enabled: boolean;
}

/**
 * Everything one complete native list carried: readable rows and diagnosable remainder alike.
 */
export interface ProxyBlockerFilterListReading {
    /**
     * Every readable catalog row, in displayed order.
     */
    rows: readonly ProxyBlockerCatalogRow[];
    /**
     * Disabled or absent rows the contract could not read, retained for diagnosis.
     */
    unreadableRows: readonly string[];
    /**
     * Non-row output around the table, retained for diagnosis.
     */
    surroundingLines: readonly string[];
}

/**
 * The last-update column forms the pinned v1.4.13 list displays instead of an instant.
 *
 * Exported so a host that reproduces the native listing renders exactly the forms this contract
 * reads back.
 */
export const CATALOG_STATUS_FORMS = Object.freeze({
    notAdded: 'Filter is not added',
    disabled: 'Filter is disabled',
} as const);

/**
 * Exact displayed form of an enabled row's last-update instant.
 */
const CATALOG_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u;

/**
 * Character count of that displayed instant.
 */
const CATALOG_TIMESTAMP_LENGTH = 19;

/**
 * Prefix shared by every table row: the three-character state marker and the column separator.
 */
const CATALOG_ROW_PREFIX = /^(\[x\]|\[ \]| {3}) \| /u;

/**
 * Structural shape of one table row with no pinned column widths.
 */
const CATALOG_ROW_PATTERN = /^(\[x\]|\[ \]| {3}) \| *(-?\d{1,18}) \| (.+)$/u;

/**
 * Header of the table, whose column widths are presentation and are never pinned.
 */
const CATALOG_HEADER_PATTERN = /^ *\| +ID +\| +Title +Last update *$/u;

/**
 * The ASCII escape introducing every SGR sequence the pinned source can emit.
 */
const ANSI_ESCAPE = String.fromCodePoint(0x1b);

/**
 * Exact opening bold wrapper emitted by the pinned v1.4.13 source.
 */
const BOLD_PREFIX = `${ANSI_ESCAPE}[1m`;

/**
 * Exact closing bold wrapper emitted by the pinned v1.4.13 source.
 */
const BOLD_SUFFIX = `${ANSI_ESCAPE}[0m`;

/**
 * One decoded source line and whether v1.4.13 wrapped it in bold ANSI SGR.
 */
interface DecodedFilterListLine {
    /**
     * Line content without the exact bold wrapper.
     */
    text: string;
    /**
     * Whether the exact source-emitted bold wrapper was present.
     */
    bold: boolean;
}

/**
 * Displayed title and last-update status read off one row's trailing columns.
 */
interface ParsedCatalogRowColumns {
    /**
     * Displayed title with its column padding removed.
     */
    title: string;
    /**
     * Displayed last-update status, exactly as the CLI rendered it.
     */
    status: string;
}

/**
 * Remove only the exact bold wrapper emitted by the pinned v1.4.13 source.
 *
 * @param line - One complete output line.
 * @param reject - Called with the finite reason and observed facts; must throw.
 * @returns Plain line text and exact bold status.
 */
function decodeFilterListLine(
    line: string,
    reject: (reason: ProxyBlockerFilterListRejection, observed: unknown) => never,
): DecodedFilterListLine {
    if (!line.includes(ANSI_ESCAPE)) {
        return { text: line, bold: false };
    }
    if (
        !line.startsWith(BOLD_PREFIX) ||
        !line.endsWith(BOLD_SUFFIX) ||
        line.length <= BOLD_PREFIX.length + BOLD_SUFFIX.length ||
        line.slice(BOLD_PREFIX.length, -BOLD_SUFFIX.length).includes(ANSI_ESCAPE)
    ) {
        reject('ansi_wrapper_unsupported', { line });
    }
    return { text: line.slice(BOLD_PREFIX.length, -BOLD_SUFFIX.length), bold: true };
}

/**
 * Split one row's trailing columns into the displayed title and the last-update status.
 *
 * The status column is recognized by its own three known forms rather than by a pinned character
 * offset, so a title column that widens or narrows with whatever the catalog currently holds cannot
 * be mistaken for a changed row contract.
 *
 * @param columns - Everything after the ID column separator.
 * @returns Title and status, or null when the row carries no recognizable status.
 */
function splitCatalogRowColumns(columns: string): ParsedCatalogRowColumns | null {
    const trimmed = columns.trimEnd();
    for (const status of Object.values(CATALOG_STATUS_FORMS)) {
        if (trimmed.endsWith(status)) {
            return { title: trimmed.slice(0, -status.length).trimEnd(), status };
        }
    }
    const timestamp = trimmed.slice(-CATALOG_TIMESTAMP_LENGTH);
    if (!CATALOG_TIMESTAMP_PATTERN.test(timestamp)) {
        return null;
    }
    return {
        title: trimmed.slice(0, -CATALOG_TIMESTAMP_LENGTH).trimEnd(),
        status: timestamp,
    };
}

/**
 * Parse one release-bound v1.4.13 catalog row.
 *
 * @param line - One non-bold native row.
 * @returns Parsed row, or null when the row does not carry the state contract.
 */
function parseCatalogRow(line: string): ProxyBlockerCatalogRow | null {
    const row = CATALOG_ROW_PATTERN.exec(line);
    if (!row) {
        return null;
    }
    const columns = splitCatalogRowColumns(row[3]);
    if (!columns || columns.title.length === 0) {
        return null;
    }
    const id = Number(row[2]);
    if (!Number.isSafeInteger(id)) {
        return null;
    }
    const marker = row[1];
    const statusMatchesMarker =
        (marker === '[x]' && CATALOG_TIMESTAMP_PATTERN.test(columns.status)) ||
        (marker === '[ ]' && columns.status === CATALOG_STATUS_FORMS.disabled) ||
        (marker === '   ' && columns.status === CATALOG_STATUS_FORMS.notAdded);
    if (!statusMatchesMarker) {
        return null;
    }
    return {
        id,
        title: columns.title,
        status: columns.status,
        installed: marker !== '   ',
        enabled: marker === '[x]',
    };
}

/**
 * Parse the complete bounded `filters list --all` output into readable catalog rows.
 *
 * What this refuses is deliberately narrow, because most of what the list shows belongs to upstream
 * and moves without notice: the catalog gains and loses filters, titles are renamed and localized,
 * column widths follow the widest current entry, groups are reordered, and the CLI may print
 * notices around the table. None of that is evidence about any filter under test, so none of it
 * fails a read. What does fail it are the cases where a caller would otherwise attribute filtering
 * to the wrong filter: an _enabled_ row the state contract cannot read, and a duplicate catalog
 * ID.
 *
 * The rejection callback is injected so each consumer keeps its own diagnostic-log call site and
 * its own public failure code without this module importing either.
 *
 * @param stdout - Complete bounded native list output.
 * @param reject - Called with the finite reason and observed facts; must throw.
 * @returns Every readable row plus the material a refusal would need.
 */
export function readProxyBlockerFilterList(
    stdout: string,
    reject: (reason: ProxyBlockerFilterListRejection, observed: unknown) => never,
): ProxyBlockerFilterListReading {
    const rows: ProxyBlockerCatalogRow[] = [];
    const ids = new Set<number>();
    const surroundingLines: string[] = [];
    const unreadableRows: string[] = [];
    const lines = stdout
        .split('\n')
        .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
    if (lines.at(-1) === '') {
        lines.pop();
    }
    const decoded = lines.map((line) => decodeFilterListLine(line, reject));
    const headerIndex = decoded.findIndex((line) => CATALOG_HEADER_PATTERN.test(line.text));
    if (headerIndex < 0) {
        reject('table_header_absent', { lineCount: lines.length, lines });
    }
    surroundingLines.push(...decoded.slice(0, headerIndex).map((line) => line.text));
    for (const line of decoded.slice(headerIndex + 1)) {
        const prefix = CATALOG_ROW_PREFIX.exec(line.text);
        if (!prefix) {
            surroundingLines.push(line.text);
            continue;
        }
        // The state marker is the first thing on a row and the only thing that can hide an enabled
        // filter, so a row the contract cannot read is fatal exactly when it is marked enabled. A
        // disabled or absent row that reads oddly is upstream's business, not the proof's.
        const enabledMarker = prefix[1] === '[x]';
        const row =
            line.bold ||
            [...line.text].some((character) => {
                const codePoint = character.codePointAt(0)!;
                return codePoint <= 31 || codePoint === 127;
            })
                ? null
                : parseCatalogRow(line.text);
        if (!row) {
            if (enabledMarker) {
                reject('enabled_row_unreadable', { line: line.text, surroundingLines });
            }
            unreadableRows.push(line.text);
            continue;
        }
        if (ids.has(row.id)) {
            reject('duplicate_catalog_id', { id: row.id, line: line.text });
        }
        ids.add(row.id);
        rows.push(row);
    }
    return { rows, unreadableRows, surroundingLines };
}
