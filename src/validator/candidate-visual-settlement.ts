/**
 * Settle the AFTER inventory before the final synthesis: set aside what the page showed without the
 * candidate and blank space an agent DOM check proves is layout, so the synthesis never weighs
 * either against the candidate.
 *
 * Two grounds, in this order. An AFTER flaw or blank space a BEFORE image shows unchanged is the
 * page's own (`candidate-visual-attribution`); blank space where BEFORE showed the symptom never
 * takes that ground, since it is what the candidate had to clear. Blank space left open may still
 * be layout a DOM check proves (`candidate-visual-dom-adjudication`). Only blank space and flaws
 * are ever set aside: visible advertising, an ad label or a frame stays the synthesis's to judge.
 * An incorrect-blocking review settles flaws only, because there an empty panel is the defect.
 */
import type { CallLimiter } from '../pi/call-limiter';
import { TraceEventType } from '../types/trace';
import {
    CandidateVisualSettlementGround,
    type CandidateVisualSettledDamage,
    type CandidateVisualSettledObservation,
    type CandidateVisualSettlement,
} from '../types/candidate-visual-settlement';
import {
    CandidateVisualInstanceFootprint,
    type CandidateVisualInventoryInstance,
} from '../types/candidate-visual-instance';
import type { CandidateVisualVerifierOptions } from './candidate-visual-evidence';
import type { CandidateVisualTileInventory } from './candidate-visual-context';
import { attributeAfterItems } from './candidate-visual-attribution';
import { AttributionItemKind, type AttributionItem } from './candidate-visual-attribution-request';
import { adjudicateDomChecks } from './candidate-visual-dom-adjudication';
import { SymptomKind, isBreakageSymptom } from './symptom-rubric';

/**
 * The AFTER inventory the synthesis reconciles, and what was set aside from it.
 */
export interface SettledAfterInventory {
    /**
     * The AFTER inventory without the settled instances and flaws.
     */
    after: CandidateVisualTileInventory;

    /**
     * Every settled instance and flaw with its ground.
     */
    settlement: CandidateVisualSettlement;
}

/**
 * Key of one AFTER instance.
 *
 * @param index - Zero-based position in the AFTER inventory.
 * @returns The key.
 */
function instanceKey(index: number): string {
    return `instance:${index}`;
}

/**
 * Key of one AFTER flaw.
 *
 * @param observationIndex - Zero-based position of the request that reported it.
 * @param entryIndex - Zero-based position in that request's damage.
 * @returns The key.
 */
function damageKey(observationIndex: number, entryIndex: number): string {
    return `damage:${observationIndex}:${entryIndex}`;
}

/**
 * Rebuild the AFTER inventory without the settled entries, keeping every request's counts true.
 *
 * Instances are stored flat in request order, each request owning the next `instanceCount` of them,
 * so the counts are recomputed request by request.
 *
 * @param after - The complete AFTER inventory.
 * @param settled - Keys of the settled instances and flaws.
 * @returns The inventory the synthesis reconciles.
 */
function withoutSettled(
    after: CandidateVisualTileInventory,
    settled: ReadonlySet<string>,
): CandidateVisualTileInventory {
    const instances: CandidateVisualInventoryInstance[] = [];
    let cursor = 0;
    const observations = after.observations.map((observation, observationIndex) => {
        const start = cursor;
        const kept = after.instances
            .slice(start, start + observation.instanceCount)
            .filter((_, offset) => !settled.has(instanceKey(start + offset)));
        cursor += observation.instanceCount;
        instances.push(...kept);
        return {
            ...observation,
            instanceCount: kept.length,
            observedDamage: observation.observedDamage.filter(
                (_, entryIndex) => !settled.has(damageKey(observationIndex, entryIndex)),
            ),
        };
    });
    return {
        coverageObserved: after.coverageObserved,
        citationDropped: after.citationDropped,
        instances,
        observations,
    };
}

/**
 * Set aside every AFTER flaw and blank space the BEFORE state shows unchanged, then every blank
 * space an agent DOM check proves is layout.
 *
 * @param options - Review options providing evidence, checks, model and trace.
 * @param before - The complete BEFORE inventory.
 * @param after - The complete AFTER inventory.
 * @param limiter - The review's call limiter.
 * @returns The AFTER inventory to reconcile and what was set aside.
 */
export async function settleAfterInventory(
    options: CandidateVisualVerifierOptions,
    before: CandidateVisualTileInventory,
    after: CandidateVisualTileInventory,
    limiter: CallLimiter,
): Promise<SettledAfterInventory> {
    const adsReview = !isBreakageSymptom(options.symptomKind ?? SymptomKind.Ads);
    const blankSpace = adsReview
        ? after.instances
              .map((instance, index) => ({ instance, key: instanceKey(index) }))
              .filter(
                  ({ instance }) =>
                      instance.footprint === CandidateVisualInstanceFootprint.BlankSpace,
              )
        : [];
    const flaws = after.observations.flatMap((observation, observationIndex) =>
        observation.observedDamage.map((entry, entryIndex) => ({
            entry,
            artifactId: entry.artifactId,
            key: damageKey(observationIndex, entryIndex),
        })),
    );
    const items: AttributionItem[] = [
        ...flaws.map(({ entry, artifactId, key }) => ({
            kind: AttributionItemKind.Flaw,
            key,
            artifactId,
            text: entry.description,
        })),
        ...blankSpace.map(({ instance, key }) => ({
            kind: AttributionItemKind.BlankSpace,
            key,
            artifactId: instance.artifactId,
            text: `${instance.landmark} — ${instance.description}`,
        })),
    ];
    const matches = await attributeAfterItems(options, items, before.instances, limiter);
    const proofs = await adjudicateDomChecks(
        options,
        blankSpace.filter(({ key }) => !matches.has(key)),
        before.instances,
    );

    const settled = new Set<string>();
    const observations: CandidateVisualSettledObservation[] = [];
    for (const { instance, key } of blankSpace) {
        const { footprint: _footprint, ...persisted } = instance;
        const match = matches.get(key);
        const proof = proofs.get(key);
        if (match !== undefined) {
            settled.add(key);
            observations.push({
                ground: CandidateVisualSettlementGround.UnchangedBefore,
                instance: persisted,
                beforeArtifactId: match.beforeArtifactId,
                rationale: match.rationale,
            });
        } else if (proof !== undefined) {
            settled.add(key);
            observations.push({
                ground: CandidateVisualSettlementGround.DomCheckLayout,
                instance: persisted,
                domCheckIndex: proof.domCheckIndex,
                holder: proof.holder,
                rationale: proof.rationale,
            });
        }
    }
    const damage: CandidateVisualSettledDamage[] = [];
    for (const { entry, artifactId, key } of flaws) {
        const match = matches.get(key);
        if (match !== undefined) {
            settled.add(key);
            damage.push({
                artifactId,
                description: entry.description,
                beforeArtifactId: match.beforeArtifactId,
                rationale: match.rationale,
            });
        }
    }
    options.recorder.record(TraceEventType.Decision, {
        phase: 'candidate_visual_settlement',
        validationArtifactId: options.validationArtifactId,
        settledUnchangedBefore: observations.filter(
            (item) => item.ground === CandidateVisualSettlementGround.UnchangedBefore,
        ).length,
        settledDomCheckLayout: observations.filter(
            (item) => item.ground === CandidateVisualSettlementGround.DomCheckLayout,
        ).length,
        settledDamage: damage.length,
    });
    return { after: withoutSettled(after, settled), settlement: { observations, damage } };
}

/**
 * Present what the runner set aside from the AFTER inventory, or nothing when it set nothing aside.
 *
 * The batch rationales still describe what was set aside, so the synthesis is told those items are
 * settled rather than left to rediscover them there.
 *
 * @param settlement - What the runner set aside.
 * @returns Context lines for the final text-only request.
 */
export function settlementContext(settlement: CandidateVisualSettlement): string[] {
    if (settlement.observations.length === 0 && settlement.damage.length === 0) {
        return [];
    }
    return [
        'Runner-settled AFTER items, taken out of the AFTER inventory before this synthesis ' +
            'because a BEFORE image shows them unchanged or an agent DOM check proves the blank ' +
            'space is page layout. They are settled: never count them as remaining, residue or ' +
            'damage, whatever a batch rationale says about them.',
        JSON.stringify({
            observations: settlement.observations.map((item) => ({
                ground: item.ground,
                landmark: item.instance.landmark,
                description: item.instance.description,
            })),
            damage: settlement.damage.map((item) => item.description),
        }),
    ];
}
