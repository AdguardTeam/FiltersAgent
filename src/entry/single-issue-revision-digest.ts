/**
 * Fetched-issue revision projection for the default single-issue engine's report dedupe.
 */

import { createHash } from 'node:crypto';
import type { RawIssue } from '../github/fetch-issue';
import type { RepositorySlug } from '../types/repository-slug';

/**
 * Version mixed into a fetched issue's revision projection, so a projection change cannot alias an
 * old revision binding to a new one.
 *
 * Version 2 is the projection that hashes the content the run actually read rather than
 * `updatedAt`, which GitHub moves on every new comment, including the run's own posted report.
 */
const FETCHED_ISSUE_REVISION_PROJECTION_VERSION = 2;

/**
 * Project a fetched issue into the revision identity the report dedupe binds to. The platform
 * exposes no revision identity, and `updatedAt` is not it either: GitHub moves it on every new
 * comment, including the report this run itself posts, so the digest is derived from the content
 * the run actually read instead — title, body, and the kept comments — the same content the
 * snapshot path binds to.
 *
 * @param raw - The fetched issue.
 * @param slug - The repository the issue was read from.
 * @returns Lowercase 64-hex revision digest.
 */
export function fetchedIssueRevisionDigest(raw: RawIssue, slug: RepositorySlug): string {
    return createHash('sha256')
        .update(
            JSON.stringify({
                schemaVersion: FETCHED_ISSUE_REVISION_PROJECTION_VERSION,
                slug,
                number: raw.number,
                title: raw.title,
                body: raw.body,
                comments: raw.comments.map((comment) => ({
                    author: comment.author,
                    body: comment.body,
                    createdAt: comment.createdAt,
                })),
            }),
            'utf8',
        )
        .digest('hex');
}
