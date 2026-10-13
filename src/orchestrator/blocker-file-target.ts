/**
 * Resolution of the file one instruction's file-backed verification declares.
 *
 * The `user-rules-file` and `managed-storage-file` declarations name the state the run maintains as
 * a path in the instruction's own words. Two places need that path: the between-phases application,
 * which writes the file and reads it back, and a Firefox launch, which must put the file's current
 * content into the enterprise policies' managed storage. Both resolve it through this one rule, so
 * a launch can never serve a different file than the read-back credits.
 */
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { ApplicationInstructionGap } from '../environment/application-instruction-gap';
import {
    parseRuleApplication,
    type ApplicationInstructionRefusal,
} from '../knowledge/instruction-application';

/**
 * Resolution of one declared file-backed verification target: either the absolute path the
 * file-backed read-back is admitted to read, or the typed refusal recording why the declaration
 * cannot be honored. Structurally discriminated like the rule-application parse: a member carrying
 * `gap` is the refusal.
 */
export type BlockerFileTargetResolution =
    | {
          /**
           * The absolute path the file-backed read-back is admitted to read.
           */
          path: string;
      }
    | ApplicationInstructionRefusal;

/**
 * Resolve one declared file-backed verification target against the run's host-state root.
 *
 * The file-backed declarations name state the host maintains for itself, as the instruction writes
 * it: a relative target is that file's path inside the run's host-state directory — a fresh per-run
 * directory outside the repository checkout, so no checkout walk can ever read the run's own
 * candidate back as repository content — and an absolute target is honored as-is, as part of the
 * instruction's trusted content. A relative target whose resolution escapes the host-state root is
 * a typed refusal: the host contains file-backed read-backs to that directory, and the refused
 * target is never read.
 *
 * @param hostStateRoot - The run's host-state root the relative reference resolves against.
 * @param target - Declared target exactly as the instruction wrote it.
 * @returns The absolute path the file-backed read-back is admitted to read, or the typed refusal
 *   recording why the declaration cannot be honored.
 */
export function resolveBlockerFileTarget(
    hostStateRoot: string,
    target: string,
): BlockerFileTargetResolution {
    if (isAbsolute(target)) {
        return { path: target };
    }
    const resolved = resolve(hostStateRoot, target);
    // Containment by the target's position relative to the host-state root: a first `..` segment
    // (or a cross-root resolution that no longer names a position under the root) is the escape.
    const relativeToRoot = relative(hostStateRoot, resolved);
    const leadingSegment = relativeToRoot.split(sep, 1)[0];
    if (leadingSegment === '..' || isAbsolute(relativeToRoot)) {
        return {
            gap: ApplicationInstructionGap.VerificationTargetOutsideHostState,
            detail:
                'The state verification declares a relative target that resolves outside the ' +
                `run's host-state root ("${target}"); the host contains file-backed read-backs ` +
                'to that directory and refuses this target before reading it.',
        };
    }
    return { path: resolved };
}

/**
 * Resolve the file-backed target one loaded instruction declares, for the callers that need the
 * path before any application runs.
 *
 * A launch needs it to build the Firefox managed storage from the file's current content. An
 * instruction that declares no file-backed method, or one whose target the host refuses, yields
 * undefined here: the launch simply carries no user filters, and the application procedure is the
 * one place that turns a refused target into a recorded refusal.
 *
 * @param application - The run's application instruction content.
 * @param hostStateRoot - The run's host-state root a relative target resolves against.
 * @returns The absolute declared path, or undefined when the instruction declares none the host
 *   will read.
 */
export function resolveDeclaredBlockerFile(
    application: string,
    hostStateRoot: string,
): string | undefined {
    const contract = parseRuleApplication(application);
    if ('gap' in contract) {
        return undefined;
    }
    const { target } = contract.verification;
    if (target === undefined) {
        return undefined;
    }
    const resolution = resolveBlockerFileTarget(hostStateRoot, target);
    return 'path' in resolution ? resolution.path : undefined;
}
