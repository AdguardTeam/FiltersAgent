import { createHash } from 'node:crypto';
import * as nodePath from 'node:path';
import * as v from 'valibot';
import {
    hashStream,
    nodeBaselineFileSystem,
    sameMetadata,
    type BaselineFileSystemPort,
} from './baseline-file-lock';
import { BrowserExtensionExecutorName } from './executor-name';
import { adguardListKey } from './filter-list-ref';
import {
    EnvironmentAdapterLimitationCode,
    type EnvironmentAdapterLimitation,
} from './filtering-environment';
import {
    PublishedBaselineProvenanceSchema,
    type PublishedBaselineProvenance,
} from './environment-proofs';
import type {
    ExtensionBaselineLockResult,
    ExtensionBaselineSettings,
} from './browser-extension-environment';

/**
 * Largest accepted bundled MV2 filter text file.
 */
const MAX_MV2_FILTER_TEXT_BYTES = 64 * 1024 * 1024;

/**
 * Largest accepted aggregate of bundled MV2 filter text bytes.
 */
const MAX_MV2_BASELINE_BYTES = 256 * 1024 * 1024;

/**
 * Input for exact MV2 filter-text baseline locking.
 */
export interface Mv2ExtensionBaselineLockRequest {
    /**
     * Trusted unpacked Extension root.
     */
    extensionRoot: string;

    /**
     * Browser-observed settings proof captured from the options API.
     */
    settings: ExtensionBaselineSettings;

    /**
     * Deterministic acquisition timestamp.
     */
    acquiredAt: string;
}

/**
 * Bundled MV2 filter text selected for byte locking.
 */
interface SelectedMv2FilterText {
    /**
     * Official filter identity.
     */
    filterId: number;

    /**
     * Portable extension-relative path constructed from the filter identity.
     */
    portablePath: string;
}

/**
 * Build a bounded stable public limitation.
 *
 * @param code - Stable public failure category.
 * @param stage - Stable lifecycle stage.
 * @param detail - Constant public detail without filesystem identity.
 * @returns Schema-compatible public limitation.
 */
function limitation(
    code: EnvironmentAdapterLimitation['code'],
    stage: EnvironmentAdapterLimitation['stage'],
    detail: string,
): EnvironmentAdapterLimitation {
    return { code, stage, detail: detail.slice(0, 500) };
}

/**
 * Require exact agreement among the MV2 settings identity proofs.
 *
 * MV2 has no declarative Net Request runtime, so the active-ruleset proof must be empty while the
 * options, runtime, and final settings sets must agree exactly.
 *
 * @param settings - Browser-observed settings proof.
 * @returns Canonical enabled IDs or null on disagreement.
 */
function agreedMv2FilterIds(settings: ExtensionBaselineSettings): number[] | null {
    const sets = [
        settings.enabledFilterIds,
        settings.optionsEnabledFilterIds,
        settings.runtimeEnabledFilterIds,
    ].map((values) => [...new Set(values)].sort((left, right) => left - right));
    if (settings.activeRulesetFilterIds.length > 0) {
        return null;
    }
    if (sets.some((ids) => ids.some((value) => !Number.isInteger(value) || value < 1))) {
        return null;
    }
    const serialized = sets.map((ids) => JSON.stringify(ids));
    return serialized.every((value) => value === serialized[0]) ? sets[0] : null;
}

/**
 * Integrity-lock the exact bundled MV2 filter text bytes selected by browser-observed settings.
 *
 * MV2 ships only AdGuard-owned filter texts inside the extension package; third-party subscriptions
 * are downloaded into profile storage at runtime. Filters without bundled bytes are named as
 * unattributed rather than silently dropped, so every phase observes the same enabled set while the
 * report shows which parts are byte-proven.
 *
 * @param request - Extension root, observed settings, and acquisition timestamp.
 * @param fileSystem - Optional deterministic filesystem boundary.
 * @returns Exact baseline provenance or a stable path-free limitation.
 */
export async function lockMv2ExtensionBaseline(
    request: Mv2ExtensionBaselineLockRequest,
    fileSystem: BaselineFileSystemPort = nodeBaselineFileSystem,
): Promise<ExtensionBaselineLockResult> {
    const filterIds = agreedMv2FilterIds(request.settings);
    if (!filterIds || filterIds.length === 0) {
        return {
            ready: false,
            limitation: limitation(
                EnvironmentAdapterLimitationCode.SettingsMismatch,
                'baseline',
                'The MV2 Extension settings identity proofs do not agree.',
            ),
        };
    }
    const canonicalRoot = await fileSystem.realpath(nodePath.resolve(request.extensionRoot));
    const selected: SelectedMv2FilterText[] = [];
    const unattributedFilterIds: number[] = [];
    let totalBytes = 0;
    for (const filterId of filterIds) {
        const portablePath = `filters/filter_${filterId}.txt`;
        const path = nodePath.resolve(request.extensionRoot, portablePath);
        const metadata = await fileSystem.inspect(path).catch(() => null);
        if (!metadata) {
            unattributedFilterIds.push(filterId);
            continue;
        }
        const canonicalPath = await fileSystem.realpath(path).catch(() => null);
        if (
            metadata.symbolicLink ||
            !metadata.regular ||
            canonicalPath === null ||
            (canonicalPath !== canonicalRoot &&
                !canonicalPath.startsWith(`${canonicalRoot}${nodePath.sep}`))
        ) {
            return {
                ready: false,
                limitation: limitation(
                    EnvironmentAdapterLimitationCode.BaselineResourceUnsafe,
                    'baseline',
                    'A bundled MV2 filter text is not a regular file inside the Extension root.',
                ),
            };
        }
        if (metadata.size > MAX_MV2_FILTER_TEXT_BYTES) {
            return {
                ready: false,
                limitation: limitation(
                    EnvironmentAdapterLimitationCode.BaselineResourceLimitExceeded,
                    'baseline',
                    'A bundled MV2 filter text exceeds the accepted byte limit.',
                ),
            };
        }
        totalBytes += metadata.size;
        if (totalBytes > MAX_MV2_BASELINE_BYTES) {
            return {
                ready: false,
                limitation: limitation(
                    EnvironmentAdapterLimitationCode.BaselineResourceLimitExceeded,
                    'baseline',
                    'The bundled MV2 filter text aggregate exceeds the accepted byte limit.',
                ),
            };
        }
        selected.push({ filterId, portablePath });
    }
    const resources: PublishedBaselineProvenance['resources'] = [];
    for (const resource of selected) {
        const path = nodePath.resolve(request.extensionRoot, resource.portablePath);
        const preflight = await fileSystem.inspect(path);
        const opened = await fileSystem.openNoFollow(path);
        let sha256: string | null = null;
        let descriptorBefore = null;
        let descriptorAfter = null;
        let postflight = null;
        try {
            descriptorBefore = await opened.stat();
            sha256 = await hashStream(preflight.size, opened);
            descriptorAfter = await opened.stat();
            postflight = await fileSystem.inspect(path);
        } finally {
            await opened.close();
        }
        if (
            !sha256 ||
            !descriptorBefore ||
            !descriptorAfter ||
            !postflight ||
            !sameMetadata(preflight, descriptorBefore) ||
            !sameMetadata(descriptorBefore, descriptorAfter) ||
            !sameMetadata(descriptorAfter, postflight)
        ) {
            return {
                ready: false,
                limitation: limitation(
                    EnvironmentAdapterLimitationCode.BaselineResourceChanged,
                    'baseline',
                    'A bundled MV2 filter text changed while its executable bytes were locked.',
                ),
            };
        }
        resources.push({
            listKey: adguardListKey(resource.filterId),
            rulesetId: `filter_${resource.filterId}`,
            path: resource.portablePath,
            version: request.settings.versions.get(resource.filterId) ?? null,
            byteCount: preflight.size,
            sha256,
        });
    }
    const aggregateDigest = createHash('sha256')
        .update(JSON.stringify({ resources, unattributedFilterIds }))
        .digest('hex');
    return {
        ready: true,
        baseline: v.parse(PublishedBaselineProvenanceSchema, {
            environment: BrowserExtensionExecutorName,
            acquiredAt: request.acquiredAt,
            enabledListKeys: filterIds.map(adguardListKey),
            resources,
            ...(unattributedFilterIds.length > 0
                ? { unattributedListKeys: unattributedFilterIds.map(adguardListKey) }
                : {}),
            aggregateDigest,
        }),
    };
}
