import { describe, expect, it } from 'vitest';
import { buildBrowserSubprocessEnvironment } from '../../src/browser/browser-subprocess-environment';

describe('buildBrowserSubprocessEnvironment', () => {
    it('keeps browser runtime variables while withholding GitHub and LLM credentials', () => {
        const environment = buildBrowserSubprocessEnvironment({
            PATH: '/usr/bin',
            HOME: '/home/runner',
            TMPDIR: '/tmp',
            LANG: 'C.UTF-8',
            DISPLAY: ':99',
            GITHUB_TOKEN: 'github-secret',
            GITHUB_EVENT_PATH: '/runner/event.json',
            LLM_API_KEY: 'llm-secret',
            OPENROUTER_API_KEY: 'legacy-secret',
            BENCHMARK_HUMAN_FIX_COMMIT: 'a'.repeat(40),
        });

        expect(environment).toEqual({
            PATH: '/usr/bin',
            HOME: '/home/runner',
            TMPDIR: '/tmp',
            LANG: 'C.UTF-8',
            DISPLAY: ':99',
        });
        expect(environment).not.toHaveProperty('GITHUB_TOKEN');
        expect(environment).not.toHaveProperty('GITHUB_EVENT_PATH');
        expect(environment).not.toHaveProperty('LLM_API_KEY');
        expect(environment).not.toHaveProperty('OPENROUTER_API_KEY');
        expect(environment).not.toHaveProperty('BENCHMARK_HUMAN_FIX_COMMIT');
    });
});
