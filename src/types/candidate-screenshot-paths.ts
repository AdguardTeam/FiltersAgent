/**
 * The screenshots of one candidate experiment as a run result names them: both viewports, and the
 * full-page overview of each state where the browser captured one. The browser cannot capture an
 * overview of a very tall document; the original-resolution tiles carry that state's proof.
 */

/**
 * The before and after overviews of one candidate, either of which may be missing.
 */
export interface CandidateOverviewPair<T> {
    /**
     * Overview before the candidate, absent when the browser captured none.
     */
    beforeFullPage?: T;

    /**
     * Overview after the candidate, absent when the browser captured none.
     */
    afterFullPage?: T;
}

/**
 * Before and after screenshot paths of one candidate.
 */
export interface CandidateScreenshotPathSet extends CandidateOverviewPair<string> {
    /**
     * Viewport before the candidate.
     */
    before: string;

    /**
     * Viewport after the candidate.
     */
    after: string;
}

/**
 * Map a candidate's overviews through one projection, leaving out any never captured.
 *
 * @param pair - The overviews as captured.
 * @param project - Projection applied to each captured overview.
 * @returns The projected overviews that exist.
 */
export function mapCandidateOverviews<T, U>(
    pair: CandidateOverviewPair<T>,
    project: (overview: T) => U,
): CandidateOverviewPair<U> {
    return {
        ...(pair.beforeFullPage === undefined
            ? {}
            : { beforeFullPage: project(pair.beforeFullPage) }),
        ...(pair.afterFullPage === undefined ? {} : { afterFullPage: project(pair.afterFullPage) }),
    };
}

/**
 * List one optional path as zero or one entries.
 *
 * @param path - The path, when one exists.
 * @returns The path in a list, or an empty list.
 */
export function optionalPathList(path: string | undefined): string[] {
    return path === undefined ? [] : [path];
}

/**
 * List a candidate's screenshot paths in before, after, before-overview, after-overview order.
 *
 * @param paths - The candidate's screenshot paths.
 * @returns Every path that exists, an overview never captured left out.
 */
export function candidateScreenshotPathList(paths: CandidateScreenshotPathSet): string[] {
    return [
        paths.before,
        paths.after,
        ...optionalPathList(paths.beforeFullPage),
        ...optionalPathList(paths.afterFullPage),
    ];
}
