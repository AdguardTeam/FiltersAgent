import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createHandledInterruptScope } from '../../../lab/local/handled-interrupt';

describe('handled interrupt scope', () => {
    it('preserves pre-existing listeners, owns exact additions, and restores on dispose', () => {
        const target = new EventEmitter();
        const existing = vi.fn();
        target.on('SIGINT', existing);
        const beforeInt = target.listeners('SIGINT');
        const beforeTerm = target.listeners('SIGTERM');
        const scope = createHandledInterruptScope({ processTarget: target });

        target.emit('SIGTERM');
        target.emit('SIGINT');
        expect(scope.signal.aborted).toBe(true);
        expect(scope.intent()).toEqual({ signal: 'SIGTERM', exitCode: 143 });

        scope.dispose();
        expect(target.listeners('SIGINT')).toEqual(beforeInt);
        expect(target.listeners('SIGTERM')).toEqual(beforeTerm);
        expect(existing).toHaveBeenCalledTimes(1);
    });

    it('handles an already-aborted queue signal and coalesces later signals', () => {
        const target = new EventEmitter();
        const queue = new AbortController();
        queue.abort();
        const scope = createHandledInterruptScope({
            processTarget: target,
            queueSignal: queue.signal,
        });

        expect(scope.signal.aborted).toBe(true);
        expect(scope.intent()).toEqual({ signal: 'queue_abort', exitCode: null });
        target.emit('SIGINT');
        expect(scope.intent()).toEqual({ signal: 'queue_abort', exitCode: null });
        scope.dispose();
        scope.dispose();
        expect(target.listenerCount('SIGINT')).toBe(0);
        expect(target.listenerCount('SIGTERM')).toBe(0);
    });
});
