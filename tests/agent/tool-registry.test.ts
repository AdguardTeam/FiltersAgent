import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../src/agent/tool-registry';

describe('ToolRegistry', () => {
    it('register stores a tool and getDefinitions returns it', () => {
        const registry = new ToolRegistry();
        registry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'test_tool',
                    description: 'A test tool',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async (args) => ({ ok: true, args }),
        });

        const defs = registry.getDefinitions();
        expect(defs).toHaveLength(1);
        expect(defs[0].function.name).toBe('test_tool');
    });

    it('dispatch calls the handler with parsed args and returns the result', async () => {
        const registry = new ToolRegistry();
        registry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'greet',
                    description: 'Greet someone',
                    parameters: {
                        type: 'object',
                        properties: { name: { type: 'string' } },
                        required: ['name'],
                    },
                },
            },
            handler: async (args) => ({ greeting: `Hello, ${args.name}` }),
        });

        const result = await registry.dispatch('greet', { name: 'World' });
        expect(result).toEqual({ greeting: 'Hello, World' });
    });

    it('dispatch throws when tool name is not registered', async () => {
        const registry = new ToolRegistry();
        await expect(() => registry.dispatch('unknown', {})).rejects.toThrow(
            'Tool not found: unknown',
        );
    });

    it('returns a fresh definition snapshot after tools are registered at runtime', () => {
        const registry = new ToolRegistry();
        const before = registry.getDefinitions();

        registry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'runtime_tool',
                    description: 'Registered after the first snapshot',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async () => ({ ok: true }),
        });

        expect(before).toEqual([]);
        expect(registry.getDefinitions().map((definition) => definition.function.name)).toEqual([
            'runtime_tool',
        ]);
    });

    it('reports the live tool names and their registered parameters across a lifecycle change', () => {
        const registry = new ToolRegistry();
        registry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'always_there',
                    description: 'Registered for the whole run',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async () => ({ ok: true }),
        });
        registry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'session_bound',
                    description: 'Bound to one browser session',
                    parameters: {
                        type: 'object',
                        properties: { url: { type: 'string' } },
                        required: ['url'],
                    },
                },
            },
            handler: async () => ({ ok: true }),
        });

        expect(registry.getToolNames()).toEqual(['always_there', 'session_bound']);
        expect(registry.getRegisteredTools()).toEqual([
            { name: 'always_there', parameters: { type: 'object', properties: {} } },
            {
                name: 'session_bound',
                parameters: {
                    type: 'object',
                    properties: { url: { type: 'string' } },
                    required: ['url'],
                },
            },
        ]);

        registry.unregister('session_bound');

        expect(registry.getToolNames()).toEqual(['always_there']);
        expect(registry.getRegisteredTools().map((tool) => tool.name)).toEqual(['always_there']);
    });

    it('removes a dynamic tool from subsequent definition snapshots', () => {
        const registry = new ToolRegistry();
        registry.register({
            definition: {
                type: 'function',
                function: {
                    name: 'browser_tool',
                    description: 'Bound to one browser session',
                    parameters: { type: 'object', properties: {} },
                },
            },
            handler: async () => ({ ok: true }),
        });

        expect(registry.unregister('browser_tool')).toBe(true);
        expect(registry.unregister('browser_tool')).toBe(false);
        expect(registry.getDefinitions()).toEqual([]);
    });
});
