/**
 * Run one call that is expected to throw and return what it threw.
 *
 * @param run - The call expected to fail.
 * @returns The thrown error.
 */
export function captureFailure(run: () => unknown): Error {
    try {
        run();
    } catch (error) {
        return error as Error;
    }
    throw new Error('Expected the call to fail.');
}
