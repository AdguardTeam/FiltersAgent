import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BlockerVerificationMethod } from '../../src/environment/environment-proofs';
import {
    fileBackedApplicationRefusalDetail,
    parseRuleApplication,
} from '../../src/knowledge/instruction-application';
import { PromptDocumentName, createPromptDocumentLoader } from '../../src/prompts/prompt-documents';

/**
 * An instruction carrying one application and one verification section.
 */
const COMPLETE_INSTRUCTION = [
    '# Executor instruction',
    '',
    '## Rule application',
    '',
    'Apply exactly these steps, invent none:',
    '',
    '1. Open the blocker options page.',
    '2. Add the candidate to the user rules and save.',
    '',
    '## State verification',
    '',
    'The host reads the state back itself:',
    '',
    'read: extension-state user-rules',
].join('\n');

/**
 * The exact application body the extractor returns for COMPLETE_INSTRUCTION.
 */
const EXPECTED_APPLICATION_BODY = [
    '',
    'Apply exactly these steps, invent none:',
    '',
    '1. Open the blocker options page.',
    '2. Add the candidate to the user rules and save.',
    '',
].join('\n');

/**
 * SHA-256 over exact content bytes, as the application contract records it.
 *
 * @param content - Exact section content.
 * @returns The lowercase hex digest.
 */
function sha256Of(content: string): string {
    return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * An application-instruction body used by the verification-declaration tests.
 *
 * @param verificationBody - Lines placed under the state-verification heading.
 * @returns The full instruction text.
 */
function instructionWithVerification(verificationBody: string[]): string {
    return ['## Rule application', 'Steps.', '## State verification', ...verificationBody].join(
        '\n',
    );
}

describe('parseRuleApplication', () => {
    it('parses an application section, its digest, and the declared verification method', () => {
        const parsed = parseRuleApplication(COMPLETE_INSTRUCTION);

        expect(parsed).toStrictEqual({
            application: {
                content: EXPECTED_APPLICATION_BODY,
                sha256: sha256Of(EXPECTED_APPLICATION_BODY),
            },
            verification: { method: BlockerVerificationMethod.ExtensionState },
        });
    });

    it('binds the application role on the plain fallback keyword heading', () => {
        const parsed = parseRuleApplication(
            [
                '## Application',
                'Steps live here.',
                '',
                '## Verification',
                'read: extension-state',
            ].join('\n'),
        );

        expect(parsed).toMatchObject({
            application: { content: 'Steps live here.\n' },
            verification: { method: BlockerVerificationMethod.ExtensionState },
        });
    });

    it('records no-application-method when the instruction carries no application section', () => {
        const parsed = parseRuleApplication('# Executor instruction\n\nNo sections here.\n');

        expect(parsed).toMatchObject({ gap: 'no-application-method' });
        expect(parsed).toHaveProperty('detail');
    });

    it('records no-verification-method when no verification section exists', () => {
        const parsed = parseRuleApplication('# Instruction\n\n## Rule application\n\nSteps.\n');

        expect(parsed).toMatchObject({ gap: 'no-verification-method' });
    });

    it('records no-verification-method when the verification section declares no read', () => {
        const parsed = parseRuleApplication(
            instructionWithVerification(['The host verifies somehow, somehow.', '']),
        );

        expect(parsed).toMatchObject({ gap: 'no-verification-method' });
    });

    it('records unknown-verification-method and names the declared method', () => {
        const parsed = parseRuleApplication(
            instructionWithVerification(['read: crystal-ball deep-state', '']),
        );

        expect(parsed).toMatchObject({ gap: 'unknown-verification-method' });
        expect((parsed as { detail: string }).detail).toContain('crystal-ball');
    });

    it('records no-verification-method when a file method declares no target', () => {
        const parsed = parseRuleApplication(instructionWithVerification(['read: user-rules-file']));

        expect(parsed).toMatchObject({ gap: 'no-verification-method' });
    });

    it('parses a user-rules-file declaration with its target path', () => {
        const parsed = parseRuleApplication(
            instructionWithVerification(['read: user-rules-file /tmp/blocker/rules.txt', '']),
        );

        expect(parsed).toStrictEqual({
            application: expect.objectContaining({ content: 'Steps.' }),
            verification: {
                method: BlockerVerificationMethod.UserRulesFile,
                target: '/tmp/blocker/rules.txt',
            },
        });
    });

    it('parses a managed-storage-file declaration with its target path', () => {
        const parsed = parseRuleApplication(
            instructionWithVerification(['read: managed-storage-file /settings/storage.json', '']),
        );

        expect(parsed).toStrictEqual({
            application: expect.objectContaining({ content: 'Steps.' }),
            verification: {
                method: BlockerVerificationMethod.ManagedStorageFile,
                target: '/settings/storage.json',
            },
        });
    });
});

/**
 * One instruction whose preparation section may declare a launch family, carrying the given
 * verification declaration.
 *
 * @param verification - The `read:` declaration line, verbatim.
 * @param launchDeclaration - The `launch:` line of the preparation section, or undefined for an
 *   instruction that declares no family (the Chromium unpacked-directory default).
 * @returns The instruction text.
 */
function instructionWithLaunch(verification: string, launchDeclaration?: string): string {
    return [
        '# Executor instruction',
        '',
        '## Preparation',
        '',
        ...(launchDeclaration === undefined ? [] : [launchDeclaration, '']),
        '1. Download the blocker.',
        '',
        '## Rule application',
        '',
        'The host maintains the declared file.',
        '',
        '## State verification',
        '',
        verification,
    ].join('\n');
}

describe('fileBackedApplicationRefusalDetail', () => {
    it('admits a managed-storage-file instruction that declares the Firefox launch family', () => {
        expect(
            fileBackedApplicationRefusalDetail(
                instructionWithLaunch(
                    'read: managed-storage-file filters-agent/ublock/user-filters.txt',
                    'launch: firefox',
                ),
            ),
        ).toBeUndefined();
    });

    it('refuses the same managed-storage-file instruction without a launch declaration', () => {
        const detail = fileBackedApplicationRefusalDetail(
            instructionWithLaunch(
                'read: managed-storage-file filters-agent/ublock/user-filters.txt',
            ),
        );

        expect(detail).toContain('managed-storage-file');
        expect(detail).toContain('launch: firefox');
    });

    it('refuses user-rules-file even beside a Firefox launch declaration', () => {
        const detail = fileBackedApplicationRefusalDetail(
            instructionWithLaunch(
                'read: user-rules-file filters-agent/ubol/custom-filters.txt',
                'launch: firefox',
            ),
        );

        expect(detail).toContain('user-rules-file');
    });

    it('admits the live-extension method every Chromium instruction declares', () => {
        expect(
            fileBackedApplicationRefusalDetail(
                instructionWithLaunch('read: extension-state user-rules'),
            ),
        ).toBeUndefined();
    });

    it('admits the shipped uBlock Origin example and refuses the uBlock Origin Lite one', () => {
        const documents = createPromptDocumentLoader();

        expect(
            fileBackedApplicationRefusalDetail(
                documents.read(PromptDocumentName.InstructionsUblockOriginFirefox),
            ),
        ).toBeUndefined();
        expect(
            fileBackedApplicationRefusalDetail(
                documents.read(PromptDocumentName.InstructionsUblockOriginLite),
            ),
        ).toContain('user-rules-file');
        expect(
            fileBackedApplicationRefusalDetail(
                documents.read(PromptDocumentName.InstructionsEdgeMv2),
            ),
        ).toBeUndefined();
    });
});
