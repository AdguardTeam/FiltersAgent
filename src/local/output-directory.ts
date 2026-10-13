import {
    closeSync,
    constants,
    existsSync,
    fstatSync,
    fsyncSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    readdirSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import {
    basename,
    dirname,
    isAbsolute,
    join,
    parse,
    relative,
    resolve,
    sep as localOutputDirectoryPathSeparator,
} from 'node:path';
import { type ExtensionEnvironmentKind } from '../types/extension-environment-kind';

export const LOCAL_RUN_OUTPUT_MARKER_NAME = '.adguard-filters-agent-output';

export const LOCAL_PUBLICATION_RUNS_DIRECTORY = 'runs';

export const LOCAL_PUBLICATION_OWNERSHIP_MARKER = '.publication-owner';

export const LOCAL_PUBLICATION_VISIBLE_MARKER = 'PUBLISHED';

/**
 * Exact marker content used to distinguish agent-owned leaves from arbitrary directories.
 */
const LOCAL_RUN_OUTPUT_MARKER_CONTENT = 'adguard-filters-agent local run output v1\n';

/**
 * Check whether text contains a disallowed control character.
 *
 * @param value - Text inspected before path use.
 * @returns Whether one C0 or DEL control character is present.
 */
function hasUnsafeControl(value: string): boolean {
    return Array.from(value).some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 31 || codePoint === 127;
    });
}

/**
 * Check whether one absolute path is the same as or nested below another absolute path.
 *
 * @param parentPath - Absolute boundary directory.
 * @param candidatePath - Absolute path tested against the boundary.
 * @returns True when the candidate stays at or below the parent.
 */
function isPathAtOrBelow(parentPath: string, candidatePath: string): boolean {
    const relativePath = relative(parentPath, candidatePath);
    return (
        relativePath === '' ||
        (relativePath !== '..' &&
            !relativePath.startsWith(`..${localOutputDirectoryPathSeparator}`) &&
            !isAbsolute(relativePath))
    );
}

/**
 * Read path metadata without following a final symlink.
 *
 * @param path - Absolute path to inspect.
 * @returns Path metadata, or null when the path does not exist.
 */
function lstatIfExists(path: string): Stats | null {
    try {
        return lstatSync(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}

/**
 * Reject shared machine roots that can never be a dedicated run-output leaf.
 *
 * @param outputPath - Canonical existing output directory.
 */
function assertDedicatedMachinePath(outputPath: string): void {
    const machineRoot = realpathSync(parse(outputPath).root);
    if (outputPath === machineRoot) {
        throw new Error('Local run output must be a dedicated leaf, not the filesystem root.');
    }
    if (outputPath === realpathSync(homedir())) {
        throw new Error('Local run output must be a dedicated leaf, not the home directory.');
    }
    if (outputPath === realpathSync(tmpdir())) {
        throw new Error('Local run output must be a dedicated leaf, not the temporary root.');
    }
}

/**
 * Enforce the project-local tmp boundary while rejecting the shared tmp root itself.
 *
 * @param workspacePath - Canonical workspace root.
 * @param outputPath - Canonical existing or prospective output path.
 */
function assertCanonicalProjectOutputPath(workspacePath: string, outputPath: string): void {
    if (!isPathAtOrBelow(workspacePath, outputPath)) {
        return;
    }
    const projectTmpPath = join(workspacePath, 'tmp');
    if (!isPathAtOrBelow(projectTmpPath, outputPath)) {
        throw new Error('Canonical local output escapes the project tmp/ directory.');
    }
    const projectTmpRelative = relative(projectTmpPath, outputPath);
    if (projectTmpRelative.split(localOutputDirectoryPathSeparator).filter(Boolean).length < 1) {
        throw new Error('Canonical local output must be a dedicated leaf below project tmp/.');
    }
}

/**
 * Check whether a directory contains the exact regular ownership marker.
 *
 * Invalid or linked markers fail closed instead of making a directory eligible for cleanup.
 *
 * @param outputPath - Canonical existing output directory.
 * @returns True when the exact ownership marker is present.
 */
function hasLocalRunOutputMarker(outputPath: string): boolean {
    const markerPath = join(outputPath, LOCAL_RUN_OUTPUT_MARKER_NAME);
    const markerStats = lstatIfExists(markerPath);
    if (!markerStats) {
        return false;
    }
    if (markerStats.isSymbolicLink() || !markerStats.isFile() || markerStats.nlink !== 1) {
        throw new Error('Local run output ownership marker must be an unlinked regular file.');
    }
    if (readFileSync(markerPath, 'utf8') !== LOCAL_RUN_OUTPUT_MARKER_CONTENT) {
        throw new Error('Local run output ownership marker is invalid.');
    }
    return true;
}

/**
 * Claim an empty directory for exclusive local run-output use.
 *
 * @param outputPath - Canonical existing directory to claim.
 */
function claimLocalRunOutputDir(outputPath: string): void {
    if (readdirSync(outputPath).length > 0) {
        throw new Error('Local run output is nonempty and is not owned by adguard-filters-agent.');
    }
    writeFileSync(join(outputPath, LOCAL_RUN_OUTPUT_MARKER_NAME), LOCAL_RUN_OUTPUT_MARKER_CONTENT, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
    });
}

/**
 * Resolve the output directory for one local current or historical run.
 *
 * @param workspaceRoot - Absolute project root used for the project-local default.
 * @param issueNumber - Positive issue number included in the deterministic directory name.
 * @param environment - Current or historical product horizon.
 * @param explicitOutputDir - Optional caller-selected absolute output directory.
 * @returns Validated absolute directory for the local report and artifacts.
 */
export function resolveLocalRunOutputDir(
    workspaceRoot: string,
    issueNumber: number,
    environment: ExtensionEnvironmentKind,
    explicitOutputDir?: string,
): string {
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
        throw new Error('Local run issue number must be a positive integer.');
    }
    const outputDir =
        explicitOutputDir ??
        join(workspaceRoot, 'tmp', 'adguard-agent-runs', `issue-${issueNumber}-${environment}`);
    return validateLocalRunOutputDir(outputDir, workspaceRoot);
}

/**
 * Validate a local run output path while preserving external-path compatibility.
 *
 * Paths outside the workspace remain supported. Paths inside the workspace are restricted to the
 * ignored project-local `tmp/` tree so a typo cannot overwrite source or test fixtures.
 *
 * @param outputDir - Absolute caller-selected or default output directory.
 * @param workspaceRoot - Absolute project root that owns the local `tmp/` tree.
 * @returns Normalized absolute output directory.
 */
export function validateLocalRunOutputDir(outputDir: string, workspaceRoot: string): string {
    if (!isAbsolute(outputDir) || !isAbsolute(workspaceRoot)) {
        throw new Error('Local output and workspace paths must be absolute.');
    }
    const outputPath = resolve(outputDir);
    const workspacePath = resolve(workspaceRoot);
    const isInsideWorkspace = isPathAtOrBelow(workspacePath, outputPath);
    if (!isInsideWorkspace) {
        return outputPath;
    }

    const projectTmpPath = join(workspacePath, 'tmp');
    const isInsideProjectTmp = isPathAtOrBelow(projectTmpPath, outputPath);
    if (!isInsideProjectTmp) {
        throw new Error('Local run output inside the workspace must be under project tmp/.');
    }
    const projectTmpRelative = relative(projectTmpPath, outputPath);
    if (projectTmpRelative.split(localOutputDirectoryPathSeparator).filter(Boolean).length < 1) {
        throw new Error('Local run output must be a dedicated leaf below project tmp/.');
    }
    return outputPath;
}

/**
 * Materialize one output directory and return the canonical path used for every later mutation.
 *
 * Existing symlink components below the workspace root are rejected before directory creation, so a
 * nominal `tmp/` destination cannot redirect cleanup into tracked source or test fixtures. External
 * output remains supported, but an existing nonempty leaf must already contain the exact regular
 * ownership marker before any caller may clean it.
 *
 * @param outputDir - Absolute caller-selected output directory.
 * @param workspaceRoot - Absolute project root that owns the local `tmp/` boundary.
 * @returns Canonical real directory safe for subsequent reads, writes, and cleanup.
 */
export function materializeLocalRunOutputDir(outputDir: string, workspaceRoot: string): string {
    const outputPath = validateLocalRunOutputDir(outputDir, workspaceRoot);
    const initialOutputStats = lstatIfExists(outputPath);
    if (initialOutputStats?.isSymbolicLink()) {
        throw new Error(`Local output directory must not be a symlink: ${outputPath}`);
    }
    if (initialOutputStats && !initialOutputStats.isDirectory()) {
        throw new Error(`Local output path is not a directory: ${outputPath}`);
    }
    const workspacePath = resolve(workspaceRoot);
    const workspaceRelative = relative(workspacePath, outputPath);
    const insideWorkspace = isPathAtOrBelow(workspacePath, outputPath);
    const canonicalWorkspace = realpathSync(workspacePath);

    if (insideWorkspace) {
        let cursor = workspacePath;
        for (const component of workspaceRelative
            .split(localOutputDirectoryPathSeparator)
            .filter(Boolean)) {
            cursor = join(cursor, component);
            if (existsSync(cursor)) {
                const stats = lstatSync(cursor);
                if (stats.isSymbolicLink()) {
                    throw new Error(`Local output path contains a symlink: ${cursor}`);
                }
                if (!stats.isDirectory()) {
                    throw new Error(`Local output path component is not a directory: ${cursor}`);
                }
            } else {
                mkdirSync(cursor, { mode: 0o700 });
            }
        }
    } else {
        let existingAncestor = outputPath;
        while (!existsSync(existingAncestor)) {
            const parent = dirname(existingAncestor);
            if (parent === existingAncestor) {
                break;
            }
            existingAncestor = parent;
        }
        const projectedOutput = resolve(
            realpathSync(existingAncestor),
            relative(existingAncestor, outputPath),
        );
        assertCanonicalProjectOutputPath(canonicalWorkspace, projectedOutput);
        mkdirSync(outputPath, { recursive: true, mode: 0o700 });
    }

    const canonicalOutput = realpathSync(outputPath);
    assertDedicatedMachinePath(canonicalOutput);
    assertCanonicalProjectOutputPath(canonicalWorkspace, canonicalOutput);
    if (!hasLocalRunOutputMarker(canonicalOutput)) {
        claimLocalRunOutputDir(canonicalOutput);
    }
    return canonicalOutput;
}

/**
 * Clear a run-output directory only after proving that the agent owns the dedicated leaf.
 *
 * @param outputDir - Absolute caller-selected output directory.
 * @param workspaceRoot - Absolute project root that owns the local `tmp/` boundary.
 * @param preserveEntries - Optional top-level owned entries to retain across the cleanup.
 * @returns Canonical owned directory after cleanup.
 */
export function clearLocalRunOutputDir(
    outputDir: string,
    workspaceRoot: string,
    preserveEntries: readonly string[] = [],
): string {
    for (const entry of preserveEntries) {
        if (
            entry.length === 0 ||
            entry === '.' ||
            entry === '..' ||
            basename(entry) !== entry ||
            entry === LOCAL_RUN_OUTPUT_MARKER_NAME
        ) {
            throw new Error(`Invalid preserved local output entry: ${entry}`);
        }
    }
    const outputPath = materializeLocalRunOutputDir(outputDir, workspaceRoot);
    if (!hasLocalRunOutputMarker(outputPath)) {
        throw new Error('Cannot clear a local run output directory without its ownership marker.');
    }
    const preserved = new Set([LOCAL_RUN_OUTPUT_MARKER_NAME, ...preserveEntries]);
    for (const entry of readdirSync(outputPath)) {
        if (!preserved.has(entry)) {
            rmSync(join(outputPath, entry), { recursive: true, force: true });
        }
    }
    return outputPath;
}

declare const publicationIdBrand: unique symbol;

/**
 * Opaque validated lowercase RFC 4122 publication identifier.
 */
export interface PublicationId {
    /**
     * Compile-time opaque publication ID marker.
     */
    readonly [publicationIdBrand]: true;
}

declare const reservationBrand: unique symbol;

/**
 * Opaque exclusive publication-generation reservation.
 */
export interface ReservedLocalPublicationGeneration {
    /**
     * Compile-time opaque reservation marker.
     */
    readonly [reservationBrand]: true;

    /**
     * Validated lowercase UUID string.
     */
    readonly id: string;

    /**
     * Canonical reserved generation path.
     */
    readonly generationPath: string;

    /**
     * Exact ownership marker path.
     */
    readonly ownershipMarkerPath: string;

    /**
     * Exact visibility marker path.
     */
    readonly publishedMarkerPath: string;
}

/**
 * Test seams for publication ID generation.
 */
export interface PublicationReservationOptions {
    /**
     * UUID source; production uses `randomUUID()`.
     */
    idSource?: () => string;
}

/**
 * Private canonical reservation state keyed by Host-issued objects.
 */
interface PublicationReservationState {
    /**
     * Validated lowercase publication UUID.
     */
    id: string;

    /**
     * Canonical parent `runs` directory.
     */
    runsRoot: string;

    /**
     * Canonical owned generation directory.
     */
    generationPath: string;

    /**
     * Exact ownership marker path.
     */
    ownershipMarkerPath: string;

    /**
     * Exact consumer-visibility marker path.
     */
    publishedMarkerPath: string;
}

/**
 * Private canonical reservation state keyed by Host-issued objects.
 */
const publicationReservations = new WeakMap<object, PublicationReservationState>();

/**
 * Validate a generated ID before using it in any path operation.
 *
 * @param value - Raw generator output.
 * @returns Opaque validated publication ID.
 */
function parsePublicationId(value: string): PublicationId {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)) {
        throw new Error('Generated publication ID is not a lowercase RFC 4122 UUID.');
    }
    return value as unknown as PublicationId;
}

/**
 * Fsync one exact owned directory.
 *
 * @param path - Directory path.
 */
function fsyncDirectory(path: string): void {
    let descriptor: number | undefined;
    try {
        descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        if (!fstatSync(descriptor).isDirectory()) {
            throw new Error('Publication path is not a directory.');
        }
        fsyncSync(descriptor);
    } finally {
        if (descriptor !== undefined) {
            closeSync(descriptor);
        }
    }
}

/**
 * Create one exclusive single-link file, fsync it, and verify its exact size.
 *
 * @param path - New exact file path.
 * @param content - Exact file bytes.
 */
function createExclusivePublicationFile(path: string, content: Buffer): void {
    let descriptor: number | undefined;
    try {
        descriptor = openSync(
            path,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
            0o600,
        );
        const opened = fstatSync(descriptor);
        if (!opened.isFile() || opened.nlink !== 1 || opened.size !== 0) {
            throw new Error('Publication file is not a new single-link regular file.');
        }
        writeFileSync(descriptor, content);
        fsyncSync(descriptor);
        const written = fstatSync(descriptor);
        if (!written.isFile() || written.nlink !== 1 || written.size !== content.byteLength) {
            throw new Error('Publication file changed while it was being written.');
        }
    } finally {
        if (descriptor !== undefined) {
            closeSync(descriptor);
        }
    }
}

/**
 * Read one stable no-follow single-link publication file.
 *
 * @param path - Exact file path.
 * @returns Exact bytes.
 */
function readStablePublicationFile(path: string): Buffer {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
        throw new Error('Publication marker or manifest must be a single-link regular file.');
    }
    let descriptor: number | undefined;
    try {
        descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const opened = fstatSync(descriptor);
        if (
            !opened.isFile() ||
            opened.nlink !== 1 ||
            opened.dev !== before.dev ||
            opened.ino !== before.ino ||
            opened.size !== before.size
        ) {
            throw new Error('Publication marker or manifest identity changed before reading.');
        }
        const content = readFileSync(descriptor);
        const after = fstatSync(descriptor);
        if (
            content.byteLength !== opened.size ||
            after.dev !== opened.dev ||
            after.ino !== opened.ino ||
            after.size !== opened.size ||
            after.mtimeMs !== opened.mtimeMs
        ) {
            throw new Error('Publication marker or manifest changed while reading.');
        }
        return content;
    } finally {
        if (descriptor !== undefined) {
            closeSync(descriptor);
        }
    }
}

/**
 * Resolve or create one canonical direct `runs` directory beneath an existing output root.
 *
 * @param outputRoot - Existing local output root.
 * @returns Canonical runs root.
 */
function ensurePublicationRunsRoot(outputRoot: string): string {
    const rootStats = lstatSync(outputRoot);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
        throw new Error('Local publication output root must be a regular directory.');
    }
    const canonicalRoot = realpathSync(outputRoot);
    const runsPath = join(canonicalRoot, LOCAL_PUBLICATION_RUNS_DIRECTORY);
    if (!existsSync(runsPath)) {
        mkdirSync(runsPath, { mode: 0o700 });
        fsyncDirectory(canonicalRoot);
    }
    const runsStats = lstatSync(runsPath);
    if (!runsStats.isDirectory() || runsStats.isSymbolicLink()) {
        throw new Error('Local publication runs path must be a regular directory.');
    }
    const canonicalRuns = realpathSync(runsPath);
    if (
        dirname(canonicalRuns) !== canonicalRoot ||
        basename(canonicalRuns) !== LOCAL_PUBLICATION_RUNS_DIRECTORY
    ) {
        throw new Error('Local publication runs path escapes its canonical output root.');
    }
    return canonicalRuns;
}

/**
 * Reserve one append-only publication generation with an exclusive ownership marker.
 *
 * @param outputRoot - Existing local output root.
 * @param options - Optional deterministic ID source for tests.
 * @returns Opaque exclusive reservation.
 */
export function reserveLocalPublicationGeneration(
    outputRoot: string,
    options: PublicationReservationOptions = {},
): ReservedLocalPublicationGeneration {
    const id = parsePublicationId((options.idSource ?? randomUUID)()) as unknown as string;
    const runsRoot = ensurePublicationRunsRoot(outputRoot);
    const generationPath = resolve(runsRoot, id);
    if (relative(runsRoot, generationPath) !== id || dirname(generationPath) !== runsRoot) {
        throw new Error('Generated publication ID does not project one contained path component.');
    }
    try {
        mkdirSync(generationPath, { mode: 0o700 });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new Error(`Publication generation collision: ${id}.`, { cause: error });
        }
        throw error;
    }
    const canonicalGeneration = realpathSync(generationPath);
    if (dirname(canonicalGeneration) !== runsRoot || basename(canonicalGeneration) !== id) {
        throw new Error('Reserved publication generation escaped its canonical runs root.');
    }
    const ownershipMarkerPath = join(canonicalGeneration, LOCAL_PUBLICATION_OWNERSHIP_MARKER);
    const publishedMarkerPath = join(canonicalGeneration, LOCAL_PUBLICATION_VISIBLE_MARKER);
    createExclusivePublicationFile(
        ownershipMarkerPath,
        Buffer.from(`adguard-filters-agent publication ${id}\n`, 'utf8'),
    );
    fsyncDirectory(canonicalGeneration);
    fsyncDirectory(runsRoot);
    const reservation = Object.freeze({
        id,
        generationPath: canonicalGeneration,
        ownershipMarkerPath,
        publishedMarkerPath,
    }) as unknown as ReservedLocalPublicationGeneration;
    publicationReservations.set(reservation, {
        id,
        runsRoot,
        generationPath: canonicalGeneration,
        ownershipMarkerPath,
        publishedMarkerPath,
    });
    return reservation;
}

/**
 * Resolve a safe publication-relative path and create its owned parent directories.
 *
 * @param generationPath - Canonical generation root.
 * @param relativePath - Portable relative path.
 * @returns Exact contained file path.
 */
function prepareReservedFilePath(generationPath: string, relativePath: string): string {
    if (
        relativePath.length === 0 ||
        isAbsolute(relativePath) ||
        relativePath.includes('\\') ||
        hasUnsafeControl(relativePath) ||
        relativePath
            .split('/')
            .some((part) => part.length === 0 || part === '.' || part === '..') ||
        [LOCAL_PUBLICATION_OWNERSHIP_MARKER, LOCAL_PUBLICATION_VISIBLE_MARKER].includes(
            relativePath,
        )
    ) {
        throw new Error('Invalid reserved publication file path.');
    }
    const components = relativePath.split('/');
    let parent = generationPath;
    for (const component of components.slice(0, -1)) {
        parent = join(parent, component);
        if (!existsSync(parent)) {
            mkdirSync(parent, { mode: 0o700 });
        }
        const stats = lstatSync(parent);
        if (!stats.isDirectory() || stats.isSymbolicLink()) {
            throw new Error('Reserved publication path contains an unsafe directory.');
        }
    }
    const target = resolve(generationPath, relativePath);
    const relativeTarget = relative(generationPath, target);
    if (relativeTarget.split(localOutputDirectoryPathSeparator).join('/') !== relativePath) {
        throw new Error('Reserved publication file escapes its generation.');
    }
    return target;
}

/**
 * Write one no-clobber file inside an opaque publication reservation.
 *
 * @param reservation - Opaque exclusive generation reservation.
 * @param relativePath - Portable generation-relative path.
 * @param content - Exact file bytes.
 * @returns Exact created file path.
 */
export function writeReservedPublicationFile(
    reservation: ReservedLocalPublicationGeneration,
    relativePath: string,
    content: Uint8Array,
): string {
    const state = publicationReservations.get(reservation);
    if (!state) {
        throw new Error('Invalid opaque publication reservation.');
    }
    if (existsSync(state.publishedMarkerPath)) {
        throw new Error('Published generations are immutable.');
    }
    const target = prepareReservedFilePath(state.generationPath, relativePath);
    createExclusivePublicationFile(target, Buffer.from(content));
    fsyncDirectory(dirname(target));
    return target;
}

/**
 * Make one complete generation consumer-visible through an exclusive durable marker.
 *
 * @param reservation - Opaque exclusive generation reservation.
 * @param manifestBytes - Exact bytes already written as `manifest.json`.
 */
export function markLocalPublicationPublished(
    reservation: ReservedLocalPublicationGeneration,
    manifestBytes: Uint8Array,
): void {
    const state = publicationReservations.get(reservation);
    if (!state) {
        throw new Error('Invalid opaque publication reservation.');
    }
    const manifestPath = join(state.generationPath, 'manifest.json');
    const actualManifest = readStablePublicationFile(manifestPath);
    const expectedManifest = Buffer.from(manifestBytes);
    if (!actualManifest.equals(expectedManifest)) {
        throw new Error('Publication manifest bytes do not match the durable file.');
    }
    const digest = createHash('sha256').update(actualManifest).digest('hex');
    createExclusivePublicationFile(state.publishedMarkerPath, Buffer.from(`${digest}\n`, 'utf8'));
    fsyncDirectory(state.generationPath);
    fsyncDirectory(state.runsRoot);
}

/**
 * List only fully marked generations whose ownership and manifest digests verify.
 *
 * @param outputRoot - Existing local output root.
 * @returns Lexically ordered canonical visible generation paths.
 */
export function listPublishedLocalGenerations(outputRoot: string): string[] {
    const runsPath = join(realpathSync(outputRoot), LOCAL_PUBLICATION_RUNS_DIRECTORY);
    if (!existsSync(runsPath)) {
        return [];
    }
    const runsRoot = realpathSync(runsPath);
    const visible: string[] = [];
    for (const entry of readdirSync(runsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
            continue;
        }
        let id: string;
        try {
            id = parsePublicationId(entry.name) as unknown as string;
        } catch {
            continue;
        }
        const generationPath = join(runsRoot, id);
        const publishedPath = join(generationPath, LOCAL_PUBLICATION_VISIBLE_MARKER);
        if (!existsSync(publishedPath)) {
            continue;
        }
        const ownership = readStablePublicationFile(
            join(generationPath, LOCAL_PUBLICATION_OWNERSHIP_MARKER),
        ).toString('utf8');
        if (ownership !== `adguard-filters-agent publication ${id}\n`) {
            throw new Error('Published generation ownership marker is invalid.');
        }
        const publishedDigest = readStablePublicationFile(publishedPath).toString('utf8').trim();
        const manifest = readStablePublicationFile(join(generationPath, 'manifest.json'));
        const manifestDigest = createHash('sha256').update(manifest).digest('hex');
        if (!/^[0-9a-f]{64}$/u.test(publishedDigest) || publishedDigest !== manifestDigest) {
            throw new Error('Published generation manifest digest is invalid.');
        }
        visible.push(generationPath);
    }
    // oxlint-disable-next-line unicorn/no-array-sort -- The function owns this local array.
    return visible.sort((left, right) => left.localeCompare(right));
}

/**
 * Canonical ownership facts for one exact publication generation.
 */
interface OwnedPublicationGeneration {
    /**
     * Validated generation UUID.
     */
    id: string;

    /**
     * Canonical direct child of the canonical `runs` directory.
     */
    generationPath: string;

    /**
     * Canonical parent `runs` directory fsynced after removal.
     */
    runsRoot: string;

    /**
     * Exact visibility marker path.
     */
    publishedMarkerPath: string;

    /**
     * Exact durable manifest path.
     */
    manifestPath: string;
}

/**
 * Resolve an exact caller path and prove publication-generation ownership without following links.
 *
 * @param generationPath - Exact absolute generation path supplied by an explicit cleanup caller.
 * @returns Canonical generation ownership facts.
 */
function resolveOwnedPublicationGeneration(generationPath: string): OwnedPublicationGeneration {
    if (
        !isAbsolute(generationPath) ||
        generationPath !== resolve(generationPath) ||
        hasUnsafeControl(generationPath) ||
        Array.from(generationPath).some((character) => '*?{}[]'.includes(character))
    ) {
        throw new Error('Publication cleanup requires one exact absolute generation path.');
    }
    const generationStats = lstatSync(generationPath);
    if (!generationStats.isDirectory() || generationStats.isSymbolicLink()) {
        throw new Error('Publication cleanup target must be an unlinked generation directory.');
    }
    const canonicalGeneration = realpathSync(generationPath);
    if (canonicalGeneration !== generationPath) {
        throw new Error('Publication cleanup target must use its exact canonical path.');
    }
    const id = parsePublicationId(basename(canonicalGeneration)) as unknown as string;
    const runsPath = dirname(canonicalGeneration);
    const runsStats = lstatSync(runsPath);
    if (
        !runsStats.isDirectory() ||
        runsStats.isSymbolicLink() ||
        basename(runsPath) !== LOCAL_PUBLICATION_RUNS_DIRECTORY
    ) {
        throw new Error('Publication generation is not a direct child of an unlinked runs root.');
    }
    const runsRoot = realpathSync(runsPath);
    if (runsRoot !== runsPath || join(runsRoot, id) !== canonicalGeneration) {
        throw new Error('Publication generation escapes its canonical runs root.');
    }
    const ownership = readStablePublicationFile(
        join(canonicalGeneration, LOCAL_PUBLICATION_OWNERSHIP_MARKER),
    ).toString('utf8');
    if (ownership !== `adguard-filters-agent publication ${id}\n`) {
        throw new Error('Publication generation ownership marker is invalid.');
    }
    return {
        id,
        generationPath: canonicalGeneration,
        runsRoot,
        publishedMarkerPath: join(canonicalGeneration, LOCAL_PUBLICATION_VISIBLE_MARKER),
        manifestPath: join(canonicalGeneration, 'manifest.json'),
    };
}

/**
 * Remove one exact generation after all ownership and visibility preconditions were proven.
 *
 * @param owned - Canonical ownership facts returned immediately before cleanup.
 */
function removeOwnedPublicationGeneration(owned: OwnedPublicationGeneration): void {
    rmSync(owned.generationPath, { recursive: true, force: false });
    fsyncDirectory(owned.runsRoot);
}

/**
 * Remove an explicitly selected unmarked quarantine reservation.
 *
 * This API never accepts a published result. It is deliberately separate from normal publication
 * cleanup so a trust-failed raw generation cannot be mistaken for consumer-visible output.
 *
 * @param generationPath - Exact canonical unmarked generation path.
 */
export function cleanupUnpublishedLocalPublicationReservation(generationPath: string): void {
    const owned = resolveOwnedPublicationGeneration(generationPath);
    if (existsSync(owned.publishedMarkerPath)) {
        throw new Error('Published generations require verified publication cleanup.');
    }
    removeOwnedPublicationGeneration(owned);
}

/**
 * Destroy one secret-tainted unmarked generation through its Host-issued reservation capability.
 *
 * Unlike path-based quarantine cleanup, this boundary accepts only the exact in-process opaque
 * reservation that created the generation. It re-proves the canonical path and ownership marker
 * immediately before removing bytes and never accepts a consumer-visible publication.
 *
 * @param reservation - Exact opaque reservation that owns the tainted generation.
 */
export function destroyReservedLocalPublicationGeneration(
    reservation: ReservedLocalPublicationGeneration,
): void {
    const state = publicationReservations.get(reservation);
    if (!state) {
        throw new Error('Invalid opaque publication reservation.');
    }
    const owned = resolveOwnedPublicationGeneration(state.generationPath);
    if (
        owned.id !== state.id ||
        owned.generationPath !== state.generationPath ||
        owned.runsRoot !== state.runsRoot
    ) {
        throw new Error('Opaque publication reservation ownership changed.');
    }
    if (existsSync(owned.publishedMarkerPath)) {
        throw new Error('Published generations cannot be destroyed as tainted reservations.');
    }
    removeOwnedPublicationGeneration(owned);
    publicationReservations.delete(reservation);
}

/**
 * Remove a published generation after its marker still binds the exact durable manifest.
 *
 * Callers must first perform the stronger evidence and review verification. This lower-level
 * boundary repeats the ownership and marker checks immediately before the exact recursive remove.
 *
 * @param generationPath - Exact canonical verified generation path.
 */
export function removeVerifiedLocalPublicationGeneration(generationPath: string): void {
    const owned = resolveOwnedPublicationGeneration(generationPath);
    if (!existsSync(owned.publishedMarkerPath)) {
        throw new Error('Verified publication cleanup requires a PUBLISHED marker.');
    }
    const manifest = readStablePublicationFile(owned.manifestPath);
    const publishedDigest = readStablePublicationFile(owned.publishedMarkerPath)
        .toString('utf8')
        .trim();
    const manifestDigest = createHash('sha256').update(manifest).digest('hex');
    if (publishedDigest !== manifestDigest) {
        throw new Error('Published generation manifest digest is invalid.');
    }
    removeOwnedPublicationGeneration(owned);
}
