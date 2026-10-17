import {
    lstatSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeAtomicJson } from '../../lab/atomic-json';

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

function temporaryRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'atomic-json-'));
    roots.push(root);
    return root;
}

describe('writeAtomicJson', () => {
    it('creates private JSON artifacts and replaces symlinks without changing their targets', () => {
        const root = temporaryRoot();
        const destination = join(root, 'nested', 'record.json');
        writeAtomicJson(destination, { result: 'first' });
        expect(JSON.parse(readFileSync(destination, 'utf8'))).toEqual({ result: 'first' });
        expect(statSync(destination).mode & 0o777).toBe(0o600);
        rmSync(destination);
        const target = join(root, 'target.json');
        writeFileSync(target, 'preserved');
        symlinkSync(target, destination);

        writeAtomicJson(destination, { result: 'replacement' });

        expect(lstatSync(destination).isSymbolicLink()).toBe(false);
        expect(JSON.parse(readFileSync(destination, 'utf8'))).toEqual({ result: 'replacement' });
        expect(readFileSync(target, 'utf8')).toBe('preserved');
        expect(statSync(destination).mode & 0o777).toBe(0o600);
        expect(readdirSync(join(root, 'nested'))).toEqual(['record.json']);
    });

    it('keeps an existing artifact intact and removes its temporary file when serialization fails', () => {
        const root = temporaryRoot();
        const destination = join(root, 'record.json');
        writeFileSync(destination, 'preserved');
        const circular: { self?: unknown } = {};
        circular.self = circular;

        expect(() => writeAtomicJson(destination, circular)).toThrow();
        expect(readFileSync(destination, 'utf8')).toBe('preserved');
        expect(readdirSync(root)).toEqual(['record.json']);
    });
});
