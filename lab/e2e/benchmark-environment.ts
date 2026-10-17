import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { binaryInfo } from 'cloakbrowser';
import type { BenchmarkRunEnvironment } from './benchmark-record';

/**
 * Read the source revision and whether the benchmark includes uncommitted changes.
 *
 * @param workspaceRoot - FiltersAgent checkout containing the benchmark sources.
 * @returns Current commit and working-tree dirtiness.
 */
export function readAgentRevision(workspaceRoot: string): BenchmarkRunEnvironment['agent'] {
    const options = { cwd: workspaceRoot, encoding: 'utf8' as const };
    return {
        commit: execFileSync('git', ['rev-parse', 'HEAD'], options).trim(),
        dirty: execFileSync('git', ['status', '--porcelain'], options).trim().length > 0,
    };
}

/**
 * Describe the installed browser package and binary without launching or updating a browser.
 *
 * @param workspaceRoot - Checkout with the installed CloakBrowser package.
 * @returns Package and Chromium versions suitable for benchmark provenance.
 */
export function describeBrowserBuild(workspaceRoot: string): string {
    const metadata = JSON.parse(
        readFileSync(join(workspaceRoot, 'node_modules', 'cloakbrowser', 'package.json'), 'utf8'),
    ) as {
        /**
         * Installed package version from its generated metadata.
         */
        version: string;
    };
    return `cloakbrowser ${metadata.version}, chromium ${binaryInfo().version}`;
}
