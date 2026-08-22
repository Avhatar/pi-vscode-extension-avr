import { describe, expect, it } from 'vitest';
import { CHILD_SAFE_LSP_TOOLS, registerLspChildTools } from '../../../../pi/lsp/child-tools';
import { ChildToolFactoryRegistry } from '../../../../pi/subagents/child-tools';

describe('child-safe LSP tools', () => {
    it('contributes every read-only language-server query to children', () => {
        const registry = new ChildToolFactoryRegistry();

        registerLspChildTools(registry, { enabled: true });

        expect(registry.listNames()).toEqual([...CHILD_SAFE_LSP_TOOLS].sort((a, b) => a.localeCompare(b)));
        expect(registry.listDiagnostics()).toEqual([]);
    });

    it('produces tool definitions children can execute', async () => {
        const registry = new ChildToolFactoryRegistry();
        registerLspChildTools(registry, { enabled: true });

        const tools = await registry.createTools(['find_references'], {
            agentId: 'child-1',
            cwd: '/workspace',
            signal: new AbortController().signal,
            spec: {} as never,
        }) as Array<{ name: string; execute: unknown }>;

        expect(tools).toHaveLength(1);
        expect(tools[0].name).toBe('find_references');
        expect(typeof tools[0].execute).toBe('function');
    });

    it('registers nothing while the language-server setting is off', () => {
        const registry = new ChildToolFactoryRegistry();

        registerLspChildTools(registry, { enabled: false });

        expect(registry.listNames()).toEqual([]);
    });

    it('revokes the grant on dispose so the setting can be turned back off', () => {
        const registry = new ChildToolFactoryRegistry();

        const registration = registerLspChildTools(registry, { enabled: true });
        registration.dispose();

        expect(registry.listNames()).toEqual([]);
    });

    it('never hands children a write-capable or shell tool', () => {
        expect(CHILD_SAFE_LSP_TOOLS).not.toContain('bash');
        expect(CHILD_SAFE_LSP_TOOLS.every((name) => !/rename|apply|edit|write|execute/.test(name))).toBe(true);
    });
});
