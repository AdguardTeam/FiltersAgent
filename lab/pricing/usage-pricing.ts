import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as v from 'valibot';
import { ConfigError } from '../../src/config/config-error';
import { UsageModelRatesSchema, type UsageRatesTable } from '../../src/types/usage-summary';

/**
 * The one loader of the per-model price table a run prices its tokens from. The table is the
 * user's: every provider bills differently, so nothing here knows a price. It lives outside the
 * benchmark tree because every run that reports a cost reads it, not only the benchmark.
 */

/**
 * Environment variable naming the JSON price file. Unset, a run proceeds and its cost is not
 * computed: the usage summary records an empty rate table and a null cost.
 */
export const LLM_PRICING_FILE_VAR = 'LLM_PRICING_FILE';

/**
 * The price file a user supplies: per-million-token USD rates keyed by the model id the provider
 * reports, which is the slug the run configured in `LLM_MODEL` / `LLM_VISION_MODEL`.
 */
const UsagePricingDocumentSchema = v.strictObject({
    /**
     * Free-text note on where the prices came from and when, for whoever reads the file later.
     */
    source: v.optional(v.string()),
    // Strict per model: a misspelled optional rate would otherwise be dropped without a word and
    // the model priced at its fallback rate.
    models: v.pipe(
        v.record(v.pipe(v.string(), v.minLength(1)), v.strictObject(UsageModelRatesSchema.entries)),
        v.check((models) => Object.keys(models).length > 0, 'models must price at least one model'),
    ),
});

/**
 * Load the price table the environment names, or null when it names none.
 *
 * A named file that cannot be read or does not match the format fails the run before it starts: a
 * cost the user asked for and silently did not get is worse than no run.
 *
 * @param env - Environment source supplied by the caller.
 * @param workspaceRoot - Directory a relative path is resolved against.
 * @returns The validated rates table, or null when `LLM_PRICING_FILE` is unset or empty.
 * @throws {ConfigError} When the named file is unreadable or invalid, naming the variable and path.
 */
export function loadUsagePricing(
    env: Record<string, string | undefined>,
    workspaceRoot: string,
): UsageRatesTable | null {
    const configured = env[LLM_PRICING_FILE_VAR]?.trim();
    if (!configured) {
        return null;
    }
    const absolutePath = resolve(workspaceRoot, configured);
    let decoded: unknown;
    try {
        decoded = JSON.parse(readFileSync(absolutePath, 'utf8'));
    } catch (error) {
        throw new ConfigError(
            `${LLM_PRICING_FILE_VAR} names ${absolutePath}, which cannot be read as JSON: ` +
                (error as Error).message,
        );
    }
    const parsed = v.safeParse(UsagePricingDocumentSchema, decoded);
    if (!parsed.success) {
        const problems = parsed.issues
            .map((issue) => `  - ${v.getDotPath(issue) ?? '(root)'}: ${issue.message}`)
            .join('\n');
        throw new ConfigError(
            `${LLM_PRICING_FILE_VAR} names ${absolutePath}, which is not a valid price file:\n` +
                problems,
        );
    }
    return parsed.output.models;
}
