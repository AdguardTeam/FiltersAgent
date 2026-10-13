import { describe, expect, it } from 'vitest';
import { terminalRejectionFingerprint } from '../../src/orchestrator/terminal-rejection-fingerprint';
import type { FinishFixValidationRejection } from '../../src/types/terminal-rejection';

/**
 * A current-extension full-vision rejection as the runtime emits it, with the requirement report
 * the model is supposed to act on.
 *
 * @param overrides - Fields to change on the requirement report.
 * @returns The structured rejection.
 */
function visionRejection(overrides: Record<string, unknown> = {}): FinishFixValidationRejection {
    return {
        error: 'A current-first result requires complete full-page vision.',
        errorKind: 'current_extension_full_vision_required',
        retryable: true,
        requiredAction: 'inspect_current_extension_full_page',
        requiredTools: ['screenshot', 'inspect_full_page_capture'],
        guidance: ['Capture and inspect the full page.'],
        currentVisionRequirement: {
            environment: 'current_prepared_extension',
            status: 'incomplete',
            sessionId: 'session-1',
            sessionOrdinal: 2,
            targetUrl: 'https://example.test/',
            selectedSettingsProfileKind: 'reported_on_current',
            navigationVerified: true,
            coverageComplete: true,
            requiredArtifactCount: 4,
            analyzedArtifactCount: 0,
            missingArtifactIds: ['a', 'b', 'c', 'd'],
            nextAction: 'inspect_full_page_capture',
            ...overrides,
        },
    };
}

describe('terminalRejectionFingerprint', () => {
    it('ignores prose, session identity and artifact ids', () => {
        // Contract: a model that relaunches a session and re-captures without inspecting is
        // resubmitting into the same wall, however the ids and the wording moved.
        const relaunched = visionRejection({
            sessionId: 'session-2',
            sessionOrdinal: 3,
            targetUrl: 'https://example.test/?fresh',
            missingArtifactIds: ['e', 'f', 'g', 'h'],
        });
        relaunched.error = 'Reworded for the retry.';
        relaunched['guidance'] = ['Different guidance.'];
        relaunched['requiredTools'] = ['analyze_screenshot'];

        expect(terminalRejectionFingerprint(relaunched)).toBe(
            terminalRejectionFingerprint(visionRejection()),
        );
    });

    it('changes when the evidence progress or the rejection kind changes', () => {
        const base = terminalRejectionFingerprint(visionRejection());

        expect(
            terminalRejectionFingerprint(visionRejection({ analyzedArtifactCount: 3 })),
        ).not.toBe(base);
        expect(
            terminalRejectionFingerprint({
                ...visionRejection(),
                errorKind: 'current_reporter_settings_required',
            }),
        ).not.toBe(base);
    });

    it('is independent of key and array order', () => {
        const reordered: FinishFixValidationRejection = {
            retryable: true,
            errorKind: 'current_extension_full_vision_required',
            error: 'A current-first result requires complete full-page vision.',
            currentVisionRequirement: {
                nextAction: 'inspect_full_page_capture',
                analyzedArtifactCount: 0,
                requiredArtifactCount: 4,
                coverageComplete: true,
                navigationVerified: true,
                selectedSettingsProfileKind: 'reported_on_current',
                status: 'incomplete',
                environment: 'current_prepared_extension',
            },
            requiredTools: ['inspect_full_page_capture', 'screenshot'],
            requiredAction: 'inspect_current_extension_full_page',
            guidance: ['Capture and inspect the full page.'],
        };

        expect(terminalRejectionFingerprint(reordered)).toBe(
            terminalRejectionFingerprint(visionRejection()),
        );
    });
});
