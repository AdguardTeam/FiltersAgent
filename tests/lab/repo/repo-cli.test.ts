import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { assertCheckoutPath, buildRepoSearchHandler } from '../../../lab/repo/repo-handlers';
import { ConfigError, loadCoreConfig } from '../../../src/config/config';
import { testCoreConfig } from '../../config/test-core-config';

const validBase = testCoreConfig();

describe('assertCheckoutPath', () => {
    it('returns the path when repositoryPath is set', () => {
        const path = assertCheckoutPath({ ...validBase, repositoryPath: '/repo' });
        expect(path).toBe('/repo');
    });

    it('throws a ConfigError when repositoryPath is unset', () => {
        expect(() => assertCheckoutPath({ ...validBase })).toThrow(ConfigError);
    });

    it('mentions REPOSITORY_PATH in the error message', () => {
        expect(() => assertCheckoutPath({ ...validBase })).toThrow(/REPOSITORY_PATH/);
    });
});

describe('repo command on a configuration with no checkout path', () => {
    it('fails naming REPOSITORY_PATH and never substitutes a real checkout path', async () => {
        // AC3's checkout leg: with REPOSITORY_PATH unset the failure must name the missing
        // variable, never quietly fall back to some other real checkout sitting on this machine.
        const unrelatedCheckout = mkdtempSync(join(tmpdir(), 'repo-cli-other-checkout-'));
        writeFileSync(
            join(unrelatedCheckout, 'filter.txt'),
            '! Title: Unrelated fixture\n\nexample.test###banner\n',
            'utf8',
        );
        const core = loadCoreConfig({
            LLM_API_KEY: 'local-key',
            LLM_BASE_URL: 'https://llm.example.com/v1',
            LLM_MODEL: 'reasoning-model',
            LLM_VISION_MODEL: 'vision-model',
            LLM_CONTEXT_WINDOW_TOKENS: '131072',
            LLM_MAX_OUTPUT_TOKENS: '32768',
            LLM_VISION_MAX_OUTPUT_TOKENS: '8192',
        });

        try {
            try {
                await buildRepoSearchHandler(core)({
                    subcommand: 'search',
                    query: { domain: 'example.test' },
                    verbose: false,
                });
                expect.unreachable('repo search must fail when no checkout path is configured');
            } catch (error) {
                expect(error).toBeInstanceOf(ConfigError);
                const message = (error as Error).message;
                expect(message).toContain('REPOSITORY_PATH');
                expect(message).not.toContain(unrelatedCheckout);
                expect(message).not.toMatch(/(?:^|\s)\/[^\s']+/u);
            }
        } finally {
            rmSync(unrelatedCheckout, { recursive: true, force: true });
        }
    });
});

describe('repo commands on the core loader', () => {
    let stdoutSpy: MockInstance<typeof process.stdout.write> | undefined;

    beforeEach(() => {
        stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
        stdoutSpy?.mockRestore();
    });

    it('runs repo search against a checkout with no origin remote and no env repository', async () => {
        // A mirror extraction (plain directory, no git) plus a silent environment must still be a
        // working `repo search`: the repo commands read only the checkout path and never the
        // GitHub-reading configuration, whose repository identity would otherwise be mandatory.
        const checkout = mkdtempSync(join(tmpdir(), 'repo-cli-checkout-'));
        writeFileSync(
            join(checkout, 'filter.txt'),
            '! Title: Search fixture\n\nexample.test###banner\n',
            'utf8',
        );
        const core = loadCoreConfig({
            LLM_API_KEY: 'local-key',
            LLM_BASE_URL: 'https://llm.example.com/v1',
            LLM_MODEL: 'reasoning-model',
            LLM_VISION_MODEL: 'vision-model',
            LLM_CONTEXT_WINDOW_TOKENS: '131072',
            LLM_MAX_OUTPUT_TOKENS: '32768',
            LLM_VISION_MAX_OUTPUT_TOKENS: '8192',
            REPOSITORY_PATH: checkout,
        });

        try {
            await buildRepoSearchHandler(core)({
                subcommand: 'search',
                query: { domain: 'example.test' },
                verbose: false,
            });
        } finally {
            rmSync(checkout, { recursive: true, force: true });
        }

        const written = stdoutSpy?.mock.calls.map((call) => String(call[0])).join('') ?? '';
        const matches = JSON.parse(written) as Array<{ rule: string }>;
        expect(matches.some((match) => match.rule.includes('###banner'))).toBe(true);
    });
});
