import { existsSync, rmSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { firefox, type Browser, type Page } from 'playwright-core';
import { createToolRegistry, type ToolRegistryOptions } from '../../src/agent/tool-factory';
import type { RawIssue } from '../../src/github/fetch-issue';
import { planRepositoryEdit } from '../../src/repo/repository-edit';
import { TraceArtifactStore } from '../../src/tracer/artifact-store';
import { TraceRecorder } from '../../src/tracer/trace-recorder';
import { createListCheckout } from '../repo/list-checkout-fixture';

/**
 * Whether the Playwright Firefox build is installed; the Checks workflow installs it.
 */
const firefoxInstalled = existsSync(firefox.executablePath());

/**
 * The cookie list the shared rules below live in.
 */
const COOKIES_LIST = 'AnnoyancesFilter/Cookies/sections/cookies_specific.txt';

/**
 * A second list holding one of the same rules for other sites.
 */
const POPUPS_LIST = 'AnnoyancesFilter/Popups/sections/popups_specific.txt';

/**
 * The domain the live session was launched on, as the runtime hands it to the check.
 */
const SESSION_DOMAIN = 'site.example';

/**
 * The position the planner check passes: where a new line lands is not what it asserts.
 */
const AT_FILE_END = {
    kind: 'file_end',
    reason: 'No section keeps rules of this kind.',
} as const;

/**
 * The issue the registry binds; only its number matters here.
 */
const localIssue: RawIssue = {
    number: 1,
    url: 'https://github.com/example-owner/example-repo/issues/1',
    title: 'Cookie notice',
    body: 'Website: https://www.site.example/',
    state: 'open',
    labels: [],
    assignee: null,
    comments: [],
};

/**
 * One match of a page check, as the model reads it.
 */
interface ModelMatch {
    candidateRule: string;
    lists: Array<{ filePath: string; line?: number; domainCount: number; groupLines?: number[] }>;
}

/**
 * Search one selector through `search_rules` and return the whole answer.
 *
 * @param checkout - Checkout the registry searches.
 * @param selector - Selector to search.
 * @param options - Registry bindings: the active page above all.
 * @returns The tool's answer.
 */
async function searchSelector(
    checkout: string,
    selector: string,
    options: Partial<ToolRegistryOptions>,
): Promise<Record<string, unknown>> {
    const registry = await createToolRegistry({
        allowedIssueNumber: 1,
        checkoutPath: checkout,
        localIssueTools: { localIssue },
        ...options,
    });
    return await registry.dispatch('search_rules', { selector });
}

/**
 * The rule selectors a probe was asked to compare, read from the payload the page receives.
 *
 * @param expression - The probe expression the page evaluates.
 * @returns The rule selectors, by index.
 */
function probedRuleSelectors(expression: string): string[] {
    const payload = /atob\('([^']+)'\)/u.exec(expression)?.[1] ?? '';
    return (JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as { rules: string[] })
        .rules;
}

/**
 * A page without a browser behind it that answers the probe through `answer`; the check's own logic
 * around the probe needs no native selector matching.
 *
 * @param answer - What the page answers, given the rule selectors it was asked to compare.
 * @returns The fake page.
 */
function fakePage(answer: (ruleSelectors: string[]) => Promise<unknown>): Page {
    return {
        context: () => {
            throw new Error('a fake page has no browser context');
        },
        evaluate: async (expression: string) => await answer(probedRuleSelectors(expression)),
    } as unknown as Page;
}

/**
 * A probe answer in which every compared rule hides the searched element itself.
 *
 * @param ruleSelectors - The rule selectors the probe was asked to compare.
 * @returns The answer.
 */
async function everyRuleHidesTheElement(ruleSelectors: string[]): Promise<unknown> {
    return {
        status: 'checked',
        elementCount: 1,
        comparedElementCount: 1,
        uncheckedCount: 0,
        descendantsChecked: true,
        matches: ruleSelectors.map((_, index) => ({
            index,
            relation: 'same',
            levels: 0,
            elsewhere: 0,
        })),
    };
}

describe('search_rules page check without an open page', () => {
    it('says no page was checked', async () => {
        const checkout = createListCheckout({
            [COOKIES_LIST]: ['one.example,two.example##.fixed.bottom-0'],
        });
        try {
            const result = await searchSelector(checkout, '.fixed', {
                activePage: () => undefined,
            });

            expect(result.pageCheck).toMatchObject({ status: 'no_open_page' });
        } finally {
            rmSync(checkout, { recursive: true, force: true });
        }
    });
});

describe('search_rules page check around the probe', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('leaves out a rule that already covers the session domain through a parent domain', async () => {
        const checkout = createListCheckout({
            [COOKIES_LIST]: [
                'example.com,two.example##.covered',
                'example.*,three.example##.entity',
                'one.example,two.example##.banner',
            ],
        });
        try {
            const result = await searchSelector(checkout, '.banner', {
                activePage: () => ({
                    page: fakePage(everyRuleHidesTheElement),
                    domain: 'shop.example.com',
                }),
            });

            const pageCheck = result.pageCheck as { matches: ModelMatch[] };
            expect(pageCheck.matches.map((match) => match.candidateRule)).toEqual([
                'shop.example.com##.banner',
            ]);
        } finally {
            rmSync(checkout, { recursive: true, force: true });
        }
    });

    it('shows ten matches and persists every match when more are found', async () => {
        const selectors = Array.from({ length: 12 }, (_, index) => `.notice-${index}`);
        const checkout = createListCheckout({
            // Each rule keeps its own domain list: rules repeating one would be a project's group.
            [COOKIES_LIST]: selectors.map(
                (selector, index) => `a${index}.example,b${index}.example##${selector}`,
            ),
        });
        const recorder = new TraceRecorder({ runId: 'page-check', issueNumber: 1, mode: 'fix' });
        const artifactStore = new TraceArtifactStore(checkout, recorder);
        try {
            const result = await searchSelector(checkout, '.notice-0', {
                activePage: () => ({
                    page: fakePage(everyRuleHidesTheElement),
                    domain: SESSION_DOMAIN,
                }),
                artifactStore,
            });

            const pageCheck = result.pageCheck as {
                totalMatches: number;
                truncated: boolean;
                matches: ModelMatch[];
                artifactId: string;
            };
            expect(pageCheck).toMatchObject({ totalMatches: 12, truncated: true });
            expect(pageCheck.matches).toHaveLength(10);
            const persisted = JSON.parse(artifactStore.read(pageCheck.artifactId) ?? '{}') as {
                matches: ModelMatch[];
            };
            expect(persisted.matches.map((match) => match.candidateRule).sort()).toEqual(
                selectors.map((selector) => `${SESSION_DOMAIN}##${selector}`).sort(),
            );
        } finally {
            rmSync(checkout, { recursive: true, force: true });
        }
    });

    it('answers probe_failed and keeps the text matches when the page throws', async () => {
        const checkout = createListCheckout({
            [COOKIES_LIST]: ['one.example,two.example##.banner'],
        });
        try {
            const result = await searchSelector(checkout, '.banner', {
                activePage: () => ({
                    page: fakePage(async () => {
                        throw new Error('Execution context was destroyed');
                    }),
                    domain: SESSION_DOMAIN,
                }),
            });

            expect(result.pageCheck).toEqual({
                status: 'probe_failed',
                detail: 'Execution context was destroyed',
            });
            expect(result.totalMatches).toBe(1);
        } finally {
            rmSync(checkout, { recursive: true, force: true });
        }
    });

    it('answers probe_failed when the page never answers', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const checkout = createListCheckout({
            [COOKIES_LIST]: ['one.example,two.example##.banner'],
        });
        try {
            const pending = searchSelector(checkout, '.banner', {
                activePage: () => ({
                    page: fakePage(() => new Promise<never>(() => {})),
                    domain: SESSION_DOMAIN,
                }),
            });
            await vi.advanceTimersByTimeAsync(10 * 60_000);

            const result = await pending;
            expect(result.pageCheck).toMatchObject({ status: 'probe_failed' });
            expect(result.totalMatches).toBe(1);
        } finally {
            rmSync(checkout, { recursive: true, force: true });
        }
    });

    it('promises no extended line when the instruction declares a file for hiding rules', async () => {
        const checkout = createListCheckout({
            [COOKIES_LIST]: ['one.example,two.example##.banner'],
        });
        try {
            const result = await searchSelector(checkout, '.banner', {
                activePage: () => ({
                    page: fakePage(everyRuleHidesTheElement),
                    domain: SESSION_DOMAIN,
                }),
                declaredPlacement: { byRuleType: { cosmetic: { filePath: POPUPS_LIST } } },
            });

            expect(result.pageCheck).toMatchObject({
                status: 'checked',
                declaredFile: POPUPS_LIST,
                matches: [
                    {
                        candidateRule: `${SESSION_DOMAIN}##.banner`,
                        lists: [{ filePath: COOKIES_LIST, domainCount: 2 }],
                    },
                ],
            });
            const [match] = (result.pageCheck as { matches: ModelMatch[] }).matches;
            expect(match.lists[0].line).toBeUndefined();
        } finally {
            rmSync(checkout, { recursive: true, force: true });
        }
    });

    it('names the line the planner extends for every candidate and list', async () => {
        const checkout = createListCheckout({
            [COOKIES_LIST]: [
                'one.example,two.example##.banner',
                'eins.de,zwei.de##.banner',
                'site.de,other.example##.covered',
                'project-a.example,project-b.example##.group',
                'project-a.example,project-b.example##.group-promo',
                'one.example,~two.example,three.example##.excluded',
                '[$path=/news]one.example,two.example##.modified',
                'drei.de,vier.de##.notice',
            ],
            [POPUPS_LIST]: ['nine.example,ten.example,eleven.example##.banner'],
        });
        try {
            const result = await searchSelector(checkout, '.banner', {
                activePage: () => ({
                    page: fakePage(everyRuleHidesTheElement),
                    domain: 'shop.site.de',
                }),
            });

            const matches = (result.pageCheck as { matches: ModelMatch[] }).matches;
            expect(matches.map((match) => match.candidateRule).sort()).toEqual([
                'shop.site.de##.banner',
                'shop.site.de##.group',
                'shop.site.de##.group-promo',
                'shop.site.de##.notice',
            ]);
            // A grouped rule names its group and no line: the planner writes a line of its own.
            expect(
                matches.find((match) => match.candidateRule === 'shop.site.de##.group')?.lists,
            ).toEqual([{ filePath: COOKIES_LIST, domainCount: 2, groupLines: [4, 5] }]);
            for (const match of matches) {
                for (const list of match.lists) {
                    expect(
                        planRepositoryEdit(
                            checkout,
                            list.filePath,
                            match.candidateRule,
                            undefined,
                            AT_FILE_END,
                        ).edit,
                    ).toMatchObject(
                        list.line === undefined
                            ? { kind: 'insert' }
                            : { kind: 'extend_domains', line: list.line },
                    );
                }
            }
        } finally {
            rmSync(checkout, { recursive: true, force: true });
        }
    });
});

/**
 * A fixed cookie notice inside a consent wrapper, a notice labelled for assistive technology, one
 * labelled in Russian, and an element no shared rule hides.
 */
const PAGE = [
    '<!doctype html><html><head><meta charset="utf-8"></head><body>',
    '<div id="root">',
    '<div class="consent-root">',
    '<div id="site-banner" class="fixed bottom-0 left-0 right-0 z-50">',
    'We use cookies <a class="policy" href="/privacy">Privacy</a>',
    '</div>',
    '</div>',
    '<div id="site-consent" role="region" aria-label="Cookie consent">Cookies</div>',
    '<div id="ru-consent" aria-label="Согласие на куки">Куки</div>',
    '<p id="plain">Article</p>',
    '</div>',
    '</body></html>',
].join('');

/**
 * A page repeating one card more times than the probe compares.
 */
const CROWDED_PAGE = [
    '<!doctype html><html><head></head><body>',
    ...Array.from({ length: 25 }, (_, index) => `<div class="item">Card ${index}</div>`),
    '</body></html>',
].join('');

/**
 * Which shared rules hide what a searched selector matches, measured in a real browser: native
 * selector matching is the contract, so a fake page could not exercise it.
 */
describe.skipIf(!firefoxInstalled)('search_rules page check in a real browser', () => {
    let browser: Browser;
    let page: Page;
    let crowdedPage: Page;
    let checkout: string;

    beforeAll(async () => {
        browser = await firefox.launch({ headless: true });
        page = await browser.newPage();
        await page.setContent(PAGE);
        crowdedPage = await browser.newPage();
        await crowdedPage.setContent(CROWDED_PAGE);
        checkout = createListCheckout({
            [COOKIES_LIST]: [
                'one.example,two.example##.fixed.bottom-0',
                'three.example,four.example##div[aria-label="Cookie consent"]',
                'five.example,six.example##a.policy',
                'project-a.example,project-b.example##.consent-root',
                'project-a.example,project-b.example##.promo',
                'seven.example,eight.example#?#div:has-text(Cookies)',
                'ru-one.example,ru-two.example##div[aria-label="Согласие на куки"]',
                'cards-one.example,cards-two.example##.item',
            ],
            [POPUPS_LIST]: ['nine.example,ten.example,eleven.example##.fixed.bottom-0'],
        });
    });

    afterAll(async () => {
        await browser?.close();
        if (checkout !== undefined) {
            rmSync(checkout, { recursive: true, force: true });
        }
    });

    /**
     * Search one selector with a test page open and return the page check.
     *
     * @param selector - Selector to search.
     * @param openPage - The page the live session shows.
     * @returns The answer's page check.
     */
    async function pageCheckFor(
        selector: string,
        openPage: Page = page,
    ): Promise<Record<string, unknown>> {
        const result = await searchSelector(checkout, selector, {
            activePage: () => ({ page: openPage, domain: SESSION_DOMAIN }),
        });
        return result.pageCheck as Record<string, unknown>;
    }

    it('finds a shared rule that hides the same element under a shorter selector', async () => {
        const pageCheck = await pageCheckFor('div.fixed.bottom-0.left-0.right-0.z-50');

        expect(pageCheck).toMatchObject({
            status: 'checked',
            elementCount: 1,
            comparedElementCount: 1,
            checkedSelectors: 7,
            uncheckedSelectors: 1,
            totalMatches: 3,
            truncated: false,
        });
        expect(pageCheck.matches).toEqual([
            {
                relation: 'same',
                levels: 0,
                candidateRule: 'site.example##.fixed.bottom-0',
                elsewhereOnPage: 0,
                lists: [
                    { filePath: POPUPS_LIST, line: 1, domainCount: 3 },
                    { filePath: COOKIES_LIST, line: 1, domainCount: 2 },
                ],
            },
            {
                relation: 'ancestor',
                levels: 1,
                candidateRule: 'site.example##.consent-root',
                elsewhereOnPage: 0,
                lists: [{ filePath: COOKIES_LIST, domainCount: 2, groupLines: [4, 5] }],
            },
            {
                relation: 'descendant',
                levels: 1,
                candidateRule: 'site.example##a.policy',
                elsewhereOnPage: 0,
                lists: [{ filePath: COOKIES_LIST, line: 3, domainCount: 2 }],
            },
        ]);
    });

    it('finds a shared attribute rule for an element the agent named by its id', async () => {
        const pageCheck = await pageCheckFor('#site-consent');

        expect(pageCheck.matches).toEqual([
            {
                relation: 'same',
                levels: 0,
                candidateRule: 'site.example##div[aria-label="Cookie consent"]',
                elsewhereOnPage: 0,
                lists: [{ filePath: COOKIES_LIST, line: 2, domainCount: 2 }],
            },
        ]);
    });

    it('matches a searched selector naming non-Latin text', async () => {
        const pageCheck = await pageCheckFor('[aria-label="Согласие на куки"]');

        expect(pageCheck).toMatchObject({
            status: 'checked',
            elementCount: 1,
            matches: [{ relation: 'same', candidateRule: expect.stringContaining('Согласие') }],
        });
    });

    it('finds wrapper rules, the nearer wrapper first', async () => {
        const pageCheck = await pageCheckFor('.policy');
        const matches = pageCheck.matches as Array<Record<string, unknown>>;

        expect(matches.map((match) => [match.relation, match.levels, match.candidateRule])).toEqual(
            [
                ['same', 0, 'site.example##a.policy'],
                ['ancestor', 1, 'site.example##.fixed.bottom-0'],
                ['ancestor', 2, 'site.example##.consent-root'],
            ],
        );
    });

    it('says the comparison stopped short of every element the selector matches', async () => {
        const pageCheck = await pageCheckFor('.item', crowdedPage);

        // The cards past the compared ones are matched by the searched selector itself, so the
        // rule hides nothing elsewhere on the page.
        expect(pageCheck).toMatchObject({
            status: 'checked',
            elementCount: 25,
            comparedElementCount: 20,
            hint: expect.any(String),
            matches: [{ candidateRule: 'site.example##.item', elsewhereOnPage: 0 }],
        });
    });

    it('finds no shared rule for an element none of them hides', async () => {
        const pageCheck = await pageCheckFor('#plain');

        expect(pageCheck).toMatchObject({ status: 'checked', totalMatches: 0, matches: [] });
    });

    it('says when the browser cannot evaluate the searched selector', async () => {
        const pageCheck = await pageCheckFor('div:has-text(Cookies)');

        expect(pageCheck).toMatchObject({ status: 'selector_not_supported' });
    });
});
