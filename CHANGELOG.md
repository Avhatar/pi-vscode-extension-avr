# Changelog

All notable changes to the Pi Agent VS Code extension are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
