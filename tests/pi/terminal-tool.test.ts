import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import {
    buildTerminalTool,
    DEFAULT_MAX_TERMINAL_REJECTIONS,
    TERMINAL_REJECTION_TOTAL_MULTIPLE,
    TerminalSettlement,
    type TerminalToolController,
    type TerminalToolOptions,
} from '../../src/pi/terminal-tool';
import { RejectionCap } from '../../src/pi/seal-types';

const VerdictSchema = v.object({
    verdict: v.picklist(['ok', 'retry']),
    summary: v.string(),
});
type Verdict = v.InferOutput<typeof VerdictSchema>;

const VALID_PAYLOAD: Verdict = { verdict: 'ok', summary: 'done' };

/**
 * Build the verdict terminal tool under test, with optional host hook / cap overrides.
 *
 * @param overrides - Host hook and rejection cap overrides.
 * @returns The terminal tool controller.
 */
function buildVerdictTool(overrides: Partial<TerminalToolOptions<Verdict>> = {}) {
    return buildTerminalTool<Verdict>({
        name: 'submit_verdict',
        description: 'Submit the final verdict.',
        schema: VerdictSchema,
        validateHost: overrides.validateHost,
        maxRejections: overrides.maxRejections,
    });
}

/**
 * Submit one payload the way the session does: execute it, and feed the error result back through
 * the observation channel the runner wires from pi's `tool_execution_end` events. (In a live
 * session a schema-invalid payload would be bounced by pi's pre-`execute` validation and never
 * reach `execute`, but it still arrives at `observeRejection` as an error result — counting is
 * identical either way, which is exactly the point of the observation channel.)
 *
 * @param controller - The terminal tool controller under test.
 * @param args - The raw submitted arguments.
 * @returns The thrown error message when the submission was rejected, otherwise undefined.
 */
async function submit(controller: TerminalToolController<Verdict>, args: unknown) {
    const error = await controller.tool.execute(args, undefined).catch((caught: unknown) => caught);
    if (error instanceof Error) {
        controller.observeRejection(error.message);
        return error.message;
    }
    return undefined;
}

describe('buildTerminalTool', () => {
    it('declares itself sequential so two submissions in one batch never interleave', () => {
        // The pending-fingerprint slot between execute and its observation holds one call; pi
        // honours this flag by running the tool one call at a time.
        expect(buildVerdictTool().tool.executionMode).toBe('sequential');
    });

    it('accepts a valid payload and settles accepted with it', async () => {
        const terminal = buildVerdictTool();

        const result = await terminal.tool.execute(VALID_PAYLOAD, undefined);

        expect(result.details).toEqual({ payload: VALID_PAYLOAD });
        expect(terminal.accepted()).toEqual(VALID_PAYLOAD);
        expect(terminal.rejections()).toBe(0);
        await expect(terminal.settled).resolves.toEqual({
            kind: TerminalSettlement.Accepted,
            payload: VALID_PAYLOAD,
        });
    });

    it('rejects an invalid payload with the validation reasons and counts it once via observation', async () => {
        const terminal = buildVerdictTool();

        const message = await submit(terminal, { verdict: 'maybe', summary: 1 });

        expect(message).toContain('submit_verdict: invalid payload');
        expect(message).toContain('verdict');
        expect(terminal.rejections()).toBe(1);
        expect(terminal.repeatedRejections()).toBe(1);
        expect(terminal.lastReason()).toContain('verdict');
        expect(terminal.accepted()).toBeUndefined();
    });

    it('passes host-hook rejection reasons through and still accepts a corrected submission', async () => {
        const terminal = buildVerdictTool({
            validateHost: (payload) =>
                payload.summary === 'stale' ? { reason: 'evidence is stale' } : undefined,
        });

        const message = await submit(terminal, { verdict: 'ok', summary: 'stale' });

        expect(message).toContain('evidence is stale');
        expect(terminal.rejections()).toBe(1);

        await terminal.tool.execute({ verdict: 'ok', summary: 'fresh' }, undefined);
        await expect(terminal.settled).resolves.toEqual({
            kind: TerminalSettlement.Accepted,
            payload: { verdict: 'ok', summary: 'fresh' },
        });
    });

    it('settles capped with the last reason when the observation channel reaches the cap', async () => {
        const terminal = buildVerdictTool({ maxRejections: 2 });

        await submit(terminal, {});
        await submit(terminal, { still: 'wrong' });

        const settlement = await terminal.settled;
        expect(settlement.kind).toBe(TerminalSettlement.Capped);
        if (settlement.kind !== TerminalSettlement.Capped) {
            return;
        }
        expect(settlement.lastReason).toContain('invalid payload');
        // Which bound tripped travels with the settlement: an operator reading the seal is told
        // the model repeated one reason, not that "one of two budgets" ran out.
        expect(settlement.cappedBy).toBe(RejectionCap.Streak);
        expect(terminal.rejections()).toBe(2);
        expect(terminal.repeatedRejections()).toBe(2);
    });

    it('restarts the budget when the rejection reason changes', async () => {
        // A model that cannot count characters shortens its summary on every retry and hits a new
        // reason each time: it is converging, not stuck, and sealing the run there throws away a
        // healthy investigation.
        const terminal = buildVerdictTool({ maxRejections: 2 });

        await submit(terminal, { verdict: 'ok' });
        await submit(terminal, { verdict: 'ok', summary: 1 });
        await submit(terminal, { verdict: 'nope', summary: 'fine' });

        // The cap reads the same-reason streak, which every new reason restarts...
        expect(terminal.repeatedRejections()).toBe(1);
        // ...while the reported total keeps every rejection the run actually made. Reporting the
        // streak as the total made a run that failed three different ways claim one rejection.
        expect(terminal.rejections()).toBe(3);
        // Not sealed: a converging model keeps its turn.
        await submit(terminal, VALID_PAYLOAD);
        expect(terminal.accepted()).toEqual(VALID_PAYLOAD);
        const settlement = await terminal.settled;
        expect(settlement.kind).toBe(TerminalSettlement.Accepted);
    });

    it('keys the streak on the host fingerprint, not the reason text, when the host gives one', async () => {
        // Contract: a rejection reworded between two submissions is still the same wall when the
        // host says the evidence did not move, and the same words are a new wall when it did. The
        // live loop this protects: identical prose over three submissions while the model launched
        // fresh sessions in between.
        let progress = 0;
        const terminal = buildVerdictTool({
            maxRejections: 2,
            validateHost: (payload) =>
                payload.summary === 'done'
                    ? undefined
                    : {
                          reason: `attempt ${payload.summary}: evidence incomplete`,
                          fingerprint: `progress:${progress}`,
                      },
        });

        await submit(terminal, { verdict: 'ok', summary: 'first' });
        progress += 1;
        await submit(terminal, { verdict: 'ok', summary: 'second' });
        // Different progress, different prose: the streak restarted.
        expect(terminal.repeatedRejections()).toBe(1);
        expect(terminal.rejections()).toBe(2);

        await submit(terminal, { verdict: 'ok', summary: 'third' });
        // Same progress as the previous rejection, different prose: the streak built and capped.
        const settlement = await terminal.settled;
        expect(settlement.kind).toBe(TerminalSettlement.Capped);
        if (settlement.kind !== TerminalSettlement.Capped) {
            return;
        }
        expect(settlement.cappedBy).toBe(RejectionCap.Streak);
        expect(settlement.lastReason).toContain('attempt third');
    });

    it('seals a model alternating between two walls at the total ceiling', async () => {
        // Alternating reasons never build a streak, so the streak cap alone never fires: the run
        // used to flail until the turn budget ran out and sealed as budget-exceeded, an outcome
        // that carries neither the rejection count nor the last reason an operator needs.
        const maxRejections = 2;
        const terminal = buildVerdictTool({ maxRejections });
        const ceiling = maxRejections * TERMINAL_REJECTION_TOTAL_MULTIPLE;

        const reasons: (string | undefined)[] = [];
        for (let attempt = 0; attempt < ceiling; attempt += 1) {
            reasons.push(
                await submit(terminal, attempt % 2 === 0 ? { verdict: 'nope' } : { summary: 1 }),
            );
        }

        // Never more than one repeat in a row, so only the total ceiling can have sealed this.
        expect(terminal.repeatedRejections()).toBeLessThan(maxRejections);
        expect(terminal.rejections()).toBe(ceiling);
        const settlement = await terminal.settled;
        expect(settlement.kind).toBe(TerminalSettlement.Capped);
        if (settlement.kind !== TerminalSettlement.Capped) {
            return;
        }
        expect(settlement.lastReason).toBe(reasons[ceiling - 1]);
        expect(settlement.cappedBy).toBe(RejectionCap.Total);
    });

    it('caps at DEFAULT_MAX_TERMINAL_REJECTIONS when no cap is given', async () => {
        const terminal = buildVerdictTool();

        for (let attempt = 0; attempt < DEFAULT_MAX_TERMINAL_REJECTIONS; attempt++) {
            await submit(terminal, {});
        }

        const settlement = await terminal.settled;
        expect(settlement.kind).toBe(TerminalSettlement.Capped);
        expect(terminal.rejections()).toBe(DEFAULT_MAX_TERMINAL_REJECTIONS);
        expect(terminal.repeatedRejections()).toBe(DEFAULT_MAX_TERMINAL_REJECTIONS);
    });

    it('refuses submissions after acceptance without counting or re-settling', async () => {
        const terminal = buildVerdictTool();
        await terminal.tool.execute(VALID_PAYLOAD, undefined);

        const message = await submit(terminal, VALID_PAYLOAD);

        expect(message).toContain('already accepted');
        expect(terminal.rejections()).toBe(0);
        expect(terminal.repeatedRejections()).toBe(0);
        await expect(terminal.settled).resolves.toEqual({
            kind: TerminalSettlement.Accepted,
            payload: VALID_PAYLOAD,
        });
    });
});
