import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    listBundledListIds,
    readBundledListLines,
    sliceListText,
} from '../../src/browser/extension-list-text';

const FILTER_ID = 2;

/**
 * The list text as the pinned build stores it: the published checksum header first, a second
 * checksum line in the middle (so a slice has to strip more than the header), and CRLF line ends
 * with the final line break every published list ends with.
 */
const LIST_LINES = [
    '! Checksum: 5eV9kU2vJ1Xm3Q0HkFjJ7A',
    '! Title: AdGuard Base filter',
    'example.com##.ad-banner',
    '!   checksum: stale-mid-list-marker',
    '||ads.example^$third-party',
    'example.org##.sidebar-promo',
];

const LIST_TEXT = `${LIST_LINES.join('\r\n')}\r\n`;

let extensionPath: string | undefined;

/**
 * Writes one ruleset JSON at the path the build uses for a list: the dummy first rule carries the
 * list text, a real declarative rule follows.
 */
function writeUnpackedBuild(filterId: number, rules: unknown[]): string {
    const root = mkdtempSync(join(tmpdir(), 'extension-list-text-'));
    const rulesetDir = join(root, 'filters', 'declarative', `ruleset_${filterId}`);
    mkdirSync(rulesetDir, { recursive: true });
    writeFileSync(join(rulesetDir, `ruleset_${filterId}.json`), JSON.stringify(rules));
    writeManifest(root, [filterId]);
    return root;
}

function writeManifest(root: string, ids: number[]): void {
    writeFileSync(
        join(root, 'manifest.json'),
        JSON.stringify({
            declarative_net_request: {
                rule_resources: ids.map((id) => ({
                    id: `ruleset_${id}`,
                    enabled: true,
                    path: `filters/declarative/ruleset_${id}/ruleset_${id}.json`,
                })),
            },
        }),
    );
}

function metadataRule(filterContent: string): unknown {
    return {
        id: 1,
        priority: 1,
        action: { type: 'allow' },
        condition: { urlFilter: 'dummy-metadata-rule' },
        metadata: {
            metadata: { filterId: FILTER_ID, version: '2.0.0.1' },
            lazyMetadata: { conversionMap: {} },
            filterContent,
        },
    };
}

const REAL_RULE = {
    id: 2,
    priority: 1,
    action: { type: 'block' },
    condition: { urlFilter: '||ads.example^', domainType: 'thirdParty' },
};

afterEach(() => {
    if (extensionPath !== undefined) {
        rmSync(extensionPath, { recursive: true, force: true });
        extensionPath = undefined;
    }
});

describe('readBundledListLines', () => {
    it('reads the list text a 5.4 build keeps in rawFilterList', () => {
        extensionPath = writeUnpackedBuild(FILTER_ID, [
            { metadata: { rawFilterList: LIST_TEXT } },
            REAL_RULE,
        ]);

        expect(readBundledListLines(extensionPath, FILTER_ID)).toEqual(LIST_LINES);
    });

    it('returns the list text as lines, CRLF stripped and the final line break dropped', () => {
        extensionPath = writeUnpackedBuild(FILTER_ID, [metadataRule(LIST_TEXT), REAL_RULE]);

        const lines = readBundledListLines(extensionPath, FILTER_ID);

        expect(lines).toEqual(LIST_LINES);
        expect(lines).toHaveLength(6);
    });

    it('throws when the build has no ruleset for the list', () => {
        extensionPath = writeUnpackedBuild(FILTER_ID, [metadataRule(LIST_TEXT), REAL_RULE]);

        expect(() => readBundledListLines(extensionPath as string, 999)).toThrow(/ruleset_999/);
    });

    it('throws when the first rule of the ruleset carries no list text', () => {
        extensionPath = writeUnpackedBuild(FILTER_ID, [REAL_RULE]);

        expect(() => readBundledListLines(extensionPath as string, FILTER_ID)).toThrow(
            new RegExp(`ruleset_${FILTER_ID}\\.json`),
        );
    });
});

describe('listBundledListIds', () => {
    it('lists manifest ruleset ids in numeric order without unreferenced disk assets', () => {
        extensionPath = writeUnpackedBuild(14, [metadataRule(LIST_TEXT), REAL_RULE]);
        const declarativePath = join(extensionPath, 'filters', 'declarative');
        mkdirSync(join(declarativePath, 'ruleset_1'));
        mkdirSync(join(declarativePath, 'ruleset_99'));
        writeFileSync(join(declarativePath, 'unrelated.json'), '{}');
        writeFileSync(join(declarativePath, 'ruleset_7'), '{}');
        writeManifest(extensionPath, [14, 1]);

        expect(listBundledListIds(extensionPath)).toEqual([1, 14]);
    });

    it('throws with the path when the build has no manifest', () => {
        extensionPath = mkdtempSync(join(tmpdir(), 'extension-list-text-'));

        expect(() => listBundledListIds(extensionPath as string)).toThrow(
            join(extensionPath, 'manifest.json'),
        );
    });
});

describe('sliceListText', () => {
    it('returns the range LF-joined with a trailing newline, minus every checksum line', () => {
        expect(sliceListText(LIST_LINES, { filterId: FILTER_ID, firstLine: 1, lastLine: 6 })).toBe(
            [
                '! Title: AdGuard Base filter',
                'example.com##.ad-banner',
                '||ads.example^$third-party',
                'example.org##.sidebar-promo',
                '',
            ].join('\n'),
        );
        expect(sliceListText(LIST_LINES, { filterId: FILTER_ID, firstLine: 3, lastLine: 5 })).toBe(
            'example.com##.ad-banner\n||ads.example^$third-party\n',
        );
        expect(sliceListText(LIST_LINES, { filterId: FILTER_ID, firstLine: 6, lastLine: 6 })).toBe(
            'example.org##.sidebar-promo\n',
        );
    });
});
