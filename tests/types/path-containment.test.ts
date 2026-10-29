import { join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isPathAtOrBelow } from '../../src/types/path-containment';

const ROOT = resolve(sep, 'tmp', 'skills');

describe('isPathAtOrBelow', () => {
    it.each([
        { name: 'the root itself', candidate: ROOT, inside: true },
        { name: 'a file below the root', candidate: join(ROOT, 'a', 'SKILL.md'), inside: true },
        {
            name: 'a name that starts with two dots',
            candidate: join(ROOT, '..notes.md'),
            inside: true,
        },
        { name: 'the parent directory', candidate: resolve(ROOT, '..'), inside: false },
        {
            name: 'a file beside the root',
            candidate: resolve(ROOT, '..', 'AGENTS.md'),
            inside: false,
        },
        { name: 'a sibling sharing the prefix', candidate: `${ROOT}-other`, inside: false },
        {
            name: 'an unrelated absolute path',
            candidate: resolve(sep, 'etc', 'passwd'),
            inside: false,
        },
    ])('answers $inside for $name', ({ candidate, inside }) => {
        expect(isPathAtOrBelow(ROOT, candidate)).toBe(inside);
    });
});
