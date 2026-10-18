import { describe, expect, it } from 'vitest';
import { MAX_MISSING_INFORMATION_DETAIL_CHARACTERS } from '../../src/types/missing-information';
import {
    renderUntrustedRuleCodeSpan,
    renderUntrustedText,
} from '../../src/publisher/untrusted-text';
import {
    CODE_SPAN_PATTERN,
    commonPrefix,
    liveGitHubConstructs,
    readerView,
} from './rendered-markdown';

/**
 * Text well past every bound a schema puts on model-authored text, so the renderer has to shorten
 * it wherever its own ceiling lies.
 */
const OVERLONG_CHARACTERS = 4 * MAX_MISSING_INFORMATION_DETAIL_CHARACTERS;

/**
 * Repeat a unit of text, after a filler word of the given length, past the bound: sweeping the
 * filler over one unit puts every position of the unit at the renderer's ceiling once.
 */
function overlong(unit: string, filler: number): string {
    return `${'w'.repeat(filler)} ${unit.repeat(Math.ceil(OVERLONG_CHARACTERS / unit.length))}`.trim();
}

describe('renderUntrustedText', () => {
    it('flattens model-authored text to one line and lets no HTML through', () => {
        const text =
            'Fallback — Launch failed: ad & banner <img src=x onerror=alert(1)> injected\n' +
            'next line "quoted" text <details><summary>x</summary></details> \'one\'';

        const rendered = renderUntrustedText(text);

        expect(rendered).not.toContain('\n');
        expect(liveGitHubConstructs(rendered)).toEqual([]);
        // Quotes and ampersands mean nothing in Markdown text: the reader sees them as written.
        expect(readerView(rendered)).toBe(text.replace('\n', ' '));
    });

    it('keeps code spans literal and lets no stray backtick open one', () => {
        // GitHub shows a code span's content literally, so anything the escape put inside one
        // would show: the rule has to stay exactly as the model wrote it.
        const spanned = renderUntrustedText('Hidden by `delfi.lv##.logo-row` for @user');
        expect(spanned).toContain('`delfi.lv##.logo-row`');
        expect(liveGitHubConstructs(spanned)).toEqual([]);
        // A backtick that opens no span stays a literal backtick, so Markdown cannot pair it with
        // another one into a span the text around it never meant.
        for (const text of ['one ` tick #1 @user', '``@user` and \\`@user`']) {
            const rendered = renderUntrustedText(text);
            expect(rendered.replace(CODE_SPAN_PATTERN, '')).not.toMatch(/(?<!\\)`/u);
            expect(liveGitHubConstructs(rendered)).toEqual([]);
        }
    });

    it('leaves no mention, issue reference, autolink, link or line-start block', () => {
        // GitHub decodes `&#64;user` and `&#35;123` before resolving them, so an entity alone
        // still pings the user and cross-references the issue.
        const hostile = [
            'ping @maintainer and @AdguardTeam/maintainers, see #123, owner/repo#4, GH-5 and _GH-5_,',
            'get https://evil.test/fix, ftp://evil.test/a, mailto:a@b.test, www.evil.test or x_www.evil.test,',
            'decode &#64;user, follow [this](https://evil.test) or ![logo](https://evil.test/x.png),',
            '<https://evil.test> <b>bold</b>',
        ].join(' ');
        const rendered = renderUntrustedText(hostile);

        expect(liveGitHubConstructs(rendered)).toEqual([]);
        expect(readerView(rendered)).toBe(hostile);
        for (const lineStart of [
            '# Heading',
            '> quoted',
            '[ref]: https://evil.test',
            '<div>block</div>',
        ]) {
            const atLineStart = renderUntrustedText(lineStart);
            expect(liveGitHubConstructs(atLineStart)).toEqual([]);
            expect(readerView(atLineStart)).toBe(lineStart);
        }
    });

    it('keeps tildes at the start of a fill from opening a code block', () => {
        // Three tildes at the start of a line open a fenced block that runs to the end of the
        // comment, taking the sections and the footer after it with it.
        for (const text of ['~~~ consent banners are out of scope', '~~~', '~~struck~~ text']) {
            const rendered = renderUntrustedText(text);

            expect(liveGitHubConstructs(rendered)).toEqual([]);
            expect(rendered).not.toMatch(/(?<!\\)~/u);
        }
    });

    it('keeps a backslash the model wrote from escaping the character after it', () => {
        // The model wrote \" and GitHub read the backslash as an escape of what followed it.
        const text = 'wall (\\"Dein Adblocker\\") shown, \\@user, \\# heading';

        const rendered = renderUntrustedText(text);

        expect(rendered).not.toMatch(/\\[!-/:-@[-`{-~]/u);
        expect(liveGitHubConstructs(rendered)).toEqual([]);
        expect(readerView(rendered)).toBe(text);
    });

    it('shortens text past the bound at a sentence end and says so', () => {
        const text = overlong(
            'The control session loaded the page and the banner was present. ',
            0,
        );

        const shown = readerView(renderUntrustedText(text));
        const kept = commonPrefix(shown, text).trimEnd();

        expect(kept.length).toBeLessThan(text.length);
        expect(kept.endsWith('.')).toBe(true);
        expect(text[kept.length]).toBe(' ');
        // Something after the kept text says it is not the whole of it.
        expect(shown.slice(kept.length).trim().length).toBeGreaterThan(0);
    });

    it('never ends a URL, a rule or a property inside its own punctuation', () => {
        // A sentence segmenter also breaks after the `?` of a query, the `.` of a selector and the
        // `!` of `!important`; a cut there ends the text on half a URL or half a rule.
        const unit =
            'The page loads https://example.com/watch?v=abc, hides example.com##.AdBox ' +
            'with display:none!important and stays usable. ';
        for (let filler = 0; filler < unit.length; filler += 1) {
            const text = overlong(unit, filler);
            const kept = commonPrefix(readerView(renderUntrustedText(text)), text).trimEnd();

            expect(kept.endsWith('usable.')).toBe(true);
        }
    });

    it('shortens one overlong sentence between words, never inside a code span, wherever the bound falls', () => {
        // No sentence end anywhere, and a code span with a space inside every few words.
        const unit = 'the banner stays `example.com##.ad .banner` on the page ';
        for (let filler = 0; filler < unit.length; filler += 1) {
            const text = overlong(unit, filler);
            const rendered = renderUntrustedText(text);
            const shown = readerView(rendered);
            const kept = commonPrefix(shown, text).trimEnd();

            expect(kept.length).toBeLessThan(text.length);
            expect(text[kept.length]).toBe(' ');
            expect(shown.slice(kept.length).trim().length).toBeGreaterThan(0);
            // A cut span would leave a backtick outside the code, free to pair with the next one.
            expect(rendered.replace(CODE_SPAN_PATTERN, '')).not.toMatch(/(?<!\\)`/u);
        }
    });

    it('never splits a character in two when not even a word fits', () => {
        // Text with neither a sentence end nor a space: quoted script, a long URL, CJK prose. One of
        // the two alignments puts the bound between the halves of an emoji.
        for (const filler of ['', 'x']) {
            const text = `${filler}${'😀'.repeat(OVERLONG_CHARACTERS)}`;

            const shown = readerView(renderUntrustedText(text));

            expect(shown).not.toMatch(/\p{Cs}/u);
            expect(commonPrefix(shown, text).length).toBeLessThan(text.length);
        }
    });
});

describe('renderUntrustedRuleCodeSpan', () => {
    it('renders a rule whole, however long', () => {
        // A published comment named the neighbouring rule as `zywiecinfo.pl,…,ty…`: a cut rule is
        // a different rule.
        const domains = Array.from({ length: 80 }, (_, index) => `site-${index}.example`);
        const rule = `${domains.join(',')}##div:has(> ins[data-slot])`;

        expect(renderUntrustedRuleCodeSpan(rule)).toBe(`\`${rule}\``);
    });
});
