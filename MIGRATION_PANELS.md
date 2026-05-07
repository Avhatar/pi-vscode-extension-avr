# Migration: Sidebar WebviewView → Editor WebviewPanels

A roadmap document for moving from the single sidebar panel
(`WebviewViewProvider`) to a Claude-Code-style model: every chat is its own
editor tab (`WebviewPanel`) that can be dragged, split, and moved into a new
window. The sidebar stays as a launcher.

> **Start date:** 2026-05-07
> **Current version:** 0.2.0
> **Target version after migration:** 0.3.0 (minor — the user-facing UX
> changes noticeably)

---

## 1. Goal and motivation

Current UX: the Activity Bar icon opens a webview-view that occupies the
entire side bar and crowds out other extensions. Chats live as internal tabs
inside one webview — they cannot be spread across the screen.

Target UX (matching Claude Code in VS Code):

- Every conversation is its own editor tab.
- Drag/split/move-to-new-window work per chat.
- The sidebar stays but becomes a "launcher": list of open chats and
  New / Sessions / Settings buttons.
- Session history is reachable from inside any panel (the `$(history)`
  icon in the top-right).
- Full persistence: after `Reload Window` or a VS Code restart nothing is
  lost — neither the panels themselves, nor their contents, nor their
  positions.

---

## 2. Locked-in decisions

| # | Question | Decision | Locked on |
|---|---|---|---|
| D1 | Window model | Per-chat `WebviewPanel` (one chat = one editor tab) | 2026-05-07 |
| D2 | Activity Bar | Kept as a launcher — list of chats + New/Sessions/Settings buttons | 2026-05-07 |
| D3 | Persistence | `WebviewPanelSerializer` restores positions; `workspaceState` is the fallback and cold-start source | 2026-05-07 |
| D4 | Closing a panel | Does NOT destroy `TabState`; the chat can be reopened from Session History | 2026-05-07 |
| D5 | Session history | Permanent (already in the Pi SDK via `.pi/sessions/`); a `$(history)` button inside every panel | 2026-05-07 |
| D6 | Last-active | Remembered across VS Code sessions | 2026-05-07 |
| D7 | Memory | Not optimised; `retainContextWhenHidden: true` everywhere by default | 2026-05-07 |
| D8 | Where `ChatController` lives | `src/controllers/chat-controller.ts` (new directory; cleaner separation: controllers / providers / webview / pi) | 2026-05-07 |

---

## 3. Target architecture

```
extension.ts (activate)
  │
  ├─ ChatController                    ← owns Map<id, TabState>,
  │   ├─ Map<tabId, TabState>            persistence, message routing,
  │   ├─ Map<tabId, ChatPanel?>          last-active tracking
  │   ├─ subscribeTab / unsubscribeTab
  │   ├─ handleMessage(tabId, msg)
  │   ├─ persist / restore
  │   └─ events: onTabsChanged, onActivePanelChanged
  │
  ├─ ChatPanel × N                     ← WebviewPanel wrapper, bound to a
  │   ├─ panel: vscode.WebviewPanel      single tabId. Analogous to
  │   ├─ tabId                           SettingsPanel.
  │   ├─ onDidReceiveMessage → controller.handleMessage(tabId, msg)
  │   ├─ onDidChangeViewState → controller.setActive(tabId)
  │   └─ onDidDispose → controller.detachPanel(tabId)
  │
  ├─ LauncherView                      ← formerly SidebarProvider, now only
  │   ├─ implements WebviewViewProvider  the chat list + buttons. No chat
  │   └─ listens to controller.onTabsChanged    logic.
  │
  ├─ ChatPanelSerializer               ← deserializeWebviewPanel(panel, state)
  │                                      recreates ChatPanel on window reload
  │
  └─ SettingsPanel                     ← unchanged
```

### Message flow

```
webview (panel A) ──postMessage──▶ ChatPanel ──handleMessage(tabId=A)──▶ ChatController
                                                                              │
                                                          ┌───────────────────┤
                                                          ▼                   ▼
                                                    TabState A          (other tabs untouched)
                                                          │
                                          ChatController.sendStateSync(tabId)
                                                          │
                                                          ▼
                                            panelMap.get(A).post(...)
                                                          │
                                                          ▼
                                                    webview (panel A)
```

### Persistence stack

| Layer | What it stores | When it is restored |
|---|---|---|
| `vscode.setState({ tabId, sessionPath })` inside the webview | panel ↔ session binding | `WebviewPanelSerializer.deserializeWebviewPanel` on window reload |
| `workspaceState['pi-agent.tabs']` | List of every tab ever opened: `{ tabId, name, sessionPath, isOpen }` + `lastActiveTabId` | Cold start (fresh VS Code launch) when the serializer did not fire |
| `.pi/sessions/<id>.json` (Pi SDK) | Full contents of every session | Via `session.loadSession(path)` |

---

## 4. Commit plan

### ☐ Commit 1 — Refactor: `SidebarProvider` → `ChatController` + view

**What we do:** split the existing `SidebarProvider` into a clean controller
(no knowledge of webviews) and a thin view wrapper that still renders the
sidebar webview. The UI does not change; behaviour is identical.

**Why:** isolates every later edit. If something breaks at this step, it is
visible immediately, without being mixed up with the UI migration.

**Files:**
- `src/controllers/chat-controller.ts` (new) — moves `_tabs`,
  `_subscribeTab`, `_handleTabEvent`, `_createTab`, `_closeTab`, `_switchTab`,
  `_persistTabs`, `restorePersistedTabs`, `_handleMessage`,
  `_requestToolApproval`, `_resolveToolApproval`, `sendStateSync`.
  Signature becomes `_handleMessage(tabId, msg)` instead of relying on
  `_activeTab`.
- `src/providers/sidebar.ts` — turns into a thin view that delegates
  everything to the controller.
- `src/extension.ts` — creates `ChatController` separately and passes it
  into `SidebarProvider`.

**Acceptance:**
- F5 launches the Extension Development Host; the chat works identically.
- All tabs can be created/closed/switched.
- Persistence via `restorePersistedTabs` works.
- Tool approval round-trip works.
- `npm run test:unit` is green.

**Version:** 0.2.1 (patch — pure refactor).

---

### ☐ Commit 2 — `ChatPanel` alongside the sidebar (optional mode)

**What we do:** add `ChatPanel` as a second way to display the chat — in the
editor area. The sidebar keeps working. The user can open a chat in either
place.

**Files:**
- `src/providers/chat-panel.ts` (new) — `WebviewPanel` wrapper modelled on
  [src/providers/settings-panel.ts](src/providers/settings-panel.ts), but
  bound to a specific `tabId` and routed through `ChatController`.
- `src/providers/chat-panel-serializer.ts` (new) —
  `WebviewPanelSerializer.deserializeWebviewPanel`.
- `src/extension.ts`:
  - registers `vscode.window.registerWebviewPanelSerializer('pi-agent.chat', ...)`;
  - registers a `pi-agent.openInEditor` command.
- `src/webview/main.ts`:
  - reads `?mode=panel|sidebar` from query/state;
  - in `mode=panel` hides the internal tab bar (one chat per panel);
  - persists `vscode.setState({ tabId, sessionPath })` on changes.
- `package.json` — new `pi-agent.openInEditor` command and a
  `$(link-external)` button in `view/title` for the sidebar.

**Acceptance:**
- A button in the sidebar opens the current chat as an editor tab.
- The editor tab shows the same content and reacts to streaming and
  tool approval.
- Drag into split / into a new window works.
- `Reload Window` restores every open panel at its previous position.
- Closing a panel does NOT kill `TabState` — the chat can be reopened
  from the sidebar.
- The sidebar keeps working as before.

**Version:** 0.2.2 (patch — opt-in feature).

---

### ☐ Commit 3 — Sidebar → launcher; panels become primary

**What we do:** the sidebar drops the chat and becomes a launcher. The
internal tab bar inside the webview is removed. The
`pi-agent.createTab` command now opens an editor panel directly.

**Files:**
- `src/providers/sidebar.ts` → `src/providers/launcher-view.ts`
  (or just rewrite the contents). Minimal webview: a list of chats
  (open + closed from history) and New / Settings buttons.
- `src/webview/launcher.ts` (new) — separate bundle for the launcher.
- `src/webview/main.ts` — drop the internal tab-bar rendering and its
  handlers. Only the single-chat UI remains.
- `src/webview/styles/main.css` — drop tab-bar styles, add a `$(history)`
  button to the panel header (next to the model selector).
- `src/shared/protocol.ts` — keep `tabs`/`activeTabId` for the launcher,
  but in the main protocol they are no longer needed (the panel knows
  only its own tabId).
- `esbuild.js` — add a third entry: `webview/launcher.ts`.
- `package.json`:
  - `pi-agent.createTab` now opens an editor panel;
  - `pi-agent.focusChat` focuses the last-active panel, or opens it if
    closed;
  - drop the `$(link-external)` button (no longer needed — the sidebar
    is always the launcher).

**Acceptance:**
- The sidebar contains no chat — only the launcher.
- All agent interaction happens in editor panels.
- History is reachable from any panel via `$(history)`.
- Cold start (a fresh VS Code launch) restores the last-active panel.
- `Reload Window` restores every open panel and its position.

**Version:** 0.3.0 (minor — UX changes noticeably for the user).

---

## 5. Open questions

- **Q1** — do we need an unread/streaming indicator on a closed panel in
  the launcher? `TabState` already has `hasNotification`. Surface it in the
  launcher as a badge next to the chat row.

- **Q2** — what about the global `pi-agent.abort` command (Esc)? Today it
  hits `_activeTab`. After the migration — the last-focused panel. We have
  to make sure `setContext('pi-agent.isStreaming', ...)` also flips on
  `onDidChangeViewState`.

- **Q3** — cap the number of open panels? Probably not (D7), but if 20+
  panels with `retainContextWhenHidden: true` turn out to eat memory, add
  LRU eviction into state.

---

## 6. Checkpoints and risks

**Risk 1 — Serializer is not invoked.** VS Code does not call
`deserializeWebviewPanel` for an extension that has not been activated by
the time of the reload. We need to ensure that `activationEvents` (in
`package.json:16`) either includes `onWebviewPanel:pi-agent.chat`, or `*`
(we already activate early through registered views). Verify by hand.

**Risk 2 — Double `TabState` creation via the serializer.** If cold start
brings tabs back from `workspaceState` and then the serializer fires for
the same panels, we get duplicates. Fix: cold start only creates `TabState`
for the last-active tab (or nothing at all); the serializer does the rest.

**Risk 3 — Tool approval on an inactive panel.** The Pi SDK blocks
execution until `setToolApprovalHandler.resolve`. If the request lands on
a panel that is not currently focused, the user has to notice somehow
(badge on the tab, status bar, notification). In commit 2 — the minimum:
show a popup notification; in commit 3 — a badge in the launcher.

**Risk 4 — Messages dropped into a disconnected panel.** If the controller
calls `panel.post(...)` and the panel is not yet resolved (or has been
disposed), state is lost. Fix: keep a per-`tabId` buffer in the
controller; flush on `attachPanel`.

---

## 7. Test scenarios (manual sweep on every commit)

1. **Streaming right after opening:** open a chat, send a prompt → streaming
   starts without delay.
2. **Reload Window during streaming:** prompt mid-flight, `Ctrl+R` →
   after reload the panels are in place; the current response either
   completes in the background or is cleanly aborted (no stuck panels).
3. **Drag panel into split:** works; both views stay in sync.
4. **Move into New Window:** works; the panel lives in its own window.
5. **Close a panel and reopen via history:** contents intact; streaming is
   not in flight.
6. **Tool approval from an inactive panel:** the user can tell that
   confirmation is needed.
7. **Cold start:** restart VS Code → the last-active panel is open; the
   rest are reachable through the launcher.
8. **Multiple providers:** run three panels with different models → all
   stream independently.

---

## 8. Progress

```
[x] Commit 1: ChatController extraction          → 0.2.1 (2026-05-07)
[x] Commit 2: ChatPanel optional + serializer    → 0.2.2 (2026-05-07)
[ ] Commit 3: Sidebar → launcher                 → 0.3.0
```

After every commit: `npm run deploy:patch` (or `:minor` for the last one),
manual testing per the list above, and update this document (tick the
checkbox, stamp date/version, add notes to the "Log").

---

## 9. Log

### 2026-05-07 — start

- Architecture agreed (D1–D7).
- This document created.
- D8 locked: `ChatController` lives in `src/controllers/chat-controller.ts`.
- Next action: Commit 1 — extract `ChatController`.

### 2026-05-07 — Commit 1 code complete (awaiting verification)

- Created `src/controllers/chat-controller.ts` with all tab/session/event/persistence logic moved out of `SidebarProvider`.
- `src/providers/sidebar.ts` is now a thin `ChatViewSink` that forwards webview messages to the controller and posts replies back.
- `src/extension.ts` constructs `ChatController` separately and wires it into commands; controller is added to `context.subscriptions` so it disposes cleanly on deactivate.
- `npm run compile` and `npx tsc --noEmit` are clean. `npm run test:unit`: 22 passed, 3 pre-existing failures unrelated to refactor (test fixtures reference a model that's not in the registry — both before and after the change).
- Behaviour change worth noting: under the old code, side-bar collapse/expand disposed all tab-event subscriptions (so streaming events arriving while the side-bar was hidden were dropped). The controller now keeps subscriptions alive across view dispose; cleanup happens only on extension deactivate via `context.subscriptions`. This is closer to what we'll need in Phase 2 when the same controller services multiple panels.
- Pending before ticking the checkbox in §8: F5 manual smoke (see §7 sweep), then `npm run deploy:patch` to publish 0.2.1.

### 2026-05-07 — Commit 1 shipped as 0.2.1

- `npm run deploy:patch` ran clean. `pi-agent-0.2.1.vsix` (39.35 MB) packaged and installed.
- CHANGELOG stamped: `[0.2.1] - 2026-05-07`.
- Manual sweep (§7) deferred to the user — extension is installed and ready.
- Next action: Commit 2 — add `ChatPanel` alongside the sidebar.

### 2026-05-07 — Commit 2 code complete (awaiting verification)

- Multi-sink controller: replaced single `_sink` with a `Set<ChatViewSink>` where each sink declares a `tabFilter` (`'active'` for the sidebar, a specific `tabId` for panels). Internal posts now go through `_postForTab(tabId, msg)`, which routes to every matching sink.
- `handleMessage(msg, sourceTabId?)` lets panel webviews target their own tab, while the sidebar (no `sourceTabId`) keeps targeting the active tab.
- `sendStateSync(tabId?)` builds and posts state for a specific tab. The active-tab path is unchanged.
- New: `controller.findTabIdBySessionPath`, `createTabFromSessionPath`, `getTabName`, and `onTabRenamed` event used by panels to keep their editor-tab title in sync.
- New `src/providers/chat-panel.ts` — `WebviewPanel` wrapper bound to one `tabId`. Implements `ChatViewSink` with `tabFilter = tabId`. Exposes `createChatPanel(...)` factory used by the `pi-agent.openInEditor` command.
- New `src/providers/chat-panel-serializer.ts` — `WebviewPanelSerializer` that, on window reload, looks up the tab by `sessionPath` (falling back to creating a new tab from disk if needed) and re-attaches the panel.
- View type for editor panels: `pi-agent.chatPanel` (distinct from the sidebar view id `pi-agent.chat`, even though both load the same webview bundle).
- Webview detects mode via `data-mode` attribute on `<div id="app">`. In `panel` mode it (a) hides the in-webview tab strip via CSS + `updateTabs()`, and (b) calls `vscode.setState({ tabId, sessionPath })` after each state sync so the serializer can restore.
- `package.json`: new command `pi-agent.openInEditor` with the `$(link-external)` icon; placed in `view/title` group `navigation@2` (between New Tab and Sessions).
- `extension.ts`: registers the command + the `WebviewPanelSerializer`. The serializer needs the controller to be ready, so it's registered after `restorePersistedTabs()`.
- Protocol: added optional `sessionPath` to `SerializedAgentState` so the webview can serialize it.
- `npm run compile` and `npx tsc --noEmit` clean. Unit tests: 22 passed, 3 pre-existing failures (unchanged from before).
- Pending before ticking §8: F5 sweep + `deploy:patch` to ship 0.2.2.

### 2026-05-07 — Commit 2 shipped as 0.2.2

- `npm run deploy:patch` ran clean. `pi-agent-0.2.2.vsix` (39.35 MB) packaged and installed.
- CHANGELOG stamped: `[0.2.2] - 2026-05-07`.
- Manual sweep deferred to the user. Smoke tests to run:
  - Sidebar still functions identically (regression check after multi-sink refactor).
  - Click `$(link-external)` in the sidebar title → chat opens as an editor tab.
  - Drag the editor tab into a split, then into a new window — content stays in sync.
  - Reload Window — every open chat panel returns at its prior position.
  - Close a panel, then re-open via Session History inside any other panel.
- Next action: Commit 3 — sidebar becomes a pure launcher; editor panels become the default UX. Target version 0.3.0.
