import { describe, expect, it } from 'vitest';
import { normalizePackageManagerArgv } from '../../../lab/cli/argv';

describe('normalizePackageManagerArgv', () => {
    it('removes a forwarded package-manager separator', () => {
        expect(
            normalizePackageManagerArgv([
                '/node',
                '/src/main.ts',
                '--',
                'fix',
                'issue',
                '4',
                '--issue-file',
                '/tmp/issue.json',
            ]),
        ).toEqual([
            '/node',
            '/src/main.ts',
            'fix',
            'issue',
            '4',
            '--issue-file',
            '/tmp/issue.json',
        ]);
    });

    it('preserves direct invocation arguments', () => {
        const argv = ['/node', '/src/main.ts', 'fix', 'issue', '4'];
        expect(normalizePackageManagerArgv(argv)).toEqual(argv);
    });
});
