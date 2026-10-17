import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    BUNDLED_METADATA_RULESET_ID,
    listBundledListIds,
    readBundledListLines,
} from '../../src/browser/extension-list-text';
import { withPreparedFiltersCheckout } from '../../src/local/filters-preparer';
import { ExtensionEnvironmentKind } from '../../src/types/extension-environment-kind';
import type { HumanCommitRuleLines } from './human-commit-oracle';

/**
 * The public source of the historical base used to distinguish new rules from moved duplicates.
 */
const FILTERS_REMOTE_URL = 'https://github.com/AdguardTeam/AdguardFilters.git';

/**
 * The preparation interface requires a current ref even though historical selection uses only SHA.
 */
const FILTERS_CURRENT_REF = 'master';

/**
 * Filter source files across the whole checkout carry one rule per line, including unmapped lists.
 */
const FILTER_TEXT_EXTENSION = '.txt';

/**
 * Filter text accepts both the repository's LF and generated CRLF line endings.
 */
const FILTER_LINE_BREAK = /\r?\n/u;

/**
 * A genuinely new human rule already present in one bundled list.
 */
export interface HumanFixBuildViolation {
    /**
     * Original human rule line, without its diff prefix.
     */
    rule: string;
    /**
     * List containing the newly introduced rule.
     */
    filterId: number;
}

/**
 * Refusals and advisory differences found while comparing the pre-fix state with a build.
 */
export interface HumanFixBuildCheck {
    /**
     * New human-added rules that already occur in the build's list text.
     */
    violations: HumanFixBuildViolation[];
    /**
     * Removed human rules absent from the build, without making the build unsuitable.
     */
    warnings: string[];
}

/**
 * Read trimmed lines from every text file below a historical filters checkout.
 *
 * @param directory - Directory in the complete historical checkout tree.
 * @param lines - Set receiving every trimmed text line, regardless of placement mapping.
 * @returns Nothing; unreadable directories and text files fail loudly.
 */
function collectFilterLines(directory: string, lines: Set<string>): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            collectFilterLines(path, lines);
        } else if (entry.name.endsWith(FILTER_TEXT_EXTENSION)) {
            for (const line of readFileSync(path, 'utf8').split(FILTER_LINE_BREAK)) {
                lines.add(line.trim());
            }
        }
    }
}

/**
 * Compare genuinely new human rules with all manifest-listed filter texts in the selected build.
 *
 * @param extensionDir - Prepared extension root with readable bundled list texts.
 * @param humanFix - Original added and removed rule lines from the human commit.
 * @param filtersBasePath - Complete AdguardFilters checkout at the case's historical base SHA.
 * @returns Refusals for new added rules already present, and warnings for absent removed rules.
 */
export function checkHumanFixAbsent(
    extensionDir: string,
    humanFix: HumanCommitRuleLines,
    filtersBasePath: string,
): HumanFixBuildCheck {
    const baseLines = new Set<string>();
    collectFilterLines(filtersBasePath, baseLines);
    const lists = listBundledListIds(extensionDir)
        .filter((filterId) => filterId !== BUNDLED_METADATA_RULESET_ID)
        .map((filterId) => ({
            filterId,
            lines: new Set(readBundledListLines(extensionDir, filterId).map((line) => line.trim())),
        }));
    const violations: HumanFixBuildViolation[] = [];
    for (const rule of humanFix.added) {
        if (baseLines.has(rule.trim())) {
            continue;
        }
        for (const list of lists) {
            if (list.lines.has(rule.trim())) {
                violations.push({ rule, filterId: list.filterId });
            }
        }
    }
    const warnings = humanFix.removed.filter(
        (rule) => !lists.some((list) => list.lines.has(rule.trim())),
    );
    return { violations, warnings };
}

/**
 * Use the existing historical filters preparation lifecycle to check rules against the exact base.
 *
 * @param extensionDir - Verified historical extension build directory.
 * @param humanFix - Original human-added and removed rule lines.
 * @param filtersBaseSha - Exact pre-issue AdguardFilters revision selected by the case.
 * @param prepareCheckout - Existing preparation seam, injectable for offline tests.
 * @returns The guard result after the disposable historical checkout has been cleaned up.
 */
export async function checkHistoricalHumanFixAbsent(
    extensionDir: string,
    humanFix: HumanCommitRuleLines,
    filtersBaseSha: string,
    prepareCheckout: typeof withPreparedFiltersCheckout = withPreparedFiltersCheckout,
): Promise<HumanFixBuildCheck> {
    return prepareCheckout(
        {
            environment: { kind: ExtensionEnvironmentKind.Historical, baseSha: filtersBaseSha },
            remoteUrl: FILTERS_REMOTE_URL,
            currentRef: FILTERS_CURRENT_REF,
            keepTemporaryFiles: false,
        },
        async (prepared) => checkHumanFixAbsent(extensionDir, humanFix, prepared.checkoutPath),
    );
}

/**
 * A historical build already contains a rule genuinely introduced by the human fix.
 */
export class HumanFixPresentError extends Error {
    /**
     * All new human rules already present in bundled list text.
     */
    readonly violations: HumanFixBuildViolation[];

    constructor(violations: HumanFixBuildViolation[]) {
        const detail = violations
            .map(
                (violation) =>
                    `Rule ${violation.rule} is already present in list ${violation.filterId}`,
            )
            .join('; ');
        super(`The build already carries the human fix: ${detail}`);
        this.name = 'HumanFixPresentError';
        this.violations = violations;
    }
}
