import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { explainPreExecuteRejection } from '../../src/pi/pre-execute-validation';
import { runAgentSession } from '../../src/pi/session-runner';
import { SealKind } from '../../src/pi/seal-types';
import { buildTerminalTool } from '../../src/pi/terminal-tool';
import { toAdvertisedSchema } from '../../src/pi/tool-schema';
import {
    type HermeticProvider,
    HermeticScenario,
    ScriptedReplyKind,
    startHermeticProvider,
} from './hermetic-provider';
import {
    TEST_REASONING_EFFORT,
    TEST_RUN_BUDGETS,
    TEST_RUN_RETRIES,
    createTestPiRuntime,
} from './test-runtime';

const TOOL_NAME = 'submit_choice';
const TOOL_DESCRIPTION = 'Submit the choice.';

/**
 * A strict nested shape: required fields at the root and inside one nested object.
 */
const ChoiceSchema = v.strictObject({
    kind: v.string(),
    capabilities: v.array(v.string()),
    intent: v.strictObject({
        issueType: v.string(),
        confidence: v.number(),
    }),
});
type Choice = v.InferOutput<typeof ChoiceSchema>;

const VALID_CHOICE: Choice = {
    kind: 'extension',
    capabilities: ['navigation'],
    intent: { issueType: 'ads', confidence: 0.9 },
};

let workDir: string;
let provider: HermeticProvider | undefined;

beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'pi-pre-execute-validation-'));
});

afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
});

afterEach(async () => {
    await provider?.close();
    provider = undefined;
});

/**
 * Run one session whose scripted model submits the given payloads in order.
 *
 * @param payloads - The arguments of each scripted call of the terminal tool.
 * @returns The sealed outcome and the text of every tool result the model was sent.
 */
async function submitChoices(payloads: unknown[]) {
    provider = await startHermeticProvider({
        scenario: HermeticScenario.Scripted,
        script: payloads.map((payload) => ({
            kind: ScriptedReplyKind.ToolCall,
            toolName: TOOL_NAME,
            toolArguments: JSON.stringify(payload),
        })),
    });
    const runtime = await createTestPiRuntime({ baseUrl: provider.baseUrl });
    const outcome = await runAgentSession<Choice>({
        runtime,
        systemPrompt: 'You are a test agent. Finish by calling submit_choice.',
        userTask: 'Submit the choice now.',
        nudge: 'Call submit_choice now.',
        terminal: buildTerminalTool<Choice>({
            name: TOOL_NAME,
            description: TOOL_DESCRIPTION,
            schema: ChoiceSchema,
        }),
        budgets: { ...TEST_RUN_BUDGETS },
        retries: { ...TEST_RUN_RETRIES },
        reasoningEffort: TEST_REASONING_EFFORT,
        workDir,
    });
    const toolResults = provider.requests
        .at(-1)!
        .messages.filter((message) => message['role'] === 'tool')
        .map((message) => String(message['content']));
    return { outcome, toolResults };
}

describe('a tool call refused before it executes', () => {
    it('names every missing field by its real path', async () => {
        const { outcome, toolResults } = await submitChoices([
            { intent: { issueType: 'ads' } },
            VALID_CHOICE,
        ]);

        expect(outcome.kind).toBe(SealKind.Terminal);
        expect(toolResults).toHaveLength(1);
        const refusal = toolResults[0]!;
        expect(refusal).toContain(`Validation failed for tool "${TOOL_NAME}":`);
        expect(refusal).toContain('\n  - kind: ');
        expect(refusal).toContain('\n  - capabilities: ');
        expect(refusal).toContain('\n  - intent.confidence: ');
    });

    it('names an unknown root key and does not echo the arguments back', async () => {
        const { toolResults } = await submitChoices([
            { ...VALID_CHOICE, rationale: 'a long free-text explanation' },
            VALID_CHOICE,
        ]);

        const refusal = toolResults[0]!;
        expect(refusal).toContain('\n  - rationale: ');
        expect(refusal).not.toContain('a long free-text explanation');
    });

    it("keeps the library's refusal when the tool's own schema accepts the call", () => {
        const MAX_KIND_CHARS = 3;
        const accepted = { kind: 'extension' };
        const check = (): void =>
            explainPreExecuteRejection({
                toolName: TOOL_NAME,
                description: TOOL_DESCRIPTION,
                // Advertised with a bound the tool's own schema does not have.
                advertisedSchema: toAdvertisedSchema(
                    v.object({ kind: v.pipe(v.string(), v.maxLength(MAX_KIND_CHARS)) }),
                    TOOL_NAME,
                ),
                schema: v.object({ kind: v.string() }),
                args: accepted,
            });

        expect(check).toThrow(`Validation failed for tool "${TOOL_NAME}":`);
        expect(check).toThrow('kind');
    });
});
