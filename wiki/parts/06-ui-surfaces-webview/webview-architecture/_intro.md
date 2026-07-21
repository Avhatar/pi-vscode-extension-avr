# Chapter: webview-architecture

Every UI surface in Pi Code is a **VS Code webview** — a sandboxed iframe running an IIFE-bundled TypeScript app. There are four of them (chat main, launcher, settings, RawMode), each with its own entry point and CSS. They share three cross-cutting patterns that this chapter documents: the `el()` DOM helper, the `AgentConnectionClient` transport (via [src/webview/vscode-agent-connection.ts](../../../../src/webview/vscode-agent-connection.ts)), and the VS Code CSS-variable theming.

Nothing here imports `vscode` or Node modules. Webviews are browsers; they postMessage to the extension host and consume state pushes back.

## Article roster

- [webview-architecture](webview-architecture.md) — the `el()` helper, `VsCodeAgentConnection` transport wiring, persistent `vscode.setState` for tab restoration, draft preservation across tab switches, CSS-variable theming, and `marked.js` markdown rendering with copy buttons.

## Reader task

The reader arrives here to answer one of:

- "How do webviews receive state updates from the extension host?"
- "Where does the DOM come from — is there a framework?"
- "Why do my custom colors look right in both light and dark themes without extra code?"
- "How is the tab-id preserved across `Reload Window`?"

## Neighborhood

- **Transport primitives** (`AgentConnectionClient`, epoch / sequence recovery) come from [Part II § agent-connection-client](../../02-shared-protocol-and-contracts/agent-connection-client/agent-connection-client.md).
- **Message shapes** are [Part II § message-protocol](../../02-shared-protocol-and-contracts/message-protocol/message-protocol.md).
- **Bundle production** (esbuild IIFE targets, CSS unignore) is [Part I § bundle-targets-and-esbuild](../../01-extension-host-substrate/bundle-targets-and-esbuild/bundle-targets-and-esbuild.md).
- **Panel providers** wrapping these webviews at the extension host are the sibling chapters below.

## Non-goals

- Individual webview behavior (chat rendering, launcher layout, settings form fields) is not this chapter's scope — the sibling chapters cover each surface. Cross-webview *patterns* only.
- Testing webview behavior (Playwright, jsdom) is not documented here.
- Any framework migration ("what if we used React?") — the answer is no, and the reasoning belongs elsewhere.
