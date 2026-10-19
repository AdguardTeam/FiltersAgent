import { describe, expect, it } from 'vitest';
import {
    CandidateVisualEvidenceSource,
    MAX_SYMPTOM_SCOPE_CHARS,
    MAX_TILE_INVENTORY_CONTEXT_CHARS,
    SHORTENED_RATIONALE_CHARS,
    TileInventoryContextFit,
    renderTileInventoryContext,
    type CandidateVisualInventoryObservation,
    type CandidateVisualTileInventory,
} from '../../src/validator/candidate-visual-context';
import {
    MAX_OBSERVED_DAMAGE_ENTRIES,
    MAX_OBSERVED_DAMAGE_ENTRY_CHARS,
    MAX_RATIONALE_CHARS,
} from '../../src/validator/candidate-visual-inventory';

/**
 * Observations per state that, at the largest damage and rationale a batch may report, overflow the
 * full context but fit once every rationale is shortened.
 */
const OBSERVATIONS_FITTING_ONLY_SHORTENED = 7;

/**
 * Observations per state that overflow the context even with every rationale shortened.
 */
const OBSERVATIONS_OVERFLOWING_SHORTENED = 18;

/**
 * Parsed shape of one rendered state, as far as these tests read it.
 */
interface RenderedState {
    coverageObserved: boolean;
    instances: Array<{ observationIndex: number; artifactId: string; description: string }>;
    observations: CandidateVisualInventoryObservation[];
}

/**
 * Text repeated to a given length, distinct per label so occurrences can be counted.
 *
 * @param label - Unique opening of the text.
 * @param chars - Exact length of the result.
 * @returns The padded text.
 */
function textOf(label: string, chars: number): string {
    return `${label} `.padEnd(chars, 'x');
}

/**
 * One state inventory whose observations each carry the given rationale and damage sizes.
 *
 * @param state - Prefix that keeps the two states' texts distinct.
 * @param observationCount - Number of batch observations, each citing one instance.
 * @param sizes - Rationale length and damage entries per observation.
 * @param sizes.rationaleChars - Length of every batch rationale.
 * @param sizes.damageEntries - Number of damage entries of every batch.
 * @returns An inventory as the inventory stage merges it.
 */
function stateInventory(
    state: string,
    observationCount: number,
    sizes: { rationaleChars: number; damageEntries: number },
): CandidateVisualTileInventory {
    const observations = Array.from({ length: observationCount }, (_, index) => ({
        source: CandidateVisualEvidenceSource.TileBatch,
        artifactIds: [`${state}-tile-${index + 1}`],
        coverageObserved: true,
        symptomScope: textOf(`${state} scope ${index + 1}`, MAX_SYMPTOM_SCOPE_CHARS),
        instanceCount: 1,
        observedDamage: Array.from({ length: sizes.damageEntries }, (_entry, damageIndex) =>
            textOf(
                `${state} damage ${index + 1}.${damageIndex + 1}`,
                MAX_OBSERVED_DAMAGE_ENTRY_CHARS,
            ),
        ),
        rationale: textOf(`${state} rationale ${index + 1}`, sizes.rationaleChars),
    }));
    return {
        coverageObserved: true,
        instances: observations.map((observation, index) => ({
            artifactId: observation.artifactIds[0] ?? '',
            landmark: `${state} landmark ${index + 1}`,
            description: `${state} advert ${index + 1}`,
        })),
        observations,
    };
}

/**
 * Parse a rendered context back into both states.
 *
 * @param text - The rendered synthesis context.
 * @returns The before and after states it carries.
 */
function parsed(text: string): { before: RenderedState; after: RenderedState } {
    return JSON.parse(text) as { before: RenderedState; after: RenderedState };
}

/**
 * How many times a text occurs in another.
 *
 * @param haystack - Text searched.
 * @param needle - Text counted.
 * @returns Number of non-overlapping occurrences.
 */
function occurrences(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
}

describe('renderTileInventoryContext', () => {
    it('keeps every numbered observation and every batch text when the context fits', () => {
        const before = stateInventory('before', 29, { rationaleChars: 200, damageEntries: 1 });
        const after = stateInventory('after', 3, { rationaleChars: 200, damageEntries: 1 });

        const context = renderTileInventoryContext(before, after);

        expect(context.fit).toBe(TileInventoryContextFit.Complete);
        if (context.fit === TileInventoryContextFit.Overflow) {
            return;
        }
        expect(context.chars).toBe(context.text.length);
        expect(context.limitChars).toBe(MAX_TILE_INVENTORY_CONTEXT_CHARS);
        const rendered = parsed(context.text);
        expect(rendered.before.instances.map((instance) => instance.observationIndex)).toEqual(
            Array.from({ length: 29 }, (_, index) => index + 1),
        );
        expect(rendered.after.instances.map((instance) => instance.observationIndex)).toEqual([
            1, 2, 3,
        ]);
        expect(rendered.before.observations).toEqual(before.observations);
        expect(rendered.after.observations).toEqual(after.observations);
    });

    it("sends each batch's scope, damage and rationale once", () => {
        const before = stateInventory('before', 4, { rationaleChars: 200, damageEntries: 2 });
        const after = stateInventory('after', 4, { rationaleChars: 200, damageEntries: 2 });

        const context = renderTileInventoryContext(before, after);

        if (context.fit === TileInventoryContextFit.Overflow) {
            throw new Error('A small inventory must fit the synthesis context.');
        }
        for (const observation of [...before.observations, ...after.observations]) {
            for (const batchText of [
                observation.symptomScope,
                observation.rationale,
                ...observation.observedDamage,
            ]) {
                expect(occurrences(context.text, batchText)).toBe(1);
            }
        }
    });

    it('shortens only batch rationales to the fixed length when the full context exceeds the limit', () => {
        const sizes = {
            rationaleChars: MAX_RATIONALE_CHARS,
            damageEntries: MAX_OBSERVED_DAMAGE_ENTRIES,
        };
        const before = stateInventory('before', OBSERVATIONS_FITTING_ONLY_SHORTENED, sizes);
        const after = stateInventory('after', OBSERVATIONS_FITTING_ONLY_SHORTENED, sizes);

        const context = renderTileInventoryContext(before, after);

        expect(context.fit).toBe(TileInventoryContextFit.RationalesShortened);
        if (context.fit === TileInventoryContextFit.Overflow) {
            return;
        }
        expect(context.chars).toBeLessThanOrEqual(context.limitChars);
        const rendered = parsed(context.text);
        const states = [
            { original: before, shown: rendered.before },
            { original: after, shown: rendered.after },
        ];
        for (const { original, shown } of states) {
            expect(shown.instances).toHaveLength(original.instances.length);
            shown.observations.forEach((observation, index) => {
                const source = original.observations[index];
                expect(observation.rationale.length).toBeLessThanOrEqual(SHORTENED_RATIONALE_CHARS);
                expect(source?.rationale.startsWith(observation.rationale)).toBe(true);
                expect({ ...observation, rationale: source?.rationale }).toEqual(source);
            });
        }
    });

    it('refuses a context that does not fit even with shortened rationales', () => {
        const sizes = {
            rationaleChars: MAX_RATIONALE_CHARS,
            damageEntries: MAX_OBSERVED_DAMAGE_ENTRIES,
        };
        const before = stateInventory('before', OBSERVATIONS_OVERFLOWING_SHORTENED, sizes);
        const after = stateInventory('after', OBSERVATIONS_OVERFLOWING_SHORTENED, sizes);

        const context = renderTileInventoryContext(before, after);

        expect(context.fit).toBe(TileInventoryContextFit.Overflow);
        expect(context.chars).toBeGreaterThan(context.limitChars);
        expect(context.limitChars).toBe(MAX_TILE_INVENTORY_CONTEXT_CHARS);
        expect(context).not.toHaveProperty('text');
    });
});
