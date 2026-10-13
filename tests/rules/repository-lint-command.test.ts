import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import {
    lintPublishedCandidate,
    runRepositoryLint,
    type RepositoryLintCommand,
} from '../../src/rules/repository-lint-command';
import { RepositoryLintStatus } from '../../src/types/repository-lint';

const LIST_DIRECTORY = 'filters/sections';
const LIST_FILE = `${LIST_DIRECTORY}/specific.txt`;
const FORBIDDEN_TOKEN = 'forbidden-token';

/**
 * A stand-in repository linter: reports where the candidate file sits and whether it exists, then
 * fails on a forbidden token the way a real linter fails on a rule its configuration excludes.
 */
const LINT_SCRIPT = [
    'dirname "$1"',
    'test -f "$1" && echo present',
    `if grep -q '${FORBIDDEN_TOKEN}' "$1"; then echo "$PWD/$1: rule uses ${FORBIDDEN_TOKEN}"; exit 1; fi`,
    'exit 0',
].join('\n');

const logger = pino({ level: 'silent' });

let root: string;
let lint: RepositoryLintCommand;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'repository-lint-'));
    mkdirSync(join(root, LIST_DIRECTORY), { recursive: true });
    writeFileSync(join(root, LIST_FILE), 'example.org##.ad\n');
    writeFileSync(join(root, 'lint.sh'), LINT_SCRIPT);
    lint = { command: 'sh ./lint.sh', checkoutRoot: root };
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

describe('repository lint command', () => {
    it('lints the candidate from the target list directory and removes the file afterwards', async () => {
        const result = await runRepositoryLint(
            lint,
            { rule: 'example.com##.banner', filePath: LIST_FILE },
            logger,
        );

        expect(result.status).toBe(RepositoryLintStatus.Clean);
        expect(result.output.split('\n').slice(0, 2)).toEqual([LIST_DIRECTORY, 'present']);
        expect(readdirSync(join(root, LIST_DIRECTORY))).toEqual(['specific.txt']);
    });

    it('turns a failing command into a note carrying its checkout-relative output', async () => {
        const note = await lintPublishedCandidate(
            lint,
            { rule: `example.com##.${FORBIDDEN_TOKEN}`, filePath: LIST_FILE },
            logger,
        );

        expect(note).toMatchObject({
            status: RepositoryLintStatus.Problems,
            command: lint.command,
            exitCode: 1,
            outputTruncated: false,
        });
        expect(note?.output).toContain(`rule uses ${FORBIDDEN_TOKEN}`);
        expect(note?.output).toContain(`${LIST_DIRECTORY}/`);
        expect(note?.output).not.toContain(root);
        expect(readdirSync(join(root, LIST_DIRECTORY))).toEqual(['specific.txt']);
    });

    it('says nothing about a candidate the command passes', async () => {
        await expect(
            lintPublishedCandidate(
                lint,
                { rule: 'example.com##.banner', filePath: LIST_FILE },
                logger,
            ),
        ).resolves.toBeUndefined();
    });

    it('turns a command that cannot start into a not-run note with the reason', async () => {
        const note = await lintPublishedCandidate(
            { command: 'filters-agent-no-such-linter', checkoutRoot: root },
            { rule: 'example.com##.banner', filePath: LIST_FILE },
            logger,
        );

        expect(note?.status).toBe(RepositoryLintStatus.NotRun);
        expect(note?.detail).toMatch(/could not find or execute/u);
        expect(readdirSync(join(root, LIST_DIRECTORY))).toEqual(['specific.txt']);
    });

    it('refuses to place the candidate outside the checkout', async () => {
        const result = await runRepositoryLint(
            lint,
            { rule: 'example.com##.banner', filePath: '../outside/list.txt' },
            logger,
        );

        expect(result.status).toBe(RepositoryLintStatus.NotRun);
        expect(result.detail).toMatch(/outside the checkout|does not exist/u);
    });

    it('runs nothing when the run has no lint command', async () => {
        await expect(
            lintPublishedCandidate(
                undefined,
                { rule: `example.com##.${FORBIDDEN_TOKEN}`, filePath: LIST_FILE },
                logger,
            ),
        ).resolves.toBeUndefined();
    });
});
