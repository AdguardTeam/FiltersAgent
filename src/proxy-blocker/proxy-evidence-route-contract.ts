/**
 * What the proxy-blocker evidence route is built from, and what it offers beyond the generic
 * evidence route: the HTTPS filtering proof the executor runs before it hands the route to the
 * run.
 */
import type { BrowserSession } from '../browser/browser-session';
import type { BlockerContract } from '../blocker-contract/blocker-contract';
import type { EvidenceRouteHost } from '../local/evidence-route-contract';
import type { downloadOfficialFilters } from '../local/official-filter-downloader';
import type { probePlainHttp } from '../local/plain-http-probe';
import type { probeTlsInterception } from '../local/tls-interception-diagnostic';
import type { HttpsFilteringProof } from './https-filtering-proof';

/**
 * Construction input for one run-owned AdGuard CLI evidence route.
 */
export interface CreateProxyBlockerEvidenceRouteInput {
    /**
     * Exact cycle identity, retained for route binding.
     */
    cycleId: string;

    /**
     * The blocker the route drives through the contract.
     */
    blocker: BlockerContract;

    /**
     * Directory the route owns for the baseline catalog and browser profiles.
     */
    workspaceDir: string;

    /**
     * Directory holding cached official filter lists across runs.
     */
    filterCacheDir: string;

    /**
     * Official filter identifiers the reporter had enabled.
     */
    reporterFilterIds?: readonly number[];

    /**
     * Host wall-clock source.
     */
    now?: () => string;

    /**
     * Optional deterministic seams.
     */
    dependencies?: {
        /**
         * Filter list downloader.
         */
        downloadFilters?: typeof downloadOfficialFilters;
        /**
         * Strict-route browser session factory.
         */
        createBrowserSession?: typeof BrowserSession.create;
        /**
         * HTTPS probe proving a request to the target goes through the proxy's filter.
         */
        probeInterception?: typeof probeTlsInterception;
        /**
         * Plain HTTP probe for an `http:` target served without HTTPS.
         */
        probePlainHttp?: typeof probePlainHttp;
        /**
         * Private browser-root reservation.
         */
        reserveBrowserRoot?: () => Promise<string>;
    };
}

/**
 * The proxy-blocker evidence route, with the capability gate the executor runs before it hands the
 * route to the run.
 */
export interface ProxyBlockerEvidenceRoute extends EvidenceRouteHost {
    /**
     * Start the blocker's proxy and prove an HTTPS request to the target goes through its filter.
     * Sessions launch only after this succeeded: before it, nothing shows the browser's traffic
     * would be filtered at all.
     *
     * @param targetUrl - The run's target.
     * @returns Whether HTTPS filtering is proven for the target.
     */
    proveHttpsFiltering(targetUrl: string): Promise<HttpsFilteringProof>;
}
