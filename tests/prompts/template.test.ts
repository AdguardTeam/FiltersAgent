import { describe, expect, it } from 'vitest';
import {
    extractPlaceholders,
    PromptRenderError,
    PromptRenderErrorKind,
    renderTemplate,
} from '../../src/prompts/template';

const captureError = (act: () => unknown): PromptRenderError => {
    try {
        act();
    } catch (error) {
        expect(error).toBeInstanceOf(PromptRenderError);
        return error as PromptRenderError;
    }
    throw new Error('expected renderTemplate to throw');
};

describe('extractPlaceholders', () => {
    it('returns declared placeholder names in first-appearance order, deduplicated', () => {
        const template = 'Fix #{{issueNumber}} as {{terminalToolName}}; again #{{issueNumber}}.';
        expect(extractPlaceholders(template)).toEqual(['issueNumber', 'terminalToolName']);
    });

    it('returns an empty list for a placeholder-free document', () => {
        expect(extractPlaceholders('Static text with {braces} but no placeholders.')).toEqual([]);
    });

    it('rejects malformed placeholder syntax, naming the snippet', () => {
        const error = captureError(() => extractPlaceholders('Issue #{{ issueNumber}} here'));
        expect(error.kind).toBe(PromptRenderErrorKind.MalformedPlaceholder);
        expect(error.message).toContain('{{ issueNumber}}');
    });

    it('rejects a well-formed placeholder wrapped in extra braces', () => {
        // `{{{name}}}` contains a well-formed `{{name}}` starting one character late. A
        // strip-then-grep pass would accept it (the residue is `{}`) and the token would render
        // silently as `{value}`; the occurrence rule rejects it — the `{{` at index 0 matches
        // nothing.
        const error = captureError(() => extractPlaceholders('Assign {{{name}}} carefully'));
        expect(error.kind).toBe(PromptRenderErrorKind.MalformedPlaceholder);
        expect(error.message).toContain('{{{name}}}');
    });
});

describe('renderTemplate', () => {
    it('fills every declared placeholder, including repeated occurrences', () => {
        const template =
            'Fix issue #{{issueNumber}}. Again: #{{issueNumber}}. Tool: {{terminalToolName}}.';
        const rendered = renderTemplate(template, {
            issueNumber: '42',
            terminalToolName: 'finish_fix',
        });
        expect(rendered).toBe('Fix issue #42. Again: #42. Tool: finish_fix.');
    });

    it('fails with a missing-placeholder error naming the unfilled placeholder', () => {
        const error = captureError(() => renderTemplate('Issue #{{issueNumber}}', {}));
        expect(error.kind).toBe(PromptRenderErrorKind.MissingPlaceholder);
        expect(error.message).toContain('issueNumber');
    });

    it('fails with an unknown-placeholder error naming the unmatched fill', () => {
        const error = captureError(() =>
            renderTemplate('Issue #{{issueNumber}}', { issueNumber: '42', bogusName: 'x' }),
        );
        expect(error.kind).toBe(PromptRenderErrorKind.UnknownPlaceholder);
        expect(error.message).toContain('bogusName');
    });

    it('treats an empty-string fill as filled', () => {
        expect(renderTemplate('a{{optionalContext}}b', { optionalContext: '' })).toBe('ab');
    });

    it('substitutes in a single pass: placeholder-shaped fill text stays literal', () => {
        const rendered = renderTemplate('Report: {{body}}', {
            body: 'the site showed {{issueNumber}} literally',
        });
        expect(rendered).toBe('Report: the site showed {{issueNumber}} literally');
    });

    it('returns a placeholder-free template byte-identical when no values are given', () => {
        const template = 'Static system text.\nWith newlines preserved.\n';
        expect(renderTemplate(template, {})).toBe(template);
    });

    it('rejects values supplied for a placeholder-free template', () => {
        const error = captureError(() => renderTemplate('Static.', { stray: 'x' }));
        expect(error.kind).toBe(PromptRenderErrorKind.UnknownPlaceholder);
        expect(error.message).toContain('stray');
    });
});
