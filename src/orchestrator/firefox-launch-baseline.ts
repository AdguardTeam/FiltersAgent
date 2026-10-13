/**
 * The launch-time baseline of a Firefox-family run.
 *
 * The Chromium route proves its baseline by pre-reading the AdGuard extension's live state,
 * converging the requested filter set against the build's bundled catalog and crediting the session
 * from a state read-back. A Firefox-family run can do none of that: `moz-extension://` pages cannot
 * be driven, so the blocker's own state is unreadable from the host.
 *
 * Readiness here means a successful launch with the declared policies applied. The browser has
 * installed the signed XPI and read the managed-storage document at startup by the time the session
 * exists, so the baseline this function credits is the declaration's own list selection — and it
 * says plainly what it could not observe, so nothing downstream mistakes the credit for a live
 * settings proof.
 */
import { declaredBaselineListKeys } from '../environment/declared-filter-baseline';
import type { FilterListKey } from '../environment/filter-list-ref';
import type { Logger } from '../logger/logger';
import type { FirefoxPreparedExtension } from '../local/prepared-extension';

/**
 * The declared launch baseline of one Firefox-family session.
 */
export interface FirefoxDeclaredBaseline {
    /**
     * The executable list keys the session launched with: the managed-storage declaration's own
     * selection, user filters included.
     */
    listKeys: readonly FilterListKey[];

    /**
     * What the credit rests on and what it could not observe, for the launch result and the log.
     */
    detail: string;
}

/**
 * Credit one Firefox-family launch from its own declaration.
 *
 * @param launch - The Firefox-family prepared build the session launched with.
 * @param logger - Run logger receiving the credited selection.
 * @returns The declared list keys and the detail naming how the baseline was established, or null
 *   when the declaration selects no list at all and there is therefore nothing to credit.
 */
export function launchFirefoxDeclaredBaseline(
    launch: FirefoxPreparedExtension,
    logger: Logger,
): FirefoxDeclaredBaseline | null {
    const listKeys = declaredBaselineListKeys(launch);
    if (listKeys.length === 0) {
        logger.warn(
            { extensionId: launch.extensionId },
            'the Firefox launch declaration selects no filter list, so no baseline can be credited',
        );
        return null;
    }
    logger.info(
        {
            extensionId: launch.extensionId,
            xpiPath: launch.xpiPath,
            declaredListKeys: listKeys,
        },
        'the Firefox launch baseline is the declaration, applied by the browser at startup',
    );
    return {
        listKeys,
        detail:
            `The ${launch.extensionId} baseline is the run instruction's own managed-storage ` +
            `selection (${listKeys.join(', ')}), applied by Firefox when it force-installed the ` +
            'signed XPI. The blocker has no host-readable live state, so this baseline is ' +
            "credited from the declaration and the run's phases are credited from the declared " +
            'file read-back.',
    };
}
