import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SESSION_SKILLS_ROOT } from '../../src/pi/session-logical-paths';
import {
    createSkillsReadTool,
    SKILLS_READ_BINARY_MESSAGE,
    SKILLS_READ_OUTSIDE_MESSAGE,
    skillsReadLongLineMessage,
} from '../../src/pi/skills-read-tool';
import { logicalSkillFile, REPORT_STYLE_SKILL, writeSkill } from './skill-fixtures';

/**
 * What the read tool's model-facing description says in this suite; the adapter passes it through
 * unchanged, so its exact text is not what any assertion here reads.
 */
const READ_DESCRIPTION = 'Read one file of a repository skill.';

/**
 * Text of the sibling `AGENTS.md` no read may ever return.
 */
const OUTSIDE_TEXT = 'Outside instructions that must never reach the model.\n';

/**
 * Text of the markdown file a skill keeps beside its `SKILL.md`.
 */
const NOTES_TEXT = 'Notes next to the skill file.\n';

/**
 * Text of the reference file a skill links beside its `SKILL.md`.
 */
const REFERENCE_TEXT = 'Reference text next to the skill.\n';

/**
 * Text of the markdown file in the sibling directory whose name merely starts like the skills
 * directory, the prefix trap a raw string comparison would fall for.
 */
const SIBLING_TEXT = 'Sibling directory text.\n';

/**
 * Bytes of the binary fixture: a NUL byte makes it binary, and the marker text proves none of its
 * content came back.
 */
const BINARY_BYTES = Buffer.from('secret-binary-marker\u0000payload', 'utf8');

/**
 * One line longer than pi's per-read byte limit, the shape of a minified JSON reference.
 */
const LONG_LINE = 'x'.repeat(60_000);

/**
 * The skill's reference file, as a path relative to the skills directory.
 */
const REFERENCE_PATH = posix.join(REPORT_STYLE_SKILL.name, 'references', 'x.md');

/**
 * A reference file the skill does not have, as a path relative to the skills directory.
 */
const MISSING_PATH = posix.join(REPORT_STYLE_SKILL.name, 'references', 'missing.md');

/**
 * Directories created for the running scenario, removed after each test.
 */
const createdDirs: string[] = [];

/**
 * Create one throwaway directory for the running scenario.
 *
 * @returns Absolute path to the created directory.
 */
function scratchDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'skills-read-tool-'));
    createdDirs.push(dir);
    return dir;
}

afterEach(() => {
    for (const dir of createdDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

/**
 * One on-disk scenario: the skills directory pi would load, a valid skill inside it, and everything
 * a read must refuse.
 */
interface SkillsFixture {
    /**
     * Root holding the skills directory and its neighbours.
     */
    root: string;

    /**
     * Directory the confined read tool is rooted at.
     */
    skillsDir: string;

    /**
     * Absolute path of the valid skill's `SKILL.md`.
     */
    skillFile: string;

    /**
     * Absolute path of the markdown file the skill keeps beside its `SKILL.md`.
     */
    notesFile: string;

    /**
     * Absolute path of the markdown file the skill links beside its `SKILL.md`.
     */
    referenceFile: string;

    /**
     * Absolute path of the `AGENTS.md` beside the skills directory.
     */
    outsideFile: string;

    /**
     * Absolute path of the markdown file in the sibling directory.
     */
    siblingFile: string;

    /**
     * The confined read tool over `skillsDir`.
     */
    readTool: ReturnType<typeof createSkillsReadTool>;
}

/**
 * Materialize the scenario every test in this suite reads from.
 *
 * @returns The scenario and its confined read tool.
 */
function skillsFixture(): SkillsFixture {
    const root = scratchDir();
    const skillsDir = join(root, 'skills');
    const skillFile = writeSkill(skillsDir, REPORT_STYLE_SKILL);
    const referenceFile = join(skillsDir, REFERENCE_PATH);
    mkdirSync(dirname(referenceFile), { recursive: true });
    writeFileSync(referenceFile, REFERENCE_TEXT, 'utf8');
    const notesFile = join(dirname(skillFile), 'notes.md');
    writeFileSync(notesFile, NOTES_TEXT, 'utf8');
    const outsideFile = join(root, 'AGENTS.md');
    writeFileSync(outsideFile, OUTSIDE_TEXT, 'utf8');
    const siblingDir = join(root, 'skills-other');
    mkdirSync(siblingDir, { recursive: true });
    const siblingFile = join(siblingDir, 'other.md');
    writeFileSync(siblingFile, SIBLING_TEXT, 'utf8');
    return {
        root,
        skillsDir,
        skillFile,
        notesFile,
        referenceFile,
        outsideFile,
        siblingFile,
        readTool: createSkillsReadTool(skillsDir, READ_DESCRIPTION),
    };
}

describe('createSkillsReadTool', () => {
    it('reads SKILL.md by its listed location and a file by a path built from it', async () => {
        const fixture = skillsFixture();
        const listed = logicalSkillFile(REPORT_STYLE_SKILL.name);

        const skill = await fixture.readTool.execute({ path: listed }, undefined);
        const reference = await fixture.readTool.execute(
            { path: posix.join(posix.dirname(listed), 'references', 'x.md') },
            undefined,
        );

        expect(skill.content).toBe(readFileSync(fixture.skillFile, 'utf8'));
        expect(reference.content).toBe(REFERENCE_TEXT);
    });

    it('still reads a file inside the directory by its real absolute path', async () => {
        const fixture = skillsFixture();

        const notes = await fixture.readTool.execute({ path: fixture.notesFile }, undefined);

        expect(notes.content).toBe(NOTES_TEXT);
    });

    it('resolves a relative path against the skills directory', async () => {
        const fixture = skillsFixture();

        const result = await fixture.readTool.execute({ path: REFERENCE_PATH }, undefined);

        expect(result.content).toBe(REFERENCE_TEXT);
    });

    it.each([
        {
            name: 'a parent-relative path',
            target: (_fixture: SkillsFixture) => '../AGENTS.md',
        },
        {
            name: 'the absolute path of a file beside the directory',
            target: (fixture: SkillsFixture) => fixture.outsideFile,
        },
        {
            name: 'a symlink inside a skill folder pointing outside',
            target: (fixture: SkillsFixture) => {
                const linkPath = join(dirname(fixture.skillFile), 'agents-link.md');
                symlinkSync(fixture.outsideFile, linkPath);
                return linkPath;
            },
        },
        {
            name: 'the absolute path of a file in a sibling directory',
            target: (fixture: SkillsFixture) => fixture.siblingFile,
        },
        {
            name: 'a logical path climbing out of the skills root',
            target: (_fixture: SkillsFixture) => `${SESSION_SKILLS_ROOT}/../AGENTS.md`,
        },
    ])('refuses $name', async ({ target }) => {
        const fixture = skillsFixture();

        const error = await fixture.readTool
            .execute({ path: target(fixture) }, undefined)
            .catch((thrown: unknown) => thrown);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(SKILLS_READ_OUTSIDE_MESSAGE);
        expect((error as Error).message).not.toContain(OUTSIDE_TEXT);
        expect((error as Error).message).not.toContain(SIBLING_TEXT);
    });

    it('follows a symlink that stays inside the skills directory', async () => {
        const fixture = skillsFixture();
        const linkPath = join(dirname(fixture.skillFile), 'alias.md');
        symlinkSync(fixture.referenceFile, linkPath);

        const result = await fixture.readTool.execute({ path: linkPath }, undefined);

        expect(result.content).toBe(REFERENCE_TEXT);
    });

    it.each([
        { name: 'a relative path', target: MISSING_PATH },
        { name: 'a logical path', target: posix.join(SESSION_SKILLS_ROOT, MISSING_PATH) },
    ])(
        'reports a missing file asked by $name as missing, naming the asked path only',
        async ({ target }) => {
            const fixture = skillsFixture();

            const error = await fixture.readTool
                .execute({ path: target }, undefined)
                .catch((thrown: unknown) => thrown);

            expect(error).toBeInstanceOf(Error);
            const { message } = error as Error;
            expect(message).not.toContain(SKILLS_READ_OUTSIDE_MESSAGE);
            expect(message).toContain(MISSING_PATH);
            expect(message).not.toContain(fixture.root);
        },
    );

    it('refuses a binary file inside a skill folder', async () => {
        const fixture = skillsFixture();
        const binaryFile = join(dirname(fixture.skillFile), 'blob.bin');
        writeFileSync(binaryFile, BINARY_BYTES);

        const error = await fixture.readTool
            .execute({ path: binaryFile }, undefined)
            .catch((thrown: unknown) => thrown);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(SKILLS_READ_BINARY_MESSAGE);
        expect((error as Error).message).not.toContain('secret-binary-marker');
    });

    it('refuses a file whose only line is over the read limit, without pointing at bash', async () => {
        const fixture = skillsFixture();
        const minified = join(dirname(fixture.skillFile), 'references', 'minified.json');
        writeFileSync(minified, LONG_LINE, 'utf8');

        const error = await fixture.readTool
            .execute({ path: minified }, undefined)
            .catch((thrown: unknown) => thrown);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(skillsReadLongLineMessage(1));
        expect((error as Error).message).not.toContain('bash');
    });

    it('reads around a long line: up to it, refused at it, and on from the next line', async () => {
        const fixture = skillsFixture();
        const mixed = join(dirname(fixture.skillFile), 'references', 'mixed.md');
        writeFileSync(mixed, ['first line', 'second line', LONG_LINE, 'fourth line'].join('\n'));

        const head = await fixture.readTool.execute({ path: mixed }, undefined);
        const atLong = await fixture.readTool
            .execute({ path: mixed, offset: 3 }, undefined)
            .catch((thrown: unknown) => thrown);
        const after = await fixture.readTool.execute({ path: mixed, offset: 4 }, undefined);

        expect(head.content).toContain('first line\nsecond line');
        expect(head.content).toContain('offset=3');
        expect(head.content).not.toContain(LONG_LINE.slice(0, 100));
        expect(atLong).toBeInstanceOf(Error);
        expect((atLong as Error).message).toBe(skillsReadLongLineMessage(3));
        expect(after.content).toBe('fourth line');
    });
});
