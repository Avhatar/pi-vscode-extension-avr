// Exposes the read-only LSP tool surface to isolated child agents.
//
// Children are otherwise limited to `read`/`grep`/`find`/`ls`, and a turn is
// one provider round-trip — so "where is this symbol used?" costs a child a
// dozen grep-and-read turns to answer badly, when the language server answers
// it exactly in one. That gap was the main reason children exhausted their turn
// budgets, so granting these tools is a budget fix as much as a capability one.
//
// Every tool here is a pure query: it resolves positions and reads source, and
// nothing in this set mutates the workspace. Write-capable and shell tools are
// deliberately absent.
//
// Caveat worth knowing: these tools answer against the VS Code workspace, not
// the child's cwd. A worktree-isolated child therefore sees the parent
// workspace's symbol graph rather than its own uncommitted edits. That is the
// right trade for reconnaissance — the graph is otherwise identical — but it
// means a child cannot use them to verify its own in-progress changes.

import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { ChildToolFactoryRegistry } from '../subagents/child-tools';
import { createLspExtension } from './extension';
import {
    TOOL_CALL_HIERARCHY_INCOMING,
    TOOL_CALL_HIERARCHY_OUTGOING,
    TOOL_DOCUMENT_SYMBOLS,
    TOOL_FIND_IMPLEMENTATIONS,
    TOOL_FIND_REFERENCES,
    TOOL_GOTO_DEFINITION,
    TOOL_HOVER,
    TOOL_TYPE_DEFINITION,
    TOOL_WORKSPACE_SYMBOLS,
} from './types';

/** The LSP tools a child may hold. Listed explicitly rather than derived from
 *  whatever the extension happens to register, so a future write-capable or
 *  side-effecting LSP tool cannot reach children by simply existing. */
export const CHILD_SAFE_LSP_TOOLS: readonly string[] = [
    TOOL_FIND_REFERENCES,
    TOOL_DOCUMENT_SYMBOLS,
    TOOL_GOTO_DEFINITION,
    TOOL_HOVER,
    TOOL_FIND_IMPLEMENTATIONS,
    TOOL_TYPE_DEFINITION,
    TOOL_WORKSPACE_SYMBOLS,
    TOOL_CALL_HIERARCHY_INCOMING,
    TOOL_CALL_HIERARCHY_OUTGOING,
];

/**
 * Registers the child-safe LSP tools with the child tool registry.
 *
 * The definitions are collected by running the existing extension factory
 * against a capture-only API. `registerTool` takes the same `ToolDefinition`
 * shape that child sessions accept as `customTools`, so the parent and child
 * surfaces stay identical by construction — no second copy of nine tool
 * descriptions to keep in sync.
 *
 * Passing `enabled: false` registers nothing, mirroring the parent-side gate on
 * `pi-code.lsp.enabled`. Dispose to revoke when that setting changes.
 */
export function registerLspChildTools(
    registry: ChildToolFactoryRegistry,
    options: { enabled: boolean },
): { dispose(): void } {
    if (!options.enabled) return { dispose() {} };

    const childSafe = new Set(CHILD_SAFE_LSP_TOOLS);
    const registrations = collectLspToolDefinitions()
        .filter((definition) => childSafe.has(definition.name))
        .map((definition) => registry.register({
            name: definition.name,
            source: 'extension',
            // The definitions are stateless queries with no per-child closure,
            // so every child can safely share one instance.
            create: () => definition,
        }));

    return {
        dispose(): void {
            for (const registration of registrations) registration.dispose();
        },
    };
}

function collectLspToolDefinitions(): ToolDefinition[] {
    const collected: ToolDefinition[] = [];
    const capture = {
        registerTool(tool: ToolDefinition) { collected.push(tool); },
    } as unknown as ExtensionAPI;
    createLspExtension({ enabled: true })(capture);
    return collected;
}
