import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../../src/config/config-error';
import { LLM_PRICING_FILE_VAR, loadUsagePricing } from '../../../lab/pricing/usage-pricing';

describe('loadUsagePricing', () => {
    it('loads nothing when no price file is named, so the run proceeds unpriced', () => {
        expect(loadUsagePricing({}, process.cwd())).toBeNull();
    });

    it('accepts the documented example price file', () => {
        // The guide tells users to copy this file; if the loader stops accepting it, every user
        // who followed the guide gets a failed run.
        const rates = loadUsagePricing(
            { [LLM_PRICING_FILE_VAR]: 'docs/examples/pricing.example.json' },
            process.cwd(),
        );

        expect(Object.keys(rates ?? {}).sort()).toEqual([
            'example-reasoning-model',
            'example-vision-model',
        ]);
    });

    it.each([
        ['an unreadable file', null],
        [
            'a misspelled rate field',
            {
                models: {
                    m: {
                        inputUsdPerMillionTokens: 1,
                        outputUsdPerMillionTokens: 2,
                        cachedInputUsdPerMillion: 0.1,
                    },
                },
            },
        ],
        ['an empty model table', { models: {} }],
    ])('fails before the run on %s, naming the variable', (_label, document) => {
        // A user who asked for a cost and silently got none would compare benchmark runs on
        // numbers that were never computed.
        const root = mkdtempSync(join(tmpdir(), 'usage-pricing-'));
        if (document !== null) {
            writeFileSync(join(root, 'prices.json'), JSON.stringify(document), 'utf8');
        }

        const load = () => loadUsagePricing({ [LLM_PRICING_FILE_VAR]: 'prices.json' }, root);

        expect(load).toThrow(ConfigError);
        expect(load).toThrow(new RegExp(LLM_PRICING_FILE_VAR, 'u'));
    });
});
