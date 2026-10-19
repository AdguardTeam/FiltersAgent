import { pino } from 'pino';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { createToolRegistry } from '../../src/agent/tool-factory';
import type { IBrowserSession } from '../../src/browser/browser-interfaces';
import type { SiteAnalyzer } from '../../src/analyzer/site-analyzer';
import type { GithubReadConfig } from '../../src/github/fetch-issue';
import { toAdvertisedSchema } from '../../src/pi/tool-schema';
import { FIX_TOOL_PARAMETER_SCHEMAS, TOOL_PARAMETER_SCHEMAS } from '../../src/agent/tool-catalog';
import { TraceRecorder } from '../../src/tracer/trace-recorder';

const GITHUB_CONFIG: GithubReadConfig = {
    owner: 'AdguardTeam',
    repo: 'AdguardFilters',
    token: 'test-token',
};

/**
 * A SingleShotClient stub; this suite never dispatches a vision call.
 */
const visionStub = {
    modelId: 'vision-stub',
    structured: async () => {
        throw new Error('not used by this suite');
    },
    text: async () => {
        throw new Error('not used by this suite');
    },
};

const EXPECTED_ANALYZE_SURFACE = [
    'analyze_screenshot',
    'apply_rule',
    'evaluate_js',
    'fetch_issue',
    'get_console_log',
    'get_detail',
    'get_dom',
    'get_network_log',
    'inspect_ad_slots',
    'inspect_full_page_capture',
    'inspect_page_state',
    'interact_page',
    'launch_browser',
    'lint_rule',
    'lookup_rule_guidance',
    'open_page',
    'report_finding',
    'screenshot',
    'search_rules',
    'select_environment',
    'stabilize_page',
];

/**
 * The frozen fix session surface: every tool name a fix runtime registry may hold at any lifecycle
 * point, plus the gate-refusing stub names that must stay advertised when the registry lacks them.
 * The exact 26-name set including finish_fix is pinned by the fix-session test; this list is the
 * schema-map boundary contract only.
 */
const FIX_SESSION_SURFACE = [
    'fetch_issue',
    'select_environment',
    'update_observed_intent',
    'get_detail',
    'lookup_rule_guidance',
    'report_missing_information',
    'search_rules',
    'lint_rule',
    'analyze_screenshot',
    'inspect_full_page_capture',
    'launch_browser',
    'close_browser',
    'open_page',
    'screenshot',
    'stabilize_page',
    'get_dom',
    'inspect_ad_slots',
    'get_network_log',
    'get_applied_rules',
    'get_console_log',
    'inspect_page_state',
    'evaluate_js',
    'interact_page',
    'report_finding',
    'apply_rule',
];

/**
 * The one shared-catalog entry outside the analyze surface: the application session's declared
 * write tool. The application tool set builds its inputs directly, so the name appears in no
 * registry definition and in no other surface map.
 */
const APPLICATION_ONLY_SURFACE = ['send_extension_message'];

/**
 * Browser tools registered only for a session that carries a filtering engine's applied-rules log,
 * which only the fix runtime binds.
 */
const FIX_ONLY_BROWSER_SURFACE = ['get_applied_rules'];

describe('TOOL_PARAMETER_SCHEMAS', () => {
    let tmpDir: string | undefined;

    afterEach(() => {
        if (tmpDir !== undefined) {
            rmSync(tmpDir, { recursive: true, force: true });
        }
        tmpDir = undefined;
    });

    it('covers the analyze tool surface plus the application-only and fix-only tools', async () => {
        expect(Object.keys(TOOL_PARAMETER_SCHEMAS).sort()).toEqual(
            [
                ...EXPECTED_ANALYZE_SURFACE,
                ...APPLICATION_ONLY_SURFACE,
                ...FIX_ONLY_BROWSER_SURFACE,
            ].sort(),
        );

        tmpDir = mkdtempSync(join(tmpdir(), 'pi-tool-parameters-'));
        mkdirSync(join(tmpDir, 'BaseFilter', 'sections'), { recursive: true });
        writeFileSync(join(tmpDir, 'BaseFilter', 'sections', 'foreign.txt'), 'example.com##.ad\n');
        const registry = await createToolRegistry({
            githubConfig: GITHUB_CONFIG,
            allowedIssueNumber: 1,
            checkoutPath: tmpDir,
            browserTools: {
                session: {} as IBrowserSession,
                analyzer: {} as SiteAnalyzer,
                artifactsDir: tmpDir,
                logger: pino({ level: 'silent' }),
                recorder: new TraceRecorder({
                    runId: 'tool-parameters',
                    issueNumber: 1,
                    mode: 'fix',
                }),
                allowedOrigin: 'https://example.org',
                vision: visionStub,
            },
        });

        for (const definition of registry.getDefinitions()) {
            expect(
                TOOL_PARAMETER_SCHEMAS[definition.function.name],
                definition.function.name,
            ).toBeDefined();
        }
    });

    it('converts every schema through the pi tool-schema mapper', () => {
        for (const [name, schema] of Object.entries(TOOL_PARAMETER_SCHEMAS)) {
            expect(() => toAdvertisedSchema(schema, name), name).not.toThrow();
        }
    });

    it('preserves the required/optional wire shape', () => {
        const fetchIssue = toAdvertisedSchema(
            TOOL_PARAMETER_SCHEMAS['fetch_issue'],
            'fetch_issue',
        ) as {
            required?: string[];
        };
        expect(fetchIssue.required).toEqual(['issueNumber']);
        const searchRules = toAdvertisedSchema(
            TOOL_PARAMETER_SCHEMAS['search_rules'],
            'search_rules',
        ) as {
            required?: string[];
        };
        expect(searchRules.required ?? []).toEqual([]);
    });

    it('keeps the widened stub schemas optional and convertible', () => {
        for (const name of [
            'select_environment',
            'lookup_rule_guidance',
            'launch_browser',
            'inspect_full_page_capture',
        ]) {
            const schema = TOOL_PARAMETER_SCHEMAS[name];
            expect(schema, name).toBeDefined();
            expect(() => toAdvertisedSchema(schema!, name), name).not.toThrow();
            // Every stub property is optional (nothing executes; a plausible call must reach
            // the gate refusal, not pi's pre-execute validation).
            const converted = toAdvertisedSchema(schema!, name) as { required?: string[] };
            expect(converted.required ?? [], name).toEqual([]);
        }
    });

    it('covers the whole fix surface through the strict fix-real map', () => {
        for (const name of FIX_SESSION_SURFACE) {
            const schema = FIX_TOOL_PARAMETER_SCHEMAS[name] ?? TOOL_PARAMETER_SCHEMAS[name];
            expect(schema, name).toBeDefined();
            expect(() => toAdvertisedSchema(schema!, name), name).not.toThrow();
        }
        // The fix map carries ONLY the strict mirrors; the permissive shared entries stay in
        // TOOL_PARAMETER_SCHEMAS untouched, serving the widened sibling surfaces. The preparation
        // stage's two step tools are fix-family names whose only committed shape lives here.
        expect(Object.keys(FIX_TOOL_PARAMETER_SCHEMAS).sort()).toEqual([
            'analyze_screenshot',
            'close_browser',
            'launch_browser',
            'lookup_rule_guidance',
            'report_missing_information',
            'run_command',
            'select_environment',
            'update_observed_intent',
            'write_file',
        ]);
    });

    it('advertises the registered required fields for the strict fix-real tools', () => {
        const expectedRequired = {
            select_environment: [
                'kind',
                'requiredCapabilities',
                'intent',
                'rationale',
                'confidence',
            ],
            update_observed_intent: [
                'issueType',
                'rationale',
                'confidence',
                'evidence',
                'conflicts',
            ],
            launch_browser: ['extension', 'targetUrl', 'profile'],
            lookup_rule_guidance: ['topic'],
            // The fix runtime's reporter-aware widening: reporter evidence is addressed by
            // issueScreenshotIndex, so only the prompt stays required.
            analyze_screenshot: ['prompt'],
            report_missing_information: ['subject', 'detail'],
        };
        for (const [name, required] of Object.entries(expectedRequired)) {
            const schema = FIX_TOOL_PARAMETER_SCHEMAS[name]!;
            expect(schema, name).toBeDefined();
            const converted = toAdvertisedSchema(schema, name) as { required?: string[] };
            expect(converted.required ?? [], name).toEqual(required);
        }
    });

    it('keeps the missing-information bounds on the wire so the model reads them before calling', () => {
        const converted = toAdvertisedSchema(
            FIX_TOOL_PARAMETER_SCHEMAS['report_missing_information']!,
            'report_missing_information',
        ) as {
            properties: Record<string, { type: string; maxLength?: number }>;
        };
        expect(converted.properties['subject']).toEqual({ type: 'string', maxLength: 200 });
        expect(converted.properties['detail']).toEqual({ type: 'string', maxLength: 2000 });
    });
});

/**
 * Round-trip one converted schema through JSON — the same serialization pi applies when advertising
 * tool parameters on the wire.
 *
 * @param schema - The Valibot schema to convert.
 * @returns The schema as the provider would receive it.
 */
function wireShape(schema: v.GenericSchema): unknown {
    return toAdvertisedSchema(schema, 'wire_shape');
}

describe('toAdvertisedSchema', () => {
    it('advertises object properties, required keys, and picklists', () => {
        const schema = v.object({
            verdict: v.picklist(['ok', 'retry']),
            summary: v.string(),
            note: v.optional(v.string()),
        });

        expect(wireShape(schema)).toEqual({
            type: 'object',
            properties: {
                verdict: { type: 'string', enum: ['ok', 'retry'] },
                summary: { type: 'string' },
                note: { type: 'string' },
            },
            required: ['verdict', 'summary'],
        });
    });

    it('keeps the schema bounds on the wire so pi enforces them before execute', () => {
        // pi compiles the advertisement with TypeBox and checks it natively, so a bound left in
        // the advertisement is a bound the model is machine-checked against instead of having to
        // discover it from a rejection. The bounds come from the catalog schema itself, so they
        // can never be stricter than the adapter's authoritative Valibot re-check.
        const finding = wireShape(TOOL_PARAMETER_SCHEMAS['report_finding']!) as {
            properties: Record<string, unknown>;
        };
        expect(finding.properties['confidence']).toEqual({
            type: 'number',
            minimum: 0,
            maximum: 1,
        });
    });

    it('omits the JSON Schema dialect key the provider never reads', () => {
        // pi forwards `tool.parameters` verbatim into the request body; `$schema` describes the
        // document, not the call.
        expect(wireShape(v.object({ summary: v.string() }))).not.toHaveProperty('$schema');
    });

    it('advertises no additionalProperties for a plain object and false for a strict one', () => {
        // pi pre-validates the raw arguments against this shape BEFORE execute runs. A plain
        // `v.object` STRIPS an unknown key, so advertising `additionalProperties: false` for it
        // would make pi's pre-check reject a payload the authoritative Valibot re-check accepts.
        expect(wireShape(v.object({ summary: v.string() }))).not.toHaveProperty(
            'additionalProperties',
        );
        expect(wireShape(v.strictObject({ summary: v.string() }))).toMatchObject({
            additionalProperties: false,
        });
    });

    it('advertises nested object arrays, nullable fields, and scalar types', () => {
        const schema = v.object({
            findings: v.array(v.object({ title: v.string(), confidence: v.number() })),
            url: v.nullable(v.string()),
            flag: v.boolean(),
            count: v.pipe(v.number(), v.integer()),
        });

        expect(wireShape(schema)).toMatchObject({
            type: 'object',
            properties: {
                findings: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            title: { type: 'string' },
                            confidence: { type: 'number' },
                        },
                        required: ['title', 'confidence'],
                    },
                },
                url: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                flag: { type: 'boolean' },
                count: { type: 'integer' },
            },
            required: ['findings', 'url', 'flag', 'count'],
        });
    });
});
