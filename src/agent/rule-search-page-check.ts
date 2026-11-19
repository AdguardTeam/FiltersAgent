/**
 * The page check of a `search_rules` selector query: the element-hiding rules other sites share
 * that hide, on the agent's open page, the element the searched selector matches, a wrapper of it
 * or a part of it — the rules a maintainer adds the reported site to instead of writing one for it
 * alone.
 */
import type { Page } from 'playwright-core';
import {
    PageMatchRelation,
    SelectorProbeStatus,
    probeSelectorsOnPage,
    type SelectorPageProbe,
} from '../browser/shared-rule-page-probe';
import { createLogger } from '../logger/logger';
import { domainListCovers } from '../repo/domain-scope';
import { selectEquivalentFileMatch } from '../repo/extension-target';
import type { SharedHidingRule } from '../repo/shared-hiding-rules';
import type { IArtifactStore } from '../tracer/artifact-store';

/**
 * Outcomes of one page check: the probe's own, and the two met before or around it.
 */
export const PageCheckStatus = {
    ...SelectorProbeStatus,
    NoOpenPage: 'no_open_page',
    ProbeFailed: 'probe_failed',
} as const;

/**
 * One page check outcome.
 */
export type PageCheckStatus = (typeof PageCheckStatus)[keyof typeof PageCheckStatus];

/**
 * Most matches one answer shows. Ten holds a notice's own families across every list that keeps
 * them; the rest go to an artifact, so a broad selector cannot fill the answer.
 */
const MAX_PAGE_CHECK_MATCHES = 10;

/**
 * Longest the probe may hold the call. `search_rules` is a base tool, which no tool deadline
 * covers, and a page that keeps its main thread busy would hold the run with it. A probe over a
 * checkout's shared rules answers in a few seconds; thirty leaves room for a slow page while the
 * text matches still reach the model.
 */
const PAGE_CHECK_DEADLINE_MS = 30_000;

/**
 * Order the relations are listed in: a rule hiding the element itself, then one hiding a wrapper of
 * it, then one hiding a part of it.
 */
const RELATION_ORDER: Readonly<Record<PageMatchRelation, number>> = {
    [PageMatchRelation.Same]: 0,
    [PageMatchRelation.Ancestor]: 1,
    [PageMatchRelation.Descendant]: 2,
};

/**
 * What the model reads when a page check cannot compare any rule.
 */
const PAGE_CHECK_HINTS = {
    [PageCheckStatus.NoOpenPage]:
        'No browser session has the reported page open, so only the rule text was searched. ' +
        'Search this selector again while it is open to find shared rules that hide the same ' +
        'element under another selector.',
    [PageCheckStatus.NoElement]:
        'The selector matches no element in the top document of the open page.',
    [PageCheckStatus.SelectorNotSupported]:
        'The browser cannot evaluate this selector: search a plain CSS selector of the same ' +
        'element.',
} as const;

/**
 * The page of the agent's live session, open on the page it was launched for.
 */
export interface ActivePage {
    /**
     * The session's page.
     */
    page: Page;

    /**
     * Hostname the session was launched on, without `www.`: the domain the candidates are scoped
     * to, which after a cross-site redirect is the destination the agent relaunched on.
     */
    domain: string;
}

/**
 * One list file holding a matched shared rule.
 */
export interface PageCheckList {
    /**
     * Repository path of the list file, as a draft names it.
     */
    filePath: string;

    /**
     * One-based line the planner adds the domain to when a draft names this file. Absent when the
     * planner extends no rule there: the run's instruction declares a file for hiding rules, or the
     * file keeps the rule in a group (`groupLines`).
     */
    line?: number;

    /**
     * How many sites the rule lists.
     */
    domainCount: number;

    /**
     * Lines of the group the file keeps the rule in: the rules repeating its exact site list.
     * Present only when the file holds the rule in no other form. The planner writes the candidate
     * as a line of its own there, and a maintainer adds the site to every line of the group.
     */
    groupLines?: number[];
}

/**
 * One shared rule hiding the searched element, a wrapper of it or a part of it.
 */
export interface PageCheckMatch {
    /**
     * How the element the rule hides relates to the searched one.
     */
    relation: PageMatchRelation;

    /**
     * Tree levels between the two elements; 0 for the same element.
     */
    levels: number;

    /**
     * The rule scoped to the session's domain: validating it and naming one of `lists` that gives a
     * `line` in the draft adds the domain to that shared rule.
     */
    candidateRule: string;

    /**
     * Elements of the page, outside the searched ones, their wrappers and their contents, that the
     * rule's selector also matches.
     */
    elsewhereOnPage: number;

    /**
     * The list files holding the rule, the line listing most sites first.
     */
    lists: PageCheckList[];
}

/**
 * A page check that compared no rule, because no session had the reported page open.
 */
interface PageCheckWithoutProbe {
    /**
     * Why no rule was compared.
     */
    status: typeof PageCheckStatus.NoOpenPage;

    /**
     * What to do about it.
     */
    hint: string;
}

/**
 * A page check whose probe threw or ran out of time.
 */
interface PageCheckProbeFailed {
    /**
     * The probe failed.
     */
    status: typeof PageCheckStatus.ProbeFailed;

    /**
     * The probe's error message.
     */
    detail: string;
}

/**
 * A page check whose searched selector matched nothing the rules could be compared with.
 */
interface PageCheckWithoutElement {
    /**
     * Why no rule was compared.
     */
    status: typeof PageCheckStatus.NoElement | typeof PageCheckStatus.SelectorNotSupported;

    /**
     * Elements the searched selector matches; 0 here.
     */
    elementCount: number;

    /**
     * What to do about it.
     */
    hint: string;
}

/**
 * A page check that compared the shared rules with the searched elements.
 */
interface PageCheckChecked {
    /**
     * The rules were compared.
     */
    status: typeof PageCheckStatus.Checked;

    /**
     * Elements the searched selector matches in the top document.
     */
    elementCount: number;

    /**
     * Elements the rules were compared with: the first of them, up to the probe's cap.
     */
    comparedElementCount: number;

    /**
     * Rule selectors the browser compared.
     */
    checkedSelectors: number;

    /**
     * Rule selectors the browser could not parse (extended syntax), so never compared.
     */
    uncheckedSelectors: number;

    /**
     * Whether rules hiding a part of the searched elements were compared; false when their contents
     * were too large to scan.
     */
    descendantsChecked: boolean;

    /**
     * Matches found, shown or not.
     */
    totalMatches: number;

    /**
     * Whether matches past the shown ones went to an artifact.
     */
    truncated: boolean;

    /**
     * The shown matches, the closest relation first.
     */
    matches: PageCheckMatch[];

    /**
     * File this run's instruction declares for hiding rules, which every candidate goes into as a
     * new line; absent when nothing is declared.
     */
    declaredFile?: string;

    /**
     * What the counts above leave out, when they leave something out.
     */
    hint?: string;

    /**
     * Artifact holding every match, when the answer is truncated.
     */
    artifactId?: string;

    /**
     * How to read that artifact.
     */
    metaHint?: string;
}

/**
 * The model-facing page check, one shape per status.
 */
export type PageCheckAnswer =
    | PageCheckWithoutProbe
    | PageCheckProbeFailed
    | PageCheckWithoutElement
    | PageCheckChecked;

/**
 * What a page check reads, bound once per run.
 */
export interface PageCheckOptions {
    /**
     * The live session's page and the domain it was launched on, read at call time; undefined while
     * no session has navigated to its page.
     */
    activePage: () => ActivePage | undefined;

    /**
     * The checkout's shared hiding rules, collected at the first call.
     */
    sharedRules: () => readonly SharedHidingRule[];

    /**
     * File the run's instruction declares for hiding rules; undefined when it declares none.
     */
    declaredFile: string | undefined;

    /**
     * Store the complete match list goes to when the answer is truncated; undefined when the run
     * persists nothing.
     */
    artifactStore: IArtifactStore | undefined;
}

/**
 * Describe how one list file holds a matched rule family.
 *
 * A rule standing alone is the one the planner extends, chosen the way the planner chooses it. A
 * file holding the family only inside a group gets no line: the planner extends no grouped rule.
 *
 * @param fileRules - The family's rules in one list file.
 * @param candidateDomain - Domain the candidates are scoped to.
 * @param declaredFile - File the instruction declares for hiding rules, when it declares one.
 * @returns The list entry, or undefined when the file holds no rule of the family.
 */
function pageCheckList(
    fileRules: readonly SharedHidingRule[],
    candidateDomain: string,
    declaredFile: string | undefined,
): PageCheckList | undefined {
    const standalone = selectEquivalentFileMatch(
        fileRules.filter((rule) => rule.groupLines.length === 0),
        candidateDomain,
    );
    if (standalone !== undefined) {
        return {
            filePath: standalone.filePath,
            ...(declaredFile === undefined ? { line: standalone.line } : {}),
            domainCount: standalone.domains.length,
        };
    }
    const grouped = selectEquivalentFileMatch(fileRules, candidateDomain);
    return grouped === undefined
        ? undefined
        : {
              filePath: grouped.filePath,
              domainCount: grouped.domains.length,
              groupLines: [...grouped.groupLines],
          };
}

/**
 * Turn the probe's matches into the answer's, naming per list file the line the planner extends.
 *
 * @param probe - What the page probe found.
 * @param selectors - The distinct rule selectors the probe compared, by index.
 * @param rulesBySelector - The candidate rules holding each selector.
 * @param candidateDomain - Domain the candidates are scoped to.
 * @param declaredFile - File the instruction declares for hiding rules, when it declares one.
 * @returns Every match, the closest relation first.
 */
function pageCheckMatches(
    probe: SelectorPageProbe,
    selectors: readonly string[],
    rulesBySelector: ReadonlyMap<string, readonly SharedHidingRule[]>,
    candidateDomain: string,
    declaredFile: string | undefined,
): PageCheckMatch[] {
    const matches: PageCheckMatch[] = [];
    for (const found of probe.matches) {
        const bySignature = new Map<string, SharedHidingRule[]>();
        for (const rule of rulesBySelector.get(selectors[found.index]) ?? []) {
            bySignature.set(rule.signature, [...(bySignature.get(rule.signature) ?? []), rule]);
        }
        for (const [signature, family] of bySignature) {
            const byFile = new Map<string, SharedHidingRule[]>();
            for (const rule of family) {
                byFile.set(rule.filePath, [...(byFile.get(rule.filePath) ?? []), rule]);
            }
            const lists: PageCheckList[] = [];
            for (const fileRules of byFile.values()) {
                const list = pageCheckList(fileRules, candidateDomain, declaredFile);
                if (list !== undefined) {
                    lists.push(list);
                }
            }
            // A list whose rule the planner extends comes before one that keeps it in a group.
            lists.sort(
                (left, right) =>
                    Number(left.groupLines !== undefined) -
                        Number(right.groupLines !== undefined) ||
                    right.domainCount - left.domainCount ||
                    left.filePath.localeCompare(right.filePath),
            );
            matches.push({
                relation: found.relation,
                levels: found.levels,
                candidateRule: `${candidateDomain}${signature}`,
                elsewhereOnPage: found.elsewhere,
                lists,
            });
        }
    }
    return matches.sort(
        (left, right) =>
            RELATION_ORDER[left.relation] - RELATION_ORDER[right.relation] ||
            left.levels - right.levels ||
            (right.lists[0]?.domainCount ?? 0) - (left.lists[0]?.domainCount ?? 0) ||
            left.candidateRule.localeCompare(right.candidateRule),
    );
}

/**
 * Run the probe under the page check's own deadline.
 *
 * Playwright cannot stop an evaluation the page is still running, so a late answer is dropped:
 * `Promise.race` keeps a handler on it, and its rejection never surfaces.
 *
 * @param probe - The running probe.
 * @returns The probe's answer.
 * @throws When the probe fails or does not answer within the deadline.
 */
async function withPageCheckDeadline(
    probe: Promise<SelectorPageProbe>,
): Promise<SelectorPageProbe> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(
            () =>
                reject(
                    new Error(`The page did not answer within ${PAGE_CHECK_DEADLINE_MS / 1000} s.`),
                ),
            PAGE_CHECK_DEADLINE_MS,
        );
    });
    try {
        return await Promise.race([probe, deadline]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Check one searched selector against the checkout's shared hiding rules on the agent's open page.
 *
 * A rule already covering the session's domain — itself, a parent domain or an entity — is left
 * out: the planner would not extend it. A failed probe — the page navigated under it, answered with
 * something else, or ran past the deadline — is logged with its error and answered as
 * `probe_failed` with the message.
 *
 * @param selector - Selector the agent searched.
 * @param options - The page, the rules and the run's bindings.
 * @returns The model-facing page check.
 */
export async function checkSelectorOnPage(
    selector: string,
    options: PageCheckOptions,
): Promise<PageCheckAnswer> {
    const active = options.activePage();
    if (active === undefined) {
        return {
            status: PageCheckStatus.NoOpenPage,
            hint: PAGE_CHECK_HINTS[PageCheckStatus.NoOpenPage],
        };
    }
    const rulesBySelector = new Map<string, SharedHidingRule[]>();
    for (const rule of options.sharedRules()) {
        if (!domainListCovers(rule.domains, active.domain)) {
            rulesBySelector.set(rule.selector, [
                ...(rulesBySelector.get(rule.selector) ?? []),
                rule,
            ]);
        }
    }
    const selectors = [...rulesBySelector.keys()];
    let probe: SelectorPageProbe;
    try {
        probe = await withPageCheckDeadline(probeSelectorsOnPage(active.page, selector, selectors));
    } catch (error) {
        createLogger().error({ err: error, selector }, 'the search_rules page check failed');
        return {
            status: PageCheckStatus.ProbeFailed,
            detail: error instanceof Error ? error.message : String(error),
        };
    }
    if (probe.status !== SelectorProbeStatus.Checked) {
        return {
            status: probe.status,
            elementCount: probe.elementCount,
            hint: PAGE_CHECK_HINTS[probe.status],
        };
    }
    const matches = pageCheckMatches(
        probe,
        selectors,
        rulesBySelector,
        active.domain,
        options.declaredFile,
    );
    const shown = matches.slice(0, MAX_PAGE_CHECK_MATCHES);
    const artifactRef =
        matches.length > shown.length
            ? options.artifactStore?.write(
                  JSON.stringify({ selector, matches }, null, 2),
                  'rule-search-page-check',
              )
            : undefined;
    const hints = [
        ...(probe.comparedElementCount < probe.elementCount
            ? [
                  `The rules were compared with the first ${probe.comparedElementCount} of the ` +
                      `${probe.elementCount} elements the selector matches: search a selector ` +
                      'that names the reported element alone.',
              ]
            : []),
        ...(options.declaredFile === undefined
            ? []
            : [
                  `This run's instruction declares ${options.declaredFile} for hiding rules: a ` +
                      'validated candidateRule goes there as a new line, and no shared rule is ' +
                      'extended.',
              ]),
    ];
    return {
        status: PageCheckStatus.Checked,
        elementCount: probe.elementCount,
        comparedElementCount: probe.comparedElementCount,
        checkedSelectors: selectors.length - probe.uncheckedCount,
        uncheckedSelectors: probe.uncheckedCount,
        descendantsChecked: probe.descendantsChecked,
        totalMatches: matches.length,
        truncated: matches.length > shown.length,
        matches: shown,
        ...(options.declaredFile === undefined ? {} : { declaredFile: options.declaredFile }),
        ...(hints.length === 0 ? {} : { hint: hints.join(' ') }),
        ...(artifactRef === undefined
            ? {}
            : {
                  artifactId: artifactRef.id,
                  metaHint:
                      `Every match is persisted. Use get_detail("${artifactRef.id}") with a key ` +
                      `or limit for the matches past the first ${MAX_PAGE_CHECK_MATCHES}.`,
              }),
    };
}
