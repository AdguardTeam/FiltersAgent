/**
 * The blocker contract: the six operations through which the agent drives any proxy-kind blocker
 * without knowing how the blocker works inside. A blocker module answers them; the agent applies a
 * candidate, reads the blocker's own state back, and collects what it reports, all through these
 * operations, and never reads the blocker's files, logs or configuration itself.
 *
 * The operations are a TypeScript interface here and travel as JSON between processes
 * (`blocker-wire.ts`), so every value in them is plain data.
 */

/**
 * Version of the contract this agent speaks. A module describing another version is refused before
 * it is started, so a changed shape never reaches the phase machine.
 */
export const BLOCKER_CONTRACT_VERSION = 2;

/**
 * Environment variable naming the private directory a module process keeps its own files in.
 */
export const BLOCKER_WORKSPACE_ENV = 'FILTERS_AGENT_BLOCKER_WORKSPACE';

/**
 * How a blocker filters the browser's traffic. Only the proxy kind is driven through the contract
 * today; the built-in browser extension keeps its in-process route.
 */
export const BlockerKind = {
    Proxy: 'proxy',
} as const;

/**
 * BlockerKind value.
 */
export type BlockerKind = (typeof BlockerKind)[keyof typeof BlockerKind];

/**
 * The format of what a blocker leaves inside the pages it filters, which only the agent can read
 * because only the agent holds the page.
 */
export const PageEvidenceFormat = {
    /**
     * Element-hiding markers `adguard<list>;<rule>` on hidden elements and content scripts that
     * list the script rules they run, served from {@link PageEvidence.contentScriptHost}.
     */
    AdguardMarkers: 'adguard_markers',
} as const;

/**
 * PageEvidenceFormat value.
 */
export type PageEvidenceFormat = (typeof PageEvidenceFormat)[keyof typeof PageEvidenceFormat];

/**
 * Where and how the agent reads a blocker's in-page reports.
 */
export interface PageEvidence {
    /**
     * Format of the in-page reports.
     */
    format: PageEvidenceFormat;

    /**
     * Host the blocker serves its injected content scripts from.
     */
    contentScriptHost: string;
}

/**
 * What a blocker module says about itself before it is started.
 */
export interface BlockerDescription {
    /**
     * Contract version the module speaks; compared with {@link BLOCKER_CONTRACT_VERSION}.
     */
    contractVersion: number;

    /**
     * Product label the run reports as its actual filtering context.
     */
    product: string;

    /**
     * Exact engine version, or null when the executing build does not report one.
     */
    version: string | null;

    /**
     * SHA-256 of the executing engine binary, hex: the installation identity the run proves.
     */
    binarySha256: string;

    /**
     * How the blocker filters traffic.
     */
    kind: BlockerKind;

    /**
     * What the engine's reports cover, in prose the model reads beside every applied-rules report.
     */
    covers: string;

    /**
     * Rule kinds the engine acts on without reporting their text, in prose for the model.
     */
    notReported: readonly string[];

    /**
     * The blocker's in-page reports, or null when it leaves none.
     */
    pageEvidence: PageEvidence | null;
}

/**
 * One filter list a blocker executes, given to it whole so it runs exactly these bytes.
 */
export interface BlockerFilterList {
    /**
     * Official filter identifier of the list.
     */
    id: number;

    /**
     * The list's full text.
     */
    content: string;
}

/**
 * How the browser reaches a started proxy blocker.
 */
export interface BlockerRoute {
    /**
     * Proxy URL the browser sends its traffic through.
     */
    proxyUrl: string;

    /**
     * The certificate authority the proxy signs intercepted connections with, DER as base64.
     */
    certificateDerBase64: string;
}

/**
 * The blocker's running configuration after a start or an apply.
 */
export interface BlockerRunning {
    /**
     * How the browser reaches the proxy now.
     */
    route: BlockerRoute;

    /**
     * Increases every time the proxy restarts. A browser session launched at one revision no longer
     * reaches the proxy at a later one, and its log ends there.
     */
    revision: number;
}

/**
 * The configuration an apply asks the blocker to execute.
 */
export interface BlockerApplyRequest {
    /**
     * Identifiers of the started lists to execute, or null for every started list.
     */
    enabledListIds: readonly number[] | null;

    /**
     * The agent-authored rules to execute beside the lists, exactly; empty for none.
     */
    userRules: readonly string[];

    /**
     * Text one started list executes instead of its started text — an edit or a removal of one of
     * its lines — or null to execute every list as started.
     */
    listReplacement: BlockerFilterList | null;
}

/**
 * The configuration a start runs the blocker with.
 */
export interface BlockerStartRequest extends BlockerApplyRequest {
    /**
     * Every list the blocker may execute during the run; applies choose among them by identifier.
     */
    lists: readonly BlockerFilterList[];
}

/**
 * The result of one apply.
 */
export interface BlockerApplied extends BlockerRunning {
    /**
     * Whether the apply restarted the proxy; false when the requested configuration already ran.
     */
    restarted: boolean;
}

/**
 * One list as the blocker executes it.
 */
export interface BlockerListState {
    /**
     * Official filter identifier of the list.
     */
    id: number;

    /**
     * SHA-256 of the exact bytes the blocker executes, hex.
     */
    sha256: string;
}

/**
 * The blocker's own account of what it executes.
 */
export interface BlockerState {
    /**
     * Whether the proxy is running.
     */
    running: boolean;

    /**
     * Current revision; see {@link BlockerRunning.revision}.
     */
    revision: number;

    /**
     * Loopback port of the running proxy, or null.
     */
    port: number | null;

    /**
     * The lists the blocker executes now.
     */
    lists: readonly BlockerListState[];

    /**
     * The agent-authored rules the blocker executes now, exactly.
     */
    userRules: readonly string[];
}

/**
 * What a reported event is about.
 */
export const BlockerEventKind = {
    /**
     * A network request a rule decided.
     */
    Request: 'request',

    /**
     * An element the blocker removed from served HTML.
     */
    HtmlElementRemoved: 'html_element_removed',

    /**
     * A host whose traffic the blocker passed through without reading its content, so no rule that
     * acts on a page (element hiding, scripts, HTML filtering) can apply there.
     */
    UnfilteredHost: 'unfiltered_host',
} as const;

/**
 * BlockerEventKind value.
 */
export type BlockerEventKind = (typeof BlockerEventKind)[keyof typeof BlockerEventKind];

/**
 * A network request a rule decided.
 */
export interface BlockerRequestEvent {
    /**
     * Event discriminant.
     */
    kind: typeof BlockerEventKind.Request;

    /**
     * The request URL.
     */
    url: string;

    /**
     * The rule text exactly as the blocker reported it.
     */
    rule: string;

    /**
     * Whether the blocker refused the connection at the TLS handshake instead of answering it.
     */
    handshakeBlock: boolean;
}

/**
 * An element the blocker removed from served HTML.
 */
export interface BlockerHtmlElementRemovedEvent {
    /**
     * Event discriminant.
     */
    kind: typeof BlockerEventKind.HtmlElementRemoved;

    /**
     * URL of the document the element was removed from.
     */
    url: string;

    /**
     * Name of the removed element.
     */
    element: string;

    /**
     * The rule text exactly as the blocker reported it.
     */
    rule: string;
}

/**
 * A host whose traffic the blocker passed through without reading its content.
 */
export interface BlockerUnfilteredHostEvent {
    /**
     * Event discriminant.
     */
    kind: typeof BlockerEventKind.UnfilteredHost;

    /**
     * The host, as the blocker named it.
     */
    host: string;

    /**
     * Why the blocker left it unfiltered, in the blocker's words.
     */
    reason: string;
}

/**
 * One reported event.
 */
export type BlockerEvent =
    | BlockerRequestEvent
    | BlockerHtmlElementRemovedEvent
    | BlockerUnfilteredHostEvent;

/**
 * Events reported since a cursor.
 */
export interface BlockerLogRead {
    /**
     * Revision the events were read at.
     */
    revision: number;

    /**
     * Cursor to pass to the next read for only the events after these.
     */
    cursor: string;

    /**
     * The events, oldest first.
     */
    events: readonly BlockerEvent[];
}

/**
 * What a stop released.
 */
export interface BlockerStopped {
    /**
     * Whether the engine released a licence device it held, so a run can prove none leaked.
     */
    licenceReleased: boolean;
}

/**
 * The six operations of one blocker. A module that is not started answers only describe and stop.
 */
export interface BlockerContract {
    /**
     * Describe the blocker without starting it.
     *
     * @returns The description.
     */
    describe(): Promise<BlockerDescription>;

    /**
     * Start the blocker with every list it may execute, executing the requested ones and rules.
     *
     * @param request - The lists, and which of them and which rules to execute first.
     * @returns How the browser reaches it, at revision 1 or later.
     */
    start(request: BlockerStartRequest): Promise<BlockerRunning>;

    /**
     * Execute exactly the requested lists and rules.
     *
     * @param request - The lists and rules.
     * @returns How the browser reaches it now.
     */
    apply(request: BlockerApplyRequest): Promise<BlockerApplied>;

    /**
     * Read what the blocker executes now.
     *
     * @returns The blocker's own account.
     */
    state(): Promise<BlockerState>;

    /**
     * Read the events reported since a cursor.
     *
     * @param cursor - Cursor from an earlier read, or null to read nothing and only learn the
     *   cursor at this moment, which is how a browser session marks where its own events begin.
     * @returns The events and the next cursor.
     */
    log(cursor: string | null): Promise<BlockerLogRead>;

    /**
     * Stop the blocker and release what it holds. Idempotent.
     *
     * @returns What was released.
     */
    stop(): Promise<BlockerStopped>;
}
