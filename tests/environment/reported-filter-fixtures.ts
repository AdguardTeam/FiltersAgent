import { OFFICIAL_ADGUARD_FILTERS } from '../../src/environment/official-filter-table';
import type { ReportedFilter } from '../../src/types/issue-facts';

/**
 * Build reported lists the way the extraction fills them: a name the official catalog has carries
 * that list's id, any other name none.
 *
 * @param names - Reported list texts.
 * @returns The lists as issue facts carry them.
 */
export function reportedFilters(...names: string[]): ReportedFilter[] {
    return names.map((name) => {
        const official = OFFICIAL_ADGUARD_FILTERS.find((filter) => filter.name === name);
        return official === undefined ? { name } : { name, officialFilterId: official.filterId };
    });
}
