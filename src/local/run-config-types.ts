import { ExtensionEnvironmentKind } from '../types/extension-environment-kind';
import { KnowledgeBaseEnvironmentKind } from '../types/knowledge-base-environment-kind';

/**
 * Selects the current upstream AdguardFilters head.
 */
export interface CurrentFiltersEnvironment {
    /**
     * Selects the current branch head.
     */
    kind: typeof KnowledgeBaseEnvironmentKind.Current;
}

/**
 * Selects the exact AdguardFilters state that preceded a historical issue.
 */
export interface HistoricalFiltersEnvironment {
    /**
     * Selects a pinned historical commit.
     */
    kind: typeof ExtensionEnvironmentKind.Historical;

    /**
     * Full pre-issue AdguardFilters commit SHA.
     */
    baseSha: string;
}

/**
 * Revision selection used by the temporary AdguardFilters checkout.
 */
export type FiltersEnvironment = CurrentFiltersEnvironment | HistoricalFiltersEnvironment;

/**
 * Selects the latest configured KnowledgeBase branch head.
 */
export interface CurrentKnowledgeBaseEnvironment {
    /**
     * Selects the current branch head.
     */
    kind: typeof KnowledgeBaseEnvironmentKind.Current;
}

/**
 * Selects one immutable KnowledgeBase revision for a reproducible run.
 */
export interface PinnedKnowledgeBaseEnvironment {
    /**
     * Selects exact pinned behavior.
     */
    kind: typeof KnowledgeBaseEnvironmentKind.Pinned;

    /**
     * Full KnowledgeBase commit SHA.
     */
    commit: string;
}

/**
 * Revision selection used by the sparse documentation checkout.
 */
export type KnowledgeBaseEnvironment =
    | CurrentKnowledgeBaseEnvironment
    | PinnedKnowledgeBaseEnvironment;

/**
 * Configuration for a disposable AdguardFilters checkout.
 */
export interface FiltersPreparationConfig {
    /**
     * Current or historical revision selection.
     */
    environment: FiltersEnvironment;

    /**
     * Optional local checkout used only as a shared clone source.
     */
    localSourcePath?: string;

    /**
     * Remote repository used when a local checkout is unavailable.
     */
    remoteUrl: string;

    /**
     * Branch whose remote head represents the current filters state.
     */
    currentRef: string;

    /**
     * Retains the disposable checkout for explicit debugging.
     */
    keepTemporaryFiles: boolean;
}

/**
 * Configuration for a disposable allowlisted KnowledgeBase checkout.
 */
export interface KnowledgeBasePreparationConfig {
    /**
     * Latest-master or exact pinned revision selection.
     */
    environment: KnowledgeBaseEnvironment;

    /**
     * Optional local checkout used only as a shared object source.
     */
    localSourcePath?: string;

    /**
     * Remote repository used for current refresh and fallback cloning.
     */
    remoteUrl: string;

    /**
     * `owner/repo` slug of the KnowledgeBase remote; documentation citations and their GitHub URLs
     * are built from it.
     */
    knowledgeBaseRepository: string;

    /**
     * `owner/repo` slug of the filters remote supplying CONTRIBUTING.md; its citations and their
     * GitHub URLs are built from it.
     */
    filtersRepository: string;

    /**
     * Branch whose remote head represents current documentation.
     */
    currentRef: string;

    /**
     * Retains the disposable sparse checkout for explicit debugging.
     */
    keepTemporaryFiles: boolean;
}

/**
 * Fully resolved local browser-first environment configuration.
 */
export interface LocalRunConfig {
    /**
     * Product time horizon selected by the CLI.
     */
    environment: ExtensionEnvironmentKind;

    /**
     * Disposable filter checkout configuration.
     */
    filters: FiltersPreparationConfig;

    /**
     * Disposable pinned/current KnowledgeBase configuration.
     */
    knowledgeBase: KnowledgeBasePreparationConfig;

    /**
     * Operator-supplied run-instruction path, absolute or relative to the filters checkout. An
     * explicitly supplied path that is missing or unreadable fails the run naming it — the built-in
     * default belongs to absence only. Unset probes the checkout's AGENTS.md and falls back to the
     * built-in KnowledgeBase provisioning when absent.
     */
    instructionPath?: string;
}
