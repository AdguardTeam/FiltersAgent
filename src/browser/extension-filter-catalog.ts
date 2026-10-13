import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as v from 'valibot';
import {
    parseImportExpectations,
    type AdGuardExtensionSettingsProfile,
} from './adguard-extension-settings';
import { SettingsProfileKind } from '../types/settings-profile-kind';

/**
 * Bundled filter metadata shipped inside every unpacked AdGuard extension build.
 */
const BundledFilterCatalogSchema = v.looseObject({
    filters: v.record(v.string(), v.unknown()),
});

/**
 * Process-local cache of bundled catalog reads keyed by the unpacked extension path.
 */
const bundledCatalogCache = new Map<string, Promise<Set<number> | undefined>>();

/**
 * Load the bundled catalog filter IDs from one unpacked extension root.
 *
 * The catalog is an optimization source only: when the file is missing or malformed, the runtime
 * options-page check stays the single authoritative gate.
 *
 * @param extensionPath - Unpacked extension root of the prepared build.
 * @returns Catalog filter IDs, or undefined when the bundled catalog is unavailable.
 */
async function loadBundledFilterCatalogIds(
    extensionPath: string,
): Promise<Set<number> | undefined> {
    let raw: string;
    try {
        raw = await readFile(join(extensionPath, 'filters', 'filters_i18n.json'), 'utf8');
    } catch {
        return undefined;
    }
    try {
        const parsed = v.safeParse(BundledFilterCatalogSchema, JSON.parse(raw));
        if (!parsed.success) {
            return undefined;
        }
        const catalogIds = new Set<number>();
        for (const key of Object.keys(parsed.output.filters)) {
            const filterId = Number(key);
            if (Number.isInteger(filterId) && filterId > 0) {
                catalogIds.add(filterId);
            }
        }
        return catalogIds.size > 0 ? catalogIds : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Read the bundled catalog filter IDs for one prepared extension, cached per unpacked root.
 *
 * @param extensionPath - Unpacked extension root of the prepared build.
 * @returns Catalog filter IDs, or undefined when the bundled catalog is unavailable.
 */
export function readBundledFilterCatalogIds(
    extensionPath: string,
): Promise<Set<number> | undefined> {
    let pending = bundledCatalogCache.get(extensionPath);
    if (!pending) {
        pending = loadBundledFilterCatalogIds(extensionPath);
        bundledCatalogCache.set(extensionPath, pending);
    }
    return pending;
}

/**
 * Resolve the exact filter IDs one settings profile will request from the extension build.
 *
 * @param settings - Model-selected extension settings profile.
 * @returns Requested filter IDs for catalog convergence checks.
 */
export function requestedSettingsFilterIds(settings: AdGuardExtensionSettingsProfile): number[] {
    switch (settings.kind) {
        case SettingsProfileKind.AgentSelected:
            return settings.filterIds;
        case SettingsProfileKind.DefaultsPlusRequired:
            return settings.requiredFilterIds;
        case SettingsProfileKind.ReportExact:
        case SettingsProfileKind.ReportedOnCurrent:
            return parseImportExpectations(settings.importUrl).enabledFilterIds;
    }
}
