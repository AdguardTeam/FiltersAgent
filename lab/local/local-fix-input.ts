import { mkdirSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import * as v from 'valibot';
import {
    AgentIssueInputSchema,
    loadLocalIssueSnapshot,
    safeAttachmentExtension,
    toAgentIssueInput,
    type AgentIssueInput,
} from '../../src/local/issue-snapshot';
import {
    copyVerifiedAttachments,
    copyVerifiedIssueInput,
    type VerifiedIssueRevision,
} from '../../src/local/issue-revision';
import { IssueAttachmentKind } from '../../src/types/issue-attachment-kind';
import { neutralAgentIssueInput } from './neutral-issue-input';

/**
 * File-backed issue identity and optional neutral report presentation.
 */
export interface LegacyLocalFixInputOptions {
    /**
     * Integrity-checked local issue snapshot path.
     */
    issueFile: string;
    /**
     * Issue number the snapshot must describe.
     */
    issueNumber: number;
    /**
     * Present the snapshot without historical resolution metadata.
     */
    neutralIssueInput?: boolean;
}

/**
 * Immutable issue data prepared before environment or model work.
 */
export interface PreparedLocalFixInput {
    /**
     * Prompt-safe issue supplied to the common core.
     */
    issue: AgentIssueInput;

    /**
     * Owned prompt-visible screenshot paths used by the report adapter.
     */
    issueScreenshots: string[];
}

/**
 * Input loader executed after the runner owns and clears its output directory.
 */
export type LocalFixInputLoader = (outputDir: string) => PreparedLocalFixInput;

/**
 * Load and validate the legacy file-based snapshot adapter.
 *
 * @param options - Legacy issue-file options.
 * @returns Prompt-safe issue and validated source attachment paths.
 */
export function loadLegacyLocalFixInput(
    options: LegacyLocalFixInputOptions,
): PreparedLocalFixInput {
    const snapshot = loadLocalIssueSnapshot(options.issueFile);
    if (snapshot.rawIssue.number !== options.issueNumber) {
        throw new Error(
            `Local issue snapshot is #${snapshot.rawIssue.number}, expected ` +
                `#${options.issueNumber}.`,
        );
    }
    return {
        issue: options.neutralIssueInput
            ? neutralAgentIssueInput(toAgentIssueInput(snapshot))
            : toAgentIssueInput(snapshot),
        issueScreenshots: snapshot.attachments
            .filter(
                (attachment) =>
                    attachment.kind === IssueAttachmentKind.IssueScreenshot &&
                    attachment.promptVisible,
            )
            .map((attachment) => attachment.localPath),
    };
}

/**
 * Materialize captured revision bytes only under the runner-owned artifact tree.
 *
 * @param revision - Opaque revision produced by the integrity verifier.
 * @param outputDir - Already-cleared local investigation output.
 * @returns Prompt-safe issue whose attachment paths reference exclusive owned copies.
 */
export function materializeVerifiedLocalFixInput(
    revision: VerifiedIssueRevision,
    outputDir: string,
): PreparedLocalFixInput {
    const issue = copyVerifiedIssueInput(revision);
    const captured = copyVerifiedAttachments(revision);
    const inputDir = join(outputDir, 'artifacts', 'input');
    mkdirSync(inputDir, { recursive: true, mode: 0o700 });
    const materialized = captured.map(({ attachment, bytes }, index) => {
        const localPath = join(
            inputDir,
            `${String(index + 1).padStart(2, '0')}-${attachment.sha256.slice(0, 16)}` +
                safeAttachmentExtension(extname(attachment.localPath)),
        );
        writeFileSync(localPath, bytes, { flag: 'wx', mode: 0o600 });
        return { ...attachment, localPath };
    });
    const promptVisible = materialized.filter((attachment) => attachment.promptVisible);
    const ownedIssue = v.parse(AgentIssueInputSchema, {
        ...issue,
        attachments: promptVisible,
    });
    return {
        issue: ownedIssue,
        issueScreenshots: promptVisible
            .filter((attachment) => attachment.kind === IssueAttachmentKind.IssueScreenshot)
            .map((attachment) => attachment.localPath),
    };
}
