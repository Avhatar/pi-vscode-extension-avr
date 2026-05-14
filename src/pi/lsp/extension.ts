// Inline Pi extension that registers LSP-backed tools on session start.
// Mirrors the shape of `createTodoExtension` (src/pi/todo/extension.ts)
// and is mounted via `DefaultResourceLoader.extensionFactories` in
// `_buildResourceLoader`. Tools delegate to `vscode.commands.executeCommand`
// against the standard provider command surface
// (`vscode.executeReferenceProvider` and friends), which routes to
// whichever language extension is registered for the file's language —
// so a single tool set works for C#, TypeScript, Rust, Python, etc.
//
// Gated behind the `pi-code.lsp.enabled` setting: when disabled, the
// factory returns a no-op handler so the tools do not appear in the
// system prompt at all.

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerCallHierarchyIncomingTool } from './tools/call-hierarchy-incoming';
import { registerCallHierarchyOutgoingTool } from './tools/call-hierarchy-outgoing';
import { registerDocumentSymbolsTool } from './tools/document-symbols';
import { registerFindImplementationsTool } from './tools/find-implementations';
import { registerFindReferencesTool } from './tools/find-references';
import { registerGotoDefinitionTool } from './tools/goto-definition';
import { registerHoverTool } from './tools/hover';
import { registerTypeDefinitionTool } from './tools/type-definition';
import { registerWorkspaceSymbolsTool } from './tools/workspace-symbols';

export function createLspExtension(opts: { enabled: boolean }): (pi: ExtensionAPI) => void {
    return (pi) => {
        if (!opts.enabled) return;
        registerFindReferencesTool(pi);
        registerDocumentSymbolsTool(pi);
        registerGotoDefinitionTool(pi);
        registerHoverTool(pi);
        registerFindImplementationsTool(pi);
        registerTypeDefinitionTool(pi);
        registerWorkspaceSymbolsTool(pi);
        registerCallHierarchyIncomingTool(pi);
        registerCallHierarchyOutgoingTool(pi);
    };
}
