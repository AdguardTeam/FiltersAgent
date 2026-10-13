import { describe, expect, it } from 'vitest';
import { createCallLimiter } from '../../src/pi/call-limiter';

/**
 * A call the test settles by hand, so how many are in flight is the test's to observe.
 */
interface ManualCall {
    start: () => Promise<string>;
    finish: (value: string) => void;
    fail: (error: Error) => void;
}

function manualCall(onStart: () => void): ManualCall {
    let finish!: (value: string) => void;
    let fail!: (error: Error) => void;
    const settled = new Promise<string>((resolve, reject) => {
        finish = resolve;
        fail = reject;
    });
    return {
        start: () => {
            onStart();
            return settled;
        },
        finish,
        fail,
    };
}

describe('createCallLimiter', () => {
    it('keeps at most the limit in flight and starts waiting calls in arrival order', async () => {
        const started: number[] = [];
        const calls = [0, 1, 2, 3, 4].map((index) => manualCall(() => started.push(index)));
        const limiter = createCallLimiter(2);

        const results = calls.map((call) => limiter.run(call.start));
        await Promise.resolve();
        // Two slots: the first two calls hold them, the rest wait their turn.
        expect(started).toEqual([0, 1]);

        calls[1]!.finish('b');
        await results[1];
        expect(started).toEqual([0, 1, 2]);

        calls[0]!.finish('a');
        calls[2]!.finish('c');
        await Promise.all([results[0], results[2]]);
        expect(started).toEqual([0, 1, 2, 3, 4]);

        calls[3]!.finish('d');
        calls[4]!.finish('e');
        // Results come back in the order the calls were handed in, not the order they finished.
        await expect(Promise.all(results)).resolves.toEqual(['a', 'b', 'c', 'd', 'e']);
    });

    it('frees the slot of a call that rejects', async () => {
        const started: number[] = [];
        const failing = manualCall(() => started.push(0));
        const waiting = manualCall(() => started.push(1));
        const limiter = createCallLimiter(1);

        const failed = limiter.run(failing.start);
        const next = limiter.run(waiting.start);
        failing.fail(new Error('provider refused'));

        await expect(failed).rejects.toThrow('provider refused');
        waiting.finish('ok');
        await expect(next).resolves.toBe('ok');
        expect(started).toEqual([0, 1]);
    });
});
