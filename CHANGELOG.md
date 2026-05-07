# Changelog

All notable changes to the Pi Code VS Code extension are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-05-07

### Changed
- Rebranded the extension as Pi Code, including the package identity, publisher, command IDs, settings namespace, and visible UI labels.

## [0.4.1] - 2026-05-07

### Added
- Per-turn Codex usage delta is now appended to each assistant message footer (e.g. `5h +1.2% · week +0.3%`), so you can see how much of the 5-hour and weekly subscription windows the turn consumed. Hidden for non-Codex models.

### Changed
- Both the global Codex usage indicator and the per-turn delta now show one decimal place (e.g. `1.2%` instead of `1%`) so small turns don't round to zero.

## [0.4.0] - 2026-05-07

### Added
- Web access for the Pi coding agent: `web_search`, `code_search`, `fetch_content`, and `get_search_content` tools (powered by the bundled `pi-web-access` package), plus its accompanying skill. Works out of the box via Exa MCP without any API keys; optionally read `~/.pi/web-search.json` for Exa, Perplexity, or Gemini keys. Fetching GitHub repos, YouTube videos, PDFs, and local video files is supported.

### Changed
- Pi extensions (npm packages tagged `pi-package`) now ship inside the VSIX and are loaded automatically at session start — no `pi install` step required.

## [0.3.9] - 2026-05-07

### Added
- ChatGPT subscription usage indicator in the chat footer when using a Codex (GPT-5.x) model. Shows the percent used in the 5-hour and weekly windows, with colour cues at 50% and 90%, and a tooltip detailing the plan, exact reset times, and credit balance. Hidden for non-Codex models and when the account is on a token-billed API key.

### Changed
- The temporary `PI_CODEX_PROXY_URL` discovery hook (added in 0.3.8) was removed; subscription data is now read directly from the Codex response headers.

## [0.3.8] - 2026-05-07

### Added
- Codex provider response headers are now logged to the Pi Code output channel, and the provider's base URL can be temporarily redirected to a local capture proxy by setting the `PI_CODEX_PROXY_URL` environment variable. Diagnostic plumbing for upcoming subscription-usage indicator work.

### Fixed
- The welcome screen no longer shows a "No models available yet" warning before the saved/current model has finished loading.

## [0.3.7] - 2026-05-07

### Changed
- Token usage shown after assistant turns now includes total, output, input, cache write, and cache read counts.

## [0.3.6] - 2026-05-07

### Added
- History entries in the sidebar can now be deleted one at a time.

### Fixed
- Open chats in the sidebar now keeps showing the current chat panel instead of becoming empty.

## [0.3.5] - 2026-05-07

### Removed
- Duplicate New Chat and Settings buttons from the sidebar title bar.

## [0.3.4] - 2026-05-07

### Changed
- Chat editor tabs now keep longer titles, and chat panel toolbar actions are icon-only.

## [0.3.3] - 2026-05-07

### Changed
- Chat tabs are narrower and chat panel toolbar buttons now use matching Pi icons.

## [0.3.2] - 2026-05-07

### Changed
- Chat session editor tabs now use the full Pi icon.

## [0.3.1] - 2026-05-07

### Fixed
- "Open chats" section in the launcher no longer lists ghost entries that aren't actually open in any editor tab. The list now reflects only chats with a visible panel; everything else lives under "History". Stale tab data persisted by pre-0.3.0 versions is cleared automatically on first launch.

## [0.3.0] - 2026-05-07

### Changed
- The sidebar is now a **launcher**: it lists open chats and a history of previous sessions, and gives one-click buttons to start a new chat or open settings. The chat itself lives in editor-area panels — not in the sidebar — so it can be split, dragged into another editor group, or moved into a separate window, just like Claude Code.
- Starting a new chat (sidebar `+`, palette command, or `Ctrl+Shift+N`) now opens an editor panel directly. Clicking a previous session in the launcher reopens it as a panel.

### Added
- Toolbar at the top of every chat panel with **New chat** and **History** buttons, so you don't need to switch back to the launcher to spawn a sibling chat or jump to an older session.
- Launcher shows live indicators per chat (streaming spinner, unread dot) and lets you remove a chat from the list (the underlying session is preserved on disk and remains available under "History").

## [0.2.2] - 2026-05-07

### Added
- New "Open Chat in Editor" button (link-external icon) in the sidebar title bar. Opens the current chat as a stand-alone editor tab that can be split, dragged into another editor group, or moved into a separate window — same UX as Claude Code's chat panels.
- Chat editor panels are persisted across `Reload Window`: their position, splits, and bound session are restored automatically.

### Changed
- The sidebar still works as before; opening a chat in the editor is opt-in via the new title-bar button. (A future release will make editor panels the default and turn the sidebar into a launcher.)

## [0.2.1] - 2026-05-07

### Changed
- Internal: extracted chat tab logic from `SidebarProvider` into a new `ChatController`. The sidebar view becomes a thin wrapper that forwards messages between the webview and the controller. No user-visible behaviour change — preparation step for the upcoming editor-tab panels migration.

## [0.2.0] - 2026-05-07

### Added
- Sign-in via OAuth in the settings panel: ChatGPT (Plus/Pro/Codex), Anthropic Claude, GitHub Copilot, Google Gemini CLI, Antigravity. Unlocks subscription-only models (e.g. GPT-5.1 Codex) without leaving VS Code.
- Manual authorization-code paste field shown alongside the browser flow as a fallback when the local OAuth callback can't be reached.
- Welcome screen banner with a direct "Open Settings" button when no models are available yet.

### Changed
- Auth-related errors in the chat now include an "Open Settings" shortcut.
- Model list refreshes automatically after a successful OAuth login or logout — no window reload required.

## [0.1.6] - 2026-05-07

### Fixed
- Skill text no longer floods the chat window. Skill blocks are stripped from user messages and replaced with a compact `/skill:name` badge; only the user's own text is shown.

## [0.1.5] - 2026-05-07

### Fixed
- Long user messages (e.g. skill text) filling the entire chat window and blocking agent responses. User messages now collapse at 150px with a "Show more" / "Show less" toggle.

## [0.1.4] - 2026-05-07

### Fixed
- Agent appearing stuck after completing a request (spinning indicator wouldn't stop until switching tabs). The SDK's `isStreaming` flag lags behind the `agent_end` event; now tracked locally.

## [0.1.3] - 2026-05-07

### Added
- Versioning pipeline with `deploy:patch/minor/major` npm scripts
- `CHANGELOG.md` with Keep a Changelog format
- `scripts/bump-version.js` — auto-bump with changelog validation
- Build-deploy skill for the agent (`.pi/skills/build-deploy/`)

## [0.1.2] - 2026-05-07

### Added
- Preserve draft text in input field across tab switches
- `npm run deploy` one-command build pipeline
- Build-deploy skill for the agent (`.pi/skills/build-deploy/`)

### Fixed
- Draft input text lost when switching between agent tabs

## [0.1.1] - 2025-05-07

### Added
- Persist tabs across window reloads
- Move header action buttons to VS Code view title bar

### Fixed
- Auto-scroll when user scrolls up during streaming
- Name sessions from first user message
- Forward SecretStorage API keys into Pi AuthStorage
- VSIX packaging: include hoisted deps and webview styles
- CI: prune devDeps before vsce package

## [0.1.0] - 2025-05-06

### Added
- Initial release
- Sidebar chat UI with multi-tab sessions
- Inline diffs and file change tracking
- Tool approval with allow/deny round-trip
- Checkpoints and rollback per turn
- Settings page with API key management via SecretStorage
- Message queuing during streaming
- Mid-stream steering (Ctrl+Enter)
- Slash-command skills
- Context usage display in footer
