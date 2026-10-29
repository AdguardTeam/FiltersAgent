import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Level } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import type { Logger } from '../../src/logger/logger';
import { reportRepositorySkills } from '../../src/pi/repository-skills-report';
import { REPORT_STYLE_SKILL, SKILL_FILE_NAME, writeSkill } from './skill-fixtures';

/**
 * One captured logger call: the level it was made at, the structured payload and the message.
 */
interface LogEntry {
    /**
     * Pino level the call was made at.
     */
    level: Level;

    /**
     * Structured payload the call carried.
     */
    payload: unknown;

    /**
     * Message text of the call.
     */
    message: string;
}

/**
 * Directories created for the running scenario, removed after each test.
 */
const createdDirs: string[] = [];

afterEach(() => {
    for (const dir of createdDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

/**
 * Create the skills directory of one scenario, inside a throwaway root.
 *
 * @returns Absolute path of the (not yet created) skills directory.
 */
function skillsDirPath(): string {
    const root = mkdtempSync(join(tmpdir(), 'repository-skills-report-'));
    createdDirs.push(root);
    return join(root, 'skills');
}

/**
 * Build a logger that records every call at the level it was made at.
 *
 * @param entries - Collector every call is appended to.
 * @returns The capturing logger.
 */
function capturingLogger(entries: LogEntry[]): Logger {
    const record =
        (level: Level) =>
        (payload: unknown, message?: string): void => {
            entries.push({ level, payload, message: message ?? '' });
        };
    return {
        fatal: record('fatal'),
        error: record('error'),
        warn: record('warn'),
        info: record('info'),
        debug: record('debug'),
        trace: record('trace'),
    } as unknown as Logger;
}

/**
 * Report one skills directory and return what was logged.
 *
 * @param skillsDir - The directory to report.
 * @returns Every captured logger call.
 */
function report(skillsDir: string): LogEntry[] {
    const entries: LogEntry[] = [];
    reportRepositorySkills(skillsDir, capturingLogger(entries));
    return entries;
}

/**
 * The entries logged at one level.
 *
 * @param entries - Every captured logger call.
 * @param level - The level to keep.
 * @returns The entries made at that level.
 */
function atLevel(entries: LogEntry[], level: Level): LogEntry[] {
    return entries.filter((entry) => entry.level === level);
}

describe('reportRepositorySkills', () => {
    it('warns about a skill pi skipped and names the winner of a name collision', () => {
        const skillsDir = skillsDirPath();
        const firstCopy = writeSkill(skillsDir, REPORT_STYLE_SKILL);
        const secondCopy = join(skillsDir, 'second-copy', SKILL_FILE_NAME);
        mkdirSync(dirname(secondCopy));
        writeFileSync(
            secondCopy,
            [
                '---',
                `name: ${REPORT_STYLE_SKILL.name}`,
                'description: A second copy.',
                '---',
                REPORT_STYLE_SKILL.body,
            ].join('\n'),
            'utf8',
        );
        const brokenFile = writeSkill(skillsDir, {
            name: 'broken-style',
            body: REPORT_STYLE_SKILL.body,
        });

        const warnings = atLevel(report(skillsDir), 'warn');

        expect(warnings).toContainEqual(
            expect.objectContaining({
                payload: expect.objectContaining({
                    path: brokenFile,
                    message: expect.any(String),
                }),
            }),
        );
        // Which copy wins depends on the directory listing order, so either may be the winner;
        // the warning must name both, the skipped one as its path and the used one as the winner.
        expect(warnings).toContainEqual(
            expect.objectContaining({
                payload: expect.toSatisfy(
                    (payload: { path?: string; winnerPath?: string }) =>
                        [payload.path, payload.winnerPath].sort().join('\n') ===
                        [firstCopy, secondCopy].sort().join('\n'),
                ),
            }),
        );
    });

    it('warns that a skill with model invocation disabled is never shown to the model', () => {
        const skillsDir = skillsDirPath();
        writeSkill(skillsDir, REPORT_STYLE_SKILL);
        const hiddenFile = writeSkill(skillsDir, {
            name: 'hidden-style',
            description: 'A skill only a user could invoke.',
            disableModelInvocation: true,
            body: REPORT_STYLE_SKILL.body,
        });

        const entries = report(skillsDir);

        expect(atLevel(entries, 'warn')).toContainEqual(
            expect.objectContaining({ payload: expect.objectContaining({ path: hiddenFile }) }),
        );
        expect(atLevel(entries, 'info')).toContainEqual(
            expect.objectContaining({
                payload: expect.objectContaining({ count: 1, names: [REPORT_STYLE_SKILL.name] }),
            }),
        );
    });

    it.each([
        {
            name: 'the directory is empty',
            plant: (skillsDir: string) => {
                mkdirSync(skillsDir, { recursive: true });
            },
        },
        {
            name: 'the skill file is not spelled SKILL.md',
            plant: (skillsDir: string) => {
                const skillFile = writeSkill(skillsDir, REPORT_STYLE_SKILL);
                rmSync(skillFile);
                writeFileSync(
                    join(skillsDir, REPORT_STYLE_SKILL.name, 'skill.md'),
                    REPORT_STYLE_SKILL.body,
                    'utf8',
                );
            },
        },
        {
            name: 'the only skill sits under a dot-folder',
            plant: (skillsDir: string) => {
                writeSkill(join(skillsDir, '.hidden'), REPORT_STYLE_SKILL);
            },
        },
    ])('warns once, naming the directory, when no skill loaded because $name', ({ plant }) => {
        const skillsDir = skillsDirPath();
        plant(skillsDir);

        const warnings = atLevel(report(skillsDir), 'warn');

        expect(warnings).toEqual([
            expect.objectContaining({
                payload: expect.objectContaining({ dir: skillsDir }),
                message: expect.any(String),
            }),
        ]);
    });

    it('logs the count and names of the skills the model is shown at info', () => {
        const skillsDir = skillsDirPath();
        writeSkill(skillsDir, REPORT_STYLE_SKILL);
        writeSkill(skillsDir, {
            name: 'triage-style',
            description: 'How this repository triages an issue.',
            body: REPORT_STYLE_SKILL.body,
        });

        const entries = report(skillsDir);

        expect(atLevel(entries, 'warn')).toEqual([]);
        expect(atLevel(entries, 'info')).toContainEqual(
            expect.objectContaining({
                payload: expect.objectContaining({
                    count: 2,
                    names: expect.arrayContaining([REPORT_STYLE_SKILL.name, 'triage-style']),
                }),
            }),
        );
    });
});
