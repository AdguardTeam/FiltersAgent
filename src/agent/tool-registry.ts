/**
 * One tool as the registry records it.
 *
 * The shape is OpenAI's function-calling envelope, but nothing advertises it to a model. What the
 * model sees is built by the pi session adapters from `TOOL_GUIDANCE` and the catalog's
 * advertisement schemas, so of the three fields only `name` and `parameters` have live readers —
 * see {@link ToolRegistry.getToolNames} and {@link ToolRegistry.getRegisteredTools}.
 */
export interface ToolDefinition {
    /**
     * Discriminator for the tool type.
     */
    type: 'function';

    /**
     * The function schema.
     */
    function: {
        /**
         * The function name the model can call. This is the registry's key.
         */
        name: string;

        /**
         * Human-readable description of what the function does.
         *
         * Retained only because the remaining `getDefinitions()` callers still construct the full
         * envelope; no advertisement path reads it. The model-facing text for every tool lives in
         * `TOOL_GUIDANCE` (`src/agent/tool-catalog.ts`).
         */
        description: string;

        /**
         * JSON Schema describing the function parameters. Read by the fix session's drift check,
         * which refuses to start a run whose advertisement omits a registered parameter.
         *
         * `tool-factory.ts` derives this from the catalog schema, so the two agree there by
         * construction; the check remains because `orchestrator/agent-runtime.ts` still writes its
         * definitions by hand, several of them deliberately wider than the shared catalog entry,
         * and those are the registrations a drift can still appear in.
         */
        parameters: Record<string, unknown>;
    };
}

/**
 * A registered tool as its consumers actually consume it: the dispatch key plus the parameter shape
 * the advertisement is checked against.
 */
export interface RegisteredTool {
    /**
     * The tool name, i.e. the key {@link ToolRegistry.dispatch} resolves.
     */
    name: string;

    /**
     * JSON Schema describing the tool's registered parameters.
     */
    parameters: Record<string, unknown>;
}

/**
 * A check one registration must pass before the registry accepts it.
 *
 * @param tool - The tool being registered: its name and registered parameter shape.
 * @throws When the registration is not admissible for the surface that installed the check.
 */
export type RegistrationGuard = (tool: RegisteredTool) => void;

/**
 * A tool handler registered with the agent loop.
 */
export interface ToolHandler {
    /**
     * The registry's record of the tool: its name, its registered JSON Schema parameters, and an
     * unread description field.
     */
    definition: ToolDefinition;

    /**
     * The function that executes the tool.
     *
     * @param args - The parsed JSON arguments from the LLM's tool call.
     * @returns The tool result as a plain object (serializable to JSON).
     */
    handler: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

/**
 * Registry of tools available to the agent run.
 *
 * It is a name index and a dispatch table, not an advertisement source: the pi session adapters
 * build what the model sees from the catalog, and read this registry only to learn which tools
 * exist right now ({@link getToolNames}) and what parameters they were registered with ({@link
 * getRegisteredTools}). {@link dispatch} then routes an accepted call to its handler.
 */
export class ToolRegistry {
    private readonly tools: Map<string, ToolHandler> = new Map();

    private registrationGuard: RegistrationGuard | undefined;

    /**
     * Register a tool handler.
     *
     * @param handler - The tool definition and its handler function.
     * @throws When an installed {@link RegistrationGuard} refuses the registration.
     */
    register(handler: ToolHandler): void {
        const { name, parameters } = handler.definition.function;
        this.registrationGuard?.({ name, parameters });
        this.tools.set(name, handler);
    }

    /**
     * Install the check every later registration must pass, replacing any previous one.
     *
     * A session's advertisement is decided once, at build time, but the registry keeps changing
     * after that: the environment lifecycle registers the browser tools, and the fix runtime
     * re-registers analyze_screenshot behind a widened definition. Unchecked, a drift introduced by
     * one of those late registrations surfaces as an unwinnable run rather than a startup error.
     * Guarding registration itself moves the failure to the moment the drift appears.
     *
     * @param guard - The check to run before every subsequent registration.
     */
    setRegistrationGuard(guard: RegistrationGuard): void {
        this.registrationGuard = guard;
    }

    /**
     * Remove one dynamically registered tool.
     *
     * @param name - Exact function name to remove.
     * @returns Whether a registered tool was removed.
     */
    unregister(name: string): boolean {
        return this.tools.delete(name);
    }

    /**
     * Return the names of every tool registered right now.
     *
     * This is what almost every caller wants: the browser lifecycle adds and removes tools mid-run,
     * so session wiring and gate synchronization compare successive name snapshots.
     *
     * @returns The registered tool names, in registration order.
     */
    getToolNames(): string[] {
        return Array.from(this.tools.keys());
    }

    /**
     * Return the name and registered parameter shape of every tool registered right now.
     *
     * @returns One entry per registered tool, in registration order.
     */
    getRegisteredTools(): RegisteredTool[] {
        return Array.from(this.tools.values(), (handler) => ({
            name: handler.definition.function.name,
            parameters: handler.definition.function.parameters,
        }));
    }

    /**
     * Return the full recorded envelope of every registered tool.
     *
     * Prefer {@link getToolNames} or {@link getRegisteredTools}: this also returns the unread
     * `description`.
     *
     * @returns The array of `ToolDefinition` objects.
     */
    getDefinitions(): ToolDefinition[] {
        return Array.from(this.tools.values(), (h) => h.definition);
    }

    /**
     * Dispatch a tool call by name with parsed arguments.
     *
     * @param name - The tool name requested by the LLM.
     * @param args - The parsed JSON arguments.
     * @returns The handler's result.
     * @throws If the tool name is not registered.
     */
    async dispatch(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
        const handler = this.tools.get(name);
        if (!handler) {
            throw new Error(`Tool not found: ${name}`);
        }
        return handler.handler(args);
    }
}
