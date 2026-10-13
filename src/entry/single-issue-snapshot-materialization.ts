/**
 * Verified-snapshot issue materialization for the default single-issue engine.
 */

import { extname, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as v from 'valibot';
import {
    copyVerifiedAttachments,
    copyVerifiedIssueInput,
    type VerifiedIssueRevision,
} from '../local/issue-revision';
import { AgentIssueInputSchema, safeAttachmentExtension } from '../local/issue-snapshot';

/**
 * Directory the materialized snapshot attachments land in, below the run artifacts folder; the
 * verified bundle's own copies are deleted together with the bundle.
 */
const SNAPSHOT_ISSUE_INPUT_DIR = 'artifacts/input';

/**
 * Materialize one verified snapshot issue under the runner-owned artifact tree.
 *
 * @param revision - Snapshot produced by the integrity verifier.
 * @param artifactsDir - Writable run artifacts folder.
 * @returns Prompt-safe issue whose attachment paths reference exclusive owned copies.
 */
export function materializedSnapshotIssue(
    revision: VerifiedIssueRevision,
    artifactsDir: string,
): v.InferOutput<typeof AgentIssueInputSchema> {
    const issue = copyVerifiedIssueInput(revision);
    const captured = copyVerifiedAttachments(revision);
    const inputDir = join(artifactsDir, SNAPSHOT_ISSUE_INPUT_DIR);
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
    return v.parse(AgentIssueInputSchema, {
        ...issue,
        attachments: promptVisible,
    });
}
