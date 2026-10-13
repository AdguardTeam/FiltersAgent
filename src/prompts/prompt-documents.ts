import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    type PlaceholderValues,
    PromptRenderError,
    PromptRenderErrorKind,
    renderTemplate,
} from './template';

/**
 * The prompt corpus registry: every document the loop can render.
 *
 * The system document is singular on purpose — one universal, static system text shared by all
 * modes is what makes the session prefix byte-identical across modes.
 */
export const PromptDocumentName = {
    /**
     * The universal static system document shared by all modes.
     */
    System: 'system',

    /**
     * The single re-prompt sent when a turn ends without the terminal call.
     */
    Nudge: 'nudge',

    /**
     * The single steering message sent when the run's wall-clock budget is about to expire.
     */
    WrapUp: 'wrap-up',

    /**
     * Fix-mode user task.
     */
    FixTask: 'tasks/fix',

    /**
     * Preparation-stage user task: the short-lived session that performs the instruction's blocker
     * steps with the two step tools before the fix session ever starts.
     */
    PreparationTask: 'tasks/preparation',

    /**
     * Rule-application user task: the short-lived session that performs the instruction's
     * application steps on the phase lease between two environment phases.
     */
    ApplicationTask: 'tasks/application',

    /**
     * Intake extraction task: fill the report schema from one issue.
     */
    ExtractReportTask: 'tasks/extract-report',

    /**
     * Ads-report targeting guidance — a fill for the fix task's `{{targetingGuidance}}`.
     */
    FixTargetingAds: 'fix-targeting/ads',

    /**
     * Incorrect-blocking targeting guidance — a fill for the fix task's `{{targetingGuidance}}`.
     */
    FixTargetingIncorrectBlocking: 'fix-targeting/incorrect-blocking',

    /**
     * Selection-first environment framing — the agentic fix session's `{{environmentContext}}`.
     */
    FixContextSelectionFirst: 'fix-context/selection-first',

    /**
     * Pre-orchestrated environment framing — a pre-orchestrated fix session's
     * `{{environmentContext}}`.
     */
    FixContextPreOrchestrated: 'fix-context/pre-orchestrated',

    /**
     * Reporter-profile confirmation-pass text — the fix task's `{{candidateConfirmation}}` fill
     * when a prior controlled profile's candidate is being confirmed or rejected.
     */
    FixContextCandidateConfirmation: 'fix-context/candidate-confirmation',

    /**
     * Run-instruction context — the fix task's `{{instructionContext}}` fill: the instruction text
     * plus the roster of documents it links for rule guidance.
     */
    FixTaskInstructionContext: 'tasks/instruction-context',

    /**
     * Preparation-already-done note — the instruction context's `{{preparationContext}}` fill for
     * an instruction whose preparation section the host performed before the session started.
     */
    FixTaskInstructionPreparationDone: 'tasks/instruction-preparation-done',

    /**
     * Guidance of a full-vision rejection when a qualifying session already exists: finish the
     * capture there, do not relaunch. One guidance line per document line.
     */
    RejectionQualifyingSession: 'rejections/qualifying-session',

    /**
     * Launch-first guidance of the current-extension full-vision rejection when no qualifying
     * session exists. One guidance line per document line.
     */
    RejectionCurrentExtensionLaunch: 'rejections/current-extension-launch',

    /**
     * Launch-first guidance of the CLI-route full-vision rejection when no qualifying session
     * exists. One guidance line per document line.
     */
    RejectionCliRouteLaunch: 'rejections/cli-route-launch',

    /**
     * Built-in AdGuard application instruction — the options-page steps that apply the reporter's
     * settings and the candidate to user filters, plus the verification declaration the host reads
     * back.
     */
    InstructionsAdguardExtension: 'instructions/adguard-extension',

    /**
     * Shipped example instruction for uBlock Origin in Firefox, for a uAssets-style filter
     * repository that copies it in as its run instruction: preparation of the signed uBO release
     * with Firefox policies and managed storage, rule application through the declared user-filters
     * file, the `managed-storage-file` verification declaration, issue selection, and the report
     * template.
     */
    InstructionsUblockOriginFirefox: 'instructions/ublock-origin-firefox',

    /**
     * Shipped example instruction for Edge with the MV2 build of the AdGuard Browser Extension, for
     * a filter-list repository that copies it in as its run instruction: preparation of branded
     * Edge and the current release's `edge.zip` MV2 build from the public releases API, rule
     * application through the AdGuard options page, the live `extension-state user-rules`
     * verification declaration, issue selection, and the report template.
     */
    InstructionsEdgeMv2: 'instructions/edge-mv2',

    /**
     * Shipped example instruction for uBlock Origin Lite in Chromium, for a filter-list repository
     * that copies it in as its run instruction: preparation of the current uBOLite Chromium release
     * from the public releases API under the exact-suffix asset matcher, rule application through
     * the custom-filters file with Developer mode enabled, the `user-rules-file` verification
     * declaration, issue selection, and the report template carrying the reduced-engine
     * verification caveat.
     */
    InstructionsUblockOriginLite: 'instructions/ublock-origin-lite',
} as const;

/**
 * PromptDocumentName value.
 */
export type PromptDocumentName = (typeof PromptDocumentName)[keyof typeof PromptDocumentName];

/**
 * Every registered document name, for sweeps that must cover the whole corpus.
 */
export const PROMPT_DOCUMENT_NAMES = Object.values(PromptDocumentName);

/**
 * Document storage layout: Markdown files next to this module, anchored at `import.meta.url` —
 * under tsx/tsc ESM that always names this module file, and URL-resolution is what reads the corpus
 * wherever the module travels next to its `documents/` directory. The repository ships sources, not
 * a bundle, so there is no CJS `__filename` fallback anchor.
 */
const DEFAULT_DOCUMENTS_DIR = fileURLToPath(new URL('documents/', import.meta.url));

/**
 * The on-disk extension of every prompt document.
 */
const DOCUMENT_FILE_EXTENSION = '.md';

/**
 * Options for creating a prompt document loader.
 */
export interface PromptDocumentLoaderOptions {
    /**
     * Override document root. Production wiring never sets this; tests use it to render
     * hand-written fixtures instead of the shipped corpus.
     */
    documentsDir?: string;
}

/**
 * Reads and renders prompt documents. Each document is read from disk once per loader instance and
 * memoized afterwards.
 */
export interface PromptDocumentLoader {
    /**
     * Return the raw document text (memoized).
     *
     * @param name - The registered document name.
     * @returns The document's exact file bytes as text.
     */
    read(name: PromptDocumentName): string;

    /**
     * Render a document with strict placeholder substitution.
     *
     * @param name - The registered document name.
     * @param values - Fill values; must exactly match the document's declared placeholders.
     * @returns The rendered text.
     */
    render(name: PromptDocumentName, values?: PlaceholderValues): string;
}

/**
 * Create a loader over the prompt document corpus.
 *
 * @param options - Optional document-root override for tests.
 * @returns The loader.
 */
export function createPromptDocumentLoader(
    options: PromptDocumentLoaderOptions = {},
): PromptDocumentLoader {
    const documentsDir = options.documentsDir ?? DEFAULT_DOCUMENTS_DIR;
    const cache = new Map<string, string>();

    const read = (name: PromptDocumentName): string => {
        if (!PROMPT_DOCUMENT_NAMES.includes(name)) {
            throw new PromptRenderError(
                PromptRenderErrorKind.UnknownDocument,
                `unknown prompt document '${name}' — registered: ${PROMPT_DOCUMENT_NAMES.join(', ')}`,
            );
        }
        const cached = cache.get(name);
        if (cached !== undefined) {
            return cached;
        }
        // A missing file for a registered name is a packaging bug: let the fs error propagate
        // unmodified — it already names the exact missing path.
        const template = readFileSync(
            join(documentsDir, `${name}${DOCUMENT_FILE_EXTENSION}`),
            'utf8',
        );
        cache.set(name, template);
        return template;
    };

    const render = (name: PromptDocumentName, values: PlaceholderValues = {}): string =>
        renderTemplate(read(name), values, `document '${name}'`);

    return { read, render };
}
