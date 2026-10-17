import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadLocalIssueSnapshot } from '../../../src/local/issue-snapshot';
import { FULL_COMMIT_SHA_PATTERN } from '../../../src/environment/environment-proofs';
import {
    GoldenRunSchemaVersion,
    loadGoldenHumanOracle,
    loadGoldenRunCase,
    loadLegacyGoldenRunCase,
    readGoldenRunSchemaVersion,
    writeGoldenRunDocument,
    type GoldenE2ERun,
} from '../../../lab/e2e/golden-case';

/**
 * Build the complete public run document with its historical extension identity.
 *
 * @returns Valid portable run configuration without environment or human-answer fields.
 */
function runDocument(): GoldenE2ERun {
    return {
        schemaVersion: GoldenRunSchemaVersion.Current,
        issueNumber: 235988,
        issueFile: 'issue/issue.json',
        filtersBaseSha: '0e06526e359cfb83f2883f7005aeee3feb56b653',
        extensionBuild: {
            version: '5.4.3.99',
            releaseTag: 'v5.4.3.1',
            autobuildCommit: 'a'.repeat(40),
        },
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
    it('loads the v3 run fields with the extension build without opening oracle.json', () => {
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

    it('refuses a v2 run.json and names benchmark:case:check', () => {
        const caseDir = mkdtempSync(join(tmpdir(), 'golden-case-v2-'));
        const { extensionBuild: _extensionBuild, ...legacy } = runDocument();
        writeFileSync(
            join(caseDir, 'run.json'),
            JSON.stringify({ ...legacy, schemaVersion: GoldenRunSchemaVersion.Legacy }),
        );

        expect(readGoldenRunSchemaVersion(caseDir)).toBe(GoldenRunSchemaVersion.Legacy);
        expect(() => loadGoldenRunCase(caseDir)).toThrow(/benchmark:case:check/);
        expect(() => loadGoldenRunCase(caseDir)).toThrow(caseDir.split('/').at(-1)!);
    });

    it.each([
        { version: '5.4.3', releaseTag: 'v5.4.3.1', autobuildCommit: 'a'.repeat(40) },
        { version: '5.4.3.99', releaseTag: 'v5.4.3.1', autobuildCommit: 'a'.repeat(39) },
        { version: '5.4.3.99', releaseTag: 'v5.4.3.1', autobuildCommit: 'g'.repeat(40) },
    ])(
        'rejects an extension build whose version is not four components or whose commit is not a full sha: %j',
        (extensionBuild) => {
            const caseDir = mkdtempSync(join(tmpdir(), 'golden-case-build-invalid-'));
            writeIssueDocument(caseDir);
            writeFileSync(join(caseDir, 'run.json'), JSON.stringify(runDocument()));
            expect(loadGoldenRunCase(caseDir).config.extensionBuild).toEqual(
                runDocument().extensionBuild,
            );
            writeFileSync(
                join(caseDir, 'run.json'),
                JSON.stringify({ ...runDocument(), extensionBuild }),
            );

            expect(() => loadGoldenRunCase(caseDir)).toThrow();
        },
    );

    it('reads a v2 run.json through the legacy loader for migration', () => {
        const caseDir = mkdtempSync(join(tmpdir(), 'golden-case-migrate-'));
        writeIssueDocument(caseDir);
        const { extensionBuild: _extensionBuild, ...fields } = runDocument();
        const legacy = { ...fields, schemaVersion: GoldenRunSchemaVersion.Legacy };
        writeFileSync(join(caseDir, 'run.json'), JSON.stringify(legacy));

        expect(loadLegacyGoldenRunCase(caseDir)).toEqual({
            config: legacy,
            issueFile: join(caseDir, 'issue', 'issue.json'),
            runConfigPath: join(caseDir, 'run.json'),
        });
    });

    it('writes a run.json the loader reads back', () => {
        const caseDir = mkdtempSync(join(tmpdir(), 'golden-case-write-'));
        writeIssueDocument(caseDir);

        writeGoldenRunDocument(caseDir, runDocument());
        writeGoldenRunDocument(caseDir, runDocument());

        expect(readGoldenRunSchemaVersion(caseDir)).toBe(GoldenRunSchemaVersion.Current);
        expect(loadGoldenRunCase(caseDir).config).toEqual(runDocument());
        expect(readFileSync(join(caseDir, 'run.json'), 'utf8')).toBe(
            `${JSON.stringify(runDocument(), null, 4)}\n`,
        );
        expect(readdirSync(caseDir).sort()).toEqual(['issue', 'run.json']);
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

    it('loads the human fix commit and both human timestamps from oracle.json', () => {
        const caseDir = mkdtempSync(join(tmpdir(), 'golden-case-oracle-'));
        writeIssueDocument(caseDir);
        writeFileSync(join(caseDir, 'run.json'), JSON.stringify(runDocument()), 'utf8');
        writeFileSync(
            join(caseDir, 'oracle.json'),
            JSON.stringify({
                humanFixCommit: '8e9ba459a4552df35b3edb1a4e4d8dd240095ce8',
                issueCreatedAt: '2026-07-14T06:08:12Z',
                fixCommittedAt: '2026-07-14T09:08:12Z',
            }),
            'utf8',
        );

        expect(loadGoldenHumanOracle(caseDir)).toEqual({
            humanFixCommit: '8e9ba459a4552df35b3edb1a4e4d8dd240095ce8',
            issueCreatedAt: '2026-07-14T06:08:12Z',
            fixCommittedAt: '2026-07-14T09:08:12Z',
        });
    });

    it('rejects an oracle.json without the human timestamps', () => {
        const caseDir = mkdtempSync(join(tmpdir(), 'golden-case-oracle-dates-'));
        writeFileSync(
            join(caseDir, 'oracle.json'),
            JSON.stringify({ humanFixCommit: 'a'.repeat(40) }),
        );

        expect(() => loadGoldenHumanOracle(caseDir)).toThrow();
    });

    it.each(['short', 'g'.repeat(40), 'a'.repeat(39)])(
        'rejects invalid human commit %s',
        (humanFixCommit) => {
            const caseDir = mkdtempSync(join(tmpdir(), 'golden-case-oracle-sha-'));
            writeIssueDocument(caseDir);
            writeFileSync(join(caseDir, 'run.json'), JSON.stringify(runDocument()), 'utf8');
            writeFileSync(
                join(caseDir, 'oracle.json'),
                JSON.stringify({
                    humanFixCommit,
                    issueCreatedAt: '2026-07-14T06:08:12Z',
                    fixCommittedAt: '2026-07-14T09:08:12Z',
                }),
                'utf8',
            );

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

    it('loads ISO human timestamps from every tracked case', () => {
        const casesRoot = join(process.cwd(), 'lab', 'benchmark', 'e2e', 'cases');
        for (const caseName of readdirSync(casesRoot)) {
            const oracle = loadGoldenHumanOracle(join(casesRoot, caseName));
            expect(Number.isFinite(Date.parse(oracle.issueCreatedAt))).toBe(true);
            expect(Number.isFinite(Date.parse(oracle.fixCommittedAt))).toBe(true);
        }
    });

    it.each([
        [
            'nettg-pl-235988',
            235988,
            'eda7d86824118ca0152c67dcff1ed0a75f2beee9ff642645d79c031c85b7ff8a',
            '8e9ba459a4552df35b3edb1a4e4d8dd240095ce8',
            '5.4.3.99',
        ],
        [
            'wpoznaniu-pl-235403',
            235403,
            'dbedc727d48cd82f8b80a6c9f676a1b6b815795c4572750d4ed01bb984c35bd0',
            '9a9a950e196d746ae2ed8d1f1a61d61a1ffaae8b',
            '5.4.3.91',
        ],
        [
            'sochi-camera-234715',
            234715,
            'f51fe5e9300fa9e3acac5999514ad81f4fa0454c12d0f348bbc67bd44ef035ee',
            'e741a790d92e7f4e326195bd2fbac3d1a567f434',
            '5.4.3.83',
        ],
    ] as const)(
        'loads tracked v3 case %s and its separate human oracle',
        (caseName, issueNumber, screenshotSha, humanFixCommit, extensionVersion) => {
            const caseDir = join(process.cwd(), 'lab', 'benchmark', 'e2e', 'cases', caseName);
            const run = loadGoldenRunCase(caseDir);
            const oracle = loadGoldenHumanOracle(caseDir);
            const snapshot = loadLocalIssueSnapshot(run.issueFile);

            expect(run.config).toEqual({
                schemaVersion: GoldenRunSchemaVersion.Current,
                issueNumber,
                issueFile: 'issue/issue.json',
                filtersBaseSha: expect.stringMatching(/^[0-9a-f]{40}$/),
                extensionBuild: {
                    version: extensionVersion,
                    releaseTag: 'v5.4.3.1',
                    autobuildCommit: expect.stringMatching(FULL_COMMIT_SHA_PATTERN),
                },
            });
            expect(snapshot.rawIssue.number).toBe(issueNumber);
            expect(snapshot.attachments[0]?.sha256).toBe(screenshotSha);
            expect(oracle).toEqual({
                humanFixCommit,
                issueCreatedAt: expect.any(String),
                fixCommittedAt: expect.any(String),
            });
            expect(Number.isFinite(Date.parse(oracle.issueCreatedAt))).toBe(true);
            expect(Number.isFinite(Date.parse(oracle.fixCommittedAt))).toBe(true);
        },
    );
});
