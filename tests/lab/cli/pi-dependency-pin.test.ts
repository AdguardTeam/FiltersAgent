import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Package-name prefix of the pi runtime family this agent is built on.
 *
 * The whole family is published together from one repository and the publisher ships a
 * `npm-shrinkwrap.json` inside `@earendil-works/pi-coding-agent` that pins every sibling to the
 * exact release it was tested with. pnpm ignores a dependency's nested shrinkwrap, and the sibling
 * ranges are carets, so without the `pnpm.overrides` block in package.json a plain install floats
 * the loop, the client and the protocol off the two versions package.json pins directly. That
 * produced a real mixed tree on this branch: `src/pi/runtime.ts` built a `Model` from pi-ai 0.84.1
 * and handed it to a `ModelRuntime` whose pi-agent-core had resolved to 0.84.4, a combination the
 * vendor never shipped.
 */
const PI_SCOPE = '@earendil-works/';

/**
 * Read the installed manifest of one package directory.
 *
 * @param packageDirectory - Directory holding the package's own package.json.
 * @returns The parsed manifest.
 */
function readManifest(packageDirectory: string): {
    /**
     * Installed package version.
     */
    version: string;

    /**
     * Runtime dependency ranges of the installed package.
     */
    dependencies?: Record<string, string>;
} {
    return JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8'));
}

/**
 * Resolve one dependency the way Node resolves a bare specifier: walk `node_modules` upwards from
 * the dependent package. Node's own resolver is not usable here because these packages publish an
 * `exports` map without a `./package.json` subpath.
 *
 * @param fromDirectory - Directory of the package doing the import.
 * @param name - Bare package name being imported.
 * @returns The real installed package directory, or null when nothing resolves.
 */
function resolvePackageDirectory(fromDirectory: string, name: string): string | null {
    let directory = fromDirectory;
    for (;;) {
        const candidate = join(directory, 'node_modules', name);
        if (existsSync(join(candidate, 'package.json'))) {
            return realpathSync(candidate);
        }
        const parent = dirname(directory);
        if (parent === directory) {
            return null;
        }
        directory = parent;
    }
}

/**
 * Collect every installed version of every pi package reachable from the workspace root.
 *
 * @param workspaceRoot - Repository root holding the installed `node_modules`.
 * @returns Installed versions per pi package name.
 */
function installedPiVersions(workspaceRoot: string): Map<string, Set<string>> {
    const versions = new Map<string, Set<string>>();
    const visited = new Set<string>();
    const queue = [workspaceRoot];
    while (queue.length > 0) {
        const directory = queue.shift()!;
        for (const name of Object.keys(readManifest(directory).dependencies ?? {})) {
            if (!name.startsWith(PI_SCOPE)) {
                continue;
            }
            const resolved = resolvePackageDirectory(directory, name);
            expect(resolved, `${name} is not installed for ${directory}`).not.toBeNull();
            const version = readManifest(resolved!).version;
            const seen = versions.get(name) ?? new Set<string>();
            seen.add(version);
            versions.set(name, seen);
            if (!visited.has(resolved!)) {
                visited.add(resolved!);
                queue.push(resolved!);
            }
        }
    }
    return versions;
}

describe('installed pi runtime', () => {
    it('resolves the whole pi family to one release', () => {
        const workspaceRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
        const versions = installedPiVersions(workspaceRoot);

        expect(versions.size).toBeGreaterThan(1);
        const declared = readManifest(workspaceRoot).dependencies![`${PI_SCOPE}pi-ai`];
        const drifted = [...versions]
            .filter(([, installed]) => installed.size > 1 || !installed.has(declared))
            .map(([name, installed]) => `${name}: ${[...installed].sort().join(', ')}`);
        expect(drifted, `expected every pi package at ${declared}`).toEqual([]);
    });
});
