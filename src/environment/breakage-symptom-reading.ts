import type { StructuralSnapshot } from '../types/validation';
import { ReporterSymptomPresence } from '../types/reporter-symptom-presence';

/**
 * What one phase shows of a breakage symptom: the probe of the candidate's selector and vision's
 * reading of the phase — the single-snapshot inventory for the baselines A and B, the paired
 * before/after review for the candidate phase C.
 */
export interface BreakageSymptomObservation {
    /**
     * Structural probe of the candidate's selector in the phase.
     */
    structure: StructuralSnapshot;

    /**
     * Whether the probe measured a selector derived from the candidate rather than the whole
     * document.
     */
    structureBoundToSelector: boolean;

    /**
     * Vision's reading of the reporter-defined symptom in the phase: the inventory's for A and B,
     * the paired review's for C.
     */
    symptomPresence: ReporterSymptomPresence;
}

/**
 * Decide whether a phase shows a breakage symptom when the probe measured the named element.
 *
 * A breakage symptom is the absence of content, and single-snapshot vision judges it badly: the
 * inventory that reads the baselines recognises the element the reporter named and reports the
 * symptom present in every state, intact or not. There the probe's geometry is the objective answer
 * — hidden means broken, visible means restored — and it decides the candidate phase too, whose
 * reading comes from the paired review instead.
 *
 * Geometry answers only whether the named element renders, though. An anti-adblock wall drawn
 * inside a player iframe leaves the iframe as visible as on the healthy page, so the geometry calls
 * the baseline clean while vision sees the wall. Vision's failure mode never separates the phases,
 * so when the control's inventory calls the unfiltered page clean and this phase's reading — its
 * own inventory for B, the paired review for C — calls it broken, vision saw something the probe
 * cannot measure, and the symptom is present. This only ever turns a clean reading into a broken
 * one: it lets a baseline be judged, and it keeps a candidate unverified when vision still sees the
 * breakage in its phase, however the element renders there; it never verifies one.
 *
 * @param observed - The phase being judged; its probe measured the candidate's selector and found
 *   at least one match.
 * @param control - The unfiltered control phase, when already observed.
 * @returns Whether the phase still shows the reporter-defined symptom.
 */
export function probedBreakageSymptomPresent(
    observed: BreakageSymptomObservation,
    control: BreakageSymptomObservation | undefined,
): boolean {
    if (
        control?.symptomPresence === ReporterSymptomPresence.Absent &&
        observed.symptomPresence === ReporterSymptomPresence.Present
    ) {
        return true;
    }
    // The unfiltered control defines how much of the named content a healthy page renders.
    // Judging visibility absolutely would call a page broken whenever the site itself hides
    // some matches — a state no exception can repair, so no candidate could ever verify.
    const referenceIsComparable =
        control !== undefined &&
        control.structureBoundToSelector &&
        control.structure.probeSucceeded &&
        control.structure.targetCount === observed.structure.targetCount;
    if (referenceIsComparable) {
        return observed.structure.targetVisibleCount < control.structure.targetVisibleCount;
    }
    // Without a comparable control, any match the page does not render is missing content.
    return observed.structure.targetVisibleCount < observed.structure.targetCount;
}
