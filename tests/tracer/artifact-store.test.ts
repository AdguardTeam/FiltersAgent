import { describe, it, expect } from 'vitest';
import { ArtifactStore } from '../../src/tracer/artifact-store';

describe('ArtifactStore', () => {
    it('write returns an ArtifactRef with generated id, path, type, and bytes', () => {
        const store = new ArtifactStore();
        const ref = store.write('hello world', 'text');

        expect(ref.id).toBeTruthy();
        expect(ref.path).toBe(`artifact://${ref.id}`);
        expect(ref.type).toBe('text');
        expect(ref.bytes).toBe(11);
    });

    it('read returns the stored content', () => {
        const store = new ArtifactStore();
        const ref = store.write('payload', 'json');
        const content = store.read(ref.id);

        expect(content).toBe('payload');
    });

    it('read returns undefined for unknown id', () => {
        const store = new ArtifactStore();
        expect(store.read('nonexistent')).toBeUndefined();
    });

    it('getFiltered returns key-path extraction from JSON', () => {
        const store = new ArtifactStore();
        const data = JSON.stringify({ a: { b: { c: 'value' } } });
        const ref = store.write(data, 'json');

        const result = store.getFiltered(ref.id, { key: 'a.b.c' });
        expect(result).toBe('value');
    });

    it('getFiltered supports array indexing in key paths', () => {
        const store = new ArtifactStore();
        const data = JSON.stringify({ items: [{ name: 'first' }, { name: 'second' }] });
        const ref = store.write(data, 'json');

        const r1 = store.getFiltered(ref.id, { key: 'items.0.name' });
        const r2 = store.getFiltered(ref.id, { key: 'items.1.name' });

        expect(r1).toBe('first');
        expect(r2).toBe('second');
    });

    it('getFiltered returns undefined for out-of-bounds array index', () => {
        const store = new ArtifactStore();
        const data = JSON.stringify(['a']);
        const ref = store.write(data, 'json');

        expect(store.getFiltered(ref.id, { key: '5' })).toBeUndefined();
    });

    it('getFiltered returns undefined for non-existent key path', () => {
        const store = new ArtifactStore();
        const data = JSON.stringify({ x: 1 });
        const ref = store.write(data, 'json');

        expect(store.getFiltered(ref.id, { key: 'y' })).toBeUndefined();
    });

    it('getFiltered applies limit to JSON arrays', () => {
        const store = new ArtifactStore();
        const data = JSON.stringify([1, 2, 3, 4, 5]);
        const ref = store.write(data, 'json');

        const result = store.getFiltered(ref.id, { limit: 3 });
        expect(JSON.parse(result!)).toEqual([1, 2, 3]);
    });

    it('getFiltered applies limit to text lines for non-JSON content', () => {
        const store = new ArtifactStore();
        const data = 'line1\nline2\nline3\nline4\nline5';
        const ref = store.write(data, 'text');

        const result = store.getFiltered(ref.id, { limit: 2 });
        expect(result).toBe('line1\nline2');
    });

    it('getFiltered returns full content when limit exceeds size', () => {
        const store = new ArtifactStore();
        const data = JSON.stringify([1, 2]);
        const ref = store.write(data, 'json');

        const result = store.getFiltered(ref.id, { limit: 100 });
        expect(JSON.parse(result!)).toEqual([1, 2]);
    });

    it('getFiltered returns undefined for unknown id', () => {
        const store = new ArtifactStore();
        expect(store.getFiltered('nonexistent', { key: 'x' })).toBeUndefined();
    });

    it('getFiltered without key or limit returns full content', () => {
        const store = new ArtifactStore();
        const ref = store.write('raw text', 'text');

        const result = store.getFiltered(ref.id, {});
        expect(result).toBe('raw text');
    });

    it('write creates unique ids for each call', () => {
        const store = new ArtifactStore();
        const ref1 = store.write('a', 't');
        const ref2 = store.write('b', 't');

        expect(ref1.id).not.toBe(ref2.id);
    });
});
