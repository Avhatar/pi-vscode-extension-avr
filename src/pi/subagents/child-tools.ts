import type { ResolvedAgentSpec } from './types';

export type ChildToolSource = 'extension' | 'mcp';

export interface ChildToolFactoryContext {
    agentId: string;
    cwd: string;
    signal: AbortSignal;
    spec: ResolvedAgentSpec;
}

/**
 * Explicit host-owned capability contract for tools that may enter an isolated
 * child session. Merely being registered in the parent does not make a tool
 * child-safe. Factories receive no model registry, auth storage, parent
 * session, or secrets unless their host-owned closure intentionally supplies
 * a narrower service.
 */
export interface ChildSafeToolFactory {
    name: string;
    source: ChildToolSource;
    create(context: ChildToolFactoryContext): unknown | Promise<unknown>;
}

export interface ChildToolFactoryDiagnostic {
    code: 'invalid-name' | 'duplicate-name';
    name: string;
    message: string;
}

const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class ChildToolFactoryRegistry {
    private readonly factories = new Map<string, ChildSafeToolFactory>();
    private readonly diagnostics: ChildToolFactoryDiagnostic[] = [];

    register(factory: ChildSafeToolFactory): { dispose(): void } {
        const name = factory.name?.trim();
        if (!TOOL_NAME.test(name)) {
            const diagnostic: ChildToolFactoryDiagnostic = {
                code: 'invalid-name', name,
                message: `Child-safe ${factory.source} tool has an invalid name: ${name || '(empty)'}.`,
            };
            this.diagnostics.push(diagnostic);
            return { dispose() {} };
        }
        if (this.factories.has(name)) {
            const diagnostic: ChildToolFactoryDiagnostic = {
                code: 'duplicate-name', name,
                message: `Child-safe tool factory "${name}" is already registered; the duplicate was ignored.`,
            };
            this.diagnostics.push(diagnostic);
            return { dispose() {} };
        }
        this.factories.set(name, factory);
        return { dispose: () => { if (this.factories.get(name) === factory) this.factories.delete(name); } };
    }

    listNames(): string[] {
        return [...this.factories.keys()].sort((left, right) => left.localeCompare(right));
    }

    listDiagnostics(): ChildToolFactoryDiagnostic[] {
        return this.diagnostics.map((diagnostic) => ({ ...diagnostic }));
    }

    async createTools(names: Iterable<string>, context: ChildToolFactoryContext): Promise<unknown[]> {
        const tools: unknown[] = [];
        for (const name of new Set(names)) {
            const factory = this.factories.get(name);
            if (factory) tools.push(await factory.create(context));
        }
        return tools;
    }
}

/** Register an MCP tool only after the host has explicitly classified its
 * server/tool pair as safe for child execution. Project MCP discovery alone
 * never calls this function and therefore grants nothing. */
export function registerChildSafeMcpTool(
    registry: ChildToolFactoryRegistry,
    server: string,
    tool: string,
    create: ChildSafeToolFactory['create'],
): { name: string; dispose(): void } {
    const normalize = (value: string) => value.trim().replace(/-/g, '_');
    const name = `${normalize(server)}_${normalize(tool)}`;
    const registration = registry.register({ name, source: 'mcp', create });
    return { name, dispose: () => registration.dispose() };
}
