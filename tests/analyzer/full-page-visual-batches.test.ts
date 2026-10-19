import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectInventoryBatch } from '../../src/analyzer/full-page-visual-batches';
import { TraceRecorder } from '../../src/tracer/trace-recorder';
import { PageObstruction } from '../../src/types/page-obstruction';
import { ReporterSymptomPresence } from '../../src/types/reporter-symptom-presence';
import {
    HermeticScenario,
    type HermeticProvider,
    ScriptedReplyKind,
    startHermeticProvider,
} from '../pi/hermetic-provider';
import { encodePng } from '../pi/fixtures/png-image';
import { createTestVisionClient } from '../pi/test-runtime';

let provider: HermeticProvider | undefined;
let root: string | undefined;

afterEach(async () => {
    await provider?.close();
    provider = undefined;
    if (root !== undefined) {
        rmSync(root, { recursive: true, force: true });
        root = undefined;
    }
});

describe('pre-candidate inventory batch', () => {
    it('accepts a reply that adds notes beside the requested fields', async () => {
        // A model annotates its reply and its instances on every attempt; the inventory reads
        // nothing from the notes, so refusing them would only cost the batch.
        const reply = {
            coverageObserved: true,
            coverageObserved_note: 'The tile was readable.',
            reporterSymptomPresence: ReporterSymptomPresence.Present,
            symptomScope: 'The empty ad gap above the article.',
            instances: [
                {
                    artifactId: 'tile-1',
                    landmark: 'Above the article.',
                    landmark_note: 'Measured from the header.',
                    description: 'An empty reserved gap where the ad was.',
                },
            ],
            rationale: 'The tile shows the gap.',
            pageObstruction: PageObstruction.None,
        };
        provider = await startHermeticProvider({
            scenario: HermeticScenario.Scripted,
            script: [{ kind: ScriptedReplyKind.Text, text: JSON.stringify(reply) }],
        });
        root = mkdtempSync(join(tmpdir(), 'pre-candidate-batch-'));
        const png = encodePng(4, 4, () => [255, 255, 255]);
        const path = join(root, 'tile-1.png');
        writeFileSync(path, png);

        const output = await inspectInventoryBatch(
            {
                recorder: new TraceRecorder({ runId: 'batch', issueNumber: 1, mode: 'fix' }),
                vision: await createTestVisionClient(provider.baseUrl),
                reporterSymptom: 'An empty ad gap above the article.',
                artifactsDir: root,
            },
            [{ id: 'tile-1', path, bytes: png.length, landmark: 'Tile 1 of 1.' }],
            'one tile',
        );

        expect(output.reporterSymptomPresence).toBe(ReporterSymptomPresence.Present);
        expect(output.instances.map((instance) => instance.artifactId)).toEqual(['tile-1']);
        expect(provider.requests).toHaveLength(1);
    });
});
