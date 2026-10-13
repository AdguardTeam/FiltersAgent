/**
 * The requests a proxy blocker stopped, followed through the contract's log.
 *
 * A proxy answers a request it blocks itself, so nothing in the page tells a blocked request from
 * one its host failed; the blocker's log does. The browser session asks synchronously, while the
 * log is read through the contract, so the set is refreshed in the background and on every ask; an
 * ask sees what the previous refresh read.
 */
import type { Logger } from '../logger/logger';
import { normalizeRule } from '../repo/rule-normalizer';
import { BlockerEventKind, type BlockerContract } from './blocker-contract';

/**
 * Interval between background refreshes. Short enough that a request blocked while the agent waits
 * for the page to settle is in the set before the agent reads the network log.
 */
const REFRESH_INTERVAL_MS = 250;

/**
 * The blocked requests of one browser session, followed until the route stops them.
 */
export interface BlockedRequestsFollower {
    /**
     * Read the blocked request URLs seen so far, refreshing in the background.
     *
     * @returns The URLs.
     */
    read: () => ReadonlySet<string>;

    /**
     * Stop following, before the blocker itself stops, so its shutdown is not read as a failure.
     */
    stop: () => void;
}

/**
 * Follow the requests a blocker stops for one browser session.
 *
 * @param blocker - The blocker the session rides.
 * @param cursor - Log cursor taken when the session launched.
 * @param revision - Blocker revision the session launched at.
 * @param logger - Run logger for a read that failed.
 * @returns The follower: a synchronous reader and its stop.
 */
export function followBlockedRequests(
    blocker: BlockerContract,
    cursor: string,
    revision: number,
    logger: Logger,
): BlockedRequestsFollower {
    const blocked = new Set<string>();
    let next = cursor;
    let inFlight: Promise<void> | null = null;
    let ended = false;

    const refresh = (): void => {
        if (ended || inFlight !== null) {
            return;
        }
        inFlight = blocker
            .log(next)
            .then((read) => {
                // A restarted proxy no longer serves this session, and its log ended there.
                if (read.revision !== revision) {
                    ended = true;
                    return;
                }
                next = read.cursor;
                for (const event of read.events) {
                    if (
                        event.kind === BlockerEventKind.Request &&
                        !event.handshakeBlock &&
                        !normalizeRule(event.rule).isException
                    ) {
                        blocked.add(event.url);
                    }
                }
            })
            .catch((error: unknown) => {
                // A stopped blocker answers no more; what was read stays.
                ended = true;
                logger.warn({ err: error }, 'the blocker log stopped answering blocked requests');
            })
            .finally(() => {
                inFlight = null;
            });
    };

    const timer = setInterval(() => {
        if (ended) {
            clearInterval(timer);
            return;
        }
        refresh();
    }, REFRESH_INTERVAL_MS);
    // The timer must not keep a finished run alive.
    timer.unref();

    return {
        read: () => {
            refresh();
            return blocked;
        },
        stop: () => {
            ended = true;
            clearInterval(timer);
        },
    };
}
