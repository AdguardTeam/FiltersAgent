/**
 * Which existing shared rule a candidate extends: the planner's choice of a line inside the chosen
 * file, which a `search_rules` page check reuses to name the same line.
 */
import { readFileSync } from 'node:fs';
import { domainListCovers, finalDomainLabel } from './domain-scope';
import { projectGroupLines } from './project-groups';
import {
    isExtensibleFamilyKind,
    isExtensibleSharedRule,
    normalizedFamilySignature,
} from './rule-family';
import { normalizeRule } from './rule-normalizer';

/**
 * An existing shared rule eligible for deterministic extension.
 */
export interface ExtensionCandidate {
    /**
     * One-based source line number.
     */
    line: number;

    /**
     * Exact existing rule text.
     */
    rule: string;

    /**
     * The sites the rule lists, lowercased and sorted.
     */
    domains: readonly string[];
}

/**
 * Choose one equivalent shared expression inside an already selected repository file.
 *
 * Every input has the same rule kind and expression once its domains are removed — a cosmetic,
 * scriptlet or network family — so extending any of them has identical filtering semantics for the
 * candidate domain. A same-final-label cohort keeps regional rules together when possible;
 * remaining ties use repository order for a reproducible edit.
 *
 * @param matches - Equivalent shared expressions from one repository file, with their domains.
 * @param candidateDomain - Single domain being added to the shared expression.
 * @returns Preferred existing expression, or undefined when the file has no match.
 */
export function selectEquivalentFileMatch<T extends Pick<ExtensionCandidate, 'domains'>>(
    matches: readonly T[],
    candidateDomain: string,
): T | undefined {
    const candidateLabel = finalDomainLabel(candidateDomain);
    let preferred: T | undefined;
    let preferredAllMatching = -1;
    let preferredMatchingDomains = -1;
    for (const match of matches) {
        const { domains } = match;
        const matchingDomains = candidateLabel
            ? domains.filter((domain) => finalDomainLabel(domain) === candidateLabel).length
            : 0;
        const allMatching = matchingDomains === domains.length ? 1 : 0;
        if (
            !preferred ||
            allMatching > preferredAllMatching ||
            (allMatching === preferredAllMatching && matchingDomains > preferredMatchingDomains)
        ) {
            preferred = match;
            preferredAllMatching = allMatching;
            preferredMatchingDomains = matchingDomains;
        }
    }
    return preferred;
}

/**
 * Select the shared rule in the chosen file whose exact syntax and expression match the candidate.
 *
 * Only the file the agent chose is read. Which file a rule belongs in is the agent's decision, and
 * a shared rule of the same form in another file is no reason to move the edit there: searching
 * every filter tree and retargeting to a unique owner elsewhere, or refusing the candidate when
 * several files hold one, loses a vision-verified block whose agent picked the right file. Inside
 * the chosen file several equivalent expressions may carry the family; the reported domain's cohort
 * picks one. A rule the file keeps for one project is never a family member: it belongs to that
 * project's sites only.
 *
 * @param targetPath - Canonical chosen file.
 * @param candidateRule - Locked issue-scoped candidate rule.
 * @returns The extension target in the chosen file, or undefined when the file holds none.
 */
export function selectExtensionCandidate(
    targetPath: string,
    candidateRule: string,
): ExtensionCandidate | undefined {
    const candidate = normalizeRule(candidateRule);
    if (
        !isExtensibleFamilyKind(candidate.kind) ||
        candidate.isException ||
        candidate.domains.length !== 1
    ) {
        return undefined;
    }
    const candidateDomain = candidate.domains[0];
    const candidateSignature = normalizedFamilySignature(candidate);
    if (!candidateSignature) {
        return undefined;
    }
    const lines = readFileSync(targetPath, 'utf8').split(/\r?\n/);
    const rules = lines.map(normalizeRule);
    const projectGroups = projectGroupLines(rules);
    const matches: ExtensionCandidate[] = [];
    rules.forEach((existing, index) => {
        // A family member is a shared rule of the candidate's kind whose expression matches the
        // candidate's exactly once the domain scope is removed, not yet covering the reported site
        // and not kept for one project.
        if (
            existing.kind === candidate.kind &&
            isExtensibleSharedRule(existing) &&
            !domainListCovers(existing.domains, candidateDomain) &&
            !projectGroups.has(index + 1) &&
            normalizedFamilySignature(existing) === candidateSignature
        ) {
            matches.push({ line: index + 1, rule: lines[index], domains: existing.domains });
        }
    });
    return selectEquivalentFileMatch(matches, candidateDomain);
}
