import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import {
    GuidanceDocumentOrigin,
    GuidanceDocumentRole,
} from '../../../src/knowledge/guidance-source';
import { loadRunInstruction } from '../../../lab/local/instruction-provisioning';

let root: string | undefined;

afterEach(() => {
    if (root !== undefined) {
        rmSync(root, { recursive: true, force: true });
    }
    root = undefined;
});

describe('loadRunInstruction roster logging', () => {
    it('logs each linked document with its role, URL, and exact digest at load', async () => {
        root = mkdtempSync(join(tmpdir(), 'instruction-provisioning-'));
        const checkoutRoot = join(root, 'checkout');
        mkdirSync(checkoutRoot, { recursive: true });
        const syntaxBytes = 'uBO static filter syntax reference text.\n';
        const policyBytes = 'Filter policy: do not break pages.\n';
        mkdirSync(join(checkoutRoot, 'docs'), { recursive: true });
        writeFileSync(join(checkoutRoot, 'docs/syntax-guide.md'), syntaxBytes, 'utf8');
        writeFileSync(join(checkoutRoot, 'docs/policy.md'), policyBytes, 'utf8');
        // The instruction sits at the default probe path: a root `AGENTS.md` alone is a coding
        // agent's file and never a run instruction (the Decision-2 collision rule).
        mkdirSync(join(checkoutRoot, '.github/filters-agent'), { recursive: true });
        writeFileSync(
            join(checkoutRoot, '.github/filters-agent/AGENTS.md'),
            [
                '# Agent instruction',
                '',
                'Follow [the uBO filter syntax reference](docs/syntax-guide.md) when you build',
                'candidate rules and [the filtering policy](docs/policy.md) when you review them.',
                '',
            ].join('\n'),
            'utf8',
        );
        const info = vi.fn();
        const logger = { info, warn: vi.fn(), error: vi.fn() } as unknown as Logger;

        const instruction = await loadRunInstruction(checkoutRoot, undefined, logger);

        expect(instruction).not.toBeNull();
        expect(info).toHaveBeenCalledTimes(1);
        const [context, message] = info.mock.calls[0] ?? [];
        // The log is the roster for post-mortem diagnosis: one entry per linked document carrying
        // its own role, URL, and digest, plus the instruction's own digest. Digests are opaque
        // file identifiers, so no redaction applies — and credential URLs cannot appear at all,
        // because the loader refuses them at load time and they never join a roster.
        expect(message).toContain('run instruction loaded');
        expect(context).toMatchObject({
            instruction: {
                path: '.github/filters-agent/AGENTS.md',
                digest: createHash('sha256')
                    .update(
                        [
                            '# Agent instruction',
                            '',
                            'Follow [the uBO filter syntax reference](docs/syntax-guide.md) when you build',
                            'candidate rules and [the filtering policy](docs/policy.md) when you review them.',
                            '',
                        ].join('\n'),
                        'utf8',
                    )
                    .digest('hex'),
            },
        });
        expect(context).toMatchObject({
            instruction: {
                documents: [
                    {
                        role: GuidanceDocumentRole.Syntax,
                        origin: GuidanceDocumentOrigin.CheckoutFile,
                        url: 'docs/syntax-guide.md',
                        digest: createHash('sha256').update(syntaxBytes, 'utf8').digest('hex'),
                    },
                    {
                        role: GuidanceDocumentRole.Policy,
                        origin: GuidanceDocumentOrigin.CheckoutFile,
                        url: 'docs/policy.md',
                        digest: createHash('sha256').update(policyBytes, 'utf8').digest('hex'),
                    },
                ],
            },
        });
    });
});
