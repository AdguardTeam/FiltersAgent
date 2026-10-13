import { describe, expect, it } from 'vitest';
import { AdGuardExtensionMessageType } from '../../src/browser/adguard-extension-message-types';
import { BlockerVerificationMethod } from '../../src/environment/environment-proofs';
import { parseRuleApplication } from '../../src/knowledge/instruction-application';
import { createPromptDocumentLoader, PromptDocumentName } from '../../src/prompts/prompt-documents';

/**
 * The contract this suite holds: a run without its own instruction applies the shipped built-in
 * AdGuard document, and that document must (a) parse as an application contract the host can verify
 * and (b) name every app message the run's host side speaks. The document is the specification the
 * host-performed runner implements, so a message type renamed on one side only leaves the run
 * sending a type the extension answers `undefined` to — a step that looks like it ran.
 */

const loader = createPromptDocumentLoader();

/**
 * The built-in AdGuard instruction's rule-application steps, through the production parser.
 *
 * @returns The application section content.
 */
function applicationSteps(): string {
    const parsed = parseRuleApplication(
        loader.read(PromptDocumentName.InstructionsAdguardExtension),
    );
    if (!('application' in parsed)) {
        throw new Error(
            `expected a parsed application contract, received the refusal ${parsed.gap}: ` +
                parsed.detail,
        );
    }
    expect(parsed.verification.method).toBe(BlockerVerificationMethod.ExtensionState);
    expect(parsed.application.sha256).toMatch(/^[0-9a-f]{64}$/u);
    return parsed.application.content;
}

describe('application contract of the built-in AdGuard instruction', () => {
    it('declares an extension-state read-back and digests its application steps', () => {
        expect(applicationSteps().length).toBeGreaterThan(0);
    });

    it('names the readiness, import and user-rules messages the host side speaks', () => {
        const steps = applicationSteps();
        for (const type of [
            AdGuardExtensionMessageType.GetIsAppInitialized,
            AdGuardExtensionMessageType.ApplySettingsJson,
            AdGuardExtensionMessageType.SaveUserRules,
        ]) {
            expect(steps).toContain(type);
        }
    });

    it('performs the post-import filter convergence the retired driver performed', () => {
        const steps = applicationSteps();
        // Read the observed filter set back, then turn off whatever the import left on: a
        // successful applySettingsJson is not proof of the expected set (the live run read back
        // [2, 3, 10] against the prepared [2, 3]).
        expect(steps).toContain(AdGuardExtensionMessageType.GetOptionsData);
        expect(steps).toContain(AdGuardExtensionMessageType.DisableFilter);
        expect(steps).toContain('filterId');
    });

    it('never names a message that enables a filter, which the retired driver could not do either', () => {
        expect(applicationSteps()).not.toContain('enableFilter');
    });
});
