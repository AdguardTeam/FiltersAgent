import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bundledRulesetPath } from '../../../src/browser/extension-list-text';
import { checkHumanFixAbsent, HumanFixPresentError } from '../../../lab/e2e/human-fix-build-guard';

const directories: string[] = [];

function baseCheckout(): string {
    const directory = mkdtempSync(join(tmpdir(), 'human-fix-base-'));
    directories.push(directory);
    return directory;
}

function createExtension(ids: number[]): string {
    const directory = mkdtempSync(join(tmpdir(), 'human-fix-build-guard-'));
    directories.push(directory);
    writeFileSync(
        join(directory, 'manifest.json'),
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
    return directory;
}

function writeRuleset(extension: string, id: number, metadata: object): void {
    const path = bundledRulesetPath(extension, id);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
        path,
        JSON.stringify([
            {
                id: 1,
                priority: 1,
                action: { type: 'allow' },
                condition: { urlFilter: 'dummy.rule.adguard.com' },
                metadata,
            },
        ]),
    );
}

afterEach(() => {
    for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

describe('human fix build guard', () => {
    it('ignores an added rule already present in any nested text file at the base', () => {
        const extension = createExtension([1]);
        const rule = 'example.com##.ad';
        writeRuleset(extension, 1, { rawFilterList: `${rule}\n` });
        const base = baseCheckout();
        const nested = join(base, 'unmapped', 'deep');
        mkdirSync(nested, { recursive: true });
        writeFileSync(join(nested, 'rules.txt'), `  ${rule}  \n`);

        expect(checkHumanFixAbsent(extension, { added: [` ${rule} `], removed: [] }, base)).toEqual(
            { violations: [], warnings: [] },
        );
    });

    it('passes a build that has none of the added rules and every removed rule', () => {
        const extension = createExtension([1, 14]);
        writeRuleset(extension, 1, { filterContent: '! List\r\n  example.com##.old-ad  \r\n' });
        writeRuleset(extension, 14, { rawFilterList: '||example.org/old-ad^\n' });

        expect(
            checkHumanFixAbsent(
                extension,
                {
                    added: ['example.com##.new-ad', '||example.org/new-ad^'],
                    removed: [' example.com##.old-ad ', '||example.org/old-ad^'],
                },
                baseCheckout(),
            ),
        ).toEqual({ violations: [], warnings: [] });
    });

    it('names the rule and list id when an added rule is already in a 5.4 build', () => {
        const extension = createExtension([1, 14]);
        const rule = 'example.com##.ad';
        writeRuleset(extension, 1, { rawFilterList: `! List\r\n  ${rule}  \r\n` });
        writeRuleset(extension, 14, { filterContent: `${rule}\n` });

        const { violations } = checkHumanFixAbsent(
            extension,
            { added: [` ${rule} `], removed: [] },
            baseCheckout(),
        );

        expect(violations).toEqual([
            { rule: ` ${rule} `, filterId: 1 },
            { rule: ` ${rule} `, filterId: 14 },
        ]);
        const error = new HumanFixPresentError(violations);
        expect(error.violations).toEqual(violations);
        expect(error.message).toContain(rule);
        expect(error.message).toMatch(/\b1\b/u);
        expect(error.message).toMatch(/\b14\b/u);
    });

    it('warns without refusing when no list carries a removed rule', () => {
        const extension = createExtension([1]);
        const rule = '||example.org/old-ad^';
        writeRuleset(extension, 1, { rawFilterList: 'example.com##.ad\n' });

        expect(
            checkHumanFixAbsent(extension, { added: [], removed: [rule] }, baseCheckout()),
        ).toEqual({ violations: [], warnings: [rule] });
    });

    it.each([
        { checksums: { ruleset_1: 'list-checksum' } },
        { checksums: { ruleset_1: 'list-checksum' }, byteRangeMapsCollection: {} },
    ])('ignores converter metadata and compares only manifest filter lists', (metadata) => {
        const extension = createExtension([0, 1]);
        const added = 'example.com##.new-ad';
        const removed = 'example.com##.old-ad';
        writeRuleset(extension, 0, metadata);
        writeRuleset(extension, 1, { rawFilterList: `${added}\n${removed}\n` });
        writeRuleset(extension, 99, { filterContent: added });

        expect(
            checkHumanFixAbsent(extension, { added: [added], removed: [removed] }, baseCheckout()),
        ).toEqual({
            violations: [{ rule: added, filterId: 1 }],
            warnings: [],
        });
    });

    it('fails naming a non-metadata ruleset path when it carries no list text', () => {
        const extension = createExtension([0, 1, 14]);
        writeRuleset(extension, 0, { checksums: { ruleset_1: 'list-checksum' } });
        writeRuleset(extension, 1, { filterContent: '! List\n' });
        writeRuleset(extension, 14, {});

        expect(() =>
            checkHumanFixAbsent(extension, { added: [], removed: [] }, baseCheckout()),
        ).toThrow(bundledRulesetPath(extension, 14));
    });
});
