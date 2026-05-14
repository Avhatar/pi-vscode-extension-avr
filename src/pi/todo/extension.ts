// Inline Pi extension that owns the per-session todo state. Mounted via
// DefaultResourceLoader.extensionFactories alongside our other in-tree
// extensions (codex-monitor, claude-md-injector). Shape mirrors
// `src/pi/codex-monitor.ts:18`.
//
// Lifecycle hooks rebuild state from the conversation branch on every
// boundary that could change visible history:
//   - session_start: initial load (also fires on reload).
//   - session_compact: after pi compacted older turns.
//   - session_tree: after the user navigated to a different branch.
//
// Every `todo` tool call already commits the new state via the store
// (inside the tool's `execute`). Subscribers get one notification per
// commit — that drives the sidebar update path in PR3.

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { replayFromBranch } from './replay';
import type { TodoStore } from './store';
import { registerTodoTool } from './tool';

export function createTodoExtension(
    store: TodoStore,
    guidelines?: readonly string[],
): (pi: ExtensionAPI) => void {
    return (pi) => {
        registerTodoTool(pi, store, guidelines);

        pi.on('session_start', (_event, ctx) => {
            store.replaceState(replayFromBranch(ctx.sessionManager.getEntries()));
        });

        pi.on('session_compact', (_event, ctx) => {
            store.replaceState(replayFromBranch(ctx.sessionManager.getEntries()));
        });

        pi.on('session_tree', (_event, ctx) => {
            store.replaceState(replayFromBranch(ctx.sessionManager.getEntries()));
        });
    };
}
