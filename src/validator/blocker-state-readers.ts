import { readFile } from 'node:fs/promises';
import { BlockerVerificationMethod } from '../environment/environment-proofs';
import type { FilterListKey } from '../environment/filter-list-ref';
import { normalizeRulesContent, sha256OfContent } from '../environment/rules-content';
import type { BlockerVerificationDeclaration } from '../knowledge/instruction-application';

/**
 * The `BlockerStateReader` seam of the between-phases application: how one executor reads a
 * declared blocker state back.
 *
 * After the model's steps, the host reads the state itself — the live extension state, a user-rules
 * file, or managed-storage file by exact content — and the application is credited only when that
 * state contains exactly the expected content. A method the executor supplies no reader for is a
 * typed refusal, never a guess.
 */

/**
 * The MV3 static-ruleset counters the extension's rules-limits service reports, as the read-back
 * carries them for the credit's diagnosis. Chrome bounds both the number of enabled static rulesets
 * and their total rule count; the counters name what is enabled against each bound, so an
 * unverified outcome can say how far the requested set overshoots.
 *
 * The extension produced these numbers and the host read them over its own message surface, so they
 * are carried as read, never re-validated here.
 */
export interface Mv3RulesLimits {
    /**
     * Static rulesets (filters) Chrome currently has enabled.
     */
    staticFiltersEnabledCount: number;

    /**
     * Static rulesets Chrome allows enabled at once.
     */
    staticFiltersMaximumCount: number;

    /**
     * Static rules the enabled rulesets currently contribute.
     */
    staticRulesEnabledCount: number;

    /**
     * Static rules Chrome allows across the enabled rulesets.
     */
    staticRulesMaximumCount: number;
}

/**
 * The blocker state the host read back after the application steps.
 *
 * Arm fields are optional because the three verification methods observe different state families:
 * the extension state carries rules content, the enabled filter set and Tracking protection, a
 * file-backed state carries rules content, and a future reader family may carry only the enabled
 * filter list.
 */
export interface BlockerStateRead {
    /**
     * Exact rule content the state carries, one line per rule with outer storage whitespace removed
     * the same way the extension read-back has always compared bundles.
     */
    rulesContent?: string;

    /**
     * SHA-256 over the exact rule content, when the state exposes its digest directly.
     */
    rulesContentSha256?: string;

    /**
     * Enabled filter list keys the state reports, when the state carries filter settings. The
     * carrier of this record converts its own native identity into these keys, so a reader of any
     * executor family reports through the same seam.
     */
    enabledFilterIds?: readonly FilterListKey[];

    /**
     * Tracking-protection state the read-back observed, or undefined when the reader cannot observe
     * it (the file-backed methods) and the credit stays on the rules content alone.
     */
    stealthEnabled?: boolean;

    /**
     * Filter list keys the state reports as active MV3 DNR rulesets, when the reader can observe
     * them. Requested/options credit alone proves only that a filter is switched on, not that its
     * ruleset actually compiled and activated — the file-backed methods and an MV2 runtime carry no
     * such distinction and leave this undefined.
     */
    activeRulesetFilterIds?: readonly FilterListKey[];

    /**
     * Whether the state reports MV3 filter or rule limits exceeded after the application, or
     * undefined when the reader cannot observe the limits (the file-backed methods and an MV2
     * runtime).
     */
    limitsExceeded?: boolean;

    /**
     * The MV3 static-ruleset counters behind `limitsExceeded`, when the reader can observe them, so
     * an unverified credit names how far the requested set overshoots the limits.
     */
    rulesLimits?: Mv3RulesLimits;
}

/**
 * One verification reader: how the host reads a declared blocker state back.
 */
export type BlockerStateReader = (
    declaration: BlockerVerificationDeclaration,
) => Promise<BlockerStateRead>;

/**
 * The readers one executor supplies, keyed by verification method. A method with no reader is a
 * typed refusal: the host never guesses how to read a state it was not told how to read.
 */
export type BlockerStateReaderRegistry = Partial<
    Record<BlockerVerificationMethod, BlockerStateReader>
>;

/**
 * Build the read-back reader for the file-backed verification methods (`user-rules-file`,
 * `managed-storage-file`).
 *
 * The file's decoded text with its outer storage whitespace removed is the rules content, the same
 * normalization the extension read-back compares bundles with; the phase-credit digest is taken
 * over this same content, so a file holding exactly the expected rule lines proves the goal. A
 * product whose storage wraps the rules in a container format (managed JSON, database) ships its
 * own reader over this seam instead of growing this one.
 *
 * @returns The reader for the file-backed methods.
 */
export function fileBlockerStateReader(): BlockerStateReader {
    return async (declaration) => {
        if (declaration.target === undefined) {
            throw new Error(
                `The "${declaration.method}" verification declared no target path to read.`,
            );
        }
        const raw = await readFile(declaration.target, 'utf8');
        const content = normalizeRulesContent(raw);
        return { rulesContent: content, rulesContentSha256: sha256OfContent(content) };
    };
}
