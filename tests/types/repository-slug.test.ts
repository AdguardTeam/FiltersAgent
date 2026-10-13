import { describe, it, expect } from 'vitest';
import {
    REPOSITORY_SLUG_PATTERN,
    parseRepositorySlugFromGitUrl,
} from '../../src/types/repository-slug';

describe('parseRepositorySlugFromGitUrl', () => {
    it('parses an https URL without a .git suffix', () => {
        expect(parseRepositorySlugFromGitUrl('https://github.com/o/r')).toEqual({
            owner: 'o',
            repo: 'r',
        });
    });

    it('parses an https URL with a .git suffix', () => {
        expect(parseRepositorySlugFromGitUrl('https://github.com/o/r.git')).toEqual({
            owner: 'o',
            repo: 'r',
        });
    });

    it('parses an scp-like git URL', () => {
        expect(parseRepositorySlugFromGitUrl('git@github.com:o/r.git')).toEqual({
            owner: 'o',
            repo: 'r',
        });
    });

    it('parses an ssh URL on a non-GitHub host', () => {
        expect(parseRepositorySlugFromGitUrl('ssh://git@host/o/r.git')).toEqual({
            owner: 'o',
            repo: 'r',
        });
    });

    it('rejects a bare path with no owner/repo suffix', () => {
        expect(parseRepositorySlugFromGitUrl('/tmp/AdguardFilters')).toBeNull();
    });

    it('accepts fork slugs in the shared pattern', () => {
        expect(REPOSITORY_SLUG_PATTERN.test('other-org/AdguardFilters')).toBe(true);
    });
});
