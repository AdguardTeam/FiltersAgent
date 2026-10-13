import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadLocalIssueSnapshot } from '../../../src/local/issue-snapshot';
import { loadGoldenHumanOracle, loadGoldenRunCase } from '../../../lab/e2e/golden-case';

/**
 * Build the complete public v2 run document.
 *
 * @returns Valid portable run configuration without environment or human-answer fields.
 */
function runDocument(): Record<string, unknown> {
    return {
        schemaVersion: 2,
        issueNumber: 235988,
        issueFile: 'issue/issue.json',
        filtersBaseSha: '0e06526e359cfb83f2883f7005aeee3feb56b653',
    };
}

/**
 * Write one schema-valid portable issue snapshot for run-side loader tests.
 *
 * @param caseDir - Golden case directory receiving the issue bundle.
 * @param localPath - Optional attachment path to validate.
 */
function writeIssueDocument(caseDir: string, localPath?: string): void {
    mkdirSync(join(caseDir, 'issue'), { recursive: true });
    writeFileSync(
        join(caseDir, 'issue', 'issue.json'),
        JSON.stringify({
            schemaVersion: 1,
            rawIssue: {
                number: 235988,
                url: 'https://github.com/AdguardTeam/AdguardFilters/issues/235988',
                title: 'nettg.pl',
                body: 'Repeated advertising leftovers are visible between article cards.',
                state: 'closed',
                labels: ['T: Ads'],
                assignee: null,
                comments: [],
            },
            reporterComments: [],
            attachments: localPath
                ? [
                      {
                          kind: 'issue_screenshot',
                          sourceUrl: null,
                          localPath,
                          sha256: 'a'.repeat(64),
                          promptVisible: true,
                          source: 'body',
                      },
                  ]
                : [],
        }),
        'utf8',
    );
}

describe('golden E2E case loading', () => {
    it('loads only the four public v2 run fields without opening oracle.json', () => {
        const caseDir = mkdtempSync(join(tmpdir(), 'golden-case-run-only-'));
        writeIssueDocument(caseDir);
        writeFileSync(join(caseDir, 'run.json'), JSON.stringify(runDocument()), 'utf8');
        writeFileSync(join(caseDir, 'oracle.json'), '{ intentionally invalid', 'utf8');

        const loaded = loadGoldenRunCase(caseDir);

        expect(loaded.config).toEqual(runDocument());
        expect(loaded.issueFile).toBe(join(caseDir, 'issue', 'issue.json'));
        expect(loaded.runConfigPath).toBe(join(caseDir, 'run.json'));
        expect(() => loadGoldenHumanOracle(caseDir)).toThrow(/oracle\.json/i);
    });

    it('rejects legacy environment pins and unknown fields from run.json', () => {
        const caseDir = mkdtempSync(join(tmpdir(), 'golden-case-legacy-'));
        writeIssueDocument(caseDir);
        writeFileSync(
            join(caseDir, 'run.json'),
            JSON.stringify({ ...runDocument(), environment: 'historical' }),
            'utf8',
        );

        expect(() => loadGoldenRunCase(caseDir)).toThrow();
    });

    it('loads only one full human fix commit from oracle.json', () => {
        const caseDir = mkdtempSync(join(tmpdir(), 'golden-case-oracle-'));
        writeIssueDocument(caseDir);
        writeFileSync(join(caseDir, 'run.json'), JSON.stringify(runDocument()), 'utf8');
        writeFileSync(
            join(caseDir, 'oracle.json'),
            JSON.stringify({
                humanFixCommit: '8e9ba459a4552df35b3edb1a4e4d8dd240095ce8',
            }),
            'utf8',
        );

        expect(loadGoldenHumanOracle(caseDir)).toEqual({
            humanFixCommit: '8e9ba459a4552df35b3edb1a4e4d8dd240095ce8',
        });
    });

    it.each(['short', 'g'.repeat(40), 'a'.repeat(39)])(
        'rejects invalid human commit %s',
        (humanFixCommit) => {
            const caseDir = mkdtempSync(join(tmpdir(), 'golden-case-oracle-sha-'));
            writeIssueDocument(caseDir);
            writeFileSync(join(caseDir, 'run.json'), JSON.stringify(runDocument()), 'utf8');
            writeFileSync(join(caseDir, 'oracle.json'), JSON.stringify({ humanFixCommit }), 'utf8');

            expect(() => loadGoldenHumanOracle(caseDir)).toThrow();
        },
    );

    it('rejects an issue path that escapes the portable case directory', () => {
        const caseDir = mkdtempSync(join(tmpdir(), 'golden-case-escape-'));
        writeFileSync(
            join(caseDir, 'run.json'),
            JSON.stringify({ ...runDocument(), issueFile: '../issue.json' }),
            'utf8',
        );

        expect(() => loadGoldenRunCase(caseDir)).toThrow(/escapes/i);
    });

    it.each([
        '/tmp/private-screenshot.png',
        'C:\\private-screenshot.png',
        '../outside.png',
        '..\\outside.png',
    ])('rejects non-portable attachment path %s before loading the core bundle', (localPath) => {
        const caseDir = mkdtempSync(join(tmpdir(), 'golden-case-attachment-path-'));
        writeIssueDocument(caseDir, localPath);
        writeFileSync(join(caseDir, 'run.json'), JSON.stringify(runDocument()), 'utf8');

        expect(() => loadGoldenRunCase(caseDir)).toThrow(/attachment path/i);
    });

    it.each([
        [
            'nettg-pl-235988',
            235988,
            'eda7d86824118ca0152c67dcff1ed0a75f2beee9ff642645d79c031c85b7ff8a',
            '8e9ba459a4552df35b3edb1a4e4d8dd240095ce8',
        ],
        [
            'wpoznaniu-pl-235403',
            235403,
            'dbedc727d48cd82f8b80a6c9f676a1b6b815795c4572750d4ed01bb984c35bd0',
            '9a9a950e196d746ae2ed8d1f1a61d61a1ffaae8b',
        ],
        [
            'sochi-camera-234715',
            234715,
            'f51fe5e9300fa9e3acac5999514ad81f4fa0454c12d0f348bbc67bd44ef035ee',
            'e741a790d92e7f4e326195bd2fbac3d1a567f434',
        ],
    ] as const)(
        'loads tracked v2 case %s and its separate human oracle',
        (caseName, issueNumber, screenshotSha, humanFixCommit) => {
            const caseDir = join(process.cwd(), 'lab', 'benchmark', 'e2e', 'cases', caseName);
            const run = loadGoldenRunCase(caseDir);
            const oracle = loadGoldenHumanOracle(caseDir);
            const snapshot = loadLocalIssueSnapshot(run.issueFile);

            expect(run.config).toEqual({
                schemaVersion: 2,
                issueNumber,
                issueFile: 'issue/issue.json',
                filtersBaseSha: expect.stringMatching(/^[0-9a-f]{40}$/),
            });
            expect(snapshot.rawIssue.number).toBe(issueNumber);
            expect(snapshot.attachments[0]?.sha256).toBe(screenshotSha);
            expect(oracle).toEqual({ humanFixCommit });
        },
    );
});
