import {
    existsSync,
    mkdtempSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
    cleanupUnpublishedLocalPublicationReservation,
    clearLocalRunOutputDir,
    destroyReservedLocalPublicationGeneration,
    LOCAL_RUN_OUTPUT_MARKER_NAME,
    listPublishedLocalGenerations,
    markLocalPublicationPublished,
    materializeLocalRunOutputDir,
    reserveLocalPublicationGeneration,
    resolveLocalRunOutputDir,
    validateLocalRunOutputDir,
    writeReservedPublicationFile,
} from '../../src/local/output-directory';

/**
 * A path another process creates at the moment this one tries to, and what it creates there.
 */
const concurrentCreation = vi.hoisted(() => ({
    path: undefined as string | undefined,
    create: undefined as ((path: string) => void) | undefined,
}));

vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return {
        ...actual,
        mkdirSync: (...args: Parameters<typeof actual.mkdirSync>) => {
            const [path] = args;
            if (path === concurrentCreation.path && concurrentCreation.create) {
                concurrentCreation.path = undefined;
                concurrentCreation.create(String(path));
            }
            return actual.mkdirSync(...args);
        },
    };
});

describe('resolveLocalRunOutputDir', () => {
    it('defaults current and historical runs to separate project-local tmp directories', () => {
        const workspaceRoot = '/tmp/filters-agent';

        expect(resolveLocalRunOutputDir(workspaceRoot, 4, 'current')).toBe(
            join(workspaceRoot, 'tmp', 'adguard-agent-runs', 'issue-4-current'),
        );
        expect(resolveLocalRunOutputDir(workspaceRoot, 4, 'historical')).toBe(
            join(workspaceRoot, 'tmp', 'adguard-agent-runs', 'issue-4-historical'),
        );
    });

    it('preserves an explicit absolute output directory', () => {
        expect(
            resolveLocalRunOutputDir('/tmp/filters-agent', 4, 'historical', '/tmp/custom-run'),
        ).toBe('/tmp/custom-run');
    });
});

describe('validateLocalRunOutputDir', () => {
    it('allows the ignored project-local tmp tree', () => {
        const workspaceRoot = '/tmp/filters-agent';
        const outputDir = join(workspaceRoot, 'tmp', 'adguard-agent-runs', 'issue-4-current');

        expect(validateLocalRunOutputDir(outputDir, workspaceRoot)).toBe(outputDir);
    });

    it('keeps supporting absolute output directories outside the workspace', () => {
        expect(
            validateLocalRunOutputDir(
                '/tmp/adguard-agent-runs/issue-4-current',
                '/tmp/filters-agent',
            ),
        ).toBe('/tmp/adguard-agent-runs/issue-4-current');
    });

    it('rejects arbitrary locations inside the workspace', () => {
        expect(() =>
            validateLocalRunOutputDir(
                '/tmp/filters-agent/.benchmark/results',
                '/tmp/filters-agent',
            ),
        ).toThrow(/project tmp/i);
    });
});

describe('materializeLocalRunOutputDir', () => {
    it('rejects an existing nonempty external directory without changing it', () => {
        const root = mkdtempSync(join(tmpdir(), 'local-output-nonempty-'));
        const workspaceRoot = join(root, 'workspace');
        const outputDir = join(root, 'external-output');
        mkdirSync(workspaceRoot);
        mkdirSync(outputDir);
        writeFileSync(join(outputDir, 'keep.txt'), 'keep', 'utf8');

        try {
            expect(() => materializeLocalRunOutputDir(outputDir, workspaceRoot)).toThrow(
                /not owned|nonempty/i,
            );
            expect(readFileSync(join(outputDir, 'keep.txt'), 'utf8')).toBe('keep');
            expect(existsSync(join(outputDir, LOCAL_RUN_OUTPUT_MARKER_NAME))).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('claims an empty dedicated directory and safely clears it on a rerun', () => {
        const root = mkdtempSync(join(tmpdir(), 'local-output-owned-rerun-'));
        const workspaceRoot = join(root, 'workspace');
        const outputDir = join(root, 'external-output');
        mkdirSync(workspaceRoot);
        mkdirSync(outputDir);

        try {
            const canonicalOutput = materializeLocalRunOutputDir(outputDir, workspaceRoot);
            const markerPath = join(canonicalOutput, LOCAL_RUN_OUTPUT_MARKER_NAME);
            expect(readFileSync(markerPath, 'utf8')).toMatch(/adguard-filters-agent/u);
            writeFileSync(join(canonicalOutput, 'stale.txt'), 'stale', 'utf8');

            expect(clearLocalRunOutputDir(outputDir, workspaceRoot)).toBe(canonicalOutput);
            expect(readdirSync(canonicalOutput)).toEqual([LOCAL_RUN_OUTPUT_MARKER_NAME]);

            writeFileSync(join(canonicalOutput, 'second-run.txt'), 'stale', 'utf8');
            expect(clearLocalRunOutputDir(outputDir, workspaceRoot)).toBe(canonicalOutput);
            expect(readdirSync(canonicalOutput)).toEqual([LOCAL_RUN_OUTPUT_MARKER_NAME]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('removes an owned child symlink without following it outside the output leaf', () => {
        const root = mkdtempSync(join(tmpdir(), 'local-output-child-link-'));
        const workspaceRoot = join(root, 'workspace');
        const outputDir = join(root, 'external-output');
        const targetDir = join(root, 'target');
        mkdirSync(workspaceRoot);
        mkdirSync(outputDir);
        mkdirSync(targetDir);
        writeFileSync(join(targetDir, 'keep.txt'), 'keep', 'utf8');

        try {
            materializeLocalRunOutputDir(outputDir, workspaceRoot);
            symlinkSync(targetDir, join(outputDir, 'linked-artifacts'), 'dir');

            clearLocalRunOutputDir(outputDir, workspaceRoot);

            expect(readFileSync(join(targetDir, 'keep.txt'), 'utf8')).toBe('keep');
            expect(existsSync(join(outputDir, 'linked-artifacts'))).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it.each([
        ['filesystem root', parse(process.cwd()).root],
        ['home directory', homedir()],
        ['system temporary root', tmpdir()],
    ])('rejects the %s as a run output directory', (_label, outputDir) => {
        expect(() => materializeLocalRunOutputDir(outputDir, process.cwd())).toThrow(
            /dedicated|root|home|temporary/i,
        );
    });

    it('rejects the shared project tmp root even when it is empty', () => {
        const workspaceRoot = mkdtempSync(join(tmpdir(), 'local-output-tmp-root-'));
        const tmpPath = join(workspaceRoot, 'tmp');
        mkdirSync(tmpPath);

        try {
            expect(() => materializeLocalRunOutputDir(tmpPath, workspaceRoot)).toThrow(
                /dedicated|project tmp/i,
            );
            expect(readdirSync(tmpPath)).toEqual([]);
        } finally {
            rmSync(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('rejects a final output-directory symlink without claiming or clearing its target', () => {
        const root = mkdtempSync(join(tmpdir(), 'local-output-final-link-'));
        const workspaceRoot = join(root, 'workspace');
        const target = join(root, 'target');
        const outputLink = join(root, 'output-link');
        mkdirSync(workspaceRoot);
        mkdirSync(target);
        symlinkSync(target, outputLink, 'dir');

        try {
            expect(() => materializeLocalRunOutputDir(outputLink, workspaceRoot)).toThrow(
                /symlink/i,
            );
            expect(readdirSync(target)).toEqual([]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('rejects a symlinked ownership marker without touching the linked file', () => {
        const root = mkdtempSync(join(tmpdir(), 'local-output-marker-link-'));
        const workspaceRoot = join(root, 'workspace');
        const outputDir = join(root, 'output');
        const target = join(root, 'target.txt');
        mkdirSync(workspaceRoot);
        mkdirSync(outputDir);
        writeFileSync(target, 'keep', 'utf8');
        symlinkSync(target, join(outputDir, LOCAL_RUN_OUTPUT_MARKER_NAME));

        try {
            expect(() => materializeLocalRunOutputDir(outputDir, workspaceRoot)).toThrow(
                /marker|symlink|owned/i,
            );
            expect(readFileSync(target, 'utf8')).toBe('keep');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('rejects a symlink component beneath the project tmp boundary', () => {
        const workspaceRoot = mkdtempSync(join(tmpdir(), 'local-output-workspace-'));
        const trackedDirectory = join(workspaceRoot, 'benchmark');
        const tmpPath = join(workspaceRoot, 'tmp');
        mkdirSync(trackedDirectory);
        mkdirSync(tmpPath);
        symlinkSync(trackedDirectory, join(tmpPath, 'redirect'));

        try {
            expect(() =>
                materializeLocalRunOutputDir(join(tmpPath, 'redirect', 'run'), workspaceRoot),
            ).toThrow(/symlink/i);
        } finally {
            rmSync(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('shares a fresh output root with a run that creates the same parent concurrently', () => {
        const workspaceRoot = mkdtempSync(join(tmpdir(), 'local-output-concurrent-'));
        const sharedRoot = join(workspaceRoot, 'tmp', 'series');
        concurrentCreation.path = sharedRoot;
        concurrentCreation.create = (path) => mkdirSync(path);

        try {
            const canonicalOutput = materializeLocalRunOutputDir(
                join(sharedRoot, 'runs', 'case'),
                workspaceRoot,
            );
            expect(existsSync(join(canonicalOutput, LOCAL_RUN_OUTPUT_MARKER_NAME))).toBe(true);
        } finally {
            concurrentCreation.path = undefined;
            rmSync(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('rejects a symlink planted where it was about to create an output component', () => {
        const workspaceRoot = mkdtempSync(join(tmpdir(), 'local-output-concurrent-link-'));
        const trackedDirectory = join(workspaceRoot, 'benchmark');
        const plantedPath = join(workspaceRoot, 'tmp', 'series');
        mkdirSync(trackedDirectory);
        concurrentCreation.path = plantedPath;
        concurrentCreation.create = (path) => symlinkSync(trackedDirectory, path);

        try {
            expect(() =>
                materializeLocalRunOutputDir(join(plantedPath, 'run'), workspaceRoot),
            ).toThrow(/symlink/i);
            expect(readdirSync(trackedDirectory)).toEqual([]);
        } finally {
            concurrentCreation.path = undefined;
            rmSync(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('rejects an external lexical path that resolves into tracked workspace content', () => {
        const root = mkdtempSync(join(tmpdir(), 'local-output-external-link-'));
        const workspaceRoot = join(root, 'workspace');
        const trackedDirectory = join(workspaceRoot, 'benchmark');
        const externalLink = join(root, 'external-run');
        const requestedOutput = join(externalLink, 'new-run');
        mkdirSync(trackedDirectory, { recursive: true });
        mkdirSync(join(workspaceRoot, 'tmp'));
        symlinkSync(trackedDirectory, externalLink);

        try {
            expect(() => materializeLocalRunOutputDir(requestedOutput, workspaceRoot)).toThrow(
                /project tmp|escapes/i,
            );
            expect(existsSync(join(trackedDirectory, 'new-run'))).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('append-only publication generations', () => {
    it.each([
        '../escape',
        '/absolute',
        'with/slash',
        'with\\backslash',
        '.',
        '..',
        'UPPERCASE-0000-0000-0000-000000000000',
        '00000000-0000-0000-0000-00000000000\0',
        '',
    ])('rejects an invalid generated publication id before path construction: %s', (id) => {
        const outputRoot = mkdtempSync(join(tmpdir(), 'publication-id-'));

        expect(() => reserveLocalPublicationGeneration(outputRoot, { idSource: () => id })).toThrow(
            /publication id/i,
        );
        expect(readdirSync(outputRoot)).toEqual([]);
    });

    it('reserves one UUID generation exclusively and never replaces a collision', () => {
        const outputRoot = mkdtempSync(join(tmpdir(), 'publication-collision-'));
        const id = '00000000-0000-4000-8000-000000000001';
        const first = reserveLocalPublicationGeneration(outputRoot, { idSource: () => id });
        const markerBefore = readFileSync(first.ownershipMarkerPath, 'utf8');

        expect(() => reserveLocalPublicationGeneration(outputRoot, { idSource: () => id })).toThrow(
            /already exists|collision/i,
        );
        expect(readFileSync(first.ownershipMarkerPath, 'utf8')).toBe(markerBefore);
    });

    it('lists only generations made visible by an exclusive valid PUBLISHED marker', () => {
        const outputRoot = mkdtempSync(join(tmpdir(), 'publication-visible-'));
        const visible = reserveLocalPublicationGeneration(outputRoot, {
            idSource: () => '00000000-0000-4000-8000-000000000002',
        });
        reserveLocalPublicationGeneration(outputRoot, {
            idSource: () => '00000000-0000-4000-8000-000000000003',
        });
        const manifest = Buffer.from('{"schemaVersion":1}\n');
        writeReservedPublicationFile(visible, 'manifest.json', manifest);
        markLocalPublicationPublished(visible, manifest);

        expect(listPublishedLocalGenerations(outputRoot)).toEqual([visible.generationPath]);
        expect(() => markLocalPublicationPublished(visible, manifest)).toThrow(/published|exists/i);
    });

    it('cleans only an exact owned unmarked reservation and rejects aliases or publications', () => {
        const outputRoot = mkdtempSync(join(tmpdir(), 'publication-quarantine-cleanup-'));
        const quarantine = reserveLocalPublicationGeneration(outputRoot, {
            idSource: () => '00000000-0000-4000-8000-000000000004',
        });
        const alias = join(outputRoot, 'generation-alias');
        symlinkSync(quarantine.generationPath, alias, 'dir');

        expect(() => cleanupUnpublishedLocalPublicationReservation(alias)).toThrow(
            /exact|link|generation/i,
        );
        cleanupUnpublishedLocalPublicationReservation(quarantine.generationPath);
        expect(existsSync(quarantine.generationPath)).toBe(false);

        const published = reserveLocalPublicationGeneration(outputRoot, {
            idSource: () => '00000000-0000-4000-8000-000000000005',
        });
        const manifest = Buffer.from('{"schemaVersion":1}\n');
        writeReservedPublicationFile(published, 'manifest.json', manifest);
        markLocalPublicationPublished(published, manifest);
        expect(() =>
            cleanupUnpublishedLocalPublicationReservation(published.generationPath),
        ).toThrow(/published/i);
        expect(existsSync(published.generationPath)).toBe(true);
    });

    it('destroys a tainted reservation only through its exact opaque capability', () => {
        const outputRoot = mkdtempSync(join(tmpdir(), 'publication-tainted-destroy-'));
        const reservation = reserveLocalPublicationGeneration(outputRoot, {
            idSource: () => '00000000-0000-4000-8000-000000000006',
        });
        writeReservedPublicationFile(reservation, 'raw.log', Buffer.from('plaintext-secret'));

        expect(() =>
            destroyReservedLocalPublicationGeneration(
                Object.freeze({
                    id: reservation.id,
                    generationPath: reservation.generationPath,
                }) as never,
            ),
        ).toThrow(/opaque|reservation/i);
        expect(existsSync(reservation.generationPath)).toBe(true);

        destroyReservedLocalPublicationGeneration(reservation);
        expect(existsSync(reservation.generationPath)).toBe(false);
    });
});
