import { validateToolArguments } from '@earendil-works/pi-ai';
import * as v from 'valibot';
import { formatIssuePath } from './valibot-issues';

/**
 * The error text of a tool call that is refused before it executes.
 *
 * Pi checks the arguments against the advertised JSON schema before a tool runs, and words a
 * refusal itself. For a missing property it prints the FIRST missing name as the path, so two
 * missing root fields read as one object lacking both. The tool's own Valibot schema knows the real
 * path of every problem, so this module runs pi's check ahead of pi and, when both schemas refuse
 * the call, words the refusal from the Valibot issues instead.
 *
 * Pi's own text stays in two cases: the Valibot schema accepts what pi refuses, and the arguments
 * are not an object at all. The second matters for the terminal tool, which counts repeated
 * rejections by the equality of their reason: every non-object payload keeps one reason there.
 */

/**
 * Identifier of the tool call handed to pi's validation. pi reads only the arguments from it.
 */
const DRY_RUN_TOOL_CALL_ID = 'pre-execute-validation';

/**
 * Path printed for an issue about the argument object itself, the name pi uses for the same place.
 */
const ROOT_ISSUE_PATH = 'root';

/**
 * Valibot's name for a path item that points at an object key instead of its value.
 */
const KEY_ISSUE_ORIGIN = 'key';

/**
 * One tool call checked before execution.
 */
export interface PreExecuteCall {
    /**
     * Name of the tool, printed in the refusal.
     */
    toolName: string;
    /**
     * Description of the tool, as registered with pi.
     */
    description: string;
    /**
     * JSON schema advertised to the model, the one pi validates against.
     */
    advertisedSchema: Record<string, unknown>;
    /**
     * The tool's own Valibot schema, whose issues name the real paths.
     */
    schema: v.GenericSchema;
    /**
     * Arguments of the call after JSON-text arguments were unwrapped.
     */
    args: unknown;
}

/**
 * Throw the model-facing error of a call pi would refuse; do nothing for a call pi accepts.
 *
 * @param call - The tool, both of its schemas and the prepared arguments.
 * @returns Nothing when pi accepts the arguments.
 * @throws The Valibot wording when both schemas refuse an object; otherwise pi's own error.
 */
export function explainPreExecuteRejection(call: PreExecuteCall): void {
    try {
        validateToolArguments(
            {
                name: call.toolName,
                description: call.description,
                parameters: call.advertisedSchema as Parameters<
                    typeof validateToolArguments
                >[0]['parameters'],
            },
            {
                type: 'toolCall',
                id: DRY_RUN_TOOL_CALL_ID,
                name: call.toolName,
                arguments: call.args as Record<string, unknown>,
            },
        );
    } catch (libraryError) {
        if (!isArgumentObject(call.args)) {
            throw libraryError;
        }
        const parsed = v.safeParse(call.schema, call.args);
        if (parsed.success) {
            throw libraryError;
        }
        const lines = parsed.issues.map(
            (issue) => `  - ${formatIssuePath(issue) || ROOT_ISSUE_PATH}: ${describeIssue(issue)}`,
        );
        throw new Error(`Validation failed for tool "${call.toolName}":\n${lines.join('\n')}`, {
            cause: libraryError,
        });
    }
}

/**
 * Tell whether the arguments are a JSON object, the only shape the Valibot issues describe well.
 *
 * @param args - The prepared arguments of a call.
 * @returns True for an object that is neither null nor an array.
 */
function isArgumentObject(args: unknown): boolean {
    return typeof args === 'object' && args !== null && !Array.isArray(args);
}

/**
 * Word one Valibot issue without the value the model sent.
 *
 * Valibot ends its message with the received value. For a missing or unknown key that value is the
 * key itself or `undefined`, and the line needs it. For every other issue it is payload text: it
 * would make two submissions that fail the same check read as two different reasons, and it would
 * copy the payload into the recorded reason.
 *
 * @param issue - One validation issue emitted by Valibot.
 * @returns The message, with the received value removed unless the issue is about a key.
 */
function describeIssue(issue: v.BaseIssue<unknown>): string {
    if (issue.path?.at(-1)?.origin === KEY_ISSUE_ORIGIN) {
        return issue.message;
    }
    const received = ` but received ${issue.received}`;
    return issue.message.endsWith(received)
        ? issue.message.slice(0, -received.length)
        : issue.message;
}
