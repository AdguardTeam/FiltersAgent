import { MissingCatalogFilterReason } from '../types/missing-catalog-filter-reason';
/**
 * Pinned third-party filter identities of the extension build registry.
 *
 * This is the 2026-08-05 snapshot of the third-party entries in
 * `https://filters.adtidy.org/extension/chromium/filters.json` — every entry whose authorship is
 * not AdGuard. `official-filter-catalog.ts` deliberately retains no numeric identifiers because the
 * CLI proxy route classifies reporter text by name; the extension route receives numeric filter IDs
 * from a trusted settings import URL, so classifying an ID the installed build catalog does not
 * list requires the registry's ID binding.
 *
 * The table answers one offline question: a filter ID the installed build catalog does not list is
 * either a known third-party list AdGuard redistributes (recorded with its name and subscription
 * URL, never executed) or an ID no AdGuard registry publishes (recorded as unknown, typically a
 * custom subscription the reporter's own product numbered). Nothing here is fetched at runtime;
 * refreshing the snapshot from the registry is the documented maintenance action, and the names
 * below are the only copy: `official-filter-catalog.ts` derives its third-party name union from
 * this table instead of repeating it, so a refresh here reaches the CLI proxy route as well.
 */

/**
 * One third-party list the AdGuard extension registry publishes under a stable numeric ID.
 */
export interface ThirdPartyFilterCatalogEntry {
    /**
     * Registry-global numeric filter identifier carried by reporter settings import URLs.
     */
    filterId: number;

    /**
     * Exact registry display name, and the single source of the third-party name union that
     * `official-filter-catalog.ts` classifies reporter text against.
     */
    name: string;

    /**
     * Canonical subscription URL the registry publishes for the list.
     */
    subscriptionUrl: string;
}

/**
 * Finite reason a requested filter ID cannot converge on the installed build catalog.
 */
export type { MissingCatalogFilterReason } from '../types/missing-catalog-filter-reason';

/**
 * Offline classification of one requested filter ID absent from the installed build catalog.
 */
export interface MissingCatalogFilterClassification {
    /**
     * Requested filter ID the installed build catalog does not list.
     */
    filterId: number;

    /**
     * Finite classification of the miss: known third-party registry list or unknown ID.
     */
    reason: MissingCatalogFilterReason;

    /**
     * Exact registry display name when the ID resolves to a known third-party list.
     */
    name?: string;

    /**
     * Canonical subscription URL when the ID resolves to a known third-party list.
     */
    subscriptionUrl?: string;
}

export const THIRD_PARTY_FILTER_CATALOG = Object.freeze([
    Object.freeze({
        filterId: 101,
        name: 'EasyList',
        subscriptionUrl: 'https://easylist-downloads.adblockplus.org/easylist.txt',
    }),
    Object.freeze({
        filterId: 102,
        name: 'ABPindo',
        subscriptionUrl:
            'https://raw.githubusercontent.com/ABPindo/indonesianadblockrules/master/subscriptions/abpindo.txt',
    }),
    Object.freeze({
        filterId: 103,
        name: 'Bulgarian list',
        subscriptionUrl: 'https://stanev.org/abp/adblock_bg.txt',
    }),
    Object.freeze({
        filterId: 104,
        name: 'EasyList China',
        subscriptionUrl:
            'https://raw.githubusercontent.com/easylist/easylistchina/master/easylistchina.txt',
    }),
    Object.freeze({
        filterId: 105,
        name: 'EasyList Czech and Slovak',
        subscriptionUrl:
            'https://raw.githubusercontent.com/tomasko126/easylistczechandslovak/master/filters.txt',
    }),
    Object.freeze({
        filterId: 106,
        name: 'EasyList Dutch',
        subscriptionUrl: 'https://easylist-downloads.adblockplus.org/easylistdutch.txt',
    }),
    Object.freeze({
        filterId: 107,
        name: 'EasyList Germany',
        subscriptionUrl: 'https://easylist.to/easylistgermany/easylistgermany.txt',
    }),
    Object.freeze({
        filterId: 108,
        name: 'EasyList Hebrew',
        subscriptionUrl:
            'https://raw.githubusercontent.com/easylist/EasyListHebrew/master/EasyListHebrew.txt',
    }),
    Object.freeze({
        filterId: 109,
        name: 'EasyList Italy',
        subscriptionUrl: 'https://easylist-downloads.adblockplus.org/easylistitaly.txt',
    }),
    Object.freeze({
        filterId: 110,
        name: 'EasyList Lithuania',
        subscriptionUrl:
            'https://raw.githubusercontent.com/EasyList-Lithuania/easylist_lithuania/master/easylistlithuania.txt',
    }),
    Object.freeze({
        filterId: 111,
        name: 'Latvian List',
        subscriptionUrl:
            'https://raw.githubusercontent.com/Latvian-List/adblock-latvian/master/lists/latvian-list.txt',
    }),
    Object.freeze({
        filterId: 112,
        name: 'Liste AR',
        subscriptionUrl: 'https://easylist-downloads.adblockplus.org/Liste_AR.txt',
    }),
    Object.freeze({
        filterId: 113,
        name: 'Liste FR',
        subscriptionUrl: 'https://easylist-downloads.adblockplus.org/liste_fr.txt',
    }),
    Object.freeze({
        filterId: 114,
        name: 'ROList',
        subscriptionUrl: 'https://www.zoso.ro/pages/rolist.txt',
    }),
    Object.freeze({
        filterId: 118,
        name: 'EasyPrivacy',
        subscriptionUrl: 'https://easylist.to/easylist/easyprivacy.txt',
    }),
    Object.freeze({
        filterId: 119,
        name: 'Icelandic ABP List',
        subscriptionUrl: 'https://adblock.gardar.net/is.abp.txt',
    }),
    Object.freeze({
        filterId: 120,
        name: 'AdBlockID',
        subscriptionUrl:
            'https://raw.githubusercontent.com/realodix/AdBlockID/main/dist/adblockid.adfl.txt',
    }),
    Object.freeze({
        filterId: 121,
        name: 'Greek AdBlock Filter',
        subscriptionUrl: 'https://www.void.gr/kargig/void-gr-filters.txt',
    }),
    Object.freeze({
        filterId: 122,
        name: "Fanboy's Annoyances",
        subscriptionUrl: 'https://secure.fanboy.co.nz/fanboy-annoyance_ubo.txt',
    }),
    Object.freeze({
        filterId: 123,
        name: "Fanboy's Social Blocking List",
        subscriptionUrl: 'https://easylist-downloads.adblockplus.org/fanboy-social.txt',
    }),
    Object.freeze({
        filterId: 124,
        name: 'EasyList Portuguese',
        subscriptionUrl: 'https://easylist-downloads.adblockplus.org/easylistportuguese.txt',
    }),
    Object.freeze({
        filterId: 201,
        name: 'Web Annoyances Ultralist',
        subscriptionUrl:
            'https://raw.githubusercontent.com/LanikSJ/webannoyances/master/ultralist.txt',
    }),
    Object.freeze({
        filterId: 202,
        name: 'EasyList Thailand',
        subscriptionUrl:
            'https://raw.githubusercontent.com/easylist-thailand/easylist-thailand/master/subscription/easylist-thailand.txt',
    }),
    Object.freeze({
        filterId: 203,
        name: 'Hungarian filter',
        subscriptionUrl: 'https://filters.hufilter.hu/hufilter-adguard.txt',
    }),
    Object.freeze({
        filterId: 204,
        name: "Peter Lowe's Blocklist",
        subscriptionUrl:
            'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&mimetype=plaintext',
    }),
    Object.freeze({
        filterId: 206,
        name: 'Xfiles',
        subscriptionUrl: 'https://raw.githubusercontent.com/gioxx/xfiles/master/filtri.txt',
    }),
    Object.freeze({
        filterId: 207,
        name: 'Adblock Warning Removal List',
        subscriptionUrl: 'https://easylist-downloads.adblockplus.org/antiadblockfilters.txt',
    }),
    Object.freeze({
        filterId: 208,
        name: 'Online Malicious URL Blocklist',
        subscriptionUrl: 'https://urlhaus-filter.pages.dev/urlhaus-filter-ag-online.txt',
    }),
    Object.freeze({
        filterId: 212,
        name: 'RU AdList: Counters',
        subscriptionUrl: 'https://easylist-downloads.adblockplus.org/cntblock.txt',
    }),
    Object.freeze({
        filterId: 214,
        name: 'ABPVN List',
        subscriptionUrl:
            'https://raw.githubusercontent.com/abpvn/abpvn/master/filter/abpvn_adguard.txt',
    }),
    Object.freeze({
        filterId: 216,
        name: 'Official Polish filters for AdBlock, uBlock Origin & AdGuard',
        subscriptionUrl:
            'https://raw.githubusercontent.com/MajkiIT/polish-ads-filter/master/polish-adblock-filters/adblock.txt',
    }),
    Object.freeze({
        filterId: 217,
        name: 'Polish GDPR-Cookies Filters',
        subscriptionUrl:
            'https://raw.githubusercontent.com/MajkiIT/polish-ads-filter/master/cookies_filters/adblock_cookies.txt',
    }),
    Object.freeze({
        filterId: 218,
        name: 'Estonian List',
        subscriptionUrl: 'https://ubo-et.lepik.io/list.txt',
    }),
    Object.freeze({
        filterId: 220,
        name: "CJX's Annoyances List",
        subscriptionUrl:
            'https://raw.githubusercontent.com/cjx82630/cjxlist/master/cjx-annoyance.txt',
    }),
    Object.freeze({
        filterId: 221,
        name: 'Polish Social Filters',
        subscriptionUrl:
            'https://raw.githubusercontent.com/MajkiIT/polish-ads-filter/master/adblock_social_filters/adblock_social_list.txt',
    }),
    Object.freeze({
        filterId: 225,
        name: "Fanboy's Anti-Facebook List",
        subscriptionUrl: 'https://www.fanboy.co.nz/fanboy-antifacebook.txt',
    }),
    Object.freeze({
        filterId: 227,
        name: 'List-KR Classic filter list',
        subscriptionUrl:
            'https://cdn.jsdelivr.net/npm/@list-kr/filterslists@latest/dist/filterslist-AdGuard-classic.txt',
    }),
    Object.freeze({
        filterId: 228,
        name: 'xinggsf',
        subscriptionUrl:
            'https://raw.githubusercontent.com/xinggsf/Adblock-Plus-Rule/master/rule.txt',
    }),
    Object.freeze({
        filterId: 231,
        name: 'EasyList Spanish',
        subscriptionUrl: 'https://easylist-downloads.adblockplus.org/easylistspanish.txt',
    }),
    Object.freeze({
        filterId: 232,
        name: 'KAD - Anti-Scam',
        subscriptionUrl: 'https://raw.githubusercontent.com/FiltersHeroes/KAD/master/KAD.txt',
    }),
    Object.freeze({
        filterId: 233,
        name: 'Adblock List for Finland',
        subscriptionUrl:
            'https://raw.githubusercontent.com/finnish-easylist-addition/finnish-easylist-addition/gh-pages/Finland_adb.txt',
    }),
    Object.freeze({
        filterId: 234,
        name: 'ROLIST2',
        subscriptionUrl: 'https://www.zoso.ro/pages/rolist2.txt',
    }),
    Object.freeze({
        filterId: 235,
        name: 'Persian Blocker',
        subscriptionUrl:
            'https://raw.githubusercontent.com/MasterKia/PersianBlocker/main/PersianBlocker.txt',
    }),
    Object.freeze({
        filterId: 236,
        name: 'road-block light',
        subscriptionUrl:
            'https://raw.githubusercontent.com/tcptomato/ROad-Block/master/road-block-filters-light.txt',
    }),
    Object.freeze({
        filterId: 237,
        name: 'Polish Annoyances Filters',
        subscriptionUrl:
            'https://raw.githubusercontent.com/PolishFiltersTeam/PolishAnnoyanceFilters/master/PPB.txt',
    }),
    Object.freeze({
        filterId: 238,
        name: 'Polish Anti Adblock Filters',
        subscriptionUrl:
            'https://raw.githubusercontent.com/olegwukr/polish-privacy-filters/master/anti-adblock.txt',
    }),
    Object.freeze({
        filterId: 239,
        name: "Fanboy's Anti-thirdparty Fonts",
        subscriptionUrl: 'https://fanboy.co.nz/fanboy-antifonts.txt',
    }),
    Object.freeze({
        filterId: 241,
        name: 'EasyList Cookie List',
        subscriptionUrl: 'https://www.fanboy.co.nz/fanboy-cookiemonster.txt',
    }),
    Object.freeze({
        filterId: 243,
        name: "Frellwit's Swedish Filter",
        subscriptionUrl:
            'https://raw.githubusercontent.com/lassekongo83/Frellwits-filter-lists/master/Frellwits-Swedish-Filter.txt',
    }),
    Object.freeze({
        filterId: 244,
        name: 'YousList',
        subscriptionUrl: 'https://raw.githubusercontent.com/yous/YousList/master/youslist.txt',
    }),
    Object.freeze({
        filterId: 246,
        name: 'EasyList Polish',
        subscriptionUrl: 'https://easylist-downloads.adblockplus.org/easylistpolish.txt',
    }),
    Object.freeze({
        filterId: 247,
        name: 'Polish Anti-Annoying Special Supplement',
        subscriptionUrl:
            'https://raw.githubusercontent.com/FiltersHeroes/PolishAntiAnnoyingSpecialSupplement/master/polish_rss_filters.txt',
    }),
    Object.freeze({
        filterId: 249,
        name: "Dandelion Sprout's Nordic Filters",
        subscriptionUrl:
            'https://raw.githubusercontent.com/DandelionSprout/adfilt/master/NorwegianExperimentalList%20alternate%20versions/NordicFiltersAdGuard.txt',
    }),
    Object.freeze({
        filterId: 250,
        name: "Dandelion Sprout's Annoyances List",
        subscriptionUrl:
            'https://raw.githubusercontent.com/DandelionSprout/adfilt/master/AnnoyancesList',
    }),
    Object.freeze({
        filterId: 251,
        name: 'Legitimate URL Shortener',
        subscriptionUrl:
            'https://raw.githubusercontent.com/DandelionSprout/adfilt/master/LegitimateURLShortener.txt',
    }),
    Object.freeze({
        filterId: 252,
        name: "Dandelion Sprout's Serbo-Croatian List",
        subscriptionUrl:
            'https://raw.githubusercontent.com/DandelionSprout/adfilt/master/SerboCroatianList.txt',
    }),
    Object.freeze({
        filterId: 253,
        name: 'IndianList',
        subscriptionUrl: 'https://easylist-downloads.adblockplus.org/indianlist.txt',
    }),
    Object.freeze({
        filterId: 254,
        name: 'Macedonian adBlock Filters',
        subscriptionUrl:
            'https://raw.githubusercontent.com/RandomAdversary/Macedonian-adBlock-Filters/master/Filters',
    }),
    Object.freeze({
        filterId: 255,
        name: 'Phishing URL Blocklist',
        subscriptionUrl: 'https://malware-filter.gitlab.io/malware-filter/phishing-filter-ag.txt',
    }),
    Object.freeze({
        filterId: 256,
        name: 'Scam Blocklist by DurableNapkin',
        subscriptionUrl:
            'https://raw.githubusercontent.com/durablenapkin/scamblocklist/master/adguard.txt',
    }),
    Object.freeze({
        filterId: 257,
        name: 'uBlock Origin – Badware risks',
        subscriptionUrl:
            'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/badware.txt',
    }),
    Object.freeze({
        filterId: 258,
        name: 'uBlock Origin – Block Outsider Intrusion into LAN',
        subscriptionUrl: 'https://ublockorigin.github.io/uAssetsCDN/filters/lan-block.txt',
    }),
    Object.freeze({
        filterId: 259,
        name: "Dandelion Sprout's Anti-Malware List",
        subscriptionUrl:
            'https://raw.githubusercontent.com/DandelionSprout/adfilt/master/Alternate%20versions%20Anti-Malware%20List/AntiMalwareAdGuard.txt',
    }),
    Object.freeze({
        filterId: 260,
        name: "Stevo's AI Blocklist",
        subscriptionUrl:
            'https://raw.githubusercontent.com/Stevoisiak/Stevos-AI-Blocklist/refs/heads/main/GenAI-Blocklist.txt',
    }),
]);

/**
 * Known third-party registry entries indexed by their numeric filter ID.
 */
const THIRD_PARTY_FILTERS_BY_ID: ReadonlyMap<number, ThirdPartyFilterCatalogEntry> = new Map(
    THIRD_PARTY_FILTER_CATALOG.map((entry) => [entry.filterId, entry]),
);

/**
 * Classify one requested filter ID the installed build catalog does not list.
 *
 * The decision is a pure offline function over the pinned registry snapshot: a known third-party
 * list is identified by name and subscription URL so the run can record an actionable conflict,
 * while any other ID is recorded as unknown — in practice a custom subscription the reporter's own
 * product numbered, which no catalog lookup can name.
 *
 * @param filterId - Requested filter ID absent from the installed build catalog.
 * @returns Classification carrying the registry identity when one is known.
 */
export function classifyMissingCatalogFilterId(
    filterId: number,
): MissingCatalogFilterClassification {
    const entry = THIRD_PARTY_FILTERS_BY_ID.get(filterId);
    if (entry === undefined) {
        return { filterId, reason: MissingCatalogFilterReason.UnknownFilterId };
    }
    return {
        filterId,
        reason: MissingCatalogFilterReason.ThirdPartyNotInBuildCatalog,
        name: entry.name,
        subscriptionUrl: entry.subscriptionUrl,
    };
}
