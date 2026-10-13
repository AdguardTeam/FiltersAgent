/**
 * The AdGuard CLI proxy's own logs, read as blocker-contract events.
 *
 * The proxy writes one access-log line per request, carrying the text of the network rule that
 * decided it, and one output-log line per element it removed from served HTML, carrying the rule
 * that removed it. Both logs are appended across restarts, so a cursor is the byte offset reached
 * in each, and a read stops at the last complete line: the proxy may be midway through the next.
 */
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import {
    BlockerEventKind,
    type BlockerEvent,
    type BlockerLogRead,
} from '../blocker-contract/blocker-contract';
import { ACCESS_LOG_FILENAME, OUTPUT_LOG_FILENAME } from './adguard-cli-proxy-config';

/**
 * One AdGuard CLI access-log line: `date time "listener" PROTOCOL METHOD URL REFERRER STATUS TYPE
 * RESULT N FILTER ADDRESS BYTESb DURATIONms -- RULE`. The rule is everything after `--`, empty when
 * none acted; TCP and TLS lines carry `-` for the status and do not match.
 */
const ACCESS_LOG_LINE =
    /^\S+ \S+ "[^"]*" \S+ \S+ (?<url>\S+) \S+ \d+ \S+ \S+ \d+ \S+ \S+ \d+b \d+ms -- ?(?<rule>.*)$/u;

/**
 * One AdGuard CLI line for a connection it refused at the TLS handshake, before any request: `date
 * time "listener" TLS - HOST - - TYPE BLOCKED N FILTER - BYTESb DURATIONms -- RULE`. Only the host
 * is known.
 */
const TLS_BLOCK_LINE =
    /^\S+ \S+ "[^"]*" TLS - (?<url>\S+) - - \S+ BLOCKED \d+ \S+ \S+ \d+b \d+ms -- (?<rule>.+)$/u;

/**
 * One output-log line for an element the proxy removed from served HTML.
 */
const ELEMENT_REMOVED_LINE =
    /onHtmlElementRemoved: \[[^\]]*\] rule:(?<rule>.+?) url:(?<url>\S*) element name:(?<element>\S+)/u;

/**
 * One output-log line for a host the proxy stopped decrypting: `… AGSslDomainFilter checkDomain:
 * [id=N] TLS connection may not be filtered because REASON, adding 'LISTENER#ADDRESS#HOST' to
 * exceptions`. From then on the proxy tunnels the host, so nothing it applies inside a page can act
 * there, as on learning.ua, whose certificate the CLI release judged invalid.
 */
const HTTPS_EXCEPTION_LINE =
    /TLS connection may not be filtered because (?<reason>.+?), adding '[^']*#(?<host>[^#']+)' to exceptions/u;

/**
 * Line break of both logs.
 */
const LINE_BREAK = /\r?\n/u;

/**
 * Byte value of a line feed, where a complete line ends.
 */
const LINE_FEED = 0x0a;

/**
 * Separator between the two offsets of a cursor.
 */
const CURSOR_SEPARATOR = ':';

/**
 * Read one access-log line as a request event.
 *
 * @param line - One complete line.
 * @returns The event, or undefined for a line naming no rule or not a request at all.
 */
export function parseAccessLogLine(line: string): BlockerEvent | undefined {
    const request = ACCESS_LOG_LINE.exec(line)?.groups;
    if (request !== undefined) {
        const rule = request.rule!.trimEnd();
        return rule.length === 0
            ? undefined
            : { kind: BlockerEventKind.Request, url: request.url!, rule, handshakeBlock: false };
    }
    const handshake = TLS_BLOCK_LINE.exec(line)?.groups;
    return handshake === undefined
        ? undefined
        : {
              kind: BlockerEventKind.Request,
              url: handshake.url!,
              rule: handshake.rule!.trimEnd(),
              handshakeBlock: true,
          };
}

/**
 * Read one output-log line as an element-removal or unfiltered-host event.
 *
 * @param line - One complete line.
 * @returns The event, or undefined for any other output.
 */
export function parseOutputLogLine(line: string): BlockerEvent | undefined {
    const removed = ELEMENT_REMOVED_LINE.exec(line)?.groups;
    if (removed !== undefined) {
        return {
            kind: BlockerEventKind.HtmlElementRemoved,
            url: removed.url!,
            element: removed.element!,
            rule: removed.rule!,
        };
    }
    const exception = HTTPS_EXCEPTION_LINE.exec(line)?.groups;
    return exception === undefined
        ? undefined
        : {
              kind: BlockerEventKind.UnfilteredHost,
              host: exception.host!,
              reason: exception.reason!,
          };
}

/**
 * Complete lines read from a log, and where the next read starts.
 */
interface CompleteLines {
    /**
     * The complete lines, in order.
     */
    lines: string[];

    /**
     * Offset just past the last complete line.
     */
    offset: number;
}

/**
 * Read the complete lines a log gained since an offset.
 *
 * @param path - The log.
 * @param offset - Bytes already consumed.
 * @returns The lines and the offset just past the last complete one.
 */
async function completeLinesSince(path: string, offset: number): Promise<CompleteLines> {
    let handle;
    try {
        handle = await open(path, 'r');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return { lines: [], offset };
        }
        throw error;
    }
    try {
        const size = (await handle.stat()).size;
        if (size <= offset) {
            return { lines: [], offset };
        }
        const bytes = Buffer.alloc(size - offset);
        await handle.read(bytes, 0, bytes.length, offset);
        const end = bytes.lastIndexOf(LINE_FEED) + 1;
        return {
            lines: bytes.subarray(0, end).toString('utf8').split(LINE_BREAK).filter(Boolean),
            offset: offset + end,
        };
    } finally {
        await handle.close();
    }
}

/**
 * Size of one log, zero while the proxy has not written it yet.
 *
 * @param path - The log.
 * @returns Its size in bytes.
 */
async function logSize(path: string): Promise<number> {
    let handle;
    try {
        handle = await open(path, 'r');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return 0;
        }
        throw error;
    }
    try {
        return (await handle.stat()).size;
    } finally {
        await handle.close();
    }
}

/**
 * Read the events both logs gained since a cursor.
 *
 * @param workspaceDir - The proxy workspace holding both logs.
 * @param cursor - Cursor from an earlier read, or null to read nothing and return the current one.
 * @param revision - Revision of the running proxy, carried into the result.
 * @returns The events and the next cursor.
 */
export async function readAdguardCliLog(
    workspaceDir: string,
    cursor: string | null,
    revision: number,
): Promise<BlockerLogRead> {
    const accessLogPath = join(workspaceDir, ACCESS_LOG_FILENAME);
    const outputLogPath = join(workspaceDir, OUTPUT_LOG_FILENAME);
    if (cursor === null) {
        const now = [await logSize(accessLogPath), await logSize(outputLogPath)];
        return { revision, cursor: now.join(CURSOR_SEPARATOR), events: [] };
    }
    const [accessOffset, outputOffset] = cursor.split(CURSOR_SEPARATOR).map(Number);
    const access = await completeLinesSince(accessLogPath, accessOffset!);
    const output = await completeLinesSince(outputLogPath, outputOffset!);
    const events = [
        ...access.lines.map(parseAccessLogLine),
        ...output.lines.map(parseOutputLogLine),
    ].filter((event): event is BlockerEvent => event !== undefined);
    return {
        revision,
        cursor: [access.offset, output.offset].join(CURSOR_SEPARATOR),
        events,
    };
}
