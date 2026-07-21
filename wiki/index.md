# Wiki — Book TOC

Navigation map of the Pi Code VS Code extension — organized as a book: **Parts → chapters → articles**, plus an optional cross-cutting [seam-types appendix](appendix-a-seam-types.md). The TOC below enumerates Parts and chapters with one-line descriptions; the per-chapter article roster lives in each chapter's `_intro.md` § Article roster.

## Reading order

Recommended top-down walk:

1. **Parts I–II — substrate and contracts.** Understand where the extension boots, how it is configured, how it is built, and the typed messages that carry state across every boundary.
2. **Parts III–IV — portable core and its adapters.** The headless chat runtime and the concrete VS Code / Node bindings it plugs into.
3. **Part V — Pi SDK integration.** Where the core meets the agent SDK: sessions, events, models, auth, bundled Pi extensions, and the Claude compatibility bridge.
4. **Part VI — UI surfaces.** The webview panels and views that the user actually sees.
5. **Part VII — safety and reversibility.** Invariants that keep the system from corrupting user work: change tracking, checkpoints, and exclusive session ownership.
6. **Part VIII — message flow discipline.** Behaviors visible in a live streaming chat: queuing, steering, Plan Mode, per-chat ToDo.
7. **Part IX — subagents.** Named and ad-hoc children dispatched from the parent conversation, with git-worktree write isolation.
8. **Part X — standalone desktop host.** The Electron-based alternate host that reuses the same portable core.
9. **Part XI — auxiliary systems.** Opt-in LSP tools and the packaging / release pipeline.

Each chapter starts with `_intro.md` framing what cluster of articles it owns and listing the article roster; individual articles carry the `Stance / Role / Keywords / Lifecycle edges / See also` schema.

---

## Part I — Extension host substrate

VS Code activation, configuration, and the two-target esbuild pipeline that produces the extension host and webview bundles.

- `activation-and-registration` — extension entry point, command and provider registration, activation events, and the controller glue between VS Code and the portable core.
- `configuration-and-secrets` — settings surface, secret storage bridge, provider registry, and the settings-panel round trip.
- `bundle-targets-and-esbuild` — extension-host CJS bundle vs. webview IIFE bundles, externalized Pi SDK, and the packaging invariants they impose.

---

## Part II — Shared protocol and contracts

Typed message unions and connection lifecycle that flow between the extension host, webviews, and alternate hosts.

- `message-protocol` — client/server message unions, agent-protocol payloads, and the discipline for adding new messages.
- `protocol-runtime` — bidirectional message routing and framing that hosts and clients share.
- `agent-connection-client` — client-side connection lifecycle, reconnection, and cross-boundary state observers.

---

## Part III — Portable chat core

Headless, host-agnostic chat runtime that projects Pi agent events into tab state and drives streaming behavior.

- `chat-host-and-service` — top-level lifecycle orchestration and the event-derived tab state projection they cooperate on.
- `chat-event-policy` — orphan-tool sweeps, assistant-turn classification, and completion-outcome rules applied to raw agent events.
- `chat-command-service` — parsing and routing of slash-style chat commands (name assignment, cancel, retry, and friends).
- `tab-registry-and-runtime` — tab membership, insertion order, active-tab selection, per-tab transient state, and lifecycle wrappers.
- `platform-ports` — port contracts the portable core requires (workspace, filesystem, diff presenter, session platform, and neighbors).

---

## Part IV — Platform adapters

Concrete implementations of the portable core's ports, split by embedding host.

- `vscode-workspace-and-diff` — VS Code workspace paths, Node filesystem via VS Code, and the diff-presenter that opens the built-in diff editor.
- `vscode-session-platform` — session lifecycle binding to VS Code (secrets, dialogs, persistent state, logger).
- `node-platform-adapters` — Node-only adapters used by the standalone desktop host: session platform, file-mentions index, session lock, JSON state store, and logger.

---

## Part V — Pi SDK integration

Wraps the `@earendil-works/pi-coding-agent` SDK: session lifecycle, event fan-out, models, auth, and bundled extensions.

- `session-lifecycle` — `PiSessionManager`, resource loader construction, prompt / steer / settlement flow, and cross-cutting session state.
- `event-router` — SDK event fan-out to the chat service, tab runtime, checkpoint manager, and file tracker.
- `models-and-auth` — model registry, provider ids, the `AuthStorage` bridge, and the `KNOWN_PROVIDERS` list.
- `bundled-pi-packages` — VSIX-embedded Pi extensions, `additionalExtensionPaths`, and the constraints they place on release.
- `claude-sdk-compat` — the Claude compatibility bridge (context, discovery, resources, tool-compat, settings) that lets Claude-shaped tools plug into Pi sessions.

---

## Part VI — UI surfaces (webview)

Editor-tab chat panels, activity-bar launcher, and settings page — all vanilla-TS webviews connected to the extension host via typed messages.

- `webview-architecture` — postMessage discipline, VS Code CSS-variable theming, DOM-only rendering with the `el()` helper.
- `chat-panel-provider` — the editor-area `WebviewPanel` per chat and its serializer for `Reload Window` restoration.
- `launcher-view` — the activity-bar `WebviewViewProvider` (new chat, settings, history, Plan Mode toggle, per-tab ToDo).
- `settings-panel` — the settings `WebviewPanel` and the state it round-trips to `SettingsData`.
- `slash-commands-and-skills-menu` — `/`-triggered menu, skill discovery through the Pi SDK, and the invocation flow.

---

## Part VII — Safety and reversibility

Tracks file changes, keeps checkpoints, and enforces exclusive writable-session ownership so nothing races on the same tree.

- `file-change-tracking` — portable file-change tracker and the Myers-diff engine that powers inline diffs.
- `checkpoint-rollback-redo` — checkpoint capture, rollback, and redo state machines invoked around agent tool calls.
- `writable-session-lock` — cross-host exclusive session ownership, typed conflicts, and stale-lock recovery paths.

---

## Part VIII — Message flow discipline

Behaviors that keep a live chat responsive and steerable while the agent is streaming.

- `message-queuing` — user-message queue during streaming, the `agent_settled` gate, and FIFO dispatch semantics.
- `steering` — mid-stream intent injection via `AgentSession.steer()` and the difference from a normal prompt.
- `plan-mode-and-todos` — Plan Mode toggle, per-chat ToDo persistence, and the reducer / store the ToDo tool talks to.

---

## Part IX — Subagents

Named and ad-hoc child agents dispatched from the parent conversation, with worktree-based write isolation.

- `agent-registry-and-resolution` — agent definition loading (repo, user, adapted vendor sources) and routing decisions.
- `subagent-manager-and-lifecycle` — child runtime, foreground / background execution, and integration back into the parent.
- `write-isolation-and-worktree` — git worktree isolation for write-capable children and the coordinator that keeps parent and child from stepping on each other.
- `subagent-extensibility` — gating rules and extensibility policy for adding new named agents or trust boundaries.

---

## Part X — Standalone desktop host

Alternate Electron-based host that reuses the portable chat core through the shared adapters and IPC.

- `desktop-ipc-contract` — the typed IPC contract between the desktop main process, preload bridge, and renderer.
- `desktop-host-lifecycle` — the headless `ChatHost` wiring in `standalone/desktop`, session storage on disk, and lifecycle differences from the VS Code host.

---

## Part XI — Auxiliary systems

Opt-in surfaces and release plumbing that sit around the main product.

- `lsp-tools` — opt-in Language Server tools (`find_references`, `hover`, and friends) gated by `pi-code.lsp.enabled`.
- `raw-mode` — per-chat developer view of the full agent-to-model exchange: inline Pi extension over `pi.on(...)`, `onPayload`/`onResponse` stream capture, portable recorder + ring buffer, JSONL storage keyed by `sessionPath`, RawPanel + Settings block, and `deleteHistorySession`-driven cleanup.
- `packaging-and-release` — VSIX packaging pipeline, prune / restore dance, `.vscodeignore` invariants, and the `deploy:patch|minor|major` scripts.

---

## By domain

Reading paths over the same chapters, grouped by concern — populated once the wiki has enough chapters authored to make thematic walks useful.

---

## Cross-cutting concepts

See [`appendix-a-seam-types.md`](appendix-a-seam-types.md) for the seam-types cheatsheet (create the file only when cross-cutting concepts start to accumulate — a group qualifies for the appendix once it spans 3+ chapters).
