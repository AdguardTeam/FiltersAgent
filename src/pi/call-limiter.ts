/**
 * Bounded parallelism for independent provider calls.
 *
 * A candidate review inventories a page tile by tile, and every tile is its own vision completion.
 * Run one after another they are too slow: a long page (six tiles, three page states) takes about
 * two dozen calls per experiment, and a run can spend most of its time inside vision calls with no
 * experiment reaching its verdict inside the 30-minute deadline. The calls do not depend on each
 * other, so they run side by side — bounded, because a provider rate-limits a key that opens too
 * many completions at once.
 */

/**
 * How many independent provider calls one review or capture inspection keeps in flight.
 *
 * Four turns a two-dozen-call review into about six waves, which is what brings it back inside its
 * deadline, while staying far below the concurrency any paid provider key is allowed.
 */
export const PROVIDER_CALL_CONCURRENCY = 4;

/**
 * Runs calls with at most a fixed number of them in flight, first come first served.
 */
export interface CallLimiter {
    /**
     * Run one call once a slot is free.
     *
     * @param call - The call to run; it starts only when it holds a slot.
     * @returns Whatever the call returns; a rejection passes through and frees the slot.
     */
    run<T>(call: () => Promise<T>): Promise<T>;
}

/**
 * Create a first-come-first-served limiter for independent provider calls.
 *
 * Slots are handed over in arrival order, so a caller that enqueues its calls in a meaningful order
 * — tile one before tile two — has them START in that order too.
 *
 * @param limit - How many calls may be in flight at once.
 * @returns The limiter.
 */
export function createCallLimiter(limit: number = PROVIDER_CALL_CONCURRENCY): CallLimiter {
    let inFlight = 0;
    const waiting: Array<() => void> = [];
    return {
        run: async <T>(call: () => Promise<T>): Promise<T> => {
            if (inFlight < limit) {
                inFlight += 1;
            } else {
                // The slot is handed over by the finishing call, so `inFlight` stays as it is.
                await new Promise<void>((resolve) => {
                    waiting.push(resolve);
                });
            }
            try {
                return await call();
            } finally {
                const next = waiting.shift();
                if (next === undefined) {
                    inFlight -= 1;
                } else {
                    next();
                }
            }
        },
    };
}
