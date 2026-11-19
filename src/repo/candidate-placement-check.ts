import { placementRuleTypeOfRule } from './candidate-rule-type';
import { planRepositoryEdit } from './repository-edit';
import { declaredPlacementFor, type DeclaredPlacementSet } from '../types/declared-placement';
import type { PlacementPosition } from '../types/rule-proposal';

/**
 * The repository facts a placement check reads.
 */
export interface CandidatePlacementContext {
    /**
     * Pinned filters checkout root.
     */
    checkoutPath: string;

    /**
     * Checkout-relative paths of the repository's own list files: a rule may be proposed only in
     * one of them.
     */
    ownedListPaths: ReadonlySet<string>;

    /**
     * The run instruction's placement declarations, rendered for this run, when it declares any.
     */
    declaredPlacement?: DeclaredPlacementSet;
}

/**
 * Check whether a model-supplied file path names one of the repository's own list files.
 *
 * Exact or checkout-suffixed, case-insensitive, separator-normalized, so a path written with the
 * checkout's own directory in front of it is not refused as a foreign list for spelling alone.
 *
 * @param ownedPaths - Checkout-relative paths of the repository's own list files.
 * @param candidatePath - The untrusted model-supplied path to test.
 * @returns True when the path resolves to an owned list file.
 */
function namesOwnedPath(ownedPaths: ReadonlySet<string>, candidatePath: string): boolean {
    const normalized = candidatePath.replace(/\\/gu, '/').toLowerCase();
    for (const ownedPath of ownedPaths) {
        const owned = ownedPath.replace(/\\/gu, '/').toLowerCase();
        if (normalized === owned || normalized.endsWith(`/${owned}`)) {
            return true;
        }
    }
    return false;
}

/**
 * Check that a candidate can be inserted into the file, at the place, the agent chose.
 *
 * The agent decides the file and the position inside it. This only answers whether the edit is
 * possible there, so the terminal gate can hand the reason back while the agent can still choose
 * again; it never picks another file and never picks a position. Whether the rule joins an existing
 * shared rule instead is the repository edit planner's decision when the patch is built, and that
 * edit ignores the position.
 *
 * @param context - The checkout, its own list files, and the run's declared placements.
 * @param candidateRule - The single-domain candidate rule.
 * @param filePath - Repository-relative file the agent chose.
 * @param position - The position the agent named inside that file, or undefined when it named none.
 * @returns Why the candidate cannot be inserted there, or undefined when it can.
 */
export function candidatePlacementProblem(
    context: CandidatePlacementContext,
    candidateRule: string,
    filePath: string,
    position: PlacementPosition | undefined,
): string | undefined {
    if (filePath.trim().length === 0) {
        return 'No file was chosen: name the repository list file the rule belongs in.';
    }
    // A declared placement is the repository's own statement and its file may not exist in the
    // checkout yet, so ownership has nothing to say about it; the planner holds the choice to it.
    const declared = declaredPlacementFor(
        context.declaredPlacement,
        placementRuleTypeOfRule(candidateRule),
    );
    if (declared === undefined && !namesOwnedPath(context.ownedListPaths, filePath)) {
        return (
            `${filePath} is not one of the repository's own list files. Choose a file exactly as ` +
            'search_rules reports it.'
        );
    }
    try {
        planRepositoryEdit(
            context.checkoutPath,
            filePath,
            candidateRule,
            context.declaredPlacement,
            position,
        );
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
    return undefined;
}
