import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    RULE_APPLICATION_SECTION_KEYWORDS,
    STATE_VERIFICATION_SECTION_KEYWORDS,
} from '../../src/knowledge/instruction-application';
import {
    APPLICATION_ROUTE_VALUES,
    ApplicationRoute,
} from '../../src/knowledge/instruction-application-route';
import { LinkedDocumentDownloadError } from '../../src/knowledge/linked-document-downloader';
import {
    InstructionLoadError,
    InstructionLoadFailureCode,
    MAX_INSTRUCTION_CHARACTERS,
    loadInstruction,
    toInstructionGuidanceSource,
} from '../../src/knowledge/instruction-loader';
import { MAX_LINKED_DOCUMENT_BYTES } from '../../src/knowledge/linked-document-downloader';
import {
    GuidanceDocumentOrigin,
    GuidanceDocumentRole,
    RuleGuidanceSourceKind,
} from '../../src/knowledge/guidance-source';

const INSTRUCTION_BODY = '# Run instructions\r\n\r\nFollow the linked syntax guide.\r\n';

/**
 * The Decision-2 default instruction path, written as the literal value the loader must probe;
 * pinning the literal keeps the probe honest whether or not the exported constant still agrees.
 */
const DECISION_2_DEFAULT_INSTRUCTION_PATH = '.github/filters-agent/AGENTS.md';

let checkoutRoot: string;

afterEach(() => {
    rmSync(checkoutRoot, { recursive: true, force: true });
});

function freshCheckout(): string {
    checkoutRoot = mkdtempSync(join(tmpdir(), 'instruction-loader-'));
    return checkoutRoot;
}

function writeCheckoutFile(relativePath: string, content: string): string {
    const absolutePath = join(checkoutRoot, relativePath);
    mkdirSync(join(absolutePath, '..'), { recursive: true });
    writeFileSync(absolutePath, content);
    return absolutePath;
}

function aFailureOf(promise: Promise<unknown>): Promise<unknown> {
    return promise.catch((error: unknown) => error);
}

function refusingFetch(): typeof fetch {
    return vi.fn() as unknown as typeof fetch;
}

function okFetch(body: string): { fetchImpl: typeof fetch; urls: string[] } {
    const urls: string[] = [];
    const fetchImpl = (async (input: unknown) => {
        urls.push(typeof input === 'string' ? input : String(input));
        return new Response(body, { status: 200, statusText: 'OK' });
    }) as typeof fetch;
    return { fetchImpl, urls };
}

describe('loadInstruction', () => {
    it('loads the .github/filters-agent/AGENTS.md default exactly as written', async () => {
        const root = freshCheckout();
        writeCheckoutFile(DECISION_2_DEFAULT_INSTRUCTION_PATH, INSTRUCTION_BODY);
        const expectedDigest = createHash('sha256').update(INSTRUCTION_BODY, 'utf8').digest('hex');

        const instruction = await loadInstruction({
            checkoutRoot: root,
            fetchImpl: refusingFetch(),
        });

        expect(instruction).not.toBeNull();
        expect(instruction?.path).toBe(DECISION_2_DEFAULT_INSTRUCTION_PATH);
        expect(instruction?.content).toBe(INSTRUCTION_BODY);
        expect(instruction?.sha256).toBe(expectedDigest);
        expect(instruction?.documents).toEqual([]);
    });

    it('returns null when the only instruction file is a root AGENTS.md', async () => {
        const root = freshCheckout();
        // Decision 2's collision rule: a repository's own root AGENTS.md belongs to its coding
        // agent and is never a run instruction, so a checkout carrying only that file stays in
        // built-in default mode.
        writeCheckoutFile('AGENTS.md', INSTRUCTION_BODY);

        await expect(
            loadInstruction({ checkoutRoot: root, fetchImpl: refusingFetch() }),
        ).resolves.toBeNull();
    });

    it('prefers an explicitly supplied checkout-relative instructionPath over the default', async () => {
        const root = freshCheckout();
        writeCheckoutFile(DECISION_2_DEFAULT_INSTRUCTION_PATH, 'default text that must lose\n');
        writeCheckoutFile('docs/run-instruction.md', '# Override\nOverride wins.\n');

        const instruction = await loadInstruction({
            checkoutRoot: root,
            instructionPath: 'docs/run-instruction.md',
            fetchImpl: refusingFetch(),
        });

        expect(instruction?.path).toBe('docs/run-instruction.md');
        expect(instruction?.content).toContain('Override wins.');
        expect(instruction?.content).not.toContain('must lose');
    });

    it('returns null only when the default is absent and no override is supplied', async () => {
        freshCheckout();

        await expect(
            loadInstruction({ checkoutRoot, fetchImpl: refusingFetch() }),
        ).resolves.toBeNull();
    });

    it('fails naming the path when an explicit override is missing', async () => {
        freshCheckout();

        const failure = await aFailureOf(
            loadInstruction({
                checkoutRoot,
                instructionPath: 'docs/absent-instruction.md',
                fetchImpl: refusingFetch(),
            }),
        );

        expect(failure).toBeInstanceOf(InstructionLoadError);
        expect((failure as InstructionLoadError).code).toBe(
            InstructionLoadFailureCode.InstructionUnreadable,
        );
        expect((failure as Error).message).toContain('docs/absent-instruction.md');
    });

    it('fails naming the path when an explicit override is unreadable', async () => {
        freshCheckout();
        mkdirSync(join(checkoutRoot, 'blocked-instruction'), { recursive: true });

        const failure = await aFailureOf(
            loadInstruction({
                checkoutRoot,
                instructionPath: 'blocked-instruction',
                fetchImpl: refusingFetch(),
            }),
        );

        expect(failure).toBeInstanceOf(InstructionLoadError);
        expect((failure as InstructionLoadError).code).toBe(
            InstructionLoadFailureCode.InstructionUnreadable,
        );
        expect((failure as Error).message).toContain('blocked-instruction');
    });

    it('binds one linked document per role, case-insensitively, first match wins', async () => {
        const root = freshCheckout();
        writeCheckoutFile(
            DECISION_2_DEFAULT_INSTRUCTION_PATH,
            [
                '# Instructions',
                'Read the [AdGuard SYNTAX guide](first-syntax.md) first,',
                'then the [syntax two](second-syntax.md) is ignored for an already-bound role.',
                'The [filter policy](policy.md) pages constrain every candidate.',
                'See [contributing guidelines](CONTRIBUTING.md) before proposing a rule.',
            ].join('\n'),
        );
        writeCheckoutFile('first-syntax.md', '# First syntax\nsyntax text\n');
        writeCheckoutFile('second-syntax.md', '# Second syntax\nunused text\n');
        writeCheckoutFile('policy.md', '# Policy\npolicy text\n');
        writeCheckoutFile('CONTRIBUTING.md', '# Contributing\ncontributing text\n');

        const instruction = await loadInstruction({
            checkoutRoot: root,
            fetchImpl: refusingFetch(),
        });

        expect(instruction?.documents).toHaveLength(3);
        const roles = instruction?.documents.map((document) => document.role);
        expect(roles).toEqual([
            GuidanceDocumentRole.Syntax,
            GuidanceDocumentRole.Policy,
            GuidanceDocumentRole.Contributing,
        ]);
        const syntax = instruction?.documents[0];
        expect(syntax?.origin).toBe(GuidanceDocumentOrigin.CheckoutFile);
        expect(syntax?.url).toBe('first-syntax.md');
        expect(syntax?.content).toBe('# First syntax\nsyntax text\n');
    });

    it('binds each role at most once and never reuses an already-taken URL', async () => {
        const root = freshCheckout();
        writeCheckoutFile(
            DECISION_2_DEFAULT_INSTRUCTION_PATH,
            [
                'The [filter policy](shared.md) comes first,',
                'then the [AdGuard syntax guide](shared.md) names the same target,',
                'and a [policy again](policy.md) link is ignored for an already-bound role.',
            ].join('\n'),
        );
        writeCheckoutFile('shared.md', 'shared text\n');
        writeCheckoutFile('policy.md', 'unused because policy is bound\n');

        const instruction = await loadInstruction({
            checkoutRoot: root,
            fetchImpl: refusingFetch(),
        });

        expect(instruction?.documents).toHaveLength(1);
        expect(instruction?.documents[0]?.role).toBe(GuidanceDocumentRole.Policy);
        expect(instruction?.documents[0]?.url).toBe('shared.md');
    });

    it('downloads https-linked documents through the bounded downloader', async () => {
        const root = freshCheckout();
        const remoteBody = '# Remote syntax\nsyntax text\n';
        const expectedDigest = createHash('sha256').update(remoteBody, 'utf8').digest('hex');
        writeCheckoutFile(
            DECISION_2_DEFAULT_INSTRUCTION_PATH,
            'Study the [AdGuard syntax guide](https://example.test/syntax.md) before anything else.\n',
        );
        const { fetchImpl, urls } = okFetch(remoteBody);

        const instruction = await loadInstruction({ checkoutRoot: root, fetchImpl });

        expect(urls).toEqual(['https://example.test/syntax.md']);
        expect(instruction?.documents).toHaveLength(1);
        expect(instruction?.documents[0]?.origin).toBe(GuidanceDocumentOrigin.Url);
        expect(instruction?.documents[0]?.url).toBe('https://example.test/syntax.md');
        expect(instruction?.documents[0]?.content).toBe(remoteBody);
        expect(instruction?.documents[0]?.sha256).toBe(expectedDigest);
    });

    it('fails naming the link when an https-linked document is unreachable', async () => {
        const root = freshCheckout();
        writeCheckoutFile(
            DECISION_2_DEFAULT_INSTRUCTION_PATH,
            'Study the [AdGuard syntax guide](https://example.test/missing.md) first.\n',
        );
        const fetchImpl = (async () => {
            throw new Error('connection refused');
        }) as typeof fetch;

        const failure = await aFailureOf(loadInstruction({ checkoutRoot: root, fetchImpl }));

        expect(failure).toBeInstanceOf(InstructionLoadError);
        expect((failure as InstructionLoadError).code).toBe(
            InstructionLoadFailureCode.DocumentUnreachable,
        );
        const message = (failure as Error).message;
        expect(message).toContain('https://example.test/missing.md');
        expect(message).toContain('AdGuard syntax guide');
        expect((failure as InstructionLoadError).cause).toBeInstanceOf(LinkedDocumentDownloadError);
    });

    it('fails naming the link when a linked checkout path does not exist', async () => {
        const root = freshCheckout();
        writeCheckoutFile(
            DECISION_2_DEFAULT_INSTRUCTION_PATH,
            'Read the [AdGuard syntax guide](docs/absent-syntax.md) first.\n',
        );

        const failure = await aFailureOf(
            loadInstruction({ checkoutRoot: root, fetchImpl: refusingFetch() }),
        );

        expect(failure).toBeInstanceOf(InstructionLoadError);
        expect((failure as InstructionLoadError).code).toBe(
            InstructionLoadFailureCode.DocumentUnreachable,
        );
        expect((failure as Error).message).toContain('docs/absent-syntax.md');
    });

    it('fails naming the link when a linked checkout path escapes the checkout', async () => {
        const root = freshCheckout();
        writeCheckoutFile(
            DECISION_2_DEFAULT_INSTRUCTION_PATH,
            'Read the [AdGuard syntax guide](../outside-checkout.md) first.\n',
        );

        const failure = await aFailureOf(
            loadInstruction({ checkoutRoot: root, fetchImpl: refusingFetch() }),
        );

        expect(failure).toBeInstanceOf(InstructionLoadError);
        expect((failure as InstructionLoadError).code).toBe(
            InstructionLoadFailureCode.DocumentUnreachable,
        );
        expect((failure as Error).message).toContain('../outside-checkout.md');
        expect((failure as Error).message).toContain('outside');
    });

    it('rejects an absolute filesystem link target outside the checkout', async () => {
        const root = freshCheckout();
        writeCheckoutFile(
            DECISION_2_DEFAULT_INSTRUCTION_PATH,
            'Read the [AdGuard syntax guide](/etc/hosts) first.\n',
        );

        const failure = await aFailureOf(
            loadInstruction({ checkoutRoot: root, fetchImpl: refusingFetch() }),
        );

        expect(failure).toBeInstanceOf(InstructionLoadError);
        expect((failure as InstructionLoadError).code).toBe(
            InstructionLoadFailureCode.DocumentUnreachable,
        );
        expect((failure as Error).message).toContain('/etc/hosts');
        expect((failure as Error).message).toContain('outside');
    });

    it('refuses an oversized linked checkout file instead of truncating it', async () => {
        const root = freshCheckout();
        writeCheckoutFile(
            DECISION_2_DEFAULT_INSTRUCTION_PATH,
            'Read the [AdGuard syntax guide](docs/huge-syntax.md) first.\n',
        );
        writeCheckoutFile('docs/huge-syntax.md', `x`.repeat(MAX_LINKED_DOCUMENT_BYTES + 1));

        const failure = await aFailureOf(
            loadInstruction({ checkoutRoot: root, fetchImpl: refusingFetch() }),
        );

        expect(failure).toBeInstanceOf(InstructionLoadError);
        expect((failure as InstructionLoadError).code).toBe(
            InstructionLoadFailureCode.DocumentUnreachable,
        );
        expect((failure as Error).message).toContain('docs/huge-syntax.md');
        expect((failure as Error).message).toContain('rather than truncated');
    });

    it('refuses an empty linked checkout file', async () => {
        const root = freshCheckout();
        writeCheckoutFile(
            DECISION_2_DEFAULT_INSTRUCTION_PATH,
            'Read the [AdGuard syntax guide](docs/empty.md) first.\n',
        );
        writeCheckoutFile('docs/empty.md', '');

        const failure = await aFailureOf(
            loadInstruction({ checkoutRoot: root, fetchImpl: refusingFetch() }),
        );

        expect(failure).toBeInstanceOf(InstructionLoadError);
        expect((failure as InstructionLoadError).code).toBe(
            InstructionLoadFailureCode.DocumentUnreachable,
        );
        expect((failure as Error).message).toContain('docs/empty.md');
        expect((failure as Error).message).toContain('empty');
    });

    it('fails naming the path when the instruction exceeds the character cap', async () => {
        const root = freshCheckout();
        writeCheckoutFile(
            DECISION_2_DEFAULT_INSTRUCTION_PATH,
            `${'x'.repeat(MAX_INSTRUCTION_CHARACTERS + 1)}\n`,
        );

        const failure = await aFailureOf(
            loadInstruction({ checkoutRoot: root, fetchImpl: refusingFetch() }),
        );

        expect(failure).toBeInstanceOf(InstructionLoadError);
        expect((failure as InstructionLoadError).code).toBe(
            InstructionLoadFailureCode.InstructionTooLarge,
        );
        expect((failure as Error).message).toContain(DECISION_2_DEFAULT_INSTRUCTION_PATH);
    });

    it('loads with zero documents when no link label names a guidance role', async () => {
        const root = freshCheckout();
        writeCheckoutFile(
            DECISION_2_DEFAULT_INSTRUCTION_PATH,
            [
                '# Instructions',
                'A [plain notes](notes.md) link names no guidance role.',
                'A [plain remote](https://example.test/readme.md) is not a guidance role either.',
            ].join('\n'),
        );
        writeCheckoutFile('notes.md', 'notes text\n');

        const instruction = await loadInstruction({
            checkoutRoot: root,
            fetchImpl: refusingFetch(),
        });

        expect(instruction).not.toBeNull();
        expect(instruction?.content).toContain('plain notes');
        expect(instruction?.documents).toEqual([]);
    });

    it('builds an instruction guidance source from the loaded instruction', async () => {
        const root = freshCheckout();
        writeCheckoutFile(
            DECISION_2_DEFAULT_INSTRUCTION_PATH,
            'See the [AdGuard syntax guide](syntax.md) first.\n',
        );
        writeCheckoutFile('syntax.md', '# Syntax\nsyntax text\n');

        const instruction = await loadInstruction({
            checkoutRoot: root,
            fetchImpl: refusingFetch(),
        });
        const source = toInstructionGuidanceSource(instruction!);

        expect(source.kind).toBe(RuleGuidanceSourceKind.Instruction);
        expect(source.path).toBe(DECISION_2_DEFAULT_INSTRUCTION_PATH);
        expect(source.sha256).toBe(instruction?.sha256);
        expect(source.documents).toEqual(instruction?.documents);
    });

    it('carries a declared placement to the run', async () => {
        const root = freshCheckout();
        writeCheckoutFile(
            DECISION_2_DEFAULT_INSTRUCTION_PATH,
            '# Run instruction\n\n## Placement\n\n' +
                'placement: filters/filters-{{year}}.txt comment: ! {{issueUrl}}\n',
        );

        const instruction = await loadInstruction({
            checkoutRoot: root,
            fetchImpl: refusingFetch(),
        });

        expect(instruction?.placement).toStrictEqual({
            byRuleType: {},
            unqualified: {
                pathTemplate: 'filters/filters-{{year}}.txt',
                commentTemplate: '! {{issueUrl}}',
            },
        });
    });

    it('leaves an instruction that declares no placement without one', async () => {
        const root = freshCheckout();
        writeCheckoutFile(DECISION_2_DEFAULT_INSTRUCTION_PATH, INSTRUCTION_BODY);

        const instruction = await loadInstruction({
            checkoutRoot: root,
            fetchImpl: refusingFetch(),
        });

        expect(instruction?.placement).toBeUndefined();
    });

    it('fails the load naming the instruction when the declared path is unusable', async () => {
        const root = freshCheckout();
        writeCheckoutFile(
            DECISION_2_DEFAULT_INSTRUCTION_PATH,
            'placement: /etc/filters-{{year}}.txt\n',
        );

        const error = await aFailureOf(
            loadInstruction({ checkoutRoot: root, fetchImpl: refusingFetch() }),
        );

        expect(error).toBeInstanceOf(InstructionLoadError);
        expect((error as InstructionLoadError).code).toBe(
            InstructionLoadFailureCode.InstructionPlacementInvalid,
        );
        expect((error as InstructionLoadError).message).toContain(
            DECISION_2_DEFAULT_INSTRUCTION_PATH,
        );
    });

    it('refuses a second unqualified declaration rather than picking one of them', async () => {
        const root = freshCheckout();
        writeCheckoutFile(
            DECISION_2_DEFAULT_INSTRUCTION_PATH,
            'placement: filters/filters-{{year}}.txt\n\nplacement: filters/other.txt\n',
        );

        const error = await aFailureOf(
            loadInstruction({ checkoutRoot: root, fetchImpl: refusingFetch() }),
        );

        expect((error as InstructionLoadError).code).toBe(
            InstructionLoadFailureCode.InstructionPlacementInvalid,
        );
    });

    it('reads no declaration out of a fenced example', async () => {
        const root = freshCheckout();
        writeCheckoutFile(
            DECISION_2_DEFAULT_INSTRUCTION_PATH,
            '# Run instruction\n\n```\nplacement: filters/example.txt\n```\n',
        );

        const instruction = await loadInstruction({
            checkoutRoot: root,
            fetchImpl: refusingFetch(),
        });

        expect(instruction?.placement).toBeUndefined();
    });

    it('refuses an instruction that declares a route and writes its own application contract', async () => {
        // Two answers to "how is a rule applied here", and the run can honour only one. Guessing
        // would silently ignore hand-written steps a repository believes are being performed.
        const root = freshCheckout();
        writeCheckoutFile(
            DECISION_2_DEFAULT_INSTRUCTION_PATH,
            [
                '# Run instruction',
                '',
                `application: ${ApplicationRoute.AdguardExtension}`,
                '',
                '## Rule application',
                '',
                '1. Save the candidate rule through the options page.',
                '',
                '## State verification',
                '',
                'read: extension-state user-rules',
                '',
            ].join('\n'),
        );

        const error = await aFailureOf(
            loadInstruction({ checkoutRoot: root, fetchImpl: refusingFetch() }),
        );

        expect(error).toBeInstanceOf(InstructionLoadError);
        expect((error as InstructionLoadError).code).toBe(
            InstructionLoadFailureCode.InstructionApplicationRouteInvalid,
        );
        // The refusal must be actionable from the message alone: which file, and which two facts
        // about it contradict each other.
        const message = (error as InstructionLoadError).message;
        expect(message).toContain(DECISION_2_DEFAULT_INSTRUCTION_PATH);
        expect(message).toContain(ApplicationRoute.AdguardExtension);
        expect(message).toContain(RULE_APPLICATION_SECTION_KEYWORDS[0]);
        expect(message).toContain(STATE_VERIFICATION_SECTION_KEYWORDS[0]);
    });

    it('refuses a declared route the host does not have, naming what it accepts', async () => {
        const root = freshCheckout();
        writeCheckoutFile(DECISION_2_DEFAULT_INSTRUCTION_PATH, 'application: ublock-origin\n');

        const error = await aFailureOf(
            loadInstruction({ checkoutRoot: root, fetchImpl: refusingFetch() }),
        );

        expect((error as InstructionLoadError).code).toBe(
            InstructionLoadFailureCode.InstructionApplicationRouteInvalid,
        );
        for (const accepted of APPLICATION_ROUTE_VALUES) {
            expect((error as InstructionLoadError).message).toContain(accepted);
        }
    });
});
