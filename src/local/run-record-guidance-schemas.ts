/**
 * The knowledge-guidance schemas of the local run record: the documentation citation shape both
 * provenance branches store, and the instruction provenance block an instruction-driven run records
 * beside its run result.
 *
 * Split from run-output.ts along its own seam: the citation and instruction-provenance contracts
 * have one owner (this module) that the run-output wrapper and the citation harvester both import,
 * instead of accumulating into the already oversized wrapper.
 */
import * as v from 'valibot';
import { RULE_GUIDANCE_TOPICS } from '../knowledge/rule-guidance';
import {
    GUIDANCE_DOCUMENT_ORIGIN_VALUES,
    GUIDANCE_DOCUMENT_ROLE_VALUES,
} from '../knowledge/guidance-source';

/**
 * Locator a stored citation names, admitted in one of the two shapes the serving side builds: an
 * `owner/repo` slug for GitHub-hosted documents, or the URL host a non-GitHub instruction document
 * was fetched from.
 */
export const LOCAL_CITATION_REPOSITORY_PATTERN =
    /^(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+|[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+)$/u;

export const LocalKnowledgeGuidanceCitationSchema = v.object({
    topic: v.picklist(RULE_GUIDANCE_TOPICS),
    repository: v.pipe(v.string(), v.regex(LOCAL_CITATION_REPOSITORY_PATTERN)),
    // URL-sourced instruction documents have no immutable revision to name, so the commit may be
    // absent; a present commit must still be an exact 40-hex digest or the citation names nothing.
    commit: v.optional(v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/iu))),
    filePath: v.pipe(v.string(), v.minLength(1)),
    anchor: v.pipe(v.string(), v.minLength(1)),
    url: v.pipe(v.string(), v.url()),
});

export const LocalInstructionProvenanceSchema = v.object({
    path: v.pipe(v.string(), v.minLength(1)),
    // The instruction and its documents are plain files: their digests are SHA-256 (64 hex),
    // not the 40-hex git identifiers the KnowledgeBase provenance carries.
    sha256: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/iu)),
    documents: v.array(
        v.object({
            role: v.picklist(GUIDANCE_DOCUMENT_ROLE_VALUES),
            origin: v.picklist(GUIDANCE_DOCUMENT_ORIGIN_VALUES),
            url: v.pipe(v.string(), v.minLength(1)),
            digest: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/iu)),
        }),
    ),
    // Instruction runs prepare no KnowledgeBase, so this block is the only record carrier for
    // the harvested lookup_rule_guidance citations; optional because a roster-only block stays
    // valid whenever no citation was harvestable.
    citations: v.optional(v.array(LocalKnowledgeGuidanceCitationSchema)),
});

/**
 * One immutable documentation citation consulted by the agent.
 */
export type LocalKnowledgeGuidanceCitation = v.InferOutput<
    typeof LocalKnowledgeGuidanceCitationSchema
>;

/**
 * The run instruction and its linked-document roster stored beside an instruction-driven run.
 */
export type LocalInstructionProvenance = v.InferOutput<typeof LocalInstructionProvenanceSchema>;
