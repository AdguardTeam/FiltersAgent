import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    InteractionReplay,
    revealStepsRepairGuidance,
} from '../../src/environment/interaction-replay';
import type { TraceRecorder } from '../../src/tracer/trace-recorder';
import {
    ageDialogRevealPlan,
    fakeInteractionSession,
    INTERACTION_FIXTURE_ORIGIN,
    type InteractionPhaseScript,
} from './interaction-session-fixture';

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) {
        rmSync(root, { force: true, recursive: true });
    }
});

function recorderStub(): TraceRecorder {
    const artifacts: Array<{ id: string; path: string; type: string; bytes: number }> = [];
    return {
        addArtifact: (artifact: { id: string; path: string; type: string; bytes: number }) => {
            artifacts.push(artifact);
        },
        getArtifacts: () => artifacts,
    } as unknown as TraceRecorder;
}

async function replayAllPhases(
    scripts: Partial<Record<'A' | 'B' | 'C', InteractionPhaseScript>>,
): Promise<InteractionReplay> {
    const artifactsDir = mkdtempSync(join(tmpdir(), 'interaction-replay-'));
    roots.push(artifactsDir);
    const replay = new InteractionReplay({
        plan: ageDialogRevealPlan(),
        allowedOrigin: INTERACTION_FIXTURE_ORIGIN,
        artifactsDir,
        recorder: recorderStub(),
    });
    for (const phase of ['A', 'B', 'C'] as const) {
        await replay.replayFor(phase, fakeInteractionSession(scripts[phase]), `token-${phase}`)();
    }
    return replay;
}

describe('InteractionReplay', () => {
    it('performs the same reveal steps in every phase and retains each as evidence', async () => {
        const replay = await replayAllPhases({});

        const projection = replay.projection()!;
        expect(projection.planDigest).toBe(ageDialogRevealPlan().digest);
        for (const phase of ['A', 'B', 'C'] as const) {
            expect(projection.phases[phase]).toMatchObject({
                status: 'completed',
                executedSteps: 2,
            });
            const retained = JSON.parse(readFileSync(replay.artifactOf(phase)!.path, 'utf8'));
            expect(retained.record.planDigest).toBe(projection.planDigest);
        }
        expect(replay.preparedAlike()).toBe(true);
    });

    it('keeps a candidate that stopped a click-spawned tab comparable to its baseline', async () => {
        const replay = await replayAllPhases({
            A: { popup: 'https://ads.example.net/landing' },
            B: { popup: 'https://ads.example.net/landing' },
        });

        const projection = replay.projection()!;
        expect(projection.phases.B?.popupsOpened).toBe(1);
        expect(projection.phases.C?.popupsOpened).toBe(0);
        // The whole proof of a popup rule is that the tab stops opening, so that difference must
        // never be read as the two phases being prepared differently.
        expect(replay.preparedAlike()).toBe(true);
    });

    it('refuses to compare a candidate phase that never reached the baseline state', async () => {
        const replay = await replayAllPhases({ C: { targetMissing: true } });

        expect(replay.projection()?.phases.C?.status).toBe('refused');
        expect(replay.preparedAlike()).toBe(false);
    });

    it('records a phase whose page died instead of failing the experiment', async () => {
        const replay = await replayAllPhases({ C: { pageLost: true } });

        expect(replay.projection()?.phases.C).toMatchObject({ status: 'failed', executedSteps: 0 });
        expect(replay.preparedAlike()).toBe(false);
    });

    it('sends the model to fix its steps when a phase never performed them', async () => {
        const replay = await replayAllPhases({ B: { targetMissing: true } });

        const guidance = revealStepsRepairGuidance(replay.projection());

        expect(guidance).toHaveLength(1);
        expect(guidance[0]).toContain('phase B');
        expect(revealStepsRepairGuidance((await replayAllPhases({})).projection())).toEqual([]);
    });
});
