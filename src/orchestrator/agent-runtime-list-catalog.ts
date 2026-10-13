import { generatePlacementMap } from '../repo/placement-map';
import { buildListCatalog, type ListCatalog } from '../environment/list-catalog';
import { createLogger } from '../logger/logger';
import type { PlacementMap } from '../types/repo-context';

/**
 * The substitute placement map a failed checkout walk degrades to: no file entries and no
 * timestamp, because nothing was walked — the underlying error is logged at the failure site, so
 * the substitute never carries fabricated data. No executor loads the repository's own list files
 * yet, so a failed walk never narrows the executor request: the catalog just holds only the
 * report's third-party entries.
 */
const FAILED_WALK_PLACEMENT_MAP: PlacementMap = {
    checkoutPath: '',
    generatedAt: '',
    files: [],
};

/**
 * Inputs of the runtime's per-run list catalog.
 */
export interface AgentRuntimeListCatalogInputs {
    /**
     * Pinned checkout path the single placement-map walk runs over.
     */
    filtersPath: string;

    /**
     * The report's enabled list texts, untrusted.
     */
    enabledListTexts: readonly string[];

    /**
     * Whether verbose lifecycle logging is enabled.
     */
    verbose: boolean;
}

/**
 * The runtime's per-run list catalog bundle: the ONE placement-map walk of the pinned checkout, and
 * the list catalog built from it, so every consumer — the checkout tools via the supplied factory
 * option and the filtering-environment preparation projection — reads the same derivation.
 */
export interface AgentRuntimeListCatalogBundle {
    /**
     * The walked placement map, or null when the walk failed (the failure is logged); a null map is
     * never handed to the tool factory, which then walks its own.
     */
    placementMap: PlacementMap | null;

    /**
     * The list catalog derived from the walked map and the report's enabled list texts.
     */
    catalog: ListCatalog;
}

/**
 * Walk the pinned checkout once and build the run's list catalog for the runtime.
 *
 * A failed walk is logged with the underlying error and degrades to the empty substitute map: the
 * catalog then holds only the report's third-party entries, and today's checkout-readiness gate
 * stays with the tool factory's own walk when no runtime map can be supplied.
 *
 * @param inputs - The checkout and report inputs of the run.
 * @returns The bundle the runtime shares between the registry wiring and the preparation request.
 */
export function buildAgentRuntimeListCatalog(
    inputs: AgentRuntimeListCatalogInputs,
): AgentRuntimeListCatalogBundle {
    let placementMap: PlacementMap | null = null;
    try {
        placementMap = generatePlacementMap(inputs.filtersPath);
    } catch (error) {
        createLogger({ verbose: inputs.verbose }).error(
            {
                err: error,
                filtersPath: inputs.filtersPath,
            },
            'placement map walk failed; the run list catalog degrades to the report-derived entries only',
        );
    }
    const catalog = buildListCatalog({
        placementMap: placementMap ?? FAILED_WALK_PLACEMENT_MAP,
        enabledListTexts: inputs.enabledListTexts,
    });
    return { placementMap, catalog };
}
