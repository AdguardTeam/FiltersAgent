import { describe, expect, it } from 'vitest';
import {
    normalizeRulesContent,
    observedRulesDigest,
    sha256OfContent,
} from '../../src/environment/rules-content';

describe('observedRulesDigest', () => {
    it('digests the normalized content when the read-back provides content', () => {
        const content = '  ||example.test^$script  ';

        const digest = observedRulesDigest({ rulesContent: content });

        expect(digest).toBe(sha256OfContent(normalizeRulesContent(content)));
    });

    it('lets the content win when it disagrees with the reader-supplied digest', () => {
        const content = '||example.test^';
        const staleReaderDigest = sha256OfContent('||other.test^');

        const digest = observedRulesDigest({
            rulesContent: content,
            rulesContentSha256: staleReaderDigest,
        });

        expect(digest).toBe(sha256OfContent(normalizeRulesContent(content)));
        expect(digest).not.toBe(staleReaderDigest);
    });

    it('uses the reader-supplied digest only when the content is absent', () => {
        const readerDigest = sha256OfContent('||example.test^');

        const digest = observedRulesDigest({ rulesContentSha256: readerDigest });

        expect(digest).toBe(readerDigest);
    });

    it('returns undefined when the read-back carries neither content nor digest', () => {
        expect(observedRulesDigest({})).toBeUndefined();
    });
});
